import pytest

from dsh_rlm.runtime import Runtime


@pytest.mark.asyncio
async def test_driver_send_requires_active_lease_and_acknowledges_host_admission():
    root = Runtime(rlm=True)
    child = Runtime(parent=root.ref, rlm=False, _state=root._state, _parent_runtime=root)
    calls = []

    async def callback(parent_id, method, params):
        calls.append((parent_id, method, params))
        return {"message_id": "host-message", "accepted_at": "2026-04-10T00:00:00Z"}

    async with child.bind():
        async with root._bind_host_callbacks("cell-1", callback):
            receipt = await child.send({"reply": "done"}, to=root.mailbox, mode="followup")
    assert receipt.message_id == "host-message"
    assert receipt.mailbox_id == root.mailbox.id
    assert calls == [("cell-1", "mailbox.delivery", {
        "body": {"reply": "done"}, "mode": "followup",
        "mailbox_id": root.mailbox.id, "capacity": root.mailbox.config.capacity,
    })]
    assert list(root.mailbox._queue) == []
    await child.close()
    await root.close()


@pytest.mark.asyncio
async def test_driver_send_outside_active_lease_rejects_without_local_queue():
    root = Runtime(rlm=True)
    child = Runtime(parent=root.ref, rlm=False, _state=root._state, _parent_runtime=root)
    async with child.bind():
        with pytest.raises(NotImplementedError, match="active bridge execute cell"):
            await child.send("reply", to=root.mailbox)
    assert list(root.mailbox._queue) == []
    await child.close()
    await root.close()

@pytest.mark.asyncio
async def test_nested_or_cross_driver_destination_rejects_before_callback():
    first = Runtime(rlm=True, _driver_mailbox_id="driver-one")
    second = Runtime(rlm=True, _driver_mailbox_id="driver-two")
    child = Runtime(parent=first.ref, rlm=False, _state=first._state, _parent_runtime=first)
    called = False

    async def callback(parent_id, method, params):
        nonlocal called
        called = True
        return {"message_id": "wrong", "accepted_at": "2026-04-10T00:00:00Z"}

    # Simulate a forged nested destination object sharing the active state.
    second.mailbox._owner_runtime._state = first._state
    async with child.bind():
        async with first._bind_host_callbacks("cell", callback):
            with pytest.raises(PermissionError, match="does not match"):
                await second.mailbox.send("cross-driver")
    assert called is False
    await child.close()
    await first.close()
    await second.close()


@pytest.mark.asyncio
async def test_callback_parent_is_fixed_by_active_lease():
    root = Runtime(rlm=True, _driver_mailbox_id="driver")
    child = Runtime(parent=root.ref, rlm=False, _state=root._state, _parent_runtime=root)
    parents = []

    async def callback(parent_id, method, params):
        parents.append(parent_id)
        return {"message_id": "accepted", "accepted_at": "2026-04-10T00:00:00Z"}

    async with child.bind():
        async with root._bind_host_callbacks("trusted-parent", callback):
            await child.send("reply", to=root.mailbox)
    assert parents == ["trusted-parent"]
    await child.close()
    await root.close()


@pytest.mark.asyncio
async def test_timeout_after_possible_admission_is_not_retried():
    root = Runtime(rlm=True, _driver_mailbox_id="driver")
    child = Runtime(parent=root.ref, rlm=False, _state=root._state, _parent_runtime=root)
    calls = 0

    async def lost_ack(parent_id, method, params):
        nonlocal calls
        calls += 1  # host may already have synchronously admitted here
        await __import__("asyncio").sleep(1)

    async with child.bind():
        async with root._bind_host_callbacks("cell", lost_ack):
            with pytest.raises(TimeoutError):
                await child.send("ambiguous", to=root.mailbox, timeout=0.001)
    assert calls == 1
    await child.close()
    await root.close()
