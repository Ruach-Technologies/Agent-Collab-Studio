# Architecture

One local Fastify process on `127.0.0.1:8791` serves the Studio (React), the `/v1` API it uses, `/v1/ws`, and the sidekick-only `/mcp` endpoint. The manual ngrok tunnel forwards its single HTTPS origin to that port.

```text
Staff and clients ── browser ── hub/tunnel origin ──┐
                                                    ├─ Hub :8791 ── SQLite store
Sidekick containers ── sealed network ── egress gate┘          └── Docker CLI ── room sandboxes, sidekicks
```

## State and observation

- `data/hub.sqlite`: identities, hashed tokens, room memberships, messages, sandbox/execution records, ordered events. SQLite uses WAL and foreign-key checking.
- `workspaces/<room-id>/`: room-owned files, shared between the room's participants and the ephemeral command containers.
- `.runtime/`: PID/log files and the last tunnel URL. This state and application data are gitignored.
- Events are committed before being published to connected clients. REST replay supports `since`, `room`, `type`, and `limit` filters. WebSocket delivery is live, not an exactly-once durable queue; use replay after reconnecting.
- The console has Live Feed, Rooms/conversations, Sandbox/history/files, Agents, and Audit views. Supervisors can create rooms, provision, compose messages and execute commands. Observers cannot mutate project state.

## Who connects

People use the Studio in a browser: staff with a token from the desktop app, clients through invite links and 3-hour, browser-bound sessions renewed with a passkey or a sign-in link. Sidekicks are the only software agents: each runs Claude Code or Codex in its own container on the sealed network, on its owner's plan, and calls the hub's `/mcp` endpoint through the egress gate with a token that works nowhere else. Tool calls replay the REST routes in-process as the sidekick, so every access rule applies.

Workspaces are security scopes: every identity belongs to exactly one workspace, and all REST, WebSocket, event, presence and sandbox boundaries enforce it. A person in two workspaces has two identities. The local operator credential can act in any workspace, but only from this Mac.

The desktop app manages workspaces, staff, rooms, invites and sign-in links through an OS-authorized JSON command (`hub/scripts/manage.mjs`), with no administration endpoint on the network. See the [desktop app guide](../desktop/README.md).

## Sandbox lifecycle

A supervisor provisions a persistent room container from the configured local image. It provides the file tools. Each execution runs in a separate short-lived container sharing only the room workspace; removing it terminates remaining descendants. Operations are serialized per room with one running and at most four pending requests. Containers use labels tied to this checkout/workspace root; cleanup refuses resources with different ownership labels.

Room and command containers have no network, no host Docker socket, read-only root filesystems, dropped capabilities, a non-root UID, constrained tmpfs and CPU/memory/PID limits. A separate short-lived container with outbound network runs only the hub's fixed `git clone` script to populate a workspace from GitHub. See [sandbox tools](../sandbox/README.md) for image contents and persistence semantics, and [security](security.md) for limits.

No launchd job, remote repository, automatic tunnel, or external-model integration is installed by this project.
