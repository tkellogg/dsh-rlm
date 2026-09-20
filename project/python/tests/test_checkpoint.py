from __future__ import annotations

import asyncio
import io
import socket
from dataclasses import FrozenInstanceError

import dill
import pytest

import dsh_rlm.checkpoint as checkpoint_module
from dsh_rlm.checkpoint import (
    CheckpointLimits,
    CheckpointStore,
    RestoreReport,
)
from dsh_rlm.runtime import Runtime


def test_save_restore_values_and_function_roundtrip(tmp_path):
    path = tmp_path / "state.dill"
    store = CheckpointStore(path)

    def add(value):
        return value + 2

    report = store.save({"answer": 40, "add": add, "_internal": "not saved"})
    assert report.ok
    assert report.saved == ("add", "answer")
    assert report.byte_count == path.stat().st_size
    assert report.checkpoint_id and report.created_at

    namespace = {"live": "untouched"}
    restored = store.restore(namespace)
    assert restored.ok
    assert namespace["answer"] == 40
    assert namespace["add"](3) == 5
    assert namespace["live"] == "untouched"
    assert restored.checkpoint_id == report.checkpoint_id
    assert restored.created_at == report.created_at
    assert any(issue.name == "_internal" for issue in restored.skipped)


def test_unpicklable_value_does_not_abort_other_values(tmp_path, monkeypatch):
    path = tmp_path / "state"
    store = CheckpointStore(path)
    original = checkpoint_module._dill_dump

    class Bad:
        pass

    def dump(value, stream):
        if isinstance(value, Bad):
            raise RuntimeError("cannot save this value")
        original(value, stream)

    monkeypatch.setattr(checkpoint_module, "_dill_dump", dump)
    report = store.save({"good": 7, "bad": Bad()})
    assert report.saved == ("good",)
    assert any(issue.name == "bad" for issue in report.skipped)
    namespace = {}
    restored = store.restore(namespace)
    assert namespace == {"good": 7}
    assert restored.restored == ("good",)


def test_per_value_and_aggregate_caps(tmp_path):
    path = tmp_path / "state"
    # The first value is deliberately over its per-value cap.  The second
    # still fits, while a later value is over the aggregate cap.
    store = CheckpointStore(
        path,
        CheckpointLimits(max_bytes=600, max_value_bytes=100),
    )
    report = store.save({"too_big": "x" * 500, "small": 1, "later": "y" * 200})
    assert report.saved == ("small",)
    reasons = {issue.name: issue.reason for issue in report.skipped}
    assert "per-value" in reasons["too_big"]
    assert "per-value" in reasons["later"]


def test_aggregate_cap_skips_value_when_each_value_fits(tmp_path):
    path = tmp_path / "state"
    store = CheckpointStore(
        path,
        CheckpointLimits(max_bytes=340, max_value_bytes=1_000),
    )
    report = store.save({"first": "x" * 100, "second": "y" * 100})
    assert report.saved == ("first",)
    assert any(
        issue.name == "second" and "aggregate" in issue.reason
        for issue in report.skipped
    )


def test_checkpoint_limits_reject_invalid_values():
    with pytest.raises(ValueError):
        CheckpointLimits(max_bytes=-1)
    with pytest.raises(ValueError):
        CheckpointLimits(max_value_bytes=-1)
    with pytest.raises(ValueError):
        CheckpointLimits(max_bytes=True)
    with pytest.raises(ValueError):
        CheckpointLimits(max_value_bytes="100")


def test_old_generation_survives_serialization_and_write_faults(tmp_path, monkeypatch):
    path = tmp_path / "state"
    store = CheckpointStore(path)
    store.save({"old": 1})
    original = checkpoint_module._dill_dump

    def fail_payload(value, stream):
        if isinstance(value, dict) and value.get("version") == 1:
            raise OSError("serializer stopped")
        original(value, stream)

    monkeypatch.setattr(checkpoint_module, "_dill_dump", fail_payload)
    failed = store.save({"new": 2})
    assert failed.error and "serialization" in failed.error
    namespace = {}
    store.restore(namespace)
    assert namespace == {"old": 1}

    monkeypatch.setattr(checkpoint_module, "_dill_dump", original)
    monkeypatch.setattr(
        checkpoint_module,
        "_atomic_write",
        lambda *_: (_ for _ in ()).throw(OSError("disk full")),
    )
    failed = store.save({"new": 2})
    assert failed.error and "write" in failed.error
    namespace = {}
    store.restore(namespace)
    assert namespace == {"old": 1}


def test_restore_is_partial_for_corrupt_values_and_does_not_mutate_until_loads_done(
    tmp_path,
):
    path = tmp_path / "state"
    payload = {
        "version": 1,
        "checkpoint_id": "manual",
        "created_at": "now",
        "skipped": [],
        "values": {"good": dill.dumps(3), "bad": b"not a dill stream"},
    }
    with path.open("wb") as stream:
        dill.dump(payload, stream)
    store = CheckpointStore(path)
    namespace = {"existing": True}
    report = store.restore(namespace)
    assert namespace == {"existing": True, "good": 3}
    assert report.restored == ("good",)
    assert report.failed and report.failed[0].name == "bad"
    assert report.checkpoint_id == "manual"


