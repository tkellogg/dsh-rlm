import pytest

from dsh_rlm.inspection import (
    LiveValueRecord,
    ManagedLiveTaskRecord,
    TerminalRecordStore,
    page_live_values,
    page_managed_live_tasks,
)


def add(store, task_id, state="completed", message=None):
    return store.append(
        task_id=task_id,
        parent_id="parent",
        name=task_id,
        state=state,
        started_at="2026-04-10T00:00:00+00:00",
        finished_at="2026-04-10T00:00:01+00:00",
        error_type="Problem" if message else None,
        error_message=message,
    )


def test_terminal_store_is_bounded_and_reports_eviction():
    store = TerminalRecordStore(capacity=2)
    add(store, "one")
    add(store, "two", "cancelled")
    add(store, "three", "failed", "bad")
    page = store.inspect()
    assert [item.task_id for item in page.items] == ["two", "three"]
    assert (page.oldest_sequence, page.newest_sequence) == (2, 3)
    assert page.evicted_through == 1


def test_inspection_does_not_observe_failure_but_explicit_hook_does():
    store = TerminalRecordStore()
    record = add(store, "failed", "failed", "boom")
    assert store.inspect().items[0].observed is False
    assert store.inspect().items[0].observed is False
    assert store.mark_observed(record.sequence) is True
    assert store.inspect().items[0].observed is True


def test_records_are_immutable_and_error_text_is_bounded():
    store = TerminalRecordStore()
    record = add(store, "failed", "failed", "x" * 1000)
    assert len(record.error_message) == 512
    with pytest.raises((AttributeError, TypeError)):
        record.observed = True


def test_page_filter_metadata_and_limits():
    store = TerminalRecordStore()
    for name in ("a", "b", "c"):
        add(store, name)
    page = store.inspect(after=1, limit=1)
    assert [item.task_id for item in page.items] == ["b"]
    assert page.total == 2 and page.truncated
    with pytest.raises(ValueError):
        store.inspect(limit=201)


def test_live_value_paging_is_sorted_and_metadata_only():
    values = [
        LiveValueRecord("z", "object", False),
        LiveValueRecord("a", "int", True),
        LiveValueRecord("h", "Handle", False, snapshot_exclusion_reason="runtime handle"),
    ]
    page = page_live_values(values, offset=1, limit=1)
    assert page.items == (values[2],)
    assert page.total == 3 and page.returned == 1 and page.truncated


@pytest.mark.asyncio
async def test_kernel_runtime_provider_distinguishes_membership_from_value_match(tmp_path):
    from dsh_rlm.kernel import LocalKernel

    kernel = LocalKernel(tmp_path)
    await kernel.execute("value = 1")
    first = kernel.runtime.inspection.state()
    assert first.durable is not None
    assert first.durable.checkpoint_id
    value = next(item for item in first.live.items if item.name == "value")
    assert value.snapshot_contains_name is True
    assert value.current_value_matches_snapshot == "unknown"
    # Mutating the live object/name cannot be claimed equal to its old snapshot.
    kernel.repl.globals["value"] = 2
    second = kernel.runtime.inspection.state()
    value = next(item for item in second.live.items if item.name == "value")
    assert value.snapshot_contains_name is True
    assert value.current_value_matches_snapshot == "unknown"
    await kernel.close()


@pytest.mark.asyncio
async def test_repl_task_inspection_does_not_retrieve_exception():
    import asyncio
    from dsh_rlm.repl import PersistentREPL

    repl = PersistentREPL()
    release = asyncio.Event()
    repl.globals.update({"release": release, "asyncio": asyncio})
    result = await repl.execute("task = asyncio.create_task(release.wait())")
    assert result.ok
    page = repl.inspect_tasks()
    assert page.returned == 1
    assert page.items[0].state == "running"
    release.set()
    await repl.globals["task"]


def test_managed_live_tasks_are_owner_filtered_immutable_and_bounded():
    tasks = [
        ManagedLiveTaskRecord("b", "owner", "second", "running", "t2"),
        ManagedLiveTaskRecord("a", "owner", "first", "starting", "t1"),
        ManagedLiveTaskRecord("foreign", "other", "hidden", "stopping", "t0"),
    ]
    page = page_managed_live_tasks(tasks, owner_id="owner", limit=1)
    assert page.items == (tasks[1],)
    assert page.total == 2 and page.returned == 1 and page.truncated
    with pytest.raises((AttributeError, TypeError)):
        page.items[0].state = "stopping"


