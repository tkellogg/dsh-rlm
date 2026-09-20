"""Bounded JSON-lines subprocess bridge for :class:`dsh_rlm.LocalKernel`.

The bridge owns one kernel and processes requests in order.  Standard output is
reserved for protocol messages.  Output written by an executing cell is
returned in its ``cell`` result instead of being mixed with the JSON stream.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, TextIO

from .checkpoint import CheckpointReport, ValueIssue
from .kernel import LocalKernel
from .repl import CellResult

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 1024 * 1024
MAX_ID_CHARS = 1024
_MAX_CHECKPOINT_ITEMS = 128
_MAX_CHECKPOINT_TEXT_CHARS = 512
_MAX_PROTOCOL_TEXT_CHARS = 65_536


class ProtocolError(Exception):
    """A request that is invalid without being fatal to the bridge."""

    def __init__(self, code: str, message: str, *, request_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.request_id = request_id


@dataclass(frozen=True, slots=True)
class _Request:
    id: str
    method: str
    source: str | None = None


def _truncate(text: str, limit: int = _MAX_PROTOCOL_TEXT_CHARS) -> str:
    if len(text) <= limit:
        return text
    marker = "... [truncated]"
    return text[: limit - len(marker)] + marker


def _error_message(result: CellResult) -> str | None:
    """Extract a useful message without calling user exception methods."""
    if result.error is None or not result.traceback:
        return None
    lines = result.traceback.rstrip().splitlines()
    if not lines:
        return None
    final = lines[-1]
    prefix = f"{type(result.error).__name__}:"
    if final.startswith(prefix):
        final = final[len(prefix) :].lstrip()
    return final or None


def _cell_summary(result: CellResult) -> dict[str, Any]:
    return {
        "ok": result.ok,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "display": result.display,
        "error_type": type(result.error).__name__ if result.error is not None else None,
        "error_message": _error_message(result),
        "traceback": result.traceback,
    }


def _issue_summary(issue: ValueIssue) -> dict[str, str]:
    return {
        "name": _truncate(issue.name, _MAX_CHECKPOINT_TEXT_CHARS),
        "reason": _truncate(issue.reason, _MAX_CHECKPOINT_TEXT_CHARS),
    }


def _checkpoint_summary(report: CheckpointReport | None) -> dict[str, Any] | None:
    if report is None:
        return None
    saved = [
        _truncate(name, _MAX_CHECKPOINT_TEXT_CHARS)
        for name in report.saved[:_MAX_CHECKPOINT_ITEMS]
    ]
    if len(report.saved) > len(saved):
        saved.append(f"... ({len(report.saved) - len(saved)} omitted)")
    skipped = [
        _issue_summary(issue) for issue in report.skipped[:_MAX_CHECKPOINT_ITEMS]
    ]
    if len(report.skipped) > len(skipped):
        skipped.append(
            {
                "name": "...",
                "reason": f"{len(report.skipped) - len(skipped)} omitted",
            }
        )
    return {
        "ok": report.ok,
        "checkpoint_id": report.checkpoint_id,
        "created_at": report.created_at,
        "byte_count": report.byte_count,
        "saved": saved,
        "skipped": skipped,
        "error": (
            _truncate(report.error, _MAX_CHECKPOINT_TEXT_CHARS)
            if report.error is not None
            else None
        ),
    }


def _failure(
    code: str, message: str, *, request_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": request_id,
        "ok": False,
        "error": {"code": code, "message": _truncate(message)},
    }


def _parse_request(line: bytes) -> _Request:
    try:
        text = line.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ProtocolError(
            "INVALID_ENCODING", "request must be valid UTF-8"
        ) from error
    try:
        value = json.loads(text)
    except (json.JSONDecodeError, RecursionError) as error:
        raise ProtocolError(
            "INVALID_JSON", "request must be one JSON object"
        ) from error
    if not isinstance(value, dict):
        raise ProtocolError("INVALID_REQUEST", "request must be a JSON object")

    raw_id = value.get("id")
    request_id = raw_id if isinstance(raw_id, str) else None
    if not isinstance(raw_id, str) or not raw_id:
        raise ProtocolError(
            "INVALID_REQUEST", "id must be a non-empty string", request_id=request_id
        )
    if len(raw_id) > MAX_ID_CHARS:
        raise ProtocolError("INVALID_REQUEST", "id is too long")

    method = value.get("method")
    if not isinstance(method, str):
        raise ProtocolError(
            "INVALID_REQUEST", "method must be a string", request_id=raw_id
        )
    if method == "close":
        return _Request(raw_id, method)
    if method != "execute":
        raise ProtocolError(
            "METHOD_NOT_FOUND",
            f"unknown method: {_truncate(method, 200)}",
            request_id=raw_id,
        )

    source = value.get("source")
    if not isinstance(source, str):
        raise ProtocolError(
            "INVALID_REQUEST", "execute source must be a string", request_id=raw_id
        )
    try:
        source_bytes = source.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ProtocolError(
            "INVALID_ENCODING", "source must be valid UTF-8", request_id=raw_id
        ) from error
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise ProtocolError(
            "SOURCE_TOO_LARGE",
            f"source exceeds {MAX_SOURCE_BYTES} UTF-8 bytes",
            request_id=raw_id,
        )
    return _Request(raw_id, method, source)


async def _read_line(stream: BinaryIO) -> tuple[bytes, bool]:
    """Read one bounded line and consume an oversized line's remainder."""
    line = await asyncio.to_thread(stream.readline, MAX_REQUEST_BYTES + 1)
    if not line:
        return b"", False
    oversized = len(line) > MAX_REQUEST_BYTES
    if line.endswith(b"\n"):
        return line, oversized
    if len(line) == MAX_REQUEST_BYTES + 1:
        oversized = True
        while True:
            remainder = await asyncio.to_thread(stream.readline, MAX_REQUEST_BYTES + 1)
            if not remainder or remainder.endswith(b"\n"):
                break
    return line, oversized


