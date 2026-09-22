from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest


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


def _send(process: subprocess.Popen[str], request: dict[str, Any]) -> dict[str, Any]:
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    line = process.stdout.readline()
    assert line, process.stderr.read() if process.stderr is not None else ""
    return json.loads(line)


def _close(process: subprocess.Popen[str]) -> dict[str, Any]:
    response = _send(process, {"id": "close", "method": "close"})
    assert process.wait(timeout=10) == 0
    return response


def test_execute_persists_namespace_and_returns_checkpoint(tmp_path: Path) -> None:
    process = _start(tmp_path / "session")
    first = _send(
        process,
        {"id": "one", "method": "execute", "source": "value = 40\nprint('set')"},
    )
    second = _send(
        process,
        {"id": "two", "method": "execute", "source": "value + 2"},
    )

    assert first["id"] == "one"
    assert first["ok"] is True
    assert first["result"]["cell"]["stdout"] == "set\n"
    assert first["result"]["cell"]["display"] is None
    assert first["result"]["checkpoint"]["ok"] is True
    assert "value" in first["result"]["checkpoint"]["saved"]
    assert first["result"]["recovery_notice"] is None
    assert second["result"]["cell"]["display"] == "42"
    assert second["result"]["recovery_notice"] is None
    assert _close(process) == {"id": "close", "ok": True, "result": {"closed": True}}


def test_background_tasks_run_while_bridge_waits_for_stdin(tmp_path: Path) -> None:
    process = _start(tmp_path / "session")
    created = _send(
        process,
        {
            "id": "create",
            "method": "execute",
            "source": (
                "import asyncio\n"
                "done = False\n"
                "async def finish():\n"
                "    global done\n"
                "    await asyncio.sleep(0.05)\n"
                "    done = True\n"
                "    print('late output')\n"
                "task = asyncio.create_task(finish())"
            ),
        },
    )
    assert created["ok"] is True
    checked = _send(
        process,
        {
            "id": "check",
            "method": "execute",
            "source": "await asyncio.sleep(0.1)\ndone",
        },
    )
    assert checked["result"]["cell"]["display"] == "True"
    assert _close(process)["ok"] is True


def test_raw_fd_one_write_cannot_corrupt_protocol_stdout(tmp_path: Path) -> None:
    process = _start(tmp_path / "session")
    response = _send(
        process,
        {
            "id": "raw-write",
            "method": "execute",
            "source": "import os\nos.write(1, b'raw\\n')\n42",
        },
    )

    assert response["id"] == "raw-write"
    assert response["result"]["cell"]["display"] == "42"
    assert _close(process)["ok"] is True


def test_malformed_request_does_not_crash_bridge(tmp_path: Path) -> None:
    process = _start(tmp_path / "session")
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write("{not json}\n")
    process.stdin.flush()
    malformed = json.loads(process.stdout.readline())
    assert malformed == {
        "id": None,
        "ok": False,
        "error": {"code": "INVALID_JSON", "message": "request must be one JSON object"},
    }

    valid = _send(process, {"id": "still-live", "method": "execute", "source": "6 * 7"})
    assert valid["result"]["cell"]["display"] == "42"
    assert _close(process)["ok"] is True


def test_cell_failure_is_a_successful_protocol_response(tmp_path: Path) -> None:
    process = _start(tmp_path / "session")
    response = _send(
        process,
        {"id": "bad-cell", "method": "execute", "source": "raise ValueError('bad')"},
    )
    cell = response["result"]["cell"]
    assert response["ok"] is True
    assert cell["ok"] is False
    assert cell["error_type"] == "ValueError"
    assert cell["error_message"] == "bad"
    assert "ValueError: bad" in cell["traceback"]
    assert response["result"]["checkpoint"] is None
    assert _close(process)["ok"] is True


@pytest.mark.skipif(not hasattr(__import__("os"), "_exit"), reason="requires os._exit")
def test_abrupt_exit_restores_checkpoint_and_reports_once(tmp_path: Path) -> None:
    session_dir = tmp_path / "session"
    first = _start(session_dir)
    saved = _send(
        first,
        {"id": "save", "method": "execute", "source": "durable = 42"},
    )
    assert saved["result"]["checkpoint"]["ok"] is True

    assert first.stdin is not None
    first.stdin.write(
        json.dumps(
            {"id": "exit", "method": "execute", "source": "import os; os._exit(17)"}
        )
        + "\n"
    )
    first.stdin.flush()
    assert first.wait(timeout=10) == 17

    restarted = _start(session_dir)
    recovered = _send(
        restarted,
        {
            "id": "recover",
            "method": "execute",
            "source": "should_not_run = True\ndurable",
        },
    )
    gate = recovered["result"]
    assert gate["execution"] == {"status": "not_executed", "reason": "recovery_gate"}
    assert gate["cell"] is None
    assert gate["checkpoint"] is None
    notice = gate["recovery_notice"]
    assert notice is not None
    assert "submitted cell was not executed" not in notice
    assert "runtime.recovery" in notice
    assert "should_not_run" not in recovered["result"]

    next_response = _send(
        restarted,
        {
            "id": "once",
            "method": "execute",
            "source": "('should_not_run' in globals(), durable + 1)",
        },
    )
    assert next_response["result"]["execution"] == {"status": "executed", "reason": None}
    assert next_response["result"]["cell"]["display"] == "(False, 43)"
    assert next_response["result"]["recovery_notice"] is None
    assert _close(restarted)["ok"] is True
