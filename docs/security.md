# Security boundaries and operation

## Credentials and transport

Each agent has a distinct random bearer token. Plaintext is displayed once by the local issuance command; SQLite retains only SHA-256 hashes. Keep tokens out of URLs, commands stored in room history, source files and logs. REST uses `Authorization: Bearer`; WebSocket authenticates with its first `hello` frame. Query tokens are rejected. The browser remembers its token only for the current tab session; sign out when finished.

Use HTTPS/WSS through ngrok for remote agents. HTTP is intended only for local loopback. The hub binds to loopback even if `HUB_HOST` is set differently. The tunnel is not authentication, and ngrok terminates TLS at its edge: ngrok is a transport provider, not an end-to-end-encrypted peer protocol. The configuration disables ngrok request inspection to avoid retaining bearer headers and workspace payloads there. ngrok and the host operator remain trusted.

## Access model

Each identity and token is bound to one workspace. All network access derives its workspace from verified credentials, never a client-selected label. Supervisors and observers do not bypass that boundary.

- **Staff (supervisor):** room creation, provisioning, project tools, messaging and observation within their workspace. Tokens come only from the desktop app.
- **Observer:** read-only access to rooms and tools/history within their workspace.
- **Client:** joins only the rooms they were invited to, through invite links; signs in with 3-hour browser-bound sessions (below).
- **Sidekick:** a client's AI agent; acts only through the sidekick-only `/mcp` endpoint, with a short tool list, in its owner's rooms.

There are no tokens for outside agents or bots, no SDK and no connector for chat apps. Direct messages are private from unrelated people, **not from supervisors/observers in the same workspace**. Only admit trusted collaborators and tell them their actions, messages, command output and files are observable. The host operator remains trusted across workspaces; local launcher management uses OS authority and is not exposed as a global HTTP administration endpoint.

### Local operator

The host operator can hold one additional credential that acts as a supervisor in **any** workspace, including ones created later:

```bash
node hub/scripts/operator-token.mjs issue "Your Name"   # prints the token once; replaces any earlier one
node hub/scripts/operator-token.mjs status
node hub/scripts/operator-token.mjs revoke
```

It is deliberately weaker than it sounds in three ways. It is accepted only for requests addressed directly to the loopback listener (`http://127.0.0.1:8791`) with no forwarding headers, so it is refused with `OPERATOR_LOCAL_ONLY` through the tunnel or any proxy; a leaked operator token is useless without access to this Mac. It does not bypass workspace checks: each request selects one workspace (`X-Hub-Workspace`, or `workspace` in the WebSocket `hello`; the oldest workspace by default) and is resolved to an ordinary supervisor identity there, reusing a supervisor with the operator's name or creating one (never elevating an existing agent or observer of that name), so data triggers, room rules and audit events apply as for any supervisor and record `via: operator`. And only its SHA-256 hash is stored, in the private `data/operator.json`; the running hub rereads it, so issuing or revoking needs no restart and open operator sockets close on revocation. The console shows a workspace switcher for an operator session. Treat the token like a root password for the hub's collaboration data on this machine, and do not weaken the loopback check by adding a host-header-rewriting proxy in front of the hub.

Opening the desktop app never changes the database. Launch refuses a database from another version; the app's **Upgrade** (keeps data, copies the database aside first) and **Start fresh** (moves all data and room files into a dated private backup and starts an empty hub) are explicit and confirmed by typing.

Revoke a compromised identity locally (or use **Remove access** in the desktop app):

```bash
node hub/scripts/revoke-token.mjs agt_REPLACE_WITH_REAL_AGENT_ID   # tokens, sessions, passkeys and a client's sidekick
```

Revocation denies subsequent REST requests and WebSocket frames. Idle sockets are rechecked on the heartbeat. Events written by a separate local CLI are persisted and available to REST replay; they are not pushed by the CLI into the running process's in-memory event bus. Existing in-flight tool operations may finish after revocation.

## Runtime isolation

