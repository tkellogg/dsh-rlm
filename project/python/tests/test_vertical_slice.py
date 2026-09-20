"""Small end-to-end composition checks for LocalKernel."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from dsh_rlm.kernel import LocalKernel


@pytest.mark.asyncio
async def test_vertical_slice_keeps_repl_and_runtime_alive_between_cells(
    tmp_path: Path,
) -> None:
    async with LocalKernel(tmp_path) as kernel:
        created = await kernel.execute(
            """
import asyncio

async def child(rt):
    await asyncio.sleep(0.01)
    return 7

handle = await runtime.spawn(child)
"""
        )
        assert created.ok
        assert kernel.repl.globals["runtime"] is kernel.runtime
        await asyncio.sleep(0.02)
        observed = await kernel.execute("await handle.task")
        assert observed.value == 7
        assert observed.ok

    resumed = LocalKernel(tmp_path)
    assert "handle" not in resumed.repl.globals
    assert resumed.repl.globals["runtime"] is resumed.runtime
    notice = resumed.take_recovery_notice()
    assert notice is not None
    assert "handles are invalid" in notice
    await resumed.close()
