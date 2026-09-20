"""Recovery state and model-facing notices for local RLM sessions."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from .checkpoint import ValueIssue

_MAX_NOTICE_CHARS = 8_192
_MAX_NOTICE_ITEMS = 50
_MAX_DETAIL_CHARS = 256


@dataclass(frozen=True, slots=True)
class RecoveryReport:
    """Best-effort state restored when a local RLM session was opened."""

    interrupted: bool
    cause: str | None
    checkpoint_id: str | None
    created_at: str | None
    restored: tuple[str, ...]
    skipped: tuple[ValueIssue, ...]
    failed: tuple[ValueIssue, ...]
    reason: str | None = None
    final_save_error: str | None = None
    checkpoint_error: str | None = None

    def render_notice(self) -> str:
        """Render one bounded warning for the next model request."""
        cause = self.cause or "unknown"
        if self.interrupted:
            opening = f"Previous run was interrupted; the cause is {cause}."
        else:
            opening = "Session resumed cleanly from the last known state."

        # Put safety-critical facts before optional value details so truncation
        # can never hide them.
        lines = [
            opening,
            "Prior tasks, mailboxes, and handles are invalid and were not revived.",
            (
                "External side effects from the prior run may already have occurred; "
                "check before retrying."
            ),
        ]
        if self.checkpoint_id:
            lines.append(
                f"Restored checkpoint {_short(self.checkpoint_id)} created at "
                f"{_short(self.created_at or 'unknown time')}."
            )
        else:
            lines.append("No usable checkpoint identity or time was available.")
        if self.checkpoint_error:
            lines.append(
                "The latest completed cell was not checkpointed: "
                f"{_short(self.checkpoint_error)}."
            )
        if self.final_save_error:
            lines.append(
                "The prior final checkpoint attempt failed: "
                f"{_short(self.final_save_error)}."
            )
        if self.reason:
            lines.append(f"Restore note: {_short(self.reason)}.")
        lines.extend(
            (
                _names_line("Restored values", self.restored),
                _issues_line("Skipped values", self.skipped),
                _issues_line("Failed values", self.failed),
            )
        )
        notice = "<runtime_recovery>\n" + "\n".join(lines) + "\n</runtime_recovery>"
        if len(notice) <= _MAX_NOTICE_CHARS:
            return notice
        suffix = "\n[recovery details truncated]\n</runtime_recovery>"
        return notice[: _MAX_NOTICE_CHARS - len(suffix)] + suffix


def _short(value: str) -> str:
    if len(value) <= _MAX_DETAIL_CHARS:
        return value
    return value[: _MAX_DETAIL_CHARS - 16] + "...[truncated]"


def _limited(values: Iterable[str]) -> tuple[tuple[str, ...], int]:
    items = tuple(values)
    visible = tuple(_short(item) for item in items[:_MAX_NOTICE_ITEMS])
    return visible, len(items) - len(visible)


def _names_line(label: str, names: Iterable[str]) -> str:
    values, omitted = _limited(names)
    rendered = ", ".join(values) if values else "none"
    if omitted:
        rendered += f", ... ({omitted} omitted)"
    return f"{label}: {rendered}."


def _issues_line(label: str, issues: Iterable[ValueIssue]) -> str:
    values = tuple(issues)
    rendered_values = (
        f"{_short(item.name)} ({_short(item.reason)})"
        for item in values[:_MAX_NOTICE_ITEMS]
    )
    rendered = ", ".join(rendered_values) if values else "none"
    omitted = len(values) - min(len(values), _MAX_NOTICE_ITEMS)
    if omitted:
        rendered += f", ... ({omitted} omitted)"
    return f"{label}: {rendered}."


__all__ = ["RecoveryReport"]
