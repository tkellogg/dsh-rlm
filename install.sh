#!/bin/sh
# Optional convenience entry point; uv owns installation and Python provisioning.
set -eu
if ! command -v uv >/dev/null 2>&1; then
  printf '%s\n' 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
fi
exec uv tool install dsh-rlm "$@"
