from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from dsh_rlm import Runtime, UnsupportedOperationError


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


def _write(process: subprocess.Popen[str], value: dict[str, Any]) -> None:
    assert process.stdin is not None
    process.stdin.write(json.dumps(value) + "\n")
    process.stdin.flush()


def _read(process: subprocess.Popen[str]) -> dict[str, Any]:
    assert process.stdout is not None
    line = process.stdout.readline()
    assert line, process.stderr.read() if process.stderr is not None else ""
    return json.loads(line)


def _close(process: subprocess.Popen[str]) -> None:
    _write(process, {"id": "close", "method": "close"})
    assert _read(process)["ok"] is True
    assert process.wait(timeout=10) == 0


def test_callbacks_correlate_out_of_order_and_use_exact_params(tmp_path: Path) -> None:
    process = _start(tmp_path / "session")
    _write(
        process,
        {
            "id": "execute",
            "method": "execute",
            "capabilities": ["host-callback-v1"],
            "source": (
                "import asyncio\n"
                "answers = await asyncio.gather("
                "runtime.tools.call('lookup', {'n': 1}), "
                "runtime.models.complete('hello', provider='p', model='m', "
                "reasoning_effort='high', max_tokens=50))\n"
                "answers"
            ),
        },
    )
    first = _read(process)
    second = _read(process)
    frames = {first["method"]: first, second["method"]: second}
    assert frames["tools.call"]["params"] == {
        "name": "lookup",
        "arguments": {"n": 1},
    }
    assert frames["models.complete"]["params"] == {
        "prompt": "hello",
        "provider": "p",
        "model": "m",
        "reasoning_effort": "high",
        "max_tokens": 50,
    }
    assert all(frame["kind"] == "callback" for frame in frames.values())
    assert all(frame["parent_id"] == "execute" for frame in frames.values())

    model_frame = frames["models.complete"]
    tool_frame = frames["tools.call"]
    _write(
        process,
        {
            "kind": "callback_result",
            "id": model_frame["id"],
            "ok": True,
            "result": {"text": "done", "provider": "p", "model": "m"},
        },
    )
    _write(
        process,
        {
            "kind": "callback_result",
            "id": tool_frame["id"],
            "ok": True,
            "result": {"found": 7},
        },
    )
    response = _read(process)
    assert response["id"] == "execute"
    assert response["result"]["cell"]["ok"] is True
    display = response["result"]["cell"]["display"]
    assert "'found': 7" in display
    assert "'text': 'done'" in display
    _close(process)


def test_callback_error_without_capability_and_post_cell_rejection(
    tmp_path: Path,
) -> None:
    process = _start(tmp_path / "session")
    _write(
        process,
        {
            "id": "host-error",
            "method": "execute",
            "capabilities": ["host-callback-v1"],
            "source": "await runtime.tools.list()",
        },
    )
    callback = _read(process)
    _write(
        process,
        {
            "kind": "callback_result",
            "id": callback["id"],
            "ok": False,
            "error": {"code": "DENIED", "message": "not allowed"},
        },
    )
    failed = _read(process)
    assert failed["result"]["cell"]["error_type"] == "HostCallbackError"
    assert "DENIED" in failed["result"]["cell"]["error_message"]

    _write(
        process,
        {"id": "no-cap", "method": "execute", "source": "await runtime.tools.list()"},
    )
    no_cap = _read(process)
    assert no_cap["id"] == "no-cap"
    assert no_cap["result"]["cell"]["error_type"] == "UnsupportedOperationError"

    _write(
        process,
        {
            "id": "create-background",
            "method": "execute",
            "capabilities": ["host-callback-v1"],
            "source": (
                "import asyncio\n"
                "gate = asyncio.Event()\n"
                "async def later():\n"
                "    await gate.wait()\n"
                "    return await runtime.tools.list()\n"
                "background = asyncio.create_task(later())"
            ),
        },
    )
    assert _read(process)["id"] == "create-background"
    _write(
        process,
        {
            "id": "release-background",
            "method": "execute",
            "capabilities": ["host-callback-v1"],
            "source": "gate.set()\nawait asyncio.sleep(0)\nawait background",
        },
    )
    post_cell = _read(process)
    assert post_cell["id"] == "release-background"
    assert post_cell["result"]["cell"]["error_type"] == "UnsupportedOperationError"
    _close(process)


def test_eof_during_callback_marks_run_interrupted(tmp_path: Path) -> None:
    session_dir = tmp_path / "session"
    process = _start(session_dir)
    _write(
        process,
        {
            "id": "waiting",
            "method": "execute",
            "capabilities": ["host-callback-v1"],
            "source": "await runtime.tools.list()",
        },
    )
    assert _read(process)["kind"] == "callback"
    assert process.stdin is not None
    process.stdin.close()
    assert process.wait(timeout=10) == 0
    marker = json.loads((session_dir / "dirty-run").read_text())
    assert marker["state"] == "interrupted"

    resumed = _start(session_dir)
    _write(resumed, {"id": "recover", "method": "execute", "source": "42"})
    response = _read(resumed)
    assert "Previous run was interrupted" in response["result"]["recovery_notice"]
    _close(resumed)


def test_pending_background_callback_is_revoked_at_cell_end(tmp_path: Path) -> None:
    process = _start(tmp_path / "session")
    _write(
        process,
        {
            "id": "background",
            "method": "execute",
            "capabilities": ["host-callback-v1"],
            "source": (
                "import asyncio\n"
                "pending = asyncio.create_task(runtime.tools.list())\n"
                "await asyncio.sleep(0)"
            ),
        },
    )
    callback = _read(process)
    response = _read(process)
    assert callback["kind"] == "callback"
    assert response["id"] == "background"
    assert response["result"]["cell"]["ok"] is True

    # A late result for the revoked callback is an allowed tombstone, not a
    # response that can leak into the next execute request.
    _write(
        process,
        {
            "kind": "callback_result",
            "id": callback["id"],
            "ok": True,
            "result": [],
        },
    )
    _write(process, {"id": "next", "method": "execute", "source": "6 * 7"})
    assert _read(process)["id"] == "next"
    _close(process)


@pytest.mark.asyncio
async def test_standalone_runtime_callbacks_are_clearly_unsupported() -> None:
    runtime = Runtime()
    with pytest.raises(UnsupportedOperationError, match="host-callback-v1"):
        await runtime.tools.list()
    with pytest.raises(UnsupportedOperationError, match="host-callback-v1"):
        await runtime.models.complete("hello")
    with pytest.raises(UnsupportedOperationError, match="not callable"):
        await runtime.tools.call("execute_python")
    with pytest.raises(ValueError, match="together"):
        await runtime.models.complete("hello", provider="only")
    await runtime.close()
