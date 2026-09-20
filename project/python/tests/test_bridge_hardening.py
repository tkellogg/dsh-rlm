from __future__ import annotations

import asyncio
import io
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from dsh_rlm.bridge import (
    MAX_CALLBACK_BYTES,
    MAX_PENDING_REQUESTS,
    HostCallbackError,
    _encode_message,
    _ProtocolConnection,
    serve,
)


async def _serve_bytes(
    tmp_path: Path, payload: bytes
) -> tuple[list[dict[str, Any]], Path]:
    session_dir = tmp_path / "session"
    output = io.StringIO()
    await serve(session_dir, input_stream=io.BytesIO(payload), output_stream=output)
    return [json.loads(line) for line in output.getvalue().splitlines()], session_dir


@pytest.mark.asyncio
async def test_finite_input_drains_accepted_execute_before_eof(tmp_path: Path) -> None:
    request = {
        "id": "finite",
        "method": "execute",
        "source": "import asyncio\nawait asyncio.sleep(0.02)\n6 * 7",
    }
    responses, session_dir = await _serve_bytes(
        tmp_path, (json.dumps(request) + "\n").encode()
    )

    assert responses[0]["id"] == "finite"
    assert responses[0]["result"]["cell"]["display"] == "42"
    assert json.loads((session_dir / "dirty-run").read_text())["state"] == "clean"


@pytest.mark.asyncio
async def test_malformed_close_does_not_stop_reader(tmp_path: Path) -> None:
    values = [
        {"method": "close"},
        {"id": "valid", "method": "execute", "source": "42"},
        {"id": "close", "method": "close"},
    ]
    payload = b"".join((json.dumps(value) + "\n").encode() for value in values)
    responses, _ = await _serve_bytes(tmp_path, payload)

    assert responses[0]["error"]["code"] == "INVALID_REQUEST"
    assert responses[1]["id"] == "valid"
    assert responses[1]["result"]["cell"]["display"] == "42"
    assert responses[2] == {"id": "close", "ok": True, "result": {"closed": True}}


@pytest.mark.asyncio
async def test_callback_attempt_after_finite_eof_marks_interrupted(
    tmp_path: Path,
) -> None:
    request = {
        "id": "callback",
        "method": "execute",
        "capabilities": ["host-callback-v1"],
        "source": "import asyncio\nawait asyncio.sleep(0.02)\nawait runtime.tools.list()",
    }
    responses, session_dir = await _serve_bytes(
        tmp_path, (json.dumps(request) + "\n").encode()
    )

    assert responses == []
    marker = json.loads((session_dir / "dirty-run").read_text())
    assert marker["state"] == "interrupted"
    assert "EOF" in marker["cause"]
    assert "callback" in marker["cause"]


def test_protocol_encoding_escapes_surrogates_and_rejects_coercion() -> None:
    encoded = _encode_message({"value": "\ud800"})
    assert "\ud800" not in encoded
    assert "\\ud800" in encoded
    assert json.loads(encoded) == {"value": "\ud800"}

    invalid = [
        {"value": (1,)},
        {"value": object()},
        {"value": {1: "not a string key"}},
        {"value": float("nan")},
        {"value": 1 << 53},
    ]
    for value in invalid:
        with pytest.raises((TypeError, ValueError)):
            _encode_message(value)

    assert (
        json.loads(_encode_message({"value": (1 << 53) - 1}))["value"] == (1 << 53) - 1
    )


@pytest.mark.asyncio
async def test_callback_limit_excludes_framing_newline() -> None:
    output = io.StringIO()
    connection = _ProtocolConnection(io.BytesIO(), output)
    message = {"kind": "callback", "value": "ok"}
    payload_size = len(_encode_message(message).encode())

    await connection.write(message, limit=payload_size)
    assert output.getvalue().endswith("\n")
    with pytest.raises(HostCallbackError, match="CALLBACK_PAYLOAD_TOO_LARGE"):
        await connection.write(message, limit=payload_size - 1)


