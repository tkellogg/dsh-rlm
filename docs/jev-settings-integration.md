# Jev settings: plugin-only integration

## Boundary

No DSH source files or installed DSH package files are patched. The Host and UI
are separate ordinary Loader plugins using published APIs of DSH 0.1.6-alpha.2.

- `@dsh-rlm/plugin/jev` provides `ctx.jev` and live `jev` settings.
- The `apiKeyEnv` schema uses `role('credential-ref')`; actual values live in
  Harness credentials and are resolved for each operation.
- `JevRemote` uses `TypertRemoteService` and public `@Remote` decorators. The
  existing Gateway discovers its two methods via supported source-mode discovery.
- Only `jev/status` and `jev/testConnection` cross the browser boundary. Arbitrary
  state evaluation and credential resolution are not Remote methods.
- `@dsh-rlm/jev-settings` contributes a `settings.section` seat and calls the
  existing authenticated Connection carrier with `{args:{}}`.
- The browser package has a no-op Host entry and a `dsh.client` declaration.
  Source profiles mount its **Host entry**, never execute the browser bundle as
  a Host plugin. The existing ClientModuleRegistry locates its manifest and serves
  the `./client` artifact without web-shell changes.

## Operator acceptance

1. Build Host and browser packages, install both through the normal plugin manager
   or use the provided source-checkout profile. Restart the existing Host with that
   composition. No alternate web server is needed.
2. Refresh the authenticated existing GUI and open Settings → Jev Judge.
3. With no key, verify Not configured; opening the page sends no TypeSafe request.
4. Save a key through the write-only field. Reload: only source/presence metadata
   should return; the literal must never be repopulated.
5. Change the model/timeout and save. Verify the next operation uses the new values.
6. Disable Jev. Judge calls return no decision and Test connection is unavailable.
7. Enable and explicitly click Test connection. It sends one fixed greeting sample
   (potentially billable), not conversation/runtime contents. Failures are redacted.
8. Advanced endpoint changes direct both key and explicit state to that HTTPS
   server. Use only a trusted endpoint. The UI must not silently submit it.

## Verification limits

Unit/integration tests use mocked provider transport and real published Cordis,
settings, credentials, Gateway contracts. No production credential is required.
The live GUI at `http://127.0.0.1:3080` rejects an unauthenticated probe with HTTP 401;
that proves the listener is present, not that the new plugin is deployed. Do not
claim live GUI acceptance until it is actually loaded and observed after refresh.
