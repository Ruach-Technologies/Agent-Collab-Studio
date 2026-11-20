#!/bin/sh
# Starts one hardened sidekick container and runs the empirical checks for
# Claude Code and then the Codex CLI.
# Never signs in: the Claude sign-in step writes a bogus code, the Codex
# device sign-in is cancelled before anyone could enter its code, and the
# turns run signed out. Copy the docker flags from here into
# hub/src/sidekicks.ts.
#
# Usage: HUB_TOKEN=... sidekick/probe.sh [hub-url]
#   hub-url defaults to http://host.docker.internal:8792/mcp
#   HUB_TOKEN is optional; it is passed to docker by name only, never printed.
set -eu

IMAGE=${IMAGE:-ach-sidekick:dev}
NAME=ach-sidekick-probe-$$
VOLUME=ach-sidekick-probe-home-$$
HUB_MCP_URL=${1:-http://host.docker.internal:8792/mcp}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ach-sidekick-probe.XXXXXX")

cleanup() {
  [ -n "${WRITER_PID:-}" ] && kill "$WRITER_PID" 2>/dev/null || true
  [ -n "${DEVICE_PID:-}" ] && kill "$DEVICE_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

step() { printf '\n== %s\n' "$*"; }

# ---- Recommended run flags -------------------------------------------------
# Writable paths Claude Code needs under --read-only (observed, v2.1.311):
#   /home/sidekick   ~/.claude.json, ~/.claude/ (credentials, sessions,
#                    backups, plugins), ~/.cache/claude-cli-nodejs (MCP logs)
#   /tmp             $TMPDIR/claude-<uid>/ (fatal EROFS without it), cc-socks
step "docker run"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" --init \
  --network bridge \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 1024m --memory-swap 1024m --cpus 1 --pids-limit 256 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --user 1000:1000 --log-driver none \
  --mount "type=volume,src=$VOLUME,dst=/home/sidekick" \
  --workdir /opt/sidekick/work \
  "$IMAGE" >/dev/null
docker exec "$NAME" sh -c 'id; env | grep -c "^ANTHROPIC_" || true'

step "claude --version"
docker exec "$NAME" claude --version

step "claude auth status (signed out)"
set +e
docker exec "$NAME" claude auth status
echo "exit=$?"
set -e

step "writable paths"
docker exec "$NAME" sh -c '
  for p in /home/sidekick /home/sidekick/.codex /tmp /opt/sidekick/work /etc/claude-code /etc/codex /usr/local; do
    if touch "$p/.w" 2>/dev/null; then rm -f "$p/.w"; echo "writable  $p"; else echo "read-only $p"; fi
  done'

# ---- Sign-in through a pseudo-terminal ---------------------------------------
# `script` allocates the pty; stdin stays a pipe the hub writes the code into.
step "claude auth login under script (bogus code)"
mkfifo "$WORK/in"
docker exec -i "$NAME" script -qefc "claude auth login" /dev/null <"$WORK/in" >"$WORK/login.out" 2>&1 &
LOGIN_PID=$!
exec 3>"$WORK/in"
i=0
until grep -q 'Paste code here' "$WORK/login.out" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "no prompt after 30s"; break; }
  sleep 0.5
done
echo "prompt after ~$((i / 2))s"
# Same pattern as the hub regex: strip ESC/BEL/CR so OSC 8 wrappers split off.
URL=$(LC_ALL=C tr '\033\007\r' '\n\n\n' <"$WORK/login.out" \
  | LC_ALL=C grep -Eo "https://[^[:space:]\"'<>]+/oauth/authorize\?[^[:space:]\"'<>]+" | head -n 1 || true)
echo "url host+path: $(printf '%s' "$URL" | sed -E 's#\?.*##')  (length ${#URL}; not opened)"
printf 'invalid\r' >&3
sleep 3
printf 'bogus#bogus\r' >&3
set +e
wait "$LOGIN_PID"
echo "exit=$?"
set -e
exec 3>&-
LC_ALL=C sed -E 's/(state|code_challenge)=[A-Za-z0-9_-]+/\1=REDACTED/g' "$WORK/login.out" | LC_ALL=C cat -v | cut -c1-160

# ---- Headless turn ------------------------------------------------------------
step "headless turn (signed out)"
MCP_JSON=$(printf '{"mcpServers":{"hub":{"type":"http","url":"%s","headers":{"Authorization":"Bearer ${HUB_TOKEN}"}}}}' "$HUB_MCP_URL")
set +e
printf 'hello' | docker exec -i -e HUB_TOKEN -w /opt/sidekick/work "$NAME" \
  claude -p \
    --output-format stream-json --verbose \
    --strict-mcp-config --mcp-config "$MCP_JSON" \
    --tools "" --allowedTools 'mcp__hub__*' \
    --permission-mode dontAsk --permission-prompts none \
    --disable-slash-commands \
  >"$WORK/turn.jsonl" 2>"$WORK/turn.err"
echo "exit=$?"
set -e
if command -v jq >/dev/null 2>&1; then
  jq -c 'select(.type=="system" and .subtype=="init") | {tools, mcp_servers, apiKeySource, permissionMode, slash_commands, skills, cwd, claude_code_version}' "$WORK/turn.jsonl"
  jq -c 'select(.type!="system") | {type, subtype, error, is_error, result, terminal_reason}' "$WORK/turn.jsonl"
else
  cut -c1-400 "$WORK/turn.jsonl"
fi
cut -c1-400 "$WORK/turn.err"

# ==== Codex CLI ===============================================================
# Same container. CODEX_HOME=/home/sidekick/.codex (home volume); system config
# /etc/codex/config.toml, enforced /etc/codex/requirements.toml.
step "codex --version"
docker exec "$NAME" codex --version

step "CODEX_HOME"
docker exec "$NAME" sh -c 'echo "CODEX_HOME=$CODEX_HOME"; ls -ld "$CODEX_HOME"'

step "codex login status (signed out)"
set +e
docker exec "$NAME" codex login status
echo "exit=$?"
set -e

# ---- Device-code sign-in ------------------------------------------------------
# Prints a URL and a one-time code, then polls until the code is used or
# expires (15 min). The code is masked here and never entered; the login is
# cancelled with Ctrl-C (\003) through the pty, which exits 130.
step "codex login --device-auth under script (cancelled)"
mkfifo "$WORK/cin"
docker exec -i "$NAME" script -qefc "codex login --device-auth" /dev/null <"$WORK/cin" >"$WORK/device.out" 2>&1 &
DEVICE_PID=$!
exec 4>"$WORK/cin"
i=0
until LC_ALL=C grep -Eq '[A-Z0-9]{4}-[A-Z0-9]{5}' "$WORK/device.out" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "no code after 30s"; break; }
  sleep 0.5
