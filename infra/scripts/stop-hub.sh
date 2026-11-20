#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
runtime_dir="$repo_root/.runtime"

fail() {
  printf 'stop-hub: %s\n' "$*" >&2
  exit 1
}

pid_is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null
}

command_for_pid() {
  ps -p "$1" -o command= 2>/dev/null || true
}

stop_recorded_process() {
  local name="$1" pid_file="$2" required_one="$3" required_two="${4:-}" pid command

  [[ -f "$pid_file" ]] || return 0
  pid="$(<"$pid_file")"
  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    printf 'stop-hub: ignoring invalid %s PID file: %s\n' "$name" "$pid_file" >&2
    return 0
  fi
  if ! pid_is_running "$pid"; then
    rm -f "$pid_file"
    return 0
  fi

  command="$(command_for_pid "$pid")"
  if [[ "$command" != *"$required_one"* ]] || { [[ -n "$required_two" ]] && [[ "$command" != *"$required_two"* ]]; }; then
    fail "refusing to stop PID $pid from $pid_file: command does not match expected $name process"
  fi

  printf 'Stopping %s (PID %s)...\n' "$name" "$pid"
  kill "$pid"
  for _ in $(seq 1 10); do
    if ! pid_is_running "$pid"; then
      rm -f "$pid_file"
      return 0
    fi
    sleep 1
  done

  fail "$name PID $pid did not exit after SIGTERM; refusing to escalate automatically"
}

stop_recorded_process 'ngrok tunnel' "$runtime_dir/tunnel.pid" 'ngrok' "$repo_root/infra/ngrok/agent-collab-hub.yml"
stop_recorded_process 'hub' "$runtime_dir/hub.pid" 'node' "$repo_root/hub/dist/server.js"
rm -f "$runtime_dir/tunnel-url"
printf 'Recorded hub processes stopped.\n'