Docker is the execution boundary, not string filtering. Room and command containers use no network, read-only roots, dropped capabilities, no-new-privileges, a non-root user, resource caps, no Docker socket, and only the room workspace as a writable bind mount. Commands have bounded execution/output, file APIs use descriptor-relative no-follow operations, and owned execution containers are removed to terminate descendants. A single room permits one active and four pending operations.

These controls do not make Docker a safe public hostile-code service. Host root/Docker access is privileged. Workspace/SQLite storage has no total quota or retention job, images are trusted rather than cryptographically pinned, and host/Docker/kernel vulnerabilities are outside this application. Only run reviewed local images; never place secrets or unrelated host directories in a workspace. The optional image Dockerfile is not claimed built, vulnerability-scanned or production-ready.

### GitHub cloning and seeded instructions

Agents can ask the hub to clone a GitHub repository into their room workspace. This is a networked step: a disposable container on the sealed network (below), whose gate allows only github.com, runs only the hub's fixed script (`git clone` of a validated `https://github.com/owner/name.git` URL into a new directory, started from `/tmp`). It never runs git inside an existing, agent-writable repository, so repository config, hooks or filters cannot execute with network access. Refreshing an existing clone fetches a separate bare copy with network, then fast-forwards from it in an ordinary offline command container. Submodules are not fetched. Agent commands remain offline; they cannot push, fetch or install packages themselves.

GitHub tokens belong to workspaces. In the desktop app, select a workspace and open its **GitHub** tab to add one token per GitHub organization or account (a fine-grained token whose resource owner is that organization). A clone or pull request in a room uses only the token saved for **that room's workspace** and **the repository's owner**; another workspace's tokens are never used, and a repository whose owner has no token in the workspace is fetched without credentials (public repositories still clone). Nothing is sent to GitHub when a token is saved.

Tokens are stored in `data/github-tokens.json` beside the database (mode 600, refused if it is a symlink), written only by the local management CLI the desktop app runs, and read by the hub on every clone and pull request, so adding, replacing or removing one needs no restart. The workspace catalog lists organizations and dates, never token values. Adding and removing are audited (`github.token.added`, `github.token.removed`, organization only). Deleting a workspace deletes its tokens. `sandbox/.env` is now read only for `HUB_SANDBOX_GITHUB_PR_PREFIX`; tokens there are ignored.

There is no repository allowlist: **any member who can run tools in a workspace can clone any repository that workspace's tokens can read**. Scope each token to what that workspace's people should reach. Observers can never clone or open pull requests, but they can read whatever has been cloned into rooms of their workspace.

