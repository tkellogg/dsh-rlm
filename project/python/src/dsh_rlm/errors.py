"""Errors raised by the local dsh_rlm runtime."""


class RuntimeErrorBase(Exception):
    """Base class for errors reported by this package."""


class RuntimeUnavailableError(RuntimeErrorBase):
    """No runtime is bound to the current asyncio task."""


class NoParentError(RuntimeErrorBase):
    """A parent-default operation was requested for a root runtime."""


class MailboxError(RuntimeErrorBase):
    """Base class for mailbox admission and receive errors."""


class MailboxClosedError(MailboxError):
    """The mailbox is closed and has no queued messages."""

    def __init__(self, mailbox_id: str):
        self.mailbox_id = mailbox_id
        super().__init__(f"mailbox {mailbox_id!r} is closed")


class MailboxFullError(MailboxError):
    """The mailbox queue has reached its configured capacity."""

    def __init__(self, mailbox_id: str, capacity: int):
        self.mailbox_id = mailbox_id
        self.capacity = capacity
        super().__init__(f"mailbox {mailbox_id!r} is full (capacity {capacity})")


class MailboxNotFoundError(MailboxError, LookupError):
    """No live mailbox has the requested address."""

    def __init__(self, mailbox_id: str):
        self.mailbox_id = mailbox_id
        super().__init__(f"unknown or dead mailbox {mailbox_id!r}")


class MailboxInUseError(MailboxError):
    """The RLM driver owns the default mailbox receive operation."""

    def __init__(self, mailbox_id: str):
        self.mailbox_id = mailbox_id
        super().__init__(f"mailbox {mailbox_id!r} is managed by the RLM driver")


class MessageValidationError(MailboxError, ValueError):
    """A body is not valid for the destination mailbox's JSON contract."""

    def __init__(self, message: str, *, field: str | None = None):
        self.field = field
        if field and field not in message:
            message = f"{message} (field {field!r})"
        super().__init__(message)


class UnsupportedDeliveryModeError(MailboxError, ValueError):
    """A delivery mode is not supported by the destination mailbox."""


class PermissionDeniedError(MailboxError, PermissionError):
    """The current runtime cannot receive from or close this mailbox."""


class UnsupportedOperationError(RuntimeErrorBase, NotImplementedError):
    """An integration operation intentionally outside the local core."""
