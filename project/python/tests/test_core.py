import asyncio

import dill
import pytest
from pydantic import AliasChoices, AliasPath, BaseModel, ConfigDict, Field, field_validator

from dsh_rlm import (
    AgentHandle,
    MailboxClosedError,
    MailboxConfig,
    MailboxFullError,
    MailboxInUseError,
    MailboxNotFoundError,
    MessageValidationError,
    NoParentError,
    PermissionDeniedError,
    ProgramAgentHandle,
    Runtime,
    RuntimeUnavailableError,
    UnsupportedDeliveryModeError,
    current_runtime,
)


async def send_as(runtime, body, **kwargs):
    async with runtime.bind():
        return await runtime.send(body, **kwargs)



@pytest.mark.asyncio
async def test_runtime_judge_uses_optional_host_service_and_preserves_none():
    rt = Runtime(rlm=True)
    calls = []
    async def callback(parent, method, params):
        calls.append((parent, method, params))
        return None
    async with rt.bind():
        async with rt._bind_host_callbacks("cell", callback):
            result = await rt.judge.judge(
                {"candidate": "a"},
                {"pick": {"type": "choice", "criteria": {"a": "A", "b": "B"}}},
                safe=True,
            )
    assert result is None
    assert calls[0][1] == "judge.judge"
    assert calls[0][2]["model"] is None
    assert calls[0][2]["safe"] is True
    await rt.close()


def test_agent_handle_compatibility_alias_is_program_agent_handle():
    assert AgentHandle is ProgramAgentHandle


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
async def test_program_agent_runs_continuously_messages_both_ways_and_cancels():
    root = Runtime()
    replies = await root.mailboxes.create(
        config=MailboxConfig(message_type=str, capacity=4)
    )
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def echo_agent(rt):
        started.set()
        try:
            while True:
                message = await rt.mailbox.receive()
                await rt.send(f"echo:{message.body}", to=replies)
        finally:
            stopped.set()

    async with root.bind():
        handle = await root.spawn_program(
            echo_agent,
            name="echo-agent",
            mailbox=MailboxConfig(message_type=str, capacity=4),
        )
        await started.wait()
        assert isinstance(handle, ProgramAgentHandle)
        assert await handle.status() == "running"

        first = await handle.send("one")
        assert first.mailbox_id == handle.mailbox.id
        assert (await replies.receive(timeout=1)).body == "echo:one"

        await handle.send("two")
        assert (await replies.receive(timeout=1)).body == "echo:two"
        assert not handle.done()

        assert handle.cancel("stop requested")
        with pytest.raises(asyncio.CancelledError, match="stop requested"):
            await handle.wait()
        await asyncio.wait_for(stopped.wait(), 1)
        assert handle.done()
        assert handle.cancelled()
        assert await handle.status() == "cancelled"

        with pytest.raises(MailboxClosedError):
            await handle.send("after-stop")

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
@pytest.mark.parametrize("as_model", [False, True])
@pytest.mark.parametrize("alias_kind", ["ordinary", "split", "path"])
@pytest.mark.parametrize("serialize_by_alias", [False, True])
async def test_pydantic_aliases_preserve_strict_detached_boundary(
    as_model, alias_kind, serialize_by_alias
):
    if alias_kind == "ordinary":
        field = Field(alias="wire_items")
    elif alias_kind == "split":
        field = Field(validation_alias="wire_items", serialization_alias="output_items")
    else:
        field = Field(
            validation_alias=AliasChoices(AliasPath("payload", "items"), "wire_items"),
            serialization_alias="output_items",
        )

    class AliasedChild(BaseModel):
        model_config = ConfigDict(extra="forbid", serialize_by_alias=serialize_by_alias)
        items: list[int] = field

    class AliasedMessage(BaseModel):
        model_config = ConfigDict(extra="forbid", serialize_by_alias=serialize_by_alias)
        child: AliasedChild = Field(alias="wire_child")

    root = Runtime()
    mailbox = await root.mailboxes.create(
        config=MailboxConfig(message_type=AliasedMessage)
    )
    values = [1, 2]
    child_data = (
        {"payload": {"items": values}}
        if alias_kind == "path"
        else {"wire_items": values}
    )
    data = {"wire_child": child_data}
    body = AliasedMessage.model_validate(data) if as_model else data
    async with root:
        await send_as(root, body, to=mailbox)
        if as_model:
            body.child.items.append(3)
        else:
            values.append(3)
        received = mailbox.receive_nowait().body
        assert isinstance(received, AliasedMessage)
        assert isinstance(received.child, AliasedChild)
        assert received.child.items == [1, 2]
        if as_model:
            assert received is not body
            assert received.child is not body.child
        received.child.items.append(4)
        assert (body.child.items if as_model else values) == [1, 2, 3]

        # Names used internally must not become valid external input names.
        invalid_inputs = [
            {"child": {"wire_items": [1]}},
            {"wire_child": {"items": [1]}},
            {"wire_child": {"output_items": [1]}},
            {"wire_child": {"wire_items": ["1"]}},
            {"wire_child": {"wire_items": [1], "unknown": 2}},
        ]
        for invalid in invalid_inputs:
            with pytest.raises(MessageValidationError):
                await send_as(root, invalid, to=mailbox)

        # Instances can be mutated or built without validation; never trust them.
        invalid_model = AliasedMessage.model_construct(
            child=AliasedChild.model_construct(items=["1"])
        )
        with pytest.warns(UserWarning, match="Pydantic serializer warnings"):
            with pytest.raises(MessageValidationError):
                await send_as(root, invalid_model, to=mailbox)
        with pytest.raises(asyncio.QueueEmpty):
            mailbox.receive_nowait()


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
async def test_explicit_mailbox_close_unregisters_backend_but_remains_owned():
    root = Runtime()
    async with root.bind():
        mailbox = await root.mailboxes.create()
        address = mailbox.id
        await mailbox.close()
        assert mailbox in root._owned_mailboxes
        with pytest.raises(MailboxNotFoundError):
            await root.mailboxes.get(address)
    assert set(root._state.registry._mailboxes) == {root.mailbox.id}
    await root.close()
    assert mailbox not in root._owned_mailboxes


@pytest.mark.asyncio
async def test_closed_mailbox_drains_live_but_run_exit_discards_pending_queue():
    root = Runtime()
    mailbox = await root.mailboxes.create()
    await send_as(root, "drain", to=mailbox)
    await send_as(root, "discard", to=mailbox)

    async with root.bind():
        await mailbox.close()
        assert (await mailbox.receive()).body == "drain"
        assert [message.body for message in mailbox._queue] == ["discard"]

    await root.close()
    assert mailbox.closed
    assert not mailbox._queue


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
