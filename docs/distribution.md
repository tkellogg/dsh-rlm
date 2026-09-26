# Distribution through PyPI and uv

## User entry points

```sh
uvx dsh-rlm
uvx dsh-rlm setup
uvx dsh-rlm doctor
```

For a persistent executable, use `uv tool install dsh-rlm`, then `dsh-rlm`.
Upgrade with `uvx --upgrade dsh-rlm` or `uv tool upgrade dsh-rlm`.
Install uv using its official instructions if missing. The optional repository
bootstrap simply delegates to `uv tool install`; it does not own another installer.

## What ships where

- **PyPI `dsh-rlm`:** universal Python wheel/sdist with runtime, console entry point,
  and secure first-run application provisioning. uv supplies the compatible Python.
- **GitHub Releases `tkellogg/dsh-rlm`:** version-matched platform archives with
  private Node, prebuilt DSH application, plugins, and internal JavaScript launcher.
- **npm:** public upstream dependencies are fetched by release CI only. No custom
  package publication or user npm login is needed.

Native builds resolve `DSH_VERSION=latest` by default (and `SUBSCRIPTIONS_VERSION=latest`), recording the concrete selected versions. Set either variable explicitly to override at build time. The installed wheel selects the matching built bundle, not a silently changing host on each startup.

The wheel version selects an exact immutable GitHub tag, never `latest`. A fresh
launch downloads SHA256SUMS and the matching archive, verifies it, safely extracts
to staging, validates the payload and publishes it atomically under an application
cache. Interrupted provisioning does not replace a working version. A per-version
lock prevents simultaneous installs. Checksums from the same release channel
protect integrity but are not an independent publisher signature.

The native archive contains `runtime/node/bin/node`, `app/`, `launcher/cli.mjs`,
and `release.json`. It intentionally has no second Python runtime. The Python
entry point supplies its own `sys.executable` as `DSH_RLM_PYTHON` to the JS launcher.
Normal startup never runs npm or builds source.

## Storage and isolation

The application cache is outside uv's tool cache. Deleting it can require a fresh
download, but does not erase credentials or conversations. User data defaults to
`$XDG_DATA_HOME/dsh-rlm/user` or `~/.local/share/dsh-rlm/user`, overridden by
`DSH_RLM_HOME`. Python checkpoints live under `rlm-state` there unless
`DSH_RLM_STATE_DIR` is explicitly set. Ordinary `DSH_HOME` is not silently reused.

The invoking directory remains the workspace. Profile initialization creates
missing files only, preserving user preferences. RLM is the deployment default;
explicit user settings may override it. Authentication remains handled by DSH
and its installed adapters; setup does not fabricate authentication success.

`DSH_RLM_APP_DIR` is a developer override pointing to a prepared native release
root; it avoids downloads but still requires a compatible manifest. `doctor`,
`--help`, and `--version` do not provision missing application assets. `setup`
launches the Web app; Settings → Setup remains available to revisit login/model
selection. No billable inference occurs merely to display setup.

## Release order

1. Build/test the Python wheel and native archives on all four target platforms.
2. Smoke-test the local wheel with uv against a relocated native archive, including
   profile configuration compilation with `--dump-config` (no Web server).
3. Publish the matching GitHub assets and checksum manifest.
4. Publish the matching Python wheel/sdist to PyPI, using configured Trusted
   Publishing. The PyPI workflow must verify native assets exist first.
5. Verify a clean `uvx dsh-rlm` invocation, browser provider selection, actual
   non-DeepSeek login, an RLM Python turn, and restart persistence.

Initial targets are macOS and glibc Linux on arm64/x64, not native Windows or
Alpine/musl. Native transitive dependencies are resolved at build time and shipped
with their lockfile; full build reproducibility still needs a maintained
application lockfile and upstream runtime digest manifest.

## Published experimental release

GitHub v0.1.0 is published for macOS arm64 only. A fresh public-wheel install downloaded the native archive, verified SHA256, extracted it with the production installer, and compiled DSH configuration successfully. Local wheel and sdist installations through uv both passed. PyPI 0.1.0 was subsequently published and its wheel/sdist availability verified. Native DSH resolves latest to 0.1.5-rc.3 and subscriptions to 0.9.4; latest and development-host plugin tests both pass. Browser login/inference and other platforms remain unverified.

## Earlier validation history (superseded by the published test above)

See [the installation test report](installation-test-report.md) for current evidence and release blockers.

Local validation passed: 244 Python tests (including 85 provisioning/CLI tests),
4 internal JavaScript launcher tests, and 2 uv bootstrap tests. Module help/version
and shell/JavaScript syntax checks also passed. The Python wheel build itself
was stopped by an outside-workspace uv cache denial; approval was cancelled.
The package entry point, uv documentation, and release workflows are implemented. No PyPI upload, GitHub publication, completed
native artifact acceptance, or real browser authentication test is claimed.
Subsequent native builds reached dependency composition and exposed incompatible
subscription/host peer resolution. This remains a release blocker; no force-install
flags were used to conceal it. Native archives have not passed acceptance.
