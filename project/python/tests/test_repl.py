import asyncio
import linecache
import subprocess
import sys

import pytest

from dsh_rlm.repl import CellResult, PersistentREPL


@pytest.mark.asyncio
async def test_state_persists_between_cells() -> None:
    repl = PersistentREPL()

    first = await repl.execute("counter = 40")
    second = await repl.execute("counter + 2")

    assert first.ok
    assert second.ok
    assert second.value == 42
    assert repl.globals["counter"] == 40


@pytest.mark.asyncio
async def test_top_level_await_runs_on_caller_loop() -> None:
    repl = PersistentREPL()

    result = await repl.execute(
        "import asyncio\nawait asyncio.sleep(0)\nanswer = 7\nanswer"
    )

    assert result.ok
    assert result.value == 7
    assert result.display == "7"


@pytest.mark.asyncio
async def test_trailing_expression_is_displayed_separately() -> None:
    repl = PersistentREPL()

    result = await repl.execute("print('before')\n{'answer': 42}")

    assert result.ok
    assert result.stdout == "before\n"
    assert result.value == {"answer": 42}
    assert result.display == "{'answer': 42}"


@pytest.mark.asyncio
async def test_output_and_write_count_are_bounded() -> None:
    repl = PersistentREPL(max_output_chars=24)

    result = await repl.execute(
        "import sys\n"
        "count = sys.stdout.write('x' * 100)\n"
        "print('e' * 100, file=sys.stderr)\n"
        "count"
    )

    assert result.ok
    assert result.value == 100
    assert len(result.stdout) == 24
    assert len(result.stderr) == 24
    assert "... [truncated]" in result.stdout
    assert "... [truncated]" in result.stderr


class _HugeRepr:
    def __repr__(self) -> str:
        return "r" * 1000


@pytest.mark.asyncio
async def test_trailing_repr_and_error_traceback_are_bounded() -> None:
    repl = PersistentREPL({"HugeRepr": _HugeRepr}, max_output_chars=32)

    display = await repl.execute("HugeRepr()")
    error = await repl.execute("raise RuntimeError('e' * 1000)")

    assert display.ok
    assert display.display is not None
    assert display.display == "<test_repl._HugeRepr object>"
    assert not error.ok
    assert error.traceback is not None
    assert len(error.traceback) == 32
    assert "... [truncated]" in error.traceback


