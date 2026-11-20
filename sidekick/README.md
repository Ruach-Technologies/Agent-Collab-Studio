# Sidekick image

One container per client sidekick, running the official, unmodified Claude Code
CLI signed in with that client's own Claude subscription, or the Codex CLI
signed in with their ChatGPT plan (see "Codex CLI" below). The hub drives it
with `docker exec`. Observed behaviour below is for Claude Code 2.1.311 on
Docker Desktop for macOS (arm64).

## Build

```sh
docker build -t ach-sidekick:dev sidekick/
```

- `node:22-bookworm-slim` plus `ca-certificates`; `script` comes from `bsdutils`.
- Claude Code is installed with `npm install -g @anthropic-ai/claude-code@2.1.311`
  (override with `--build-arg CLAUDE_CODE_VERSION=...`). npm puts the native
  binary in `/usr/local`, inside the read-only image. The native installer
  writes to `~/.local`, which the per-sidekick home volume would shadow and
  freeze at whatever version first populated it.
- `/etc/claude-code/managed-settings.json` denies every built-in tool, allows
  `mcp__hub__*`, defaults to `dontAsk`, disables bypass mode, hooks and
  claude.ai connectors, and makes managed permission rules the only ones.
- Env: `DISABLE_AUTOUPDATER=1`, `DISABLE_UPDATES=1`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`,
  `DISABLE_ERROR_REPORTING=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`,
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. No `ANTHROPIC_*` variable is set.
- Runs as `sidekick` (1000:1000), home `/home/sidekick`, workdir
  `/opt/sidekick/work` (empty, root-owned), command `sleep infinity`.

## Run

```sh
docker volume create ach-sidekick-home-<id>
docker run -d --name ach-sidekick-<id> --init \
  --network bridge \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 1024m --memory-swap 1024m --cpus 1 --pids-limit 256 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --user 1000:1000 --log-driver none \
  --mount type=volume,src=ach-sidekick-home-<id>,dst=/home/sidekick \
  --workdir /opt/sidekick/work \
  ach-sidekick:dev
```

Writable paths Claude Code needs under `--read-only`:

| Path | Why | Without it |
| --- | --- | --- |
| `/tmp` (tmpfs) | `claude-<uid>/` scratch dir, `cc-socks/` | `claude -p` dies: `EROFS: read-only file system, mkdir '/tmp/claude-1000'` |
| `/home/sidekick` (volume) | `~/.claude.json`, `~/.claude/` (login `.credentials.json`, sessions, backups, plugin store), `~/.cache/claude-cli-nodejs/` (MCP logs) | runs, but logs EROFS on every config write and cannot keep a login |

`CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_TMPDIR` are not needed with this layout.
`--network bridge` is required: the CLI needs egress to Anthropic, and
`host.docker.internal` reaches the hub on the host's 127.0.0.1 under Docker
Desktop. `--init` makes `docker stop` immediate.

## Sign-in

```sh
docker exec -i ach-sidekick-<id> script -qefc "claude auth login" /dev/null
```

- Prints `Opening browser to sign in…`, then
  `If the browser didn't open, visit: <URL>`, then
  `Paste code here if prompted > ` and waits for a line on stdin.
- Under `script` the URL is wrapped in an OSC 8 hyperlink
  (`ESC ]8;; URL BEL URL ESC ]8;; BEL`), lines end in `\r\n`, and the output
  ends with `ESC [?25h`. No line wrapping was observed (pty size is 0x0).
- Extract the URL (first match):
  `/https:\/\/[^\s\x07\x1b"'<>]+\/oauth\/authorize\?[^\s\x07\x1b"'<>]+/`
- Write the code followed by `\r` or `\n`. A malformed code prints
  `Invalid code. Please make sure the full code was copied.` and keeps
  waiting for another line. A well-formed but rejected code prints
  `Login failed: That code wasn't accepted. ...` and exits 1. EOF on stdin
  does not end the process: the hub must enforce its own timeout (Ctrl-C,
  `\x03`, exits 130).
- `-e` makes `script` return the child's exit status; without it a killed
  login returns 0.
- Plain `docker exec -i ... claude auth login` (no `script`) behaves the same
  but prints the URL without OSC 8 escapes and without `\r`.
- Check with `claude auth status` (JSON, exit 0 signed in, 1 signed out).

## Turn

Prompt on stdin (a prompt starting with `-` would otherwise be read as a flag):

```sh
printf '%s' "$PROMPT" | docker exec -i -e HUB_TOKEN -w /opt/sidekick/work ach-sidekick-<id> \
  claude -p --output-format stream-json --verbose \
    --strict-mcp-config \
    --mcp-config '{"mcpServers":{"hub":{"type":"http","url":"http://host.docker.internal:8792/mcp","headers":{"Authorization":"Bearer ${HUB_TOKEN}"}}}}' \
    --tools "" --allowedTools 'mcp__hub__*' \
    --permission-mode dontAsk --permission-prompts none \
    --disable-slash-commands \
    [--resume <session_id>]
```

