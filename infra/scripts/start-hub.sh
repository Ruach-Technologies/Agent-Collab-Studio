#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
runtime_dir="$repo_root/.runtime"
hub_pid_file="$runtime_dir/hub.pid"
hub_log_file="$runtime_dir/hub.log"
health_url="http://127.0.0.1:8791/healthz"
node_bin="${HUB_NODE_BIN:-node}"
npm_bin="${HUB_NPM_BIN:-npm}"

fail() {
  printf 'start-hub: %s\n' "$*" >&2
  exit 1
}

require_node_22() {
  command -v "$node_bin" >/dev/null 2>&1 || fail 'Node.js 22 or newer is required'
  local version major
  version="$("$node_bin" --version)"
  major="${version#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )) || fail "Node.js 22 or newer is required (found $version)"
}

pid_is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null
}

mkdir -p "$repo_root/data" "$repo_root/workspaces" "$runtime_dir"
require_node_22
command -v curl >/dev/null 2>&1 || fail 'curl is required to check hub health'

if [[ -f "$hub_pid_file" ]]; then
  existing_pid="$(<"$hub_pid_file")"
  if pid_is_running "$existing_pid"; then
    fail "hub PID file points to running process $existing_pid; use infra/scripts/stop-hub.sh before restarting"
  fi
  rm -f "$hub_pid_file"
fi

# Refuse an occupied port rather than mistaking another service for this hub.
"$node_bin" --input-type=module -e '
  import net from "node:net";
  const probe = net.createServer();
  probe.once("error", () => { console.error("start-hub: 127.0.0.1:8791 is unavailable; no process was stopped"); process.exitCode = 1; });
  probe.listen(8791, "127.0.0.1", () => probe.close());
'

needs_build=false
if [[ ! -f "$repo_root/hub/dist/server.js" ]]; then
  needs_build=true
else
  newer_files="$(find "$repo_root/hub/src" "$repo_root/hub/tsconfig.json" "$repo_root/hub/tsconfig.build.json" "$repo_root/hub/package.json" "$repo_root/package-lock.json" -type f -newer "$repo_root/hub/dist/server.js" -print)"
  [[ -z "$newer_files" ]] || needs_build=true
fi
if [[ "$needs_build" == true ]]; then
  printf 'Building hub...\n'
  (cd "$repo_root" && "$npm_bin" run build --workspace hub)
fi

needs_web_build=false
if [[ ! -f "$repo_root/web/dist/index.html" ]]; then
  needs_web_build=true
else
  newer_web_files="$(find "$repo_root/web/src" "$repo_root/web/index.html" "$repo_root/web/vite.config.ts" "$repo_root/web/tsconfig.json" "$repo_root/web/package.json" "$repo_root/package-lock.json" -type f -newer "$repo_root/web/dist/index.html" -print)"
  [[ -z "$newer_web_files" ]] || needs_web_build=true
fi
if [[ "$needs_web_build" == true ]]; then
  printf 'Building observability UI...\n'
  (cd "$repo_root" && "$npm_bin" run build --workspace web)
fi

printf 'Starting hub on 127.0.0.1:8791...\n'
nohup env HUB_HOST=127.0.0.1 HUB_PORT=8791 "$node_bin" "$repo_root/hub/dist/server.js" >>"$hub_log_file" 2>&1 &
hub_pid=$!
printf '%s\n' "$hub_pid" >"$hub_pid_file"

deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if ! pid_is_running "$hub_pid"; then
    rm -f "$hub_pid_file"
    fail "hub exited during startup; see $hub_log_file"
  fi
  if curl --noproxy '*' --connect-timeout 1 --max-time 1 --fail --silent "$health_url" >/dev/null && pid_is_running "$hub_pid"; then
    printf 'Hub is healthy: %s\n' "$health_url"
    exit 0
  fi
  sleep 1
done

if pid_is_running "$hub_pid"; then
  fail "hub did not become healthy within 30 seconds; it is still running (PID $hub_pid). See $hub_log_file"
fi
rm -f "$hub_pid_file"
fail "hub exited before becoming healthy; see $hub_log_file"
