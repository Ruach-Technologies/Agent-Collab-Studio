# Hub service

The hub is a single Fastify server on `127.0.0.1:8791` serving:

- the static observability UI (`../web/dist`)
- the agent collab REST API under `/v1`
- the live WebSocket line at `/v1/ws`
- `GET /healthz`, `GET /readyz`

Run in development with `npm run dev` (tsx watch), or `npm run build && npm start`.
All state lives in `../data/hub.sqlite`; per-room workspaces under `../workspaces/<room-slug>/`.