- `-e HUB_TOKEN` (name only) keeps the token out of `docker` argv; Claude Code
  expands `${HUB_TOKEN}` in the header. The token was not found anywhere in
  the home volume after turns.
- The first event is `system/init`. Abort the turn unless `mcp_servers`
  contains `{"name":"hub","status":"connected"}`; a wrong or missing token
  gives `"status":"failed"` and an empty `tools` list, and the turn still runs.
- Signed out: an `assistant` event with `"error":"authentication_failed"` and
  text `Not logged in · Please run /login`, then a `result` with
  `"subtype":"success"`, `"is_error":true`, `"terminal_reason":"api_error"`;
  exit code 1.
- `--disable-slash-commands` removes the built-in commands and skills from
  `slash_commands` / `skills` (only the hub's MCP prompt
  `mcp__hub__collaborate` remains), so client text such as `/loop` is not run
  as a command.
- `tools` is only `mcp__hub__*`, both with `--tools ""` and, through the
  managed deny list alone, with `--tools default`. `EndConversation` never
  appeared. `--dangerously-skip-permissions` and
  `--permission-mode bypassPermissions` are ignored (mode stays `dontAsk`).
- Project files: in an empty read-only workdir there is nothing to load. In a
  writable test dir, `.mcp.json` servers load unless `--strict-mcp-config` is
  passed, `.claude/settings.json` hooks do not run (`disableAllHooks`), and
  `CLAUDE.md` is skipped (`a Read deny rule covers it`).

## Codex CLI (ChatGPT-plan sidekicks)

The same image also carries the official, unmodified OpenAI Codex CLI for
sidekicks on a ChatGPT plan. Observed behaviour is for `codex-cli 0.170.0`
in the same hardened container (run flags above, unchanged).

### Install and config

- `npm install -g @openai/codex@0.170.0` (override with
  `--build-arg CODEX_VERSION=...`). The launcher is `/usr/local/bin/codex`; the
  native musl binary (plus `codex-code-mode-host`) sits under
  `/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-<arch>/`,
  inside the read-only image. It runs as 1000:1000 under `--read-only`.
- `CODEX_HOME=/home/sidekick/.codex` (home volume). Codex refuses to start if
  it is missing (`Error loading configuration: CODEX_HOME points to "...", but
  that path does not exist`, exit 1). The image bakes the directory (seeds
  fresh volumes) and the entrypoint runs `mkdir -p "$CODEX_HOME"` on every
  start, which also covers older volumes; `docker run ... sleep infinity`
  replaces only `CMD`, so the entrypoint still runs.
- `/etc/codex/config.toml` (from `codex-config.toml`) is the system layer.
  It sets `sandbox_mode = "read-only"`, `approval_policy = "never"`,
  `web_search = "disabled"`, `forced_login_method = "chatgpt"`,
  `cli_auth_credentials_store = "file"` (login in `$CODEX_HOME/auth.json`),
  `check_for_update_on_startup = false`, analytics/feedback/otel off, and
  turns off the shell, unified exec, image, browser, computer-use, sub-agent,
  goal, apps/connectors, plugin, hook, memory, skill and request-user-input
  tools.
- `/etc/codex/requirements.toml` (from `codex-requirements.toml`) enforces
  `allowed_sandbox_modes = ["read-only"]`, `allowed_approval_policies =
  ["never"]`, `allowed_web_search_modes = ["disabled"]`,
  `allowed_login_methods = ["chatgpt"]` and pins the same features off.
  Observed: `-s danger-full-access` and
  `--dangerously-bypass-approvals-and-sandbox` fail at startup (exit 1,
  ``Error: `approval_policy = "never"` cannot be used because requirements do
  not allow `sandbox_mode = "danger-full-access"` ...``);
  `-c approval_policy="on-request"` silently stays `never`;
  `-c web_search="live"` falls back to disabled with an `error` item;
  `-c features.shell_tool=true` / `--enable` of a pinned feature is ignored.
- Both files load with `--ignore-user-config` (which only skips
  `$CODEX_HOME/config.toml`). No `-c` overrides are needed for the policy; the
  hub passes only the MCP server.

### Sign-in

```sh
docker exec -i ach-sidekick-<id> codex login --device-auth
```

The client must first enable device code login in ChatGPT's security
settings (beta). No TTY or stdin is needed; output goes to stdout, about 1 s
after start, even without a TTY it carries ANSI colours (`ESC[90m`, `ESC[94m`,
`ESC[0m`), lines end in `\n` (`\r\n` under `script`):

```
Welcome to Codex [v0.170.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   RHOV-8B0EG

Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
```

- Strip ANSI (`/\x1b\[[0-9;]*m/g`) and `\r`, then
  URL: `/https:\/\/[^\s\x1b]+\/codex\/device\b[^\s\x1b]*/`
  (observed exactly `https://auth.openai.com/codex/device`, no query string);
  code: `/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/` (observed `RHOV-8B0EG`,
  `RI26-8L6A1`).
