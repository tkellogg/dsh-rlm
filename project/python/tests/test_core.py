import asyncio

import dill
import pytest
from pydantic import BaseModel, field_validator

from dsh_rlm import (
    MailboxClosedError,
    MailboxConfig,
    MailboxFullError,
    MailboxInUseError,
    MailboxNotFoundError,
    MessageValidationError,
    NoParentError,
    PermissionDeniedError,
    Runtime,
    RuntimeUnavailableError,
    UnsupportedDeliveryModeError,
    current_runtime,
)


async def send_as(runtime, body, **kwargs):
    async with runtime.bind():
        return await runtime.send(body, **kwargs)


@pytest.mark.asyncio
async def test_current_runtime_is_task_local_and_spawn_does_not_wait_for_receive():
    with pytest.raises(RuntimeUnavailableError):
        current_runtime()
    root = Runtime()
    started = asyncio.Event()
    release = asyncio.Event()

    async def child(rt):
        started.set()
        message = await rt.mailbox.receive()
        await release.wait()
        assert current_runtime() is rt
        return message.body

    handle = await root.spawn(child, mailbox=MailboxConfig(message_type=str))
    assert isinstance(handle.task, asyncio.Task)
    await started.wait()
    await send_as(root, "hello", to=handle.mailbox)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(handle.task), 0)
    release.set()
    assert await asyncio.wait_for(handle.task, 1) == "hello"
    await root.close()


@pytest.mark.asyncio
async def test_native_cancellation_and_shielding():
    root = Runtime()
    entered = asyncio.Event()
    unblock = asyncio.Event()

    async def worker(rt):
        entered.set()
        await unblock.wait()
        return 4

    handle = await root.spawn(worker)
    await entered.wait()
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(handle.task), 0)
    assert not handle.task.done()
    unblock.set()
    assert await handle.task == 4

    handle2 = await root.spawn(worker)
    handle2.task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await handle2.task
    await root.close()


@pytest.mark.asyncio
async def test_typed_untyped_copy_full_dead_and_modes():
    root = Runtime()
    mailbox = await root.mailboxes.create(config=MailboxConfig(capacity=1))
    payload = {"items": [1]}
    await send_as(root, payload, to=mailbox)
    payload["items"].append(2)
    async with root:
        assert mailbox.receive_nowait().body == {"items": [1]}
    # Re-entering a runtime after its context exits is intentionally not
    # supported; use a fresh runtime for the remainder of this mailbox test.
    root = Runtime()
    mailbox = await root.mailboxes.create(config=MailboxConfig(capacity=1))
    await send_as(root, "x", to=mailbox)
    with pytest.raises(MailboxFullError):
        await send_as(root, "y", to=mailbox)
    async with root:
        assert mailbox.receive_nowait().body == "x"
        await mailbox.close()
        with pytest.raises(MailboxClosedError):
            mailbox.receive_nowait()
    root = Runtime()
    typed = await root.mailboxes.create(config=MailboxConfig(message_type=str))
    with pytest.raises(MessageValidationError):
        await send_as(root, 4, to=typed)
    with pytest.raises(UnsupportedDeliveryModeError):
        await send_as(root, "ok", to=typed, mode="steer")
    await root.close()


class Question(BaseModel):
    text: str
    count: int


@pytest.mark.asyncio
async def test_pydantic_typed_boundary_is_strict():
    root = Runtime()
    mailbox = await root.mailboxes.create(config=MailboxConfig(message_type=Question))
    await send_as(root, {"text": "hi", "count": 2}, to=mailbox)
    async with root:
        msg = mailbox.receive_nowait()
        assert isinstance(msg.body, Question)
        assert msg.body.count == 2
        with pytest.raises(MessageValidationError):
            await send_as(root, {"text": "bad", "count": "2"}, to=mailbox)


@pytest.mark.asyncio
async def test_receive_close_and_cancel_races():
    root = Runtime()
    mailbox = await root.mailboxes.create()
    async with root:
        waiting = asyncio.create_task(mailbox.receive())
        await asyncio.sleep(0)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        await send_as(root, {"after": "cancel"}, to=mailbox)
        assert mailbox.receive_nowait().body == {"after": "cancel"}
        waiting2 = asyncio.create_task(mailbox.receive())
        await asyncio.sleep(0)
        await mailbox.close()
        with pytest.raises(MailboxClosedError):
            await waiting2
    await root.close()


@pytest.mark.asyncio
async def test_cancel_after_wakeup_does_not_lose_message():
    root = Runtime()
    mailbox = await root.mailboxes.create()
    async with root:
        receiving = asyncio.create_task(mailbox.receive())
        await asyncio.sleep(0)
        # Admission wakes the receive task but its continuation has not run.
        await send_as(root, "kept", to=mailbox)
        receiving.cancel()
        with pytest.raises(asyncio.CancelledError):
            await receiving
        assert mailbox.receive_nowait().body == "kept"


@pytest.mark.asyncio
async def test_cancelled_woken_reader_releases_message_to_competitor():
    root = Runtime()
    mailbox = await root.mailboxes.create()
    async with root:
        first = asyncio.create_task(mailbox.receive())
        second = asyncio.create_task(mailbox.receive())
        await asyncio.sleep(0)
        await send_as(root, "handoff", to=mailbox)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert (await second).body == "handoff"