@pytest.mark.parametrize("limit", [0, -1, False, 1.5, float("inf"), "10"])
def test_invalid_output_limits_are_rejected(limit: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        PersistentREPL(max_output_chars=limit)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_exceptions_are_error_records() -> None:
    repl = PersistentREPL()

    result = await repl.execute("raise ValueError('broken')")

    assert isinstance(result, CellResult)
    assert not result.ok
    assert isinstance(result.error, ValueError)
    assert result.traceback is not None
    assert "ValueError: broken" in result.traceback


@pytest.mark.asyncio
async def test_background_task_progresses_between_calls() -> None:
    repl = PersistentREPL()

    started = await repl.execute(
        "import asyncio\n"
        "progress = []\n"
        "async def worker():\n"
        "    await asyncio.sleep(0.01)\n"
        "    progress.append('done')\n"
        "background = asyncio.create_task(worker())\n"
        "None"
    )
    await asyncio.sleep(0.03)
    observed = await repl.execute("progress")

    assert started.ok
    assert observed.ok
    assert observed.value == ["done"]
    await repl.globals["background"]


@pytest.mark.asyncio
async def test_syntax_error_is_an_error_record() -> None:
    repl = PersistentREPL()

    result = await repl.execute("if True print('missing colon')")

    assert isinstance(result.error, SyntaxError)
    assert result.traceback is not None
    assert "SyntaxError" in result.traceback


@pytest.mark.asyncio
async def test_concurrent_cells_on_one_repl_are_serialized() -> None:
    repl = PersistentREPL()
    await repl.execute("import asyncio\nevents = []")

    first = asyncio.create_task(
        repl.execute(
            "events.append('first-start')\n"
            "await asyncio.sleep(0.01)\n"
            "events.append('first-end')\n"
            "None"
        )
    )
    await asyncio.sleep(0)
    second = asyncio.create_task(repl.execute("events.append('second')\nNone"))
    await asyncio.gather(first, second)

    assert repl.globals["events"] == ["first-start", "first-end", "second"]


@pytest.mark.asyncio
async def test_concurrent_repls_do_not_cross_capture_output() -> None:
    left = PersistentREPL()
    installed_stream = sys.stdout
    right = PersistentREPL()
    assert sys.stdout is installed_stream

    left_result, right_result = await asyncio.gather(
        left.execute(
            "import asyncio\n"
            "print('left-start')\n"
            "await asyncio.sleep(0.01)\n"
            "print('left-end')\n"
            "None"
        ),
        right.execute(
            "import asyncio\n"
            "print('right-start')\n"
            "await asyncio.sleep(0.01)\n"
            "print('right-end')\n"
            "None"
        ),
    )

    assert left_result.stdout == "left-start\nleft-end\n"
    assert right_result.stdout == "right-start\nright-end\n"


@pytest.mark.asyncio
async def test_background_output_is_not_captured_by_a_later_cell() -> None:
    repl = PersistentREPL()

    await repl.execute(
        "import asyncio\n"
        "async def later():\n"
        "    await asyncio.sleep(0)\n"
        "    print('background-output')\n"
        "task = asyncio.create_task(later())\n"
        "None"
    )
    await asyncio.sleep(0.01)
    later_result = await repl.execute("None")
    await repl.globals["task"]

    assert later_result.stdout == ""


def test_package_import_does_not_replace_process_streams() -> None:
    script = (
        "import sys\n"
        "stdout, stderr = sys.stdout, sys.stderr\n"
        "import dsh_rlm\n"
        "assert sys.stdout is stdout and sys.stderr is stderr\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=False
    )
    assert completed.returncode == 0, completed.stderr


@pytest.mark.asyncio
async def test_system_exit_is_a_cell_error_not_a_host_exit() -> None:
    repl = PersistentREPL()
    result = await repl.execute("raise SystemExit(7)")
    assert not result.ok
    assert isinstance(result.error, SystemExit)
    assert "SystemExit: 7" in result.traceback


@pytest.mark.asyncio
async def test_same_repl_recursive_execute_fails_instead_of_deadlocking() -> None:
    repl = PersistentREPL()
    repl.globals["repl"] = repl
    result = await asyncio.wait_for(repl.execute("await repl.execute('1')"), 1)
    assert not result.ok
    assert isinstance(result.error, RuntimeError)
    assert "recursive execute" in str(result.error)


@pytest.mark.asyncio
async def test_future_flags_persist_between_cells() -> None:
    repl = PersistentREPL()
    assert (await repl.execute("from __future__ import annotations")).ok
    result = await repl.execute("def f(value: Missing):\n    return value")
    assert result.ok
    assert repl.globals["f"].__annotations__["value"] == "Missing"


@pytest.mark.asyncio
async def test_linecache_is_bounded_per_repl() -> None:
    repl = PersistentREPL()
    for number in range(140):
        assert (await repl.execute(f"value = {number}")).ok
    prefix = f"<repl-{id(repl):x}-"
    assert sum(name.startswith(prefix) for name in linecache.cache) <= 128


@pytest.mark.asyncio
async def test_captured_stream_has_text_and_binary_attributes() -> None:
    repl = PersistentREPL()
    result = await repl.execute(
        "import sys\nprint(sys.stdout.encoding)\nsys.stdout.buffer.write(b'binary\\n')"
    )
    assert result.ok
    assert result.stdout == "utf-8\nbinary\n"
