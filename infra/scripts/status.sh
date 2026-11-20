#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
runtime_dir="$repo_root/.runtime"

show_process() {
  local name="$1" file="$2" expected_one="$3" expected_two="$4" pid command
  if [[ ! -f "$file" ]]; then
    printf '%s: not recorded\n' "$name"
    return
  fi
  pid="$(<"$file")"
  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    printf '%s: stale or invalid PID file\n' "$name"
    return
  fi
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" == *"$expected_one"* && "$command" == *"$expected_two"* ]]; then
    printf '%s: running (PID %s)\n' "$name" "$pid"
  else
    printf '%s: PID %s belongs to a different command; no action taken\n' "$name" "$pid"
  fi
}

show_process 'hub' "$runtime_dir/hub.pid" 'node' "$repo_root/hub/dist/server.js"
show_process 'tunnel' "$runtime_dir/tunnel.pid" 'ngrok' "$repo_root/infra/ngrok/agent-collab-hub.yml"
if command -v curl >/dev/null 2>&1 && curl --noproxy '*' --connect-timeout 1 --max-time 2 --fail --silent http://127.0.0.1:8791/healthz >/dev/null; then
  printf 'health: healthy at http://127.0.0.1:8791/healthz\n'
else
  printf 'health: unavailable\n'
fi
if [[ -s "$runtime_dir/tunnel-url" ]]; then
  printf 'public HTTPS URL: recorded in %s\n' "$runtime_dir/tunnel-url"
fi
