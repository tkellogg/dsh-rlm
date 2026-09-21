# Issue 01 — bounded context inspection report

## Scope and finding

The existing public surface returns complete raw values from `runtime.tools.list()` and `runtime.tools.call()`. It has no selective view helper. This change leaves those APIs, host authority, and call compatibility untouched and adds a small opt-in helper module rather than a result-store subsystem or adviser model.

## Implemented

`project/python/src/dsh_rlm/context_inspection.py` provides:

- `compact_tools(catalogue, offset=...)`: bounded raw-entry pagination over an exact built-in list, sorted within each page and excluding schemas. Exact tool names are preserved or the entry is explicitly omitted; truncated descriptions carry metadata.
- `tool_schema(catalogue, name)`: exact selection of one complete retained catalogue entry for schema-on-demand.
- `inspect_value(source, ...)`: bounded traversal of exact built-in dict/list/tuple and scalar values, explicit `truncated` and aggregate `omitted` metadata, configurable depth/item/key/string/node bounds, and retained-source path expansion through `Inspection.at(...)`.
- Supported critical envelope keys (`error[s]`, `stderr`, denial/approval, recovery, abort/timeout, exit code, signal) are selected ahead of the ordinary item budget at every inspected mapping level.
- Unsupported values and container subclasses become an opaque marker. Inspection does not call their `repr`, `str`, properties, iteration, or indexing.

Dedicated tests cover deterministic schema discovery, huge/nested selective expansion, critical envelope priority, long strings/bytes/depth bounds, invalid bounds, hostile unserializable objects, and hostile container subclasses.

## Intended controller usage

```python
from dsh_rlm.context_inspection import compact_tools, inspect_value, tool_schema

catalogue = await runtime.tools.list()       # retain complete live value
compact_tools(catalogue)                     # small discovery view
tool_schema(catalogue, "read")              # expand only selected schema

result = await runtime.tools.call("read", arguments)
view = inspect_value(result, max_items=10, max_string=300)
view.value, view.truncated, view.omitted
view.at("lines", offset=50, max_items=5).value  # retrieve retained page
```

The catalogue is only a snapshot and never authorizes execution; `runtime.tools.call()` remains the guarded authority and revalidates current policy. Tool-list/call exceptions are deliberately not caught, summarized, or suppressed.

## Boundaries and limitations

- “Retained” means reachable from the live Python object graph. It is not a durable store and is not necessarily checkpointable; restart survival depends on existing checkpoint rules.
- Critical prioritization recognizes only the documented structured envelope keys. It cannot discover semantic errors buried under arbitrary application-specific names or opaque objects. Call exceptions remain the reliable unsuppressed error path.
- The omitted count aggregates omitted entries/characters across the rendered subtree; it is an explicit truncation signal, not a byte count.
- The helper accepts exact built-in containers to avoid arbitrary callbacks. Custom mappings/sequences are intentionally opaque. `compact_tools` accepts only an exact list; later raw catalogue entries are retrievable with `offset`.
- Each `Inspection.at(...)` expansion resets unspecified limits to safe defaults. It does not inherit a prior view’s enlarged budgets.
- `max_nodes` bounds rendered nodes and recursion output. Exact built-in mappings are still scanned to identify supported critical keys and bounded ordinary windows, so it is an output/visit-recursion bound rather than a strict CPU bound on mapping size.
- No `runtime.py`, package `__init__.py`, plugin, README, tracker, installed bundle, or live deployment was changed. A parent/delivery agent may choose to add a package-level re-export; direct module import is already usable in source.

## Validation

- `.venv/bin/pytest -q tests/test_context_inspection.py` — exit 0, 8 passed. Final regressions include hostile stored-key collision/equality, schema-name equality, source-safe repr, exact critical-envelope omission counts, bounded catalogue pagination, cycles/aliases, hostile callbacks, and a million-bit integer.
- A subsequent full suite run reached unrelated concurrent shared-source failures: `LocalKernel.__init__` references a missing `inspect_state` in `kernel.py`; many bridge/recovery tests consequently failed. This module did not edit shared kernel/runtime files. Re-run the full suite after that concurrent integration is settled.
- This report does not claim live deployment or restart validation.