def _write_response(stream: TextIO, response: dict[str, Any]) -> None:
    payload = json.dumps(
        response,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )
    stream.write(payload + "\n")
    stream.flush()


async def serve(
    session_dir: str | os.PathLike[str],
    *,
    input_stream: BinaryIO,
    output_stream: TextIO,
) -> None:
    """Serve requests until ``close`` or EOF, then close the kernel."""
    kernel = await LocalKernel.open(session_dir)
    try:
        while True:
            line, oversized = await _read_line(input_stream)
            if not line and not oversized:
                break
            if oversized:
                _write_response(
                    output_stream,
                    _failure(
                        "REQUEST_TOO_LARGE",
                        f"request line exceeds {MAX_REQUEST_BYTES} bytes",
                    ),
                )
                continue
            try:
                request = _parse_request(line)
            except ProtocolError as error:
                _write_response(
                    output_stream,
                    _failure(error.code, error.message, request_id=error.request_id),
                )
                continue

            if request.method == "close":
                try:
                    await kernel.close()
                except BaseException as error:
                    _write_response(
                        output_stream,
                        _failure(
                            "CLOSE_FAILED",
                            f"{type(error).__name__}: kernel close failed",
                            request_id=request.id,
                        ),
                    )
                else:
                    _write_response(
                        output_stream,
                        {"id": request.id, "ok": True, "result": {"closed": True}},
                    )
                return

            try:
                result = await kernel.execute(request.source or "")
                recovery_notice = kernel.take_recovery_notice()
                checkpoint = _checkpoint_summary(
                    kernel.last_checkpoint if result.ok else None
                )
                response = {
                    "id": request.id,
                    "ok": True,
                    "result": {
                        "cell": _cell_summary(result),
                        "checkpoint": checkpoint,
                        "recovery_notice": recovery_notice,
                    },
                }
            except BaseException as error:
                response = _failure(
                    "EXECUTE_FAILED",
                    f"{type(error).__name__}: kernel execution failed",
                    request_id=request.id,
                )
            _write_response(output_stream, response)
    finally:
        if not kernel.closed:
            await kernel.close()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the dsh_rlm JSONL bridge")
    parser.add_argument("--session-dir", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    # Keep fd 1 exclusively for protocol output.  Late writes from background
    # tasks go to stderr after the REPL capture context has closed.
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    protocol_output = os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1)
    protocol_input = sys.stdin.buffer
    sys.stdout = sys.stderr
    sys.__stdout__ = sys.stderr
    try:
        asyncio.run(
            serve(
                args.session_dir,
                input_stream=protocol_input,
                output_stream=protocol_output,
            )
        )
    finally:
        protocol_output.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "MAX_REQUEST_BYTES",
    "MAX_SOURCE_BYTES",
    "main",
    "serve",
]
