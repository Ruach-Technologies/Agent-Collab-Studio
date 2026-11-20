#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
runtime_dir="$repo_root/.runtime"
tunnel_pid_file="$runtime_dir/tunnel.pid"
tunnel_log_file="$runtime_dir/tunnel.log"
tunnel_url_file="$runtime_dir/tunnel-url"
ngrok_config="$HOME/Library/Application Support/ngrok/ngrok.yml"
tunnel_config="$repo_root/infra/ngrok/agent-collab-hub.yml"
node_bin="${HUB_NODE_BIN:-node}"
ngrok_bin="${HUB_NGROK_BIN:-ngrok}"

fail() {
  printf 'start-tunnel: %s\n' "$*" >&2
  exit 1
}

pid_is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null
}

mkdir -p "$runtime_dir"
command -v "$node_bin" >/dev/null 2>&1 || fail 'Node.js 22 or newer is required'
"$node_bin" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || fail 'Node.js 22 or newer is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required to check hub and ngrok health'
command -v "$ngrok_bin" >/dev/null 2>&1 || fail 'ngrok is required; install and authenticate it before starting the tunnel'
[[ -f "$ngrok_config" ]] || fail "ngrok configuration is missing: $ngrok_config"
[[ -f "$tunnel_config" ]] || fail "tunnel configuration is missing: $tunnel_config"

if ! curl --noproxy '*' --connect-timeout 1 --max-time 2 --fail --silent http://127.0.0.1:8791/healthz >/dev/null; then
  fail 'hub health check failed at http://127.0.0.1:8791/healthz; run infra/scripts/start-hub.sh first'
fi

if [[ -f "$tunnel_pid_file" ]]; then
  existing_pid="$(<"$tunnel_pid_file")"
  if pid_is_running "$existing_pid"; then
    fail "tunnel PID file points to running process $existing_pid; use infra/scripts/stop-hub.sh before restarting"
  fi
  rm -f "$tunnel_pid_file"
fi
# The hub agent serves its inspection API on a dedicated port (web_addr in the
# repository tunnel config). A pre-existing listener there must not be confused
# with this invocation; other ngrok agents on the default 4040 are unaffected.
"$node_bin" --input-type=module -e '
  import net from "node:net";
  const probe = net.createServer();
  probe.once("error", () => { console.error("start-tunnel: 127.0.0.1:4045 is unavailable; no process was stopped"); process.exitCode = 1; });
  probe.listen(4045, "127.0.0.1", () => probe.close());
'
rm -f "$tunnel_url_file"

printf 'Starting ngrok tunnel...\n'
local_config="$repo_root/infra/ngrok/local.yml"
extra_config=()
[[ -f "$local_config" ]] && extra_config=(--config "$local_config")
nohup "$ngrok_bin" start --config "$ngrok_config" --config "$tunnel_config" "${extra_config[@]+"${extra_config[@]}"}" agent-collab-hub >>"$tunnel_log_file" 2>&1 &
tunnel_pid=$!
printf '%s\n' "$tunnel_pid" >"$tunnel_pid_file"

deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if ! pid_is_running "$tunnel_pid"; then
    rm -f "$tunnel_pid_file"
    fail "ngrok exited during startup; see $tunnel_log_file"
  fi
  if api_json="$(curl --noproxy '*' --connect-timeout 1 --max-time 1 --fail --silent http://127.0.0.1:4045/api/tunnels 2>/dev/null)"; then
    public_url="$("$node_bin" -e '
      let body = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        try {
          const tunnel = JSON.parse(body).tunnels?.find((item) => item.name === "agent-collab-hub" && typeof item.public_url === "string");
          if (!tunnel) return;
          const url = new URL(tunnel.public_url);
          if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) process.stdout.write(url.href);
        } catch {}
      });
    ' <<<"$api_json")"
    if [[ -n "$public_url" ]] && pid_is_running "$tunnel_pid"; then
      printf '%s\n' "$public_url" >"$tunnel_url_file"
      printf 'Tunnel is ready; public URL written to %s\n' "$tunnel_url_file"
      exit 0
    fi
  fi
  if ! pid_is_running "$tunnel_pid"; then
    rm -f "$tunnel_pid_file"
    fail "ngrok exited during startup; see $tunnel_log_file"
  fi
  sleep 1
done

if pid_is_running "$tunnel_pid"; then
  fail "ngrok did not expose an HTTPS URL within 30 seconds; it is still running (PID $tunnel_pid). See $tunnel_log_file"
fi
rm -f "$tunnel_pid_file"
fail "ngrok exited before exposing an HTTPS URL; see $tunnel_log_file"
