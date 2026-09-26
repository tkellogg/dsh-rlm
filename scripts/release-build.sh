#!/usr/bin/env bash
# Native app payload only. Python and its dependencies belong to the universal wheel.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
VERSION=${VERSION:-${1:-}}
VERSION=${VERSION#v}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Set VERSION to a stable release version (X.Y.Z)' >&2; exit 1; }
export VERSION
python3 - <<'PY'
import os, pathlib, tomllib
version = tomllib.loads(pathlib.Path('project/python/pyproject.toml').read_text())['project']['version']
if version != os.environ['VERSION']:
    raise SystemExit(f"Source Python version {version} does not match release {os.environ['VERSION']}")
PY
export npm_config_cache="$ROOT/.cache/npm"
export NPM_CONFIG_CACHE="$npm_config_cache"
NODE_VERSION=24.8.0
case "$(uname -s)" in Darwin) OS=darwin;; Linux) OS=linux;; *) exit 1;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64) ARCH=x64;; *) exit 1;; esac
OUT=$ROOT/dist/release
mkdir -p "$OUT"
WORK=$(mktemp -d "$OUT/.build.XXXXXXXX")
trap 'rm -rf "$WORK"' EXIT
STAGE=$WORK/stage
mkdir -p "$STAGE/runtime/node"
fetch() { curl -fLsS --retry 3 --proto '=https' --tlsv1.2 "$1" -o "$2"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
check() {
  local expected
  expected=$(awk -v name="$2" '$2 == name || $2 == "*" name {print $1}' "$1")
  [[ ${#expected} = 64 && $(sha "$3") = "$expected" ]] || { echo "Checksum failed: $2" >&2; exit 1; }
}
NODE_ASSET=node-v$NODE_VERSION-$OS-$ARCH.tar.gz
fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ASSET" "$WORK/node.tar.gz"
fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$WORK/node.sums"
check "$WORK/node.sums" "$NODE_ASSET" "$WORK/node.tar.gz"
tar -xzf "$WORK/node.tar.gz" --strip-components=1 -C "$STAGE/runtime/node"
export PATH="$STAGE/runtime/node/bin:$PATH"
node "$ROOT/scripts/package.mjs" "$STAGE"
# npm is build-time only, never an end-user installation requirement.
rm -rf "$STAGE/runtime/node/lib/node_modules" "$STAGE/runtime/node/bin/npm" "$STAGE/runtime/node/bin/npx" "$STAGE/runtime/node/bin/corepack"
printf '{"node":"%s"}\n' "$NODE_VERSION" > "$STAGE/runtime-versions.json"
for obsolete in runtime/python wheels install.sh bin/dsh-rlm; do
  [[ ! -e "$STAGE/$obsolete" ]] || { echo "Unexpected obsolete payload: $obsolete" >&2; exit 1; }
done
# Relocation catches absolute npm links; Python-console smoke is a separate CI step.
mv "$STAGE" "$WORK/relocated"
STAGE=$WORK/relocated
"$STAGE/runtime/node/bin/node" "$STAGE/launcher/cli.mjs" --version
ASSET=dsh-rlm-v$VERSION-$OS-$ARCH.tar.gz
# Publish only a complete archive; cancellation must not leave a release-looking tarball.
COPYFILE_DISABLE=1 tar -czf "$WORK/$ASSET" -C "$STAGE" .
mv "$WORK/$ASSET" "$OUT/$ASSET"
printf '%s  %s\n' "$(sha "$OUT/$ASSET")" "$ASSET" > "$OUT/$ASSET.sha256"
printf '%s\n' "$VERSION" > "$OUT/VERSION"
echo "Built $OUT/$ASSET"
