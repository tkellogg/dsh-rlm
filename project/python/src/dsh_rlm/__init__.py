"""Pure-Python local runtime primitives for dsh_rlm."""

from .checkpoint import (
    CheckpointLimits,
    CheckpointReport,
    CheckpointStore,
    RestoreReport,
    ValueIssue,
)
from .errors import (
    MailboxClosedError,
    MailboxError,
    MailboxFullError,
    MailboxInUseError,
    MailboxNotFoundError,
    MessageValidationError,
    NoParentError,
    PermissionDeniedError,
    RuntimeErrorBase,
    RuntimeUnavailableError,
    UnsupportedDeliveryModeError,
    UnsupportedOperationError,
)
from .kernel import LocalKernel
from .mailbox import (
    DeliveryMode,
    JsonValue,
    Mailbox,
    MailboxConfig,
    Mailboxes,
    MailboxRef,
    Message,
    SendReceipt,
)
from .recovery import RecoveryReport
from .repl import CellResult, PersistentREPL
from .runtime import (
    AgentHandle,
    AgentRef,
    AgentStatus,
    ProgramAgentHandle,
    Runtime,
    connect,
    current_runtime,
)

__all__ = [
    "AgentHandle",
    "AgentRef",
    "AgentStatus",
    "CellResult",
    "CheckpointLimits",
    "CheckpointReport",
    "CheckpointStore",
    "DeliveryMode",
    "JsonValue",
    "LocalKernel",
    "Mailbox",
    "MailboxClosedError",
    "MailboxConfig",
    "MailboxError",
    "MailboxFullError",
    "MailboxInUseError",
    "MailboxNotFoundError",
    "MailboxRef",
    "Mailboxes",
    "Message",
    "MessageValidationError",
    "NoParentError",
    "PermissionDeniedError",
    "PersistentREPL",
    "ProgramAgentHandle",
    "RecoveryReport",
    "RestoreReport",
    "Runtime",
    "RuntimeErrorBase",
    "RuntimeUnavailableError",
    "SendReceipt",
    "UnsupportedDeliveryModeError",
    "UnsupportedOperationError",
    "ValueIssue",
    "connect",
    "current_runtime",
]
