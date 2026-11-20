# Sandbox tools

The default image is `agent-collab-sandbox:local`, built from this directory's
Dockerfile (Node 22, npm, Python 3, Git). Build it once before starting the hub;
the hub never builds or pulls images itself:

```bash
docker build --tag agent-collab-sandbox:local sandbox/
```

`HUB_SANDBOX_IMAGE` picks another image.

The Dockerfile downloads public base packages during that explicit build. It
does not copy application source, keys, or host configuration. Already-provisioned
rooms keep their recorded image; select the image before provisioning a new
room. Do not replace someone else's container or image to switch tools.

## Collaboration model

- Each room has a persistent, private workspace at `workspaces/<room-id>`.
- The room container supports file tools. Each command runs in a **fresh,
  short-lived container** sharing only that room's workspace. Background
  processes are terminated when a command finishes or times out.
- Shell cwd, environment changes, `/tmp`, and installed packages outside the
  workspace do not survive commands. Write source, test results, and handoffs
  under `/workspace`.
- Runtime networking is disabled for agent commands and dev servers. The one
  way to download packages is **Install dependencies** (`POST
  /v1/sandboxes/:id/install`, MCP `hub_sandbox_install`). Phase one runs the
  hub's fixed script, `npm ci` (or `npm install` without a lockfile), with
  install scripts off, on the sealed network below. Phase two runs the
  packages' install scripts (`npm rebuild`) in an ordinary offline container,
  so they can compile native code (the image has make and g++) but cannot send
  anything anywhere. `scripts: false` skips phase two. Scripts that download
  extra files, such as browsers for testing, cannot finish. The hub never
  relays LLM calls.

## Sealed network and egress gate

Everything that needs the internet runs on an internal Docker network
(`ach-sealed-<hub port>`) with no route to the internet or to the host Mac.
Its only way out is the gate container (`ach-egress-gate-<hub port>`, script
`egress-gate.mjs`), which the hub starts on demand from the sandbox image. Each
container gets one profile:

| Profile | Used by | Allowed |
|---|---|---|
| packages | Install dependencies | npm/Yarn registries, PyPI, GitHub |
| github | clone, refresh, pull request push | github.com, codeload.github.com |
| sidekick | sidekick containers | Anthropic and OpenAI sign-in and APIs, and this hub's `/mcp` |

The gate allows only HTTPS to listed names, refuses any name that resolves to
a private, loopback or link-local address (so the Mac, the LAN and cloud
metadata are unreachable), and logs each decision (host names only, with the
client container's address and name, and bytes and duration when a connection
ends; never paths, headers or bodies). The hub reads that log for its security
monitor (see `docs/security.md`, "Security monitoring"). Set
`HUB_EGRESS_GATE=off` only for tests; networked steps then fall back to
Docker's normal network.
- Root filesystems are read-only, capabilities are dropped, containers run
  non-root, and resource/timeout/output limits apply. Docker is the isolation
  boundary; the command denylist is only an additional guardrail.
- File APIs accept relative workspace paths, reject traversal/symlinks and limit
  text reads/writes to 256 KiB. The console follows agent writes live
  (changed lines are highlighted) and lets supervisors/agents edit and save.

## GitHub repositories and git

Both images include Git. `POST /v1/sandboxes/:id/repos` (the sidekick tool
`hub_clone_repo`, or the clone form in the Studio) clones `owner/name` into `/workspace/<name>`; calling
it again for the same directory refreshes `origin/*` and fast-forwards the
current branch. Only hub-run git has network access — `git fetch`,
`git pull` and `git push` inside `execSandbox` commands have none. To publish
work, commit on a branch named `ai/<task>` and call `openPullRequest`
(`POST /v1/sandboxes/:id/pulls`): the hub pushes that branch and opens a pull
request. It cannot merge; people merge on GitHub. Clones of private
repositories and pull requests use the token saved for the repository's
organization in the room's workspace (desktop app › workspace › GitHub); pull
requests need it to have write permission. Local git
(`status`, `diff`, `branch`, `commit`) works offline: commands receive
`safe.directory=*` and the calling agent's name as author/committer.

The console's Sandbox page shows each clone's branch graph, commits and
per-file diffs (`GET /v1/sandboxes/:id/git/repos|log|commit`) and can switch
branch (`POST /v1/sandboxes/:id/git/checkout`). Each terminal command starts in
`/workspace`, so chain steps: `cd <repo> && git status`. To move a clone to the
latest `main`, refresh it from GitHub (clone form or `cloneRepo`) and check out
`main`; `git pull` in a command cannot reach the network.

Every workspace root gets the operator's global `AGENTS.md` and `CLAUDE.md`
when it is provisioned, and each cloned repository root gets them unless the
repository ships its own. They are excluded from that clone's `git status`. See
[security](../docs/security.md#github-cloning-and-seeded-instructions) for
GitHub tokens and how to change or disable seeding.

## Stopped room containers

File tools run inside the long-lived room container; commands use separate disposable containers. If Docker stops the room container, commands can still succeed while file browsing is unavailable. The status API inspects the owned container and reports `stopped` without changing saved provisioning metadata. File operations return `SANDBOX_NOT_RUNNING` (409), not an unsafe-path error. Docker connectivity, ownership conflicts and file-helper failures remain separate errors.

The hub never automatically restarts or replaces that resource. Ask the operator to verify its ID, ownership labels and workspace mount before explicitly starting the same stopped container. Provisioning a stopped room currently removes/recreates its container, so do not use it as an unreviewed recovery shortcut. Existing workspace files remain on the host bind mount. Browser listing failures stop the loading indicator and provide retry; changing rooms discards the prior viewer state.

Audit `auth.ok` rows record each authenticated non-GET operation, including every sandbox exec POST. A burst of command uploads can therefore produce several auth rows per second without any periodic login/authentication loop. Keep those security records; inspect each row's method, path and timestamp when diagnosing traffic.

The writable host workspace has no filesystem quota. CPU, memory, PID and
individual-output caps do **not** bound total workspace or SQLite disk growth.
Use only trusted project collaborators, monitor disk use, and never mount host
secrets or the Docker socket. A hostile multi-tenant service needs additional
storage quotas and stronger runtime separation before public use.

The opt-in tool image has not been built or scanned merely because this file
exists. Test a selected image locally before admitting agents to its rooms.
