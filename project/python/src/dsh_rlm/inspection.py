"""Bounded, side-effect-free inspection records for RLM integration.

This module owns data models and retention only. Runtime, REPL, kernel, and bridge
integration deliberately live at their respective ownership boundaries.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Generic, Iterable, Literal, TypeVar

TerminalState = Literal[
    "completed", "failed", "cancelled", "interrupted", "unknown"
]
SnapshotMatch = Literal["unknown"]
_MAX_TEXT = 512
T = TypeVar("T")


def _bounded(text: str | None) -> str | None:
    if text is None or len(text) <= _MAX_TEXT:
        return text
    return text[: _MAX_TEXT - 1] + "…"


@dataclass(frozen=True, slots=True)
class TerminalRecord:
    sequence: int
    task_id: str
    parent_id: str | None
    name: str | None
    state: TerminalState
    started_at: str
    finished_at: str
    error_type: str | None = None
    error_message: str | None = None
    observed: bool = False


@dataclass(frozen=True, slots=True)
class InspectionPage(Generic[T]):
    items: tuple[T, ...]
    total: int
    offset: int
    returned: int
    truncated: bool
    oldest_sequence: int | None = None
    newest_sequence: int | None = None
    evicted_through: int | None = None


class TerminalRecordStore:
    """Fixed-capacity terminal history; inspection never marks records observed."""

    def __init__(self, capacity: int = 256) -> None:
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity <= 0:
            raise ValueError("capacity must be a positive integer")
        self._records: deque[TerminalRecord] = deque()
        self._capacity = capacity
        self._next_sequence = 1
        self._evicted_through: int | None = None

    def append(
        self,
        *,
        task_id: str,
        parent_id: str | None,
        name: str | None,
        state: TerminalState,
        started_at: str,
        finished_at: str | None = None,
        error_type: str | None = None,
        error_message: str | None = None,
    ) -> TerminalRecord:
        if state not in {"completed", "failed", "cancelled", "interrupted", "unknown"}:
            raise ValueError(f"unsupported terminal state: {state!r}")
        if not task_id:
            raise ValueError("task_id must be non-empty")
        record = TerminalRecord(
            sequence=self._next_sequence,
            # Identity fields remain exact for authorization/filtering. Bound only
            # display metadata such as names and error summaries.
            task_id=task_id,
            parent_id=parent_id,
            name=_bounded(name),
            state=state,
            started_at=started_at,
            finished_at=finished_at or datetime.now(timezone.utc).isoformat(),
            error_type=_bounded(error_type),
            error_message=_bounded(error_message),
        )
        self._next_sequence += 1
        if len(self._records) == self._capacity:
            self._evicted_through = self._records.popleft().sequence
        self._records.append(record)
        return record

    def mark_observed(self, sequence: int) -> bool:
        """Explicit handle-result hook; never called by :meth:`inspect`."""
        for index, record in enumerate(self._records):
            if record.sequence == sequence:
                if not record.observed:
                    self._records[index] = replace(record, observed=True)
                return True
        return False

    def inspect(
        self, *, owner_id: str | None = None, after: int | None = None,
        offset: int = 0, limit: int = 100
    ) -> InspectionPage[TerminalRecord]:
        _validate_page(offset, limit)
        if owner_id is not None and (type(owner_id) is not str or not owner_id):
            raise ValueError("owner_id must be a non-empty exact string or None")
        if after is not None and (
            isinstance(after, bool) or not isinstance(after, int) or after < 0
        ):
            raise ValueError("after must be a non-negative integer or None")
        selected = tuple(
            record for record in self._records
            if (owner_id is None or record.parent_id == owner_id)
            and (after is None or record.sequence > after)
        )
        page = selected[offset : offset + limit]
        return InspectionPage(
            items=page,
            total=len(selected),
            offset=offset,
            returned=len(page),
            truncated=offset + len(page) < len(selected),
            oldest_sequence=self._records[0].sequence if self._records else None,
            newest_sequence=self._records[-1].sequence if self._records else None,
            evicted_through=self._evicted_through,
        )


@dataclass(frozen=True, slots=True)
class ManagedLiveTaskRecord:
    task_id: str
    parent_id: str
    name: str | None
    state: Literal["starting", "running", "idle", "stopping"]
    started_at: str


def page_managed_live_tasks(
    tasks: Iterable[ManagedLiveTaskRecord],
    *,
    owner_id: str,
    offset: int = 0,
    limit: int = 100,
) -> InspectionPage[ManagedLiveTaskRecord]:
    """Filter one owner's immutable live metadata and page deterministically.

    Callers construct records from already-known runtime fields. This helper never
    receives an asyncio task and therefore cannot retrieve an exception/result.
    """
    if not isinstance(owner_id, str) or not owner_id:
        raise ValueError("owner_id must be a non-empty string")
    _validate_page(offset, limit)
    visible = tuple(sorted(
        (task for task in tasks if task.parent_id == owner_id),
        key=lambda task: task.task_id,
    ))
    page = visible[offset : offset + limit]
    return InspectionPage(
        items=page,
        total=len(visible),
        offset=offset,
        returned=len(page),
        truncated=offset + len(page) < len(visible),
    )


@dataclass(frozen=True, slots=True)
class RawTaskRecord:
    task_id: str
    name: str | None
    state: Literal["running", "cancelled", "terminal_unknown"]


@dataclass(frozen=True, slots=True)
class LiveValueRecord:
    name: str
    type_name: str
    snapshot_contains_name: bool
    current_value_matches_snapshot: SnapshotMatch = "unknown"
    snapshot_exclusion_reason: str | None = None


@dataclass(frozen=True, slots=True)
class DurableSnapshotRecord:
    checkpoint_id: str
    created_at: str
    byte_count: int
    saved_names: tuple[str, ...]
    saved_total: int
    saved_truncated: bool
    skipped: tuple[tuple[str, str], ...]
    skipped_total: int
    skipped_truncated: bool


@dataclass(frozen=True, slots=True)
class CheckpointAttemptRecord:
    ok: bool
    error: str | None = None



@dataclass(frozen=True, slots=True)
class StateInspection:
    inspected_at: str
    live: InspectionPage[LiveValueRecord]
    durable: DurableSnapshotRecord | None
    last_attempt: CheckpointAttemptRecord | None


class RuntimeInspectionProvider:
    """Read-only runtime-facing facade injected by the owning kernel."""

    def __init__(self, inspect_state):
        self._inspect_state = inspect_state

    def state(self, *, offset: int = 0, limit: int = 100) -> StateInspection:
        return self._inspect_state(offset=offset, limit=limit)

def page_live_values(
    values: Iterable[LiveValueRecord], *, offset: int = 0, limit: int = 100
) -> InspectionPage[LiveValueRecord]:
    """Deterministically page caller-produced metadata without touching values."""
    _validate_page(offset, limit)
    ordered = tuple(sorted(values, key=lambda value: value.name))
    page = ordered[offset : offset + limit]
    return InspectionPage(
        items=page,
        total=len(ordered),
        offset=offset,
        returned=len(page),
        truncated=offset + len(page) < len(ordered),
    )


def _validate_page(offset: int, limit: int) -> None:
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise ValueError("limit must be an integer from 1 through 200")
