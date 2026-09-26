#!/usr/bin/env bash
# Test the real Python console and native payload without starting a Web server.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARCHIVE=${1:?usage: release-smoke.sh path/to/app.tar.gz path/to/dsh_rlm.whl}
WHEEL=${2:?usage: release-smoke.sh path/to/app.tar.gz path/to/dsh_rlm.whl}
ARCHIVE=$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")
WHEEL=$(cd "$(dirname "$WHEEL")" && pwd)/$(basename "$WHEEL")
[[ -f "$ARCHIVE" && -f "$WHEEL" ]] || { echo 'Archive and wheel must exist' >&2; exit 1; }
UV=$(command -v uv)
WORK=$(mktemp -d "$ROOT/.release-smoke.XXXXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/extracted" "$WORK/home"
tar -xzf "$ARCHIVE" -C "$WORK/extracted"
mv "$WORK/extracted" "$WORK/relocated app"
export HOME="$WORK/home" XDG_DATA_HOME="$WORK/home/.local/share" XDG_CONFIG_HOME="$WORK/home/.config"
export UV_TOOL_DIR="$WORK/tools" UV_TOOL_BIN_DIR="$WORK/bin"
unset DSH_HOME DSH_RLM_HOME DSH_RLM_PYTHON DSH_RLM_STATE_DIR DSH_RLM_VERSION DSH_RLM_RELEASE_URL PYTHONPATH
export DSH_RLM_APP_DIR="$WORK/relocated app"
for obsolete in runtime/python wheels install.sh bin/dsh-rlm; do
  [[ ! -e "$DSH_RLM_APP_DIR/$obsolete" ]] || { echo "Unexpected obsolete payload: $obsolete" >&2; exit 1; }
done
# Use actual packaged host libraries for client discovery and subscription contract tests.
export DSH_NODE_MODULES="$DSH_RLM_APP_DIR/app/node_modules"
export DSH_SUBSCRIPTIONS_DIR="$DSH_NODE_MODULES/dsh-plugin-subscriptions"
"$DSH_RLM_APP_DIR/runtime/node/bin/node" --test "$ROOT/scripts/release-test-launcher.mjs" "$ROOT"/project/onboarding/test/*.test.mjs
# Local wheel, not a source-tree import or fake launcher. uv resolves wheel dependencies.
"$UV" tool run --from "$WHEEL" dsh-rlm --help
"$UV" tool run --from "$WHEEL" dsh-rlm --version
"$UV" tool run --from "$WHEEL" dsh-rlm doctor
"$UV" tool run --from "$WHEEL" dsh-rlm --dump-config > "$WORK/config.yml"
[[ -s "$WORK/config.yml" ]] || { echo 'Empty compiled DSH config' >&2; exit 1; }
echo 'Local wheel console, relocated native app, doctor and DSH config compilation passed.'
