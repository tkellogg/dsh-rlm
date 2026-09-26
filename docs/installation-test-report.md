# Installation verification report

Local macOS arm64 testing; no publication, real provider login, or replacement server.

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

The earlier cache restriction is resolved. `uv build` now builds a real wheel and
sdist; `uv tool run --from <wheel>` help/version and an isolated persistent
`uv tool install <wheel>` succeeded. The sdist was found to include a local uv
cache; an explicit source allowlist fixes it, and the rebuilt archive has 33
entries with no cache/venv paths. Full app verification still needs native assets.

Fresh native npm resolution exposed two dependency problems: newer Cordis components
conflict with pinned 4.0.2, and subscriptions 0.9.2 selects older DSH 0.1.2 peers beside
0.1.6. Vendor pins address the first; coordinated overrides/explicit root deps still
fail npm ERESOLVE for dsh-brand/dsh-user-approval. No --force or --legacy-peer-deps was
used to hide this. The dependency graph remains a release blocker. An obsolete build
with mixed host versions was cancelled, and its partial archive removed.

Release gates still open: clean dependency composition and lockfile, real wheel/native
archive smoke tests, browser login and RLM turn, and Linux/x64/macOS matrix acceptance.
No GitHub or PyPI assets were published. No uv publish credentials were needed yet.