done
echo "code after ~$((i / 2))s"
ESC=$(printf '\033')
LC_ALL=C tr -d '\r' <"$WORK/device.out" | LC_ALL=C sed "s/${ESC}\[[0-9;]*m//g" >"$WORK/device.txt"
DURL=$(LC_ALL=C grep -Eo 'https://[^[:space:]]+/codex/device[^[:space:]]*' "$WORK/device.txt" | head -n 1 || true)
DCODE=$(LC_ALL=C grep -Eo '[A-Z0-9]{4}-[A-Z0-9]{5}' "$WORK/device.txt" | head -n 1 || true)
echo "url: $DURL  (not opened)"
echo "code: $(printf '%s' "$DCODE" | sed 's/[A-Z0-9]/X/g')  (masked; never entered)"
printf '\003' >&4
set +e
wait "$DEVICE_PID"
echo "exit=$?"
set -e
DEVICE_PID=
exec 4>&-
sed -E 's/[A-Z0-9]{4}-[A-Z0-9]{5}/XXXX-XXXXX/' "$WORK/device.txt" | LC_ALL=C cat -v | cut -c1-160

# ---- Headless turn ------------------------------------------------------------
# required=true makes a failed hub MCP connection fatal before any model call.
step "codex exec turn (signed out)"
HUB_CFG="mcp_servers.hub={url=\"$HUB_MCP_URL\",bearer_token_env_var=\"HUB_TOKEN\",required=true}"
set +e
printf 'hello' | docker exec -i -e HUB_TOKEN -w /opt/sidekick/work "$NAME" \
  codex exec --json --skip-git-repo-check --ignore-user-config -c "$HUB_CFG" - \
  >"$WORK/cturn.jsonl" 2>"$WORK/cturn.err"