def test_managed_live_builder_validates_bounds_and_owner():
    with pytest.raises(ValueError):
        page_managed_live_tasks([], owner_id="")
    with pytest.raises(ValueError):
        page_managed_live_tasks([], owner_id="owner", limit=201)


def test_terminal_owner_filter_precedes_paging_and_preserves_full_identities():
    store = TerminalRecordStore(capacity=256)
    owner = "owner-" + "o" * 1000
    own = store.append(task_id="task-" + "t" * 1000, parent_id=owner, name="n" * 1000, state="completed", started_at="s", finished_at="f")
    for index in range(255):
        store.append(task_id=f"foreign-{index}", parent_id="foreign", name=None, state="completed", started_at="s", finished_at="f")
    page = store.inspect(owner_id=owner)
    assert page.items == (own,) and page.items[0].parent_id == owner
    assert len(page.items[0].name) == 512


def test_terminal_inspection_validates_cursors():
    store = TerminalRecordStore()
    for kwargs in ({"offset": -1}, {"limit": 0}, {"after": -1}, {"after": True}, {"owner_id": ""}):
        with pytest.raises(ValueError):
            store.inspect(**kwargs)


@pytest.mark.asyncio
async def test_runtime_live_then_terminal_and_prestart_cancel():
    import asyncio
    from dsh_rlm.runtime import Runtime
    root = Runtime()
    gate = asyncio.Event()
    async def child(rt):
        await gate.wait()
    handle = await root.spawn(child, name="live")
    assert root.inspect_live_tasks().items[0].task_id == handle.id
    gate.set(); await handle.task
    assert root.inspect_live_tasks().total == 0
    assert root.inspect_tasks().items[-1].state == "completed"
    blocked = asyncio.Event()
    async def never(rt): await blocked.wait()
    cancelled = await root.spawn(never)
    cancelled.task.cancel()
    with pytest.raises(asyncio.CancelledError): await cancelled.task
    await asyncio.sleep(0)
    assert root.inspect_tasks().items[-1].state == "cancelled"
    await root.close()


@pytest.mark.asyncio
async def test_hostile_exception_metadata_does_not_replace_original():
    import asyncio
    from dsh_rlm.runtime import Runtime
    class Hostile(Exception):
        def __getattribute__(self, name):
            if name in {"args", "__class__"}: raise RuntimeError("metadata trap")
            return super().__getattribute__(name)
    root = Runtime()
    original = Hostile("original")
    async def fail(rt): raise original
    handle = await root.spawn(fail)
    with pytest.raises(Hostile) as caught: await handle.task
    assert caught.value is original
    assert root.inspect_tasks().items[0].state == "failed"
    await root.close()


@pytest.mark.asyncio
async def test_state_inspection_rejects_closed_kernel_and_bounds_names(tmp_path):
    from dsh_rlm.kernel import LocalKernel
    kernel = LocalKernel(tmp_path)
    kernel.repl.globals["x" * 1_000_000] = 1
    state = kernel.inspect_state(limit=10)
    assert max(map(len, (item.name for item in state.live.items))) <= 512
    await kernel.close()
    with pytest.raises(RuntimeError): kernel.runtime.inspection.state()


@pytest.mark.asyncio
async def test_live_task_name_and_checkpoint_attempt_error_are_bounded(tmp_path):
    import asyncio
    from dsh_rlm.checkpoint import CheckpointReport
    from dsh_rlm.kernel import LocalKernel
    from dsh_rlm.runtime import Runtime

    root = Runtime()
    gate = asyncio.Event()
    async def child(rt): await gate.wait()
    handle = await root.spawn(child, name="n" * 1_000_000)
    live = root.inspect_live_tasks().items[0]
    assert len(live.name) == 512 and live.name.endswith("…")
    assert live.task_id == handle.id
    gate.set(); await handle.task; await root.close()

    kernel = LocalKernel(tmp_path)
    kernel.last_checkpoint = CheckpointReport(error="e" * 1_000_000)
    attempt = kernel.inspect_state().last_attempt
    assert attempt is not None and len(attempt.error) == 512
    assert attempt.error.endswith("…")
    await kernel.close()
