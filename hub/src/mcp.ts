// The sidekicks' MCP endpoint (Streamable HTTP, JSON responses, no sessions).
//
// Only sidekick identities are accepted: their CLI runs in a container on the sealed network and
// reaches this endpoint through the egress gate. People, staff and any other token are refused,
// and so is anything that arrives through a tunnel or proxy. Each tool call is replayed against
// the hub's existing REST routes in-process as the verified sidekick, so every role, membership,
// workspace, validation, rate-limit and audit rule keeps applying unchanged. Unread messages come
// from a per-agent read position.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canObserveAll, canReadRoom, canViewEvent } from './access.js';
import { verifyToken } from './auth.js';
import type { EventRow } from './db.js';
import { sidekickToolNames } from './sidekicks.js';
import { requestSource, securityEvent } from './security.js';
import type { Agent, HubServices, Message } from './types.js';

const MAX_FOLLOWED = 50;
const PAGE = 500;
const ROOM = /^room_[a-f0-9]{16}$/;

class HubFeedError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HubFeedError'; }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Tools {
  createMcpServer: (options: { tools: () => Promise<unknown>; listTools?: (catalogue: Array<{ name: string }>) => Array<{ name: string }>; serverInfo?: unknown }) => { handle(message: unknown): Promise<unknown>; cancelAll(): void };
  createHubTools: (options: { client: unknown; feed: unknown }) => unknown;
  hubClientMethods: (request: (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>) => unknown;
  HubClientError: new (message: string, detail: { status: number; code?: string; body?: unknown }) => Error;
  addressedTo: (message: Message, agentId: string, handle: string) => boolean;
}
async function loadTools(): Promise<Tools> {
  const load = (name: string): Promise<any> => import(/* @vite-ignore */ new URL(`../mcp/${name}`, import.meta.url).href);
  const [server, tools, client, feed] = await Promise.all([load('protocol.mjs'), load('tools.mjs'), load('client.mjs'), load('feed.mjs')]);
  return { createMcpServer: server.createMcpServer, createHubTools: tools.createHubTools, hubClientMethods: client.hubClientMethods,
    HubClientError: client.HubClientError, addressedTo: feed.addressedTo };
}

