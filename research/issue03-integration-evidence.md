# Issue 03 real bridge integration evidence

## Scope

Authored `project/plugin/test/host-worker-integration.test.js` only. The fixture uses the production compiled `BridgePool`, `createHostCallbackDispatcher`, protocol parser, Python `dsh_rlm.bridge`, Python runtime and `runtime.host_workers.spawn`. It wraps a real `node:child_process` only to satisfy the subprocess-provider interface; protocol frames and worker behavior are not mocked.

The test gates the worker on a temporary marker created only after the admission execute returns. It then waits for host-side tool and model dispatch promises before issuing any second execute, proving those calls occur with no execute pending. It exercises `tools.list`, an actual `ToolRuntime` pipeline tool, and a benign model stream. Assertions cover raw inherited asyncio-child callback rejection, fresh parentless tool IDs, no stale parent/root token, no outer defer/conclude, one tool execution (no retry), model route/output, and bridge disposal/process cleanup. Every wait and cleanup is bounded.

## Results

`npm run build` succeeded on the coordinated stable TS tree.

The dependency-complete repository interpreter was used explicitly:

```
PYTHON=/Users/tim/code/dsh-rlm/project/python/.venv/bin/python node --test test/host-worker-integration.test.js
```

Result: **3 passed, 0 failed** in 699 ms (positive case 108 ms; timeout case 443 ms; disposal case 77 ms). The positive case confirms fresh worker admission/lease wire parity and successful independently timed `tools.list`, real ToolRuntime `tools.call`, and `models.complete` after the admitting execute returned and before any second execute was sent. The timeout case admits a worker with a 50 ms whole-lifetime timeout, proves its task terminates with `TimeoutError`, waits past its delayed invocation point, and verifies the host dispatcher was never called. The disposal case lets a post-final worker enter a blocking real ToolRuntime call, then disposes its owner and proves the tool signal is aborted, the effect ran exactly once without retry, and the real bridge process was reaped.

## Limitations / follow-up

The fixture defaults to the repository `.venv` interpreter and honors an explicit `PYTHON` override. Arbitrary forged/cross-client lease frames and explicit Python cancellation outcome classification remain covered by focused protocol/authority/Python unit tests rather than this real-process suite; this suite does not mock protocol success.