@pytest.mark.asyncio
async def test_rlm_driver_mailbox_is_locked_but_auxiliary_receives():
    runtime = Runtime(rlm=True)
    async with runtime:
        with pytest.raises(MailboxInUseError):
            runtime.mailbox.receive_nowait()
        with pytest.raises(MailboxInUseError):
            await runtime.mailbox.receive()
        aux = await runtime.mailboxes.create()
        await runtime.send("ordinary", to=aux)
        assert (await aux.receive()).body == "ordinary"


@pytest.mark.asyncio
async def test_completed_children_and_mailboxes_are_unregistered():
    root = Runtime()
    baseline_mailboxes = len(root._state.registry._mailboxes)
    for _ in range(24):

        async def child(rt):
            extra = await rt.mailboxes.create()
            return extra.id

        handle = await root.spawn(child)
        await handle.task
    await asyncio.sleep(0)
    assert not root._children
    assert len(root._state.registry._mailboxes) == baseline_mailboxes
    await root.close()


@pytest.mark.asyncio
async def test_parent_close_requests_child_cancellation():
    root = Runtime()
    started = asyncio.Event()

    async def child(rt):
        started.set()
        await asyncio.Event().wait()

    handle = await root.spawn(child)
    await started.wait()
    await root.close()
    with pytest.raises(asyncio.CancelledError):
        await handle.task


@pytest.mark.asyncio
async def test_mailbox_ref_send_requires_bound_sender_runtime():
    root = Runtime()
    mailbox = await root.mailboxes.create()
    with pytest.raises(RuntimeUnavailableError):
        await mailbox.send("outside")
    await root.close()


@pytest.mark.asyncio
async def test_parent_default_send_and_no_parent():
    root = Runtime()
    with pytest.raises(NoParentError):
        await send_as(root, "no parent")

    async def child(rt):
        await rt.send("reply")

    handle = await root.spawn(child)
    async with root:
        message = await root.mailbox.receive()
    assert message.body == "reply"
    await handle.task
    await root.close()


@pytest.mark.asyncio
async def test_runtime_bind_is_scoped_and_does_not_close_runtime():
    root = Runtime()
    with pytest.raises(RuntimeUnavailableError):
        current_runtime()
    async with root.bind():
        assert current_runtime() is root
    with pytest.raises(RuntimeUnavailableError):
        current_runtime()
    assert not root.closed
    await root.close()


@pytest.mark.asyncio
async def test_explicit_mailbox_close_unregisters_backend():
    root = Runtime()
    async with root.bind():
        mailbox = await root.mailboxes.create()
        address = mailbox.id
        await mailbox.close()
        assert mailbox not in root._owned_mailboxes
        with pytest.raises(MailboxNotFoundError):
            await root.mailboxes.get(address)
    assert set(root._state.registry._mailboxes) == {root.mailbox.id}
    await root.close()


@pytest.mark.asyncio
async def test_closed_runtime_cannot_create_orphan_mailbox():
    root = Runtime()
    await root.close()
    with pytest.raises(MailboxClosedError):
        await root.mailboxes.create()


@pytest.mark.asyncio
async def test_runtime_send_cannot_spoof_another_runtime():
    root = Runtime()
    child_ready = asyncio.Event()

    async def child(runtime):
        child_ready.set()
        with pytest.raises(PermissionDeniedError):
            await root.send("spoof", to=runtime.mailbox)

    handle = await root.spawn(child)
    await child_ready.wait()
    await handle.task
    await root.close()


@pytest.mark.asyncio
async def test_receive_zero_timeout_uses_immediate_queue_state():
    root = Runtime()
    mailbox = await root.mailboxes.create()
    await send_as(root, "ready", to=mailbox)
    async with root.bind():
        assert (await mailbox.receive(timeout=0)).body == "ready"
        with pytest.raises(TimeoutError):
            await mailbox.receive(timeout=0)
    await root.close()


def test_custom_pydantic_validators_are_rejected_at_registration():
    class UnsafeMessage(BaseModel):
        value: int

        @field_validator("value")
        @classmethod
        def mutate(cls, value: int) -> int:
            return value + 1

    with pytest.raises(TypeError, match="validators"):
        MailboxConfig(message_type=UnsafeMessage)


@pytest.mark.asyncio
async def test_runtime_context_rejects_nested_entry_without_leaking_binding():
    root = Runtime()
    async with root:
        assert current_runtime() is root
        with pytest.raises(RuntimeError, match="already entered"):
            async with root:
                pass
    with pytest.raises(RuntimeUnavailableError):
        current_runtime()


@pytest.mark.asyncio
async def test_deserialized_runtime_and_mailbox_are_not_authoritative():
    original = Runtime()
    ghost_runtime, ghost_mailbox = dill.loads(
        dill.dumps((original, original.mailbox), recurse=True)
    )
    sender = Runtime()
    with pytest.raises(MailboxClosedError):
        async with ghost_runtime.bind():
            pass
    async with sender.bind():
        with pytest.raises(MailboxClosedError):
            await ghost_mailbox.send("ghost")
    await original.close()
    await sender.close()