interface HubToolSet { list(): Array<{ name: string }>; has(name: string): boolean; call(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>; }

/** Database-backed unread feed for one verified agent. */
function hubFeed(svc: HubServices, agent: Agent, sdk: Tools) {
  const { db, events } = svc;
  const everything = canObserveAll(agent) ? 1 : 0;
  const mine = (message: Message) => message.from_agent_id === agent.id;
  const addressed = (message: Message) => sdk.addressedTo(message, agent.id, agent.name);
  const message = (event: EventRow): Message | null => {
    try { return (JSON.parse(event.payload) as { message?: Message }).message ?? null; } catch { return null; }
  };
  const followed = (): { room_id: string; cursor: number }[] =>
    (db.prepare('SELECT room_id, cursor FROM mcp_read_positions WHERE agent_id = ? ORDER BY room_id').all(agent.id) as { room_id: string; cursor: number }[])
      .filter((row) => canReadRoom(db, agent, row.room_id));
  const pending = (roomId: string, cursor: number): EventRow[] => db.prepare(
    `SELECT * FROM events WHERE id > @cursor AND room_id = @room AND type = 'message.created' AND workspace_id = @workspace
        AND (@everything = 1 OR target_id IS NULL OR actor_id = @viewer OR target_id = @viewer) ORDER BY id ASC LIMIT ${PAGE}`,
  ).all({ cursor, room: roomId, workspace: agent.workspace_id, everything, viewer: agent.id }) as EventRow[];

  function watch(roomId: string): { room_id: string; cursor: number } {
    if (!ROOM.test(roomId) || !canReadRoom(db, agent, roomId)) {
      throw new HubFeedError('ROOM_UNAVAILABLE', 'Cannot follow this room. Join it first with hub_join_room.');
    }
    const existing = db.prepare('SELECT room_id, cursor FROM mcp_read_positions WHERE agent_id = ? AND room_id = ?').get(agent.id, roomId) as { room_id: string; cursor: number } | undefined;
    if (existing) return existing;
    if (followed().length >= MAX_FOLLOWED) throw new HubFeedError('ROOM_LIMIT', `One identity can follow at most ${MAX_FOLLOWED} rooms`);
    // A newly followed room starts at the live position; older history stays in hub_read_messages.
    const cursor = events.lastId(agent.workspace_id);
    db.prepare('INSERT OR IGNORE INTO mcp_read_positions (agent_id, room_id, cursor, updated_at) VALUES (?, ?, ?, ?)').run(agent.id, roomId, cursor, new Date().toISOString());
    return { room_id: roomId, cursor };
  }
  const selected = (roomId?: string) => roomId ? [watch(roomId)] : followed();
  const unread = (rows: { room_id: string; cursor: number }[], addressedOnly: boolean): boolean => rows.some((row) =>
    pending(row.room_id, row.cursor).some((event) => { const item = message(event); return !!item && !mine(item) && (!addressedOnly || addressed(item)); }));

  return {
    async watch(roomId: string) { watch(roomId); },
    status: () => followed().map((row) => ({ room_id: row.room_id, state: 'live',
      unread: pending(row.room_id, row.cursor).filter((event) => { const item = message(event); return !!item && !mine(item); }).length })),
    async take({ roomId }: { roomId?: string } = {}) {
      const messages: (Message & { addressed: boolean })[] = [];
      let truncated = false;
      for (const row of selected(roomId)) {
        const rows = pending(row.room_id, row.cursor);
        for (const event of rows) { const item = message(event); if (item && !mine(item)) messages.push({ ...item, addressed: addressed(item) }); }
        if (rows.length === PAGE) truncated = true;
        const last = rows.at(-1);
        if (last) db.prepare('UPDATE mcp_read_positions SET cursor = ?, updated_at = ? WHERE agent_id = ? AND room_id = ? AND cursor < ?')
          .run(last.id, new Date().toISOString(), agent.id, row.room_id, last.id);
      }
      messages.sort((left, right) => left.created_at.localeCompare(right.created_at));
      return { messages, truncated };
    },
    async wait({ roomId, timeoutMs, addressedOnly = false, signal }: { roomId?: string; timeoutMs: number; addressedOnly?: boolean; signal?: AbortSignal }) {
      const rows = selected(roomId);
      if (!rows.length) return false;
      if (unread(rows, addressedOnly)) return true;
      const rooms = new Set(rows.map((row) => row.room_id));
      return new Promise<boolean>((resolve, reject) => {
        const finish = (value: boolean, error?: unknown) => {
          clearTimeout(timer); off(); signal?.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve(value);
        };
        const off = events.on((event) => {
          if (event.type !== 'message.created' || !event.room_id || !rooms.has(event.room_id) || !canViewEvent(db, agent, event)) return;
          const item = message(event);
          if (item && !mine(item) && (!addressedOnly || addressed(item))) finish(true);
        });
        const onAbort = () => finish(false, signal?.reason ?? new Error('Aborted'));
        const timer = setTimeout(() => finish(false), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  };
}

export async function registerMcpRoutes(app: FastifyInstance, svc: HubServices, internalSecret: string): Promise<void> {
  let sdk: Tools | null = null;
  try { sdk = await loadTools(); }
  catch (error) { app.log.error({ err: { name: (error as Error).name, message: (error as Error).message } }, 'Sidekick endpoint disabled: hub/mcp modules are missing'); }

  /** A current sidekick's own token, and nothing else. */
  function authenticate(request: FastifyRequest): Agent | null {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const agent = verifyToken(svc.db, token);
    if (!agent || !svc.db.prepare('SELECT 1 FROM sidekicks WHERE agent_id = ? AND removed_at IS NULL').get(agent.id)) return null;
    return agent;
  }
  /** Sidekicks reach the hub directly through the gate; a tunnel or proxy adds forwarding headers. */
  function forwarded(request: FastifyRequest): boolean {
    return Object.keys(request.headers).some((name) => name.startsWith('x-forwarded-') || name.startsWith('ngrok-') || name.startsWith('cf-')
      || ['forwarded', 'via', 'x-real-ip', 'x-original-host', 'true-client-ip'].includes(name));
  }
  /** Replays a REST call through the hub's own routes as the verified agent. */
  function clientFor(agent: Agent, loaded: Tools) {
    return loaded.hubClientMethods(async (path, { method = 'GET', body } = {}) => {
      const response = await app.inject({ method: method as 'GET', url: path,
        headers: { host: '127.0.0.1', authorization: 'Bearer internal', 'x-hub-internal': internalSecret, 'x-hub-agent': agent.id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
      let payload: any;
      try { payload = JSON.parse(response.body); } catch { payload = response.body; }
      if (response.statusCode >= 400) {
        throw new loaded.HubClientError(payload?.error?.message ?? `Hub request failed with ${response.statusCode}`, { status: response.statusCode, code: payload?.error?.code, body: payload });
      }
      return payload;
    });
  }

  app.post('/mcp', async (request, reply) => {
    if (!sdk) return reply.code(503).send({ error: { code: 'MCP_UNAVAILABLE', message: 'The sidekick endpoint is not available on this hub' } });
    const agent = forwarded(request) ? null : authenticate(request);
    if (!agent) {
      if (!svc.limiter.check(`invalid:${request.ip}`).allowed) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } });
      svc.events.append({ type: 'auth.denied', payload: { path: '/mcp', reason: request.headers.authorization ? 'invalid_token' : 'missing_token', source: requestSource(request) } });
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'This endpoint is only for sidekicks' } });
    }
    if (!svc.limiter.check(agent.id).allowed) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } });
    const body = request.body;
    if (!body || typeof body !== 'object' || (Array.isArray(body) && (body.length === 0 || body.length > 20))) {
      return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    }
    const loaded = sdk;
    const visible = sidekickToolNames(svc.db, agent.id);
    const server = loaded.createMcpServer({
      listTools: (catalogue: Array<{ name: string }>) => (visible ? catalogue.filter((tool) => visible.has(tool.name)) : catalogue),
      tools: async () => {
        const tools = loaded.createHubTools({ client: clientFor(agent, loaded), feed: hubFeed(svc, agent, loaded) }) as HubToolSet;
        // A sidekick identity only ever sees its own short list, whatever its CLI was configured with.
        const allowed = sidekickToolNames(svc.db, agent.id);
        if (!allowed) return tools;
        return { ...tools,
          list: () => tools.list().filter((tool) => allowed.has(tool.name)),
          has: (name: string) => allowed.has(name) && tools.has(name),
          call: (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
            if (allowed.has(name)) return tools.call(name, args, options);
            // Recorded for the operator's security view: the tool name only, never its arguments.
            const sidekick = svc.db.prepare('SELECT id FROM sidekicks WHERE agent_id = ? AND removed_at IS NULL').get(agent.id) as { id: string } | undefined;
            securityEvent(svc, { type: 'sidekick.tool.denied', actor_id: agent.id,
              payload: { tool: /^[A-Za-z0-9_.-]{1,64}$/.test(String(name)) ? name : 'invalid', sidekick_id: sidekick?.id ?? null } });
            return Promise.resolve({ isError: true, value: { error: { code: 'TOOL_NOT_ALLOWED', message: 'Sidekicks cannot use this tool.' } } });
          } };
      },
    });
    // A caller that disconnects releases its blocked wait immediately.
    const onClose = () => { if (!reply.raw.writableEnded) server.cancelAll(); };
    request.raw.socket?.once('close', onClose);
    try {
      const result = Array.isArray(body)
        ? (await Promise.all(body.map((item) => server.handle(item)))).filter((item) => item !== undefined)
        : await server.handle(body);
      if (result === undefined || (Array.isArray(result) && result.length === 0)) return reply.code(202).send();
      return reply.header('content-type', 'application/json').send(result);
    } finally { request.raw.socket?.removeListener('close', onClose); }
  });
  // No server-initiated stream and no sessions: every request stands alone.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/mcp', handler: (_request, reply) => reply.code(405).header('allow', 'POST').send({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } }) });
  }
}