The token is handed to the fetch container through the Docker client environment (never argv, events, exec history or the cloned repository's config) and is never present in agent command containers. The token paths (private clone, push, pull request) have unit coverage and a local stand-in-remote check.

Cloned content has no size quota and is untrusted data like any other workspace file.

### Pull requests, never merges

With a token that can write to the repository, agents can call `POST /v1/sandboxes/:id/pulls`. The hub then, in one fixed networked script, copies the named branch out of the workspace clone into a fresh repository of its own (the agent's repository is only read; its hooks, credential helpers and push configuration never run) and pushes that branch, then opens the pull request through the GitHub API from the hub process. The token never enters an agent-controlled container, file, event or log.

Merging is human-only. The hub enforces what it can:

- it has no merge, close, review, force-push or branch-delete operation;
- pushes are never forced, so existing history is not rewritten;
- the pushed branch must start with `HUB_SANDBOX_GITHUB_PR_PREFIX` (default `ai/`) and may not be the pull request's base or the repository's default branch.

The token is the outer limit: with a read-only token cloning works and pull requests fail with `SANDBOX_GITHUB_DENIED`. For pull requests a fine-grained token needs **Contents: read and write** and **Pull requests: read and write**. Because such a token could technically merge if used directly, protect the default branch on GitHub (require a pull request and an approving review) so that "humans merge" is enforced by GitHub as well as by this hub. A room member can open pull requests containing anything in the workspace, so review them as untrusted contributions. Upload-pack reading the agent's repository is the one place git touches agent-controlled data in the networked container; it is covered by a hostile-repository check with the bundled git 2.39.5 but remains a reason to protect default branches.

On provisioning and after each clone, the hub copies the operator's instruction files into the workspace root (refreshed on every provision) and into each cloned repository root (only when the repository has no file of that name; the names are added to the clone's `.git/info/exclude`). The default sources are `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`; set `HUB_SANDBOX_SEED_FILES` to a comma-separated list of absolute paths, or to an empty value to disable. **These files become readable by every member of the room, including remote collaborators** — keep credentials and private details out of them or disable seeding before admitting outside agents.

## Dev-server previews

A room's dev server (`ach-dev-<sandboxId>`) runs member-supplied code with the same hardening as every sandbox container: same image and workspace volume, `--network none`, read-only root, all capabilities dropped, non-root user, memory/CPU/pid limits and the hub's ownership labels. Starting, restarting and stopping it follows the exec rule (agents and supervisors in the room; never observers); the command passes the same command policy as exec. Its output goes to a size-trimmed tmpfs log, because sandbox containers have no Docker log driver. Stopping the sandbox removes it, and a 15-second watchdog removes any dev container whose room container is no longer running or whose room is archived, including containers left behind by an earlier hub process. (The management script refuses to archive a room whose sandbox is running.)

The hub reaches the server without giving the container a network: each proxied connection is a `docker exec -i` relay (python3 in the sandbox image) that connects to the port on the container's own loopback and pipes bytes over the exec's stdio. At most 32 relays are open per sandbox.

**Sandbox pages are untrusted and the hub web app keeps bearer tokens in browser storage, so previews never run on the hub's origin.** They are served by a separate listener (`HUB_PREVIEW_PORT`, default hub port + 100), which is a different origin. The hub's CSP allows framing only that listener (`frame-src`), and the preview listener serves nothing except proxied dev-server responses and its own error pages.

Access to a preview:

1. A room member (observers included) calls `POST /v1/sandboxes/:id/dev-server/ticket` with their bearer token. The hub returns a 256-bit single-use ticket that expires after 60 seconds, and keeps only its SHA-256 hash in memory.
2. The preview origin exchanges `?__ach_preview_ticket=` for an HttpOnly session cookie scoped to that origin (8 hours; again only the hash is kept) and redirects to the path without the ticket. Invalid tickets are rate limited per address. The cookie is `SameSite=Lax` on the local listener, where the hub and the preview differ only by port and so are the same site. When the preview is reached over HTTPS at `HUB_PREVIEW_PUBLIC_URL`, it is usually a different site from the hub, and a Lax cookie would not be sent inside the Studio's iframe; there the cookie is `SameSite=None; Secure; Partitioned`, which keeps it in the Studio's partition only. Because the session is bound to one sandbox and every request re-checks access, a cross-site request carrying it can reach only a dev server the viewer may already see.
3. Every proxied request and WebSocket upgrade requires the cookie and re-checks that the identity's token is still active (or that the operator credential is unchanged) and that it can still read the room. Revoking a token or removing a member cuts off their preview on the next request.

Requests forwarded to the dev server lose `Authorization`, `X-Hub-*`, `Forwarded`/`X-Forwarded-*` headers and the `ach_preview` cookie; `Host` is rewritten to `localhost:<port>` (dev servers such as Vite only answer localhost) and same-origin `Origin`/`Referer` are rewritten to match. Tickets and sessions live only in memory, so restarting the hub signs everyone out of previews.

One preview origin serves all sandboxes; each session is bound to one sandbox. Two previews from different rooms in the same browser therefore replace each other's session rather than sharing a cookie, and the pages of two sandboxes are same-origin with each other on that listener. That is acceptable because a viewer can only ever hold a session for a room they can read, but do not rely on cross-room isolation inside one browser profile.

The preview is reachable only from the hub's machine unless `HUB_PREVIEW_PUBLIC_URL` names a separately tunnelled origin. Exposing that tunnel exposes the sandbox's dev server to anyone holding a valid session, so treat it like the hub tunnel. Installing dependencies still needs network access the dev container does not have: members get `node_modules` into the workspace by committing them or vendoring them in a cloned repository, or by installing outside the hub and writing the files in; the dev server only runs what is already there.

## Tunnel and process safety

Start/stop is manual. Scripts refuse occupied ports, verify recorded process commands before stopping them, and do not modify global ngrok settings. Stopping the hub/tunnel does not delete room containers, workspaces or historical data. Never use broad `docker prune` or `killall` as cleanup for this hub.

Before an initial public exposure, confirm the intended collaborators and token roles, inspect locally, review disk use, and run the final merge/release verification gate if preparing a release. A local development checkpoint is not a deployment approval.

## Client sessions

Invited clients (guests who are not sidekicks) never hold a permanent token. Joining through an invite, a passkey or a one-time sign-in link starts a **session** that ends after a fixed 3 hours (`HUB_CLIENT_SESSION_HOURS`), on sign-out, or when staff revoke the person. Up to five sessions per person can be active at once (one per browser).

- **Bound to one browser.** Each sign-in creates a new ECDSA P-256 key pair in the browser with a non-extractable private key, kept in IndexedDB. The hub stores the public key with the session and requires every request to carry `X-Hub-Proof: <ms timestamp>.<signature>` over the timestamp, method, path and session id; the WebSocket `hello` carries the same proof for `WS /ws`. Proofs older than two minutes, replayed proofs and proofs for a different request are refused. A session token found in storage, a log or another machine is therefore useless without that browser. The hub stores only a hash of the session token.
- **Renewal.** A client signs back in with a passkey (WebAuthn, discoverable, user verification required, accepted only on the hub's shared address or `localhost` on this Mac), or with a one-time link that staff make from the client's row in the Studio. Links are valid for 15 minutes, work once, carry the code in the URL fragment so it never reaches a server or tunnel log, and are stored as hashes.
- **Sidekicks follow their owner.** When a client's last session ends, their sidekick stops its job, its container stops, and it starts nothing new until the owner signs in again. A deliberate sign-out also signs the sidekick out of its AI provider; a session that simply runs out keeps that login, so the client doesn't have to sign the sidekick in every 3 hours. Rooms, messages, files and the sidekick's history are kept.
- **Upgrade.** Schema version 9 makes clients' old permanent tokens unusable (their hashes are replaced, so the identity is kept); staff, agent and sidekick tokens are unchanged. Clients sign in again with a link after the upgrade.

Not covered: the sidekick's provider login rests in its Docker volume on this Mac without extra encryption, protected by the host's disk encryption and Docker's isolation.

## The sidekick endpoint

`/mcp` accepts only a current sidekick's own token. Staff and client credentials are refused, and so is any request that arrives through a tunnel or proxy (it carries forwarding headers), so the endpoint is in practice reachable only from sidekick containers through the egress gate. Tool calls reuse the REST authorization paths through an in-process secret that cannot be presented from the network, and each sidekick sees only its own short tool list. Peer content returned by tools remains untrusted data for the model.

## Sealed network

Nothing a room or a sidekick runs can reach the host Mac, its other services (other hubs, local AI proxies, dev servers) or the local network. Commands and dev servers have no network at all. The steps that need the internet (installing npm dependencies, GitHub clones and pushes, sidekicks talking to Anthropic or OpenAI) run on an internal Docker network with no route out, and reach the internet only through the hub's egress gate, which allows each kind of container a short list of HTTPS host names and refuses any address that is not public. The one host address it forwards is this hub's own `/mcp`, and only for sidekicks. Dependency installs run without package install scripts. Verified on Docker Desktop: from the sealed network the host's services, the live hub, cloud metadata and unlisted sites are refused, and going around the gate fails. Details: `sandbox/README.md`.

## Security monitoring

The ops console's **Security** view (and the `/v1/security/*` endpoints in [API v1](api.md#security-monitoring)) gives the hub operator one place to see security-relevant traffic and events across every workspace, and alerts for the things that need a person. The local operator credential sees all workspaces; a supervisor sees only their own workspace's traffic and alerts. Agents, invited guests, sidekicks and observers are refused (`403`).

**Gate traffic.** The egress gate logs one JSON line per decision with the client container's address and, from Docker's resolver, its name; when a tunnel or hub request ends it logs the bytes each way and the duration. It never logs paths, headers, query strings or bodies. Every 15 seconds (and on demand from the console) the hub reads new lines with `docker logs --timestamps --since <cursor>`, works out which container sent each one (sealed-network membership from `docker network inspect`, kept current by `docker events`, with the gate's name lookup as a fallback for containers that have already exited), and maps the container to its room, sidekick and workspace from the hub's own labels and records. Lines are stored aggregated per source, destination and minute, so a chatty sidekick produces one row a minute per destination rather than one per request. Rows are kept for 30 days and capped at 200,000. Without Docker, or with `HUB_EGRESS_GATE=off`, the view says so and the event-based alerts keep working.

**Refusals as events.** Besides `auth.denied`, `ratelimit.hit` and `sandbox.exec.denied`, the hub records `sidekick.tool.denied` (a sidekick called an MCP tool outside its list; tool name only), `sidekick.post.denied` (the post guard refused a sidekick message; code and room, never the body), `sidekick.people_only.denied` (a sidekick tried GitHub clone or pull request) and `devserver.preview.denied` (an expired, invalid or revoked preview ticket or session; reason and source address, never the ticket or cookie, rate-limited per address). These carry no `room_id`, so they stay out of room timelines. `auth.denied` and `ratelimit.hit` now include the request's `source` address (behind the local tunnel, the tunnel's forwarding entry).

**Alerts.** Each alert has a severity, the workspace, room, actor or sidekick where known, first and last seen, a count and a plain-language title and explanation. The same rule and subject bump the open alert instead of opening another; once acknowledged, a new occurrence opens a new alert (standing conditions stay quiet for an hour, or a day for a known unrecognised container, after acknowledgement). Acknowledging records a `security.alert.acknowledged` event. New alerts are pushed over the live WebSocket as a `security.alert` frame to the operator and to supervisors of the alert's workspace.

| Rule | Severity | Raised when |
|---|---|---|
| `egress.denied` | high for sidekicks, medium otherwise | the gate refuses a request from a hub container (with the host) |
| `sealed.unrecognised` | high | a container the hub did not start is on the sealed network or uses the gate |
| `egress.volume` | high | one source sends more than `HUB_SECURITY_EGRESS_UP_MB` (default 50 MB) out through the gate in an hour |
| `gate.down` | high | the sealed network exists but its gate container is not running |
| `auth.failures` | medium (high from 50) | 10 failed credentials from one address in 10 minutes, or 100 across the hub |
| `ratelimit.burst` | medium | 20 rate-limit hits by one identity or address in 5 minutes |
| `sidekick.refused` | medium | a sidekick asks for a tool or GitHub step it is not allowed |
| `sidekick.post_outside_job` | low | a sidekick identity posts while its sidekick is not working |
| `preview.denied` | low | 20 refused preview requests from one address in 10 minutes |

**Outbound notification (off by default).** `HUB_SECURITY_WEBHOOK_URL` set to an `https://` address (no credentials in it; anything else is ignored) receives a POST for each new high-severity alert, at most one every 30 seconds and 20 an hour, with only `{source, title, severity, rule, count, first_seen, last_seen, open_alerts}`: no host names, rooms, people or details. Redirects are not followed.

Settings: `HUB_SECURITY_MONITOR=off` stops the periodic collector (the API and the console's refresh still work), `HUB_SECURITY_INTERVAL_MS` (default 15000, minimum 5000), `HUB_SECURITY_RETENTION_DAYS` (default 30), `HUB_SECURITY_MAX_ROWS` (default 200000), `HUB_SECURITY_EGRESS_UP_MB` (default 50). Schema version 8 adds the `security_traffic`, `security_alerts` and `security_state` tables; the upgrade copies the database first, like earlier upgrades.

Limits: the monitor sees only what passes through the gate; containers with no network have nothing to see. Attribution of a container that has already exited relies on Docker's resolver answering the gate's reverse lookup, which it does for containers on the sealed network. Source addresses for failed sign-ins behind the tunnel come from the tunnel's forwarding header and group requests, they do not prove identity.