def test_missing_and_corrupt_checkpoint_reports(tmp_path):
    missing = CheckpointStore(tmp_path / "missing").restore({})
    assert isinstance(missing, RestoreReport)
    assert missing.ok
    assert missing.reason == "checkpoint not found"
    assert missing.checkpoint_id is None
    assert missing.created_at is None

    corrupt_path = tmp_path / "corrupt"
    corrupt_path.write_bytes(b"not dill")
    corrupt = CheckpointStore(corrupt_path).restore({})
    assert not corrupt.ok
    assert corrupt.reason == "corrupt checkpoint"
    assert corrupt.failed[0].name == "<checkpoint>"


def test_runtime_resources_are_skipped(tmp_path):
    path = tmp_path / "state"
    runtime = Runtime()
    loop = asyncio.new_event_loop()
    future = loop.create_future()

    async def pending():
        await asyncio.sleep(1)

    coroutine = pending()
    generator = (item for item in range(2))
    live_socket = socket.socket()
    report = CheckpointStore(path).save(
        {
            "runtime": runtime,
            "mailbox": runtime.mailbox,
            "future": future,
            "coroutine": coroutine,
            "generator": generator,
            "module": checkpoint_module,
            "file": io.BytesIO(b"not recoverable"),
            "socket": live_socket,
            "safe": 4,
        }
    )
    names = {issue.name for issue in report.skipped}
    assert {
        "runtime",
        "mailbox",
        "future",
        "coroutine",
        "generator",
        "module",
        "file",
        "socket",
    } <= names
    assert report.saved == ("safe",)
    coroutine.close()
    live_socket.close()
    loop.close()


def test_reports_are_frozen(tmp_path):
    report = CheckpointStore(tmp_path / "state").save({"x": 1})
    with pytest.raises(FrozenInstanceError):
        report.saved = ()


def test_function_referencing_runtime_state_is_skipped(tmp_path):
    runtime = Runtime()

    def unsafe_function():
        return runtime

    report = CheckpointStore(tmp_path / "state").save(
        {"unsafe_function": unsafe_function, "safe": 1}
    )
    assert report.saved == ("safe",)
    assert any(issue.name == "unsafe_function" for issue in report.skipped)


def test_objects_cannot_embed_runtime_state(tmp_path):
    runtime = Runtime()

    class Box:
        pass

    class SlottedBox:
        __slots__ = ("runtime",)

    box = Box()
    box.runtime = runtime
    slotted = SlottedBox()
    slotted.runtime = runtime
    report = CheckpointStore(tmp_path / "state").save(
        {"box": box, "slotted": slotted, "safe": 1}
    )
    assert report.saved == ("safe",)
    assert {issue.name for issue in report.skipped} >= {"box", "slotted"}


def test_user_class_methods_and_attributes_cannot_embed_runtime(tmp_path):
    runtime = Runtime()

    class Box:
        def get_runtime(self):
            return runtime

    report = CheckpointStore(tmp_path / "state").save({"box": Box(), "safe": 1})
    assert report.saved == ("safe",)
    assert any(issue.name == "box" for issue in report.skipped)


def test_deep_value_is_isolated_from_other_checkpoint_values(tmp_path):
    deep: list[object] = []
    cursor = deep
    for _ in range(2_000):
        child: list[object] = []
        cursor.append(child)
        cursor = child
    report = CheckpointStore(tmp_path / "state").save({"deep": deep, "safe": 1})
    assert "safe" in report.saved
    assert any(issue.name == "deep" for issue in report.skipped)


def test_serializer_system_exit_is_a_per_value_skip(tmp_path):
    class Exits:
        def __reduce__(self):
            raise SystemExit(23)

    report = CheckpointStore(tmp_path / "state").save({"bad": Exits(), "safe": 1})
    assert report.saved == ("safe",)
    assert any(issue.name == "bad" for issue in report.skipped)


def test_restore_enforces_file_and_per_value_limits(tmp_path):
    path = tmp_path / "state"
    CheckpointStore(path).save({"large": "x" * 10_000})
    too_small_file = CheckpointStore(
        path, CheckpointLimits(max_bytes=32, max_value_bytes=16 * 1024 * 1024)
    ).restore({})
    assert not too_small_file.ok
    assert "aggregate byte cap" in too_small_file.failed[0].reason

    namespace = {}
    per_value = CheckpointStore(
        path, CheckpointLimits(max_bytes=256 * 1024 * 1024, max_value_bytes=100)
    ).restore(namespace)
    assert "large" not in namespace
    assert any("per-value byte cap" in issue.reason for issue in per_value.failed)
