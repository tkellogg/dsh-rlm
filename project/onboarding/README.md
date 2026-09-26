# Provider-neutral dsh-rlm onboarding

Installable `@dsh-rlm/onboarding` Cordis bundle with a prebuilt browser entry. Build and test with `npm test`; package with `npm pack`. The build uses Node only and does not depend on the installed DSH checkout. Include this package in the standalone app profile and activate its bundled patch. Do not install into an existing personal profile as part of the app build.

## Integration contract

Retain DSH `@deepseek-ai/dsh-client-ui-settings-models` and the Settings shell. This package registers the **same** `settings.onboarding` list cell, `deepseek-official`, at priority **-100** (DSH ascending cell shadow rank); it does not remove, fork, or replace Models settings or the welcome notice. Tested against the installed 0.1.6-alpha.2 contract. It adds Settings → **Setup** (`dsh-rlm-setup`) so users can resume or reconfigure at any time. `dsh-rlm setup` should launch the app and direct users there; no environment flag or private bootstrap patch is required.

Host requirements: `llm`, session model catalog, credentials, writable settings, `agent-default-model`, and the normal Web client modules. The host half intentionally adds no service; all authority remains in existing host adapters. The package contains a Cordis self-activation patch and a prebuilt module-loader client entry.

## Flow and truthful support

1. Choose from the host's live/configurable provider directory, including inactive declarations clearly labelled as such. No list of fictitious supported API providers is shipped.
2. Authenticate through the installed adapter's own UI. API-key configuration stays in **Models**. Installed subscription routes `codex`, `claude`, `grok`, `copilot`, and `antigravity` delegate to **Subscriptions** from `dsh-plugin-subscriptions` (inspected version 0.9.2). The plugin owns OAuth/device flow/manual callback/import support and its platform restrictions. This package neither collects secrets nor duplicates login RPCs. Unknown/custom routes use Models; there is no claim of universal OAuth support.
3. Return to **Setup**, refresh, select an advertised model, and save the future-agent default. This uses revision-fenced settings mutation, clears incompatible reasoning effort, and confirms the persisted value. Existing session selections are not changed.

A model catalog or registered route alone does **not** prove authentication. API-key references must report configured; recognized subscription routes must report stored accounts. External-auth routes (ADC/local/environment/chain) require an explicit acknowledgement and remain labelled unverified. Save rechecks the host facts. Stored credentials, cached catalogs and user acknowledgements are not network tests; the UI says so, including after successful persistence. No inference request is made.

Opening authentication settings and “Configure later (not complete)” only dismiss the transient shell step; neither writes a success flag. Existing explicitly saved defaults bypass the modal only if the current facts include their advertised model and stored credentials/account. External-auth defaults remain unverified and do not auto-bypass. Setup is always available in Settings. Auth handoff requires manually returning to Setup because Settings section props expose no cross-section navigation callback; no shell/DOM workaround is used.

## Verification and limits

Node tests cover registration, provider/auth state joins, fail-closed subscription status, API references, external-auth acknowledgement, inactive adapters, read-only settings, revision fencing, stale reasoning cleanup, and write readback failure. Browser rendering and real login/network inference require an isolated installed-app smoke test; this package does not alter the running GUI, existing profiles, or installed dependencies. UI copy is currently English. Credentials revoked after a check or unavailable model access still surface from the adapter during actual inference.
