# Installation verification report

## Current browser verification (0.1.1 preparation)

Published 0.1.0 exists on PyPI and GitHub for macOS arm64. A fresh published-wheel
install downloaded/checksummed/extracted its native payload and passed doctor/config
compilation. Real Chrome subsequently reproduced its empty onboarding directory.

The exact browser exception was `cannot get property "remote" without inject`:
our client declared remote namespaces but omitted the parent `remote` service.
Adding that declaration fixes the scoped Cordis context. Chrome on an isolated
patched native instance lists 45 providers and successfully opens Models and
Subscriptions (five subscription provider rows). Provider-directory, model-catalog,
and subscription-status requests returned HTTP 200. No provider login or paid
inference was performed. Existing servers on ports 3080 and 3081 were untouched.

The revised UI also preserves provider discovery when settings/catalog/credential
reads fail and offers authentication settings without requiring provider selection.
18 onboarding tests against installed host dependencies pass; all 244 Python tests
pass for the prepared 0.1.1 wheel. The exact newly extracted 0.1.1 archive launched
through its real wheel also passed Chrome assertions in two fresh homes: 45
providers, API settings navigation, and subscription settings/login actions.
The installed 0.1.0 UI does not change until the process is upgraded and restarted.

## Earlier installer verification history

The following records describe earlier checkpoints, not current release blockers.

## Passed

- 244 Python tests: 159 runtime tests plus 85 installer/CLI cases.
- 78 RLM host-plugin tests, including real Python bridge lifecycles.
- 4 internal JavaScript launcher tests and 2 uv-wrapper tests.
- 17 combined installation/onboarding checks with zero skips: 5 launcher transport
  fixtures, 10 onboarding logic tests, actual DSH Loader/ClientModuleRegistry
  discovery, and actual installed subscription Fetch/RPC handling with fixture accounts.

The last checks verify real API shapes, not browser rendering or actual authentication.
Launcher transport fixtures use a spy rather than claiming that real DSH booted.

## Reproduced defects fixed

1. Symlinked launcher paths (including macOS /var alias) silently exited successfully.
   Canonical realpath comparison fixes the entry guard.
2. Truncated gzip leaked uncaught EOFError; now returns a controlled error.
3. Releases appearing while waiting for the install lock skipped directory ownership
   and symlink checks. The post-lock path now validates them identically.
4. Interrupted native archive creation left a release-named partial tarball. The
   builder now stages the archive and moves it only after successful compression.

## Stress coverage

Four real concurrent Python processes install once with one download pair. SIGKILL
between extraction and publication leaves no partial final release; a fresh process
recovers. Real flock timeout/reacquisition passes. Malformed archives, bounds,
checksums, traversal, devices, hardlinks, symlink chains/escapes/cycles/parent ordering,
duplicate entries and permission failures have regression tests. Cache manifests,
executable permissions, versions/platforms and failed-install retries are covered.

Relocated paths with spaces, empty PATH, symlinked installs, preserved cwd, persistent
profile/settings/credential fixture contents and permissions pass. Revoked provider
status and failed default-setting writes cannot become successful setup.

## Observed limits

SIGKILL leaves an orphan private staging directory; recovery safely ignores it.
Automatic orphan reclamation is not implemented.

Real wheel/sdist builds and uv installations now pass. Native dependency composition
is resolved without force/legacy-peer flags using a uniform tested host version.
0.1.1 native build, production archive checksum/extraction, and 23 relocated
launcher/onboarding checks passed, plus doctor and DSH configuration compilation.

Still unverified: real provider login and RLM inference, upgrade behavior with
real authenticated user state, and additional platform builds. Browser navigation
alone is not proof of provider authentication or model access.