@pytest.mark.asyncio
async def test_callback_result_exact_limit_excludes_newline() -> None:
    template = {"kind": "callback_result", "id": "cb", "ok": True, "result": ""}
    base_size = len(_encode_message(template).encode())
    template["result"] = "x" * (MAX_CALLBACK_BYTES - base_size)
    payload = _encode_message(template).encode()
    assert len(payload) == MAX_CALLBACK_BYTES

    connection = _ProtocolConnection(io.BytesIO(payload + b"\n"), io.StringIO())
    future = asyncio.get_running_loop().create_future()
    connection.pending["cb"] = future
    await connection._read_forever()
    assert len(await future) == MAX_CALLBACK_BYTES - base_size
    assert connection.fatal_error is None

    oversized = dict(template)
    oversized["result"] += "x"
    connection = _ProtocolConnection(
        io.BytesIO(_encode_message(oversized).encode() + b"\n"), io.StringIO()
    )
    future = asyncio.get_running_loop().create_future()
    connection.pending["cb"] = future
    await connection._read_forever()
    assert connection.fatal_error is not None
    assert connection.fatal_error.code == "CALLBACK_RESULT_TOO_LARGE"
    future.cancel()


@pytest.mark.asyncio
async def test_twenty_thousand_pipelined_requests_are_bounded() -> None:
    line = b'{"id":"queued","method":"execute","source":"pass"}\n'
    connection = _ProtocolConnection(io.BytesIO(line * 20_000), io.StringIO())

    await connection._read_forever()

    assert connection.requests.qsize() == MAX_PENDING_REQUESTS
    assert connection.fatal_error is not None
    assert connection.fatal_error.code == "REQUEST_QUEUE_OVERFLOW"


@pytest.mark.asyncio
async def test_callback_result_routes_with_full_request_queue() -> None:
    request = b'{"id":"queued","method":"execute","source":"pass"}\n'
    result = b'{"kind":"callback_result","id":"cb","ok":true,"result":42}\n'
    connection = _ProtocolConnection(
        io.BytesIO(request * MAX_PENDING_REQUESTS + result), io.StringIO()
    )
    future = asyncio.get_running_loop().create_future()
    connection.pending["cb"] = future

    await connection._read_forever()

    assert connection.requests.full()
    assert await future == 42
    assert connection.fatal_error is None


@pytest.mark.asyncio
async def test_malformed_known_callback_result_is_fatal() -> None:
    connection = _ProtocolConnection(io.BytesIO(), io.StringIO())
    future = asyncio.get_running_loop().create_future()
    connection.pending["cb"] = future

    accepted = connection._accept_callback_result(
        {
            "kind": "callback_result",
            "id": "cb",
            "ok": True,
            "result": 42,
            "extra": True,
        }
    )

    assert accepted is False
    assert connection.fatal_error is not None
    assert connection.fatal_error.code == "INVALID_CALLBACK_RESULT"
    assert "cb" in connection.pending
    future.cancel()


def _start(session_dir: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", "dsh_rlm.bridge", "--session-dir", str(session_dir)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )


def test_pipe_half_close_still_returns_accepted_execute(tmp_path: Path) -> None:
    process = _start(tmp_path / "session")
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(
        json.dumps(
            {
                "id": "pipe",
                "method": "execute",
                "source": "import asyncio\nawait asyncio.sleep(0.05)\n42",
            }
        )
        + "\n"
    )
    process.stdin.close()

    response = json.loads(process.stdout.readline())
    assert response["id"] == "pipe"
    assert response["result"]["cell"]["display"] == "42"
    assert process.wait(timeout=10) == 0


def test_eof_forces_nonzero_exit_when_cell_suppresses_cancellation(
    tmp_path: Path,
) -> None:
    session_dir = tmp_path / "session"
    process = _start(session_dir)
    assert process.stdin is not None
    assert process.stdout is not None
    source = (
        "import asyncio\n"
        "try:\n"
        "    await runtime.tools.list()\n"
        "except asyncio.CancelledError:\n"
        "    while True:\n"
        "        try:\n"
        "            await asyncio.sleep(3600)\n"
        "        except asyncio.CancelledError:\n"
        "            pass"
    )
    process.stdin.write(
        json.dumps(
            {
                "id": "stubborn",
                "method": "execute",
                "capabilities": ["host-callback-v1"],
                "source": source,
            }
        )
        + "\n"
    )
    process.stdin.flush()
    callback = json.loads(process.stdout.readline())
    assert callback["kind"] == "callback"

    process.stdin.close()
    assert process.wait(timeout=10) != 0
    marker = json.loads((session_dir / "dirty-run").read_text())
    assert marker["state"] == "interrupted"
    assert "CALLBACK_TRANSPORT_CLOSED" in marker["cause"]