- It then blocks and polls; stdin is ignored (a typed line is only echoed
  under `script`). Expiry: after 15 minutes it prints
  `Error logging in: device auth timed out after 15 minutes` on stderr and
  exits 1. Ctrl-C (`\x03` through `script -qefc`) or SIGINT inside the
  container exits 130 silently. Killing the host-side `docker exec` client or
  closing stdin does NOT stop it: the CLI keeps polling inside the container.
  To cancel, run it as `script -qefc "codex login --device-auth" /dev/null`
  and write `\x03`, or `docker exec <c> sh -c 'kill -INT <pid>'`.
  Success output and exit code were not
  observed (no sign-in was performed); check with `codex login status`.
- Each start appends `starting device code login flow` to
  `$CODEX_HOME/log/codex-login.log` (the code is not logged).
- `codex login status`: signed out prints `Not logged in`, exit 1 (exit 0
  when signed in, per docs; not observed). `codex logout` signed out prints
  `Not logged in`, exit 0.

### Turn

Prompt on stdin with `-` (a prompt starting with `-` is then safe):

```sh
printf '%s' "$PROMPT" | docker exec -i -e HUB_TOKEN -w /opt/sidekick/work ach-sidekick-<id> \
  codex exec --json --skip-git-repo-check --ignore-user-config \
    -c 'mcp_servers.hub={url="http://host.docker.internal:8792/mcp",bearer_token_env_var="HUB_TOKEN",required=true}' \
    -
# follow-up turns:
#   codex exec resume --json --skip-git-repo-check --ignore-user-config -c '...hub...' <thread_id> -
```

- `bearer_token_env_var` sends `Authorization: Bearer $HUB_TOKEN`; the token
  was not found anywhere under `/home/sidekick` or `/tmp` after turns.
- `required=true` is what tells the hub whether MCP connected: a wrong token
  or unset `HUB_TOKEN` aborts before any model call with no JSON on stdout,
  exit 1, and stderr
  `Error: thread/start: ... required MCP servers failed to initialize: hub: ...`
  (`HTTP 401 ... UNAUTHENTICATED` or
  `Environment variable HUB_TOKEN for MCP server 'hub' is not set`). Without
  `required`, a failed hub only logs an `ERROR rmcp::transport::worker` line on
  stderr and the turn runs with no hub tools. The MCP handshake happens at
  thread start, before the model call (and before auth is checked).
- JSONL events (stdout): `{"type":"thread.started","thread_id":"<uuid>"}`,
  `{"type":"turn.started"}`, `item.started` / `item.completed` with
  `item.type` of `agent_message` (`text`), `mcp_tool_call` (`server`, `tool`,
  `arguments`, `result.content[]`, `error`, `status` `in_progress` →
  `completed`) or `error` (`message`, non-fatal warnings),
  `{"type":"error","message":...}` (retries),
  `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}`
  or `{"type":"turn.failed","error":{"message":...}}`. Logs go to stderr.
- Signed out: `thread.started`, `turn.started`, then 401
  `Reconnecting... n/5` errors over WebSocket and HTTPS for about 25 s, then
  `turn.failed` with `unexpected status 401 Unauthorized: Missing bearer or
  basic authentication in header`, exit 1. The hub should check
  `codex login status` before a turn rather than wait for this.
- Session id: `thread_id` from `thread.started` (a UUIDv7) is the session id;
  `codex exec resume <thread_id> -` continues it (the resumed run emits the
  same `thread_id`, and the model sees the earlier turns). An unknown id exits
  1 with `Error: thread/resume: ... no rollout found for thread id ...`.
  Rollouts live in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`.
- Tools (observed by pointing the CLI at a local fake Responses endpoint, see
  `probe.sh`; the real ChatGPT tool list was not observed): the hub tools
  arrive as a deferred `mcp__hub` namespace; the only built-ins left are
  `apply_patch`, the MCP resource readers (`list_mcp_resources`,
  `list_mcp_resource_templates`, `read_mcp_resource`), `tool_search`, and for
  code-mode models `exec`/`wait` (a JS isolate with no fs or network that can
  call the same tools), `clock__curr_time` and `send_message_to_user_async`.
  No shell, web search, image, browser or sub-agent tools. `apply_patch` has
  no off switch for catalog models; a forced call returned
  `patch rejected: writing is blocked by read-only sandbox; rejected by user
  approval settings` and wrote nothing. Forced `exec_command`/`shell` calls
  returned `unsupported call`. A forced `hub_whoami` call ran without approval.
- Writable paths: only `$CODEX_HOME` (sqlite state, logs, `sessions/`,
  `installation_id`, `tmp/arg0-linux/` helper symlinks, and `auth.json` once
  signed in). Nothing was written to `/tmp` or elsewhere in `/home/sidekick`.
  With an unwritable `CODEX_HOME` it warns
  `could not create PATH aliases: Operation not permitted` and continues.

## Probe

`sidekick/probe.sh` starts a container with the flags above, runs every
Claude Code and Codex check signed out (the Codex device code is masked and
cancelled, never entered), and removes the container and volume. Pass
`HUB_TOKEN` in the environment to test the hub MCP connection.
