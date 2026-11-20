#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || { printf 'smoke: Node.js 22 or newer is required\n' >&2; exit 1; }
if [[ -z "${HUB_TOKEN:-}" ]]; then
  printf 'smoke: set HUB_TOKEN to a staff token (it will not be printed)\n' >&2
  exit 1
fi
exec node "$script_dir/smoke-e2e.mjs"