echo "exit=$?"
set -e
cut -c1-300 "$WORK/cturn.jsonl"
grep -v responses_websocket "$WORK/cturn.err" | cut -c1-300 || true

step "codex requirements reject loosening overrides"
for flag in '-s danger-full-access' '--dangerously-bypass-approvals-and-sandbox'; do
  set +e
  # shellcheck disable=SC2086
  docker exec -i "$NAME" codex exec --json --skip-git-repo-check --ignore-user-config $flag - \
    </dev/null >/dev/null 2>"$WORK/req.err"
  echo "$flag => exit=$? $(head -c 160 "$WORK/req.err")"
  set -e
done

# ---- Tool surface --------------------------------------------------------------
# Signed out, nothing reaches OpenAI, so point Codex at a local fake Responses
# endpoint inside the container and record the tools it would send.
step "codex tool surface (fake local model; no OpenAI traffic)"
docker exec -i "$NAME" sh -c 'cat > /tmp/fake-responses.js' <<'JS'
const http = require('http'); const fs = require('fs'); let n = 0;
http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  n += 1; fs.writeFileSync('/tmp/fake-req-' + n + '.json', b);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (t, o) => res.write('event: ' + t + '\ndata: ' + JSON.stringify({ type: t, ...o }) + '\n\n');
  ev('response.created', { response: { id: 'r' + n } });
  ev('response.output_item.done', { item: { type: 'message', role: 'assistant', id: 'm' + n, content: [{ type: 'output_text', text: 'ok' }] } });
  ev('response.completed', { response: { id: 'r' + n, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
  res.end(); }); }).listen(18080, '127.0.0.1');
JS
docker exec -d "$NAME" node /tmp/fake-responses.js
sleep 1
for model in gpt-6.2-sol gpt-5.5; do
  docker exec "$NAME" sh -c 'rm -f /tmp/fake-req-*.json'
  set +e
  printf 'hello' | docker exec -i -e HUB_TOKEN -e FAKE_KEY=unused -w /opt/sidekick/work "$NAME" \
    codex exec --json --skip-git-repo-check --ignore-user-config --ephemeral -c "$HUB_CFG" \
      -c 'model_providers.fake={name="fake",base_url="http://127.0.0.1:18080/v1",env_key="FAKE_KEY",wire_api="responses"}' \
      -c 'model_provider="fake"' -c "model=\"$model\"" - >/dev/null 2>"$WORK/fake.err"
  echo "$model exit=$?"
  set -e
  docker exec "$NAME" node -e '
    const fs = require("fs");
    const last = fs.readdirSync("/tmp").filter((f) => /^fake-req-\d+\.json$/.test(f)).sort((x, y) => parseInt(x.slice(9)) - parseInt(y.slice(9))).pop();
    const b = JSON.parse(fs.readFileSync("/tmp/" + last, "utf8"));
    const extra = (b.input || []).filter((i) => i.type === "additional_tools").flatMap((i) => i.tools || []);
    const top = [...(b.tools || []), ...extra];
    const flat = top.flatMap((t) => (t.type === "namespace" ? (t.tools || []).map((x) => t.name + "." + x.name) : [t.name || t.type]));
    console.log("  model-visible tools:", flat.join(" "));
    const ex = top.flatMap((t) => (t.type === "namespace" ? t.tools || [] : [t])).find((t) => t.name === "exec" && t.type === "custom");
    if (ex) console.log("  code-mode nested tools:", [...ex.description.matchAll(/^### `([^`]+)`/gm)].map((m) => m[1]).join(" "));
    const dev = (b.input || []).map((i) => (i.content || []).map((c) => c.text || "").join("")).join("\n");
    const ns = dev.match(/Deferred tool namespaces:\n([^<]*)/);
    if (ns) console.log("  deferred:", ns[1].trim().replace(/\n/g, " | "));' || true
done

step "codex files written"
docker exec "$NAME" sh -c 'find "$CODEX_HOME" -path "$CODEX_HOME/tmp" -prune -o -type f -print | sort; ls "$CODEX_HOME/tmp" 2>/dev/null'
if [ -n "${HUB_TOKEN:-}" ]; then
  docker exec -e HUB_TOKEN "$NAME" sh -c 'echo "files containing HUB_TOKEN: $(grep -rlF "$HUB_TOKEN" /home/sidekick /tmp 2>/dev/null | wc -l)"'
fi
