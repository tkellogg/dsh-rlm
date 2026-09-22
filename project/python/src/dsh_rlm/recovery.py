"""Recovery state and concise model-facing notices for local RLM sessions."""

from __future__ import annotations

from dataclasses import dataclass
from html import escape

from .checkpoint import ValueIssue

_MAX_NOTICE_CHARS = 2_048
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
        """Render concise recovery context for the next model request.

        Restored/skipped/failed inventories remain available on ``runtime.recovery``
        and are intentionally excluded from routine model context.
        """
        if self.interrupted:
            cause = escape(_short(self.cause or "unknown"), quote=False)
            text = (
                "Python runtime recovered from a checkpoint after an unclean shutdown "
                f"(cause: {cause}). Review runtime.recovery for restored/skipped/failed "
                "value details. Prior live tasks, mailboxes, and handles are invalid; "
                "prior external effects may already have occurred."
            )
        else:
            text = (
                "Python runtime restored from a checkpoint after restart. Review "
                "runtime.recovery for restored/skipped/failed value details. Prior "
                "live tasks, mailboxes, and handles are invalid."
            )
        notice = f"<runtime_recovery>{text}</runtime_recovery>"
        if len(notice) <= _MAX_NOTICE_CHARS:
            return notice
        suffix = "[recovery notice truncated]</runtime_recovery>"
        return notice[: _MAX_NOTICE_CHARS - len(suffix)] + suffix


def _short(value: str) -> str:
    if len(value) <= _MAX_DETAIL_CHARS:
        return value
    return value[: _MAX_DETAIL_CHARS - 16] + "...[truncated]"


__all__ = ["RecoveryReport"]
