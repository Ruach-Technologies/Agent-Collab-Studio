// The live line authenticates in a first frame; credentials never enter URLs.
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';
import { activeAgent, hashToken, verifyToken } from './auth.js';
import { SESSION_TOKEN, sessionStillValid, verifySession } from './sessions.js';
import { canReadRoom, canViewEvent } from './access.js';
import { RoomError } from './rooms.js';
import type { Agent, HubServices, Workspace, WsServerFrame } from './types.js';
import { hubIdentity } from './db.js';
import { OPERATOR_TOKEN, isLocalRequest, operatorAgent, readOperator, verifyOperator } from './operator.js';
import { requestSource } from './security.js';

interface ClientState {
  socket: WebSocket;
  agent: Agent;
  tokenHash: string;
  /** Plaintext is never kept; operator sessions are rechecked against the credential file by hash. */
  operator?: boolean;
  /** Clients' device-bound session; the socket closes when it ends. */
  session?: string;
  subscribedRooms: Set<string> | null;
  alive: boolean;
}
export interface WsState { clients: Map<WebSocket, ClientState>; }
export function initWsState(): WsState { return { clients: new Map() }; }

const frameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string().regex(/^(ach_[A-Za-z0-9_-]{32}|acho_[A-Za-z0-9_-]{43}|achs_ses_[a-f0-9]{16}\.[A-Za-z0-9_-]{43})$/),
    proof: z.string().max(200).optional(), workspace: z.string().regex(/^wks_[a-f0-9]{16}$/).optional() }).strict(),
  z.object({ t: z.literal('ping') }).strict(),
  z.object({ t: z.literal('subscribe'), rooms: z.array(z.string().regex(/^room_[a-f0-9]{16}$/)).max(200).optional() }).strict(),
  z.object({ t: z.literal('message.send'), room: z.string().regex(/^room_[a-f0-9]{16}$/), body: z.string().trim().min(1).max(8000), to: z.string().regex(/^agt_[a-f0-9]{16}$/).optional() }).strict(),
]);

function send(socket: WebSocket, frame: WsServerFrame): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Slow consumer'); return; }
  socket.send(JSON.stringify(frame));
}

export function registerWsRoutes(app: FastifyInstance, svc: HubServices, state: WsState): void {
  const pending = new Set<WebSocket>();
  let closing = false;
  function authorized(client: ClientState): boolean {
    if (client.session) {
      const still = sessionStillValid(svc.db, client.session) ? activeAgent(svc.db, client.agent.id) : null;
      if (!still) {
        const row = svc.db.prepare('SELECT end_reason, expires_at FROM sessions WHERE id = ?').get(client.session) as { end_reason: string | null; expires_at: string } | undefined;
        const expired = row && (row.end_reason === 'expired' || (!row.end_reason && row.expires_at <= new Date().toISOString()));
        client.socket.close(4009, expired ? 'Session expired' : 'Session ended'); return false;
      }
      client.agent = still;
      return true;
    }
    const agent = (client.operator
      ? (readOperator(svc.config.dataDir)?.token_hash === client.tokenHash ? svc.db.prepare("SELECT * FROM agents WHERE id=? AND role='supervisor'").get(client.agent.id) : undefined)
      : svc.db.prepare(`SELECT a.* FROM tokens t JOIN agents a ON a.id=t.agent_id
      WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.workspace_id=a.workspace_id`).get(client.tokenHash)) as Agent | undefined;
    if (!agent || agent.id !== client.agent.id || agent.workspace_id !== client.agent.workspace_id) {
      client.socket.close(4008, 'Identity no longer authorized'); return false;
    }
    client.agent = agent;
    return true;
  }
  function presence(): void {
    for (const client of state.clients.values()) {
      if (!authorized(client)) continue;
      for (const room of svc.rooms.list(client.agent.workspace_id)) {
        if (!canReadRoom(svc.db, client.agent, room.id)) continue;
        const online = [...new Set([...state.clients.values()].filter((peer) => authorized(peer) && peer.agent.workspace_id === client.agent.workspace_id && svc.rooms.isMember(room.id, peer.agent.id)).map((peer) => peer.agent.id))];
        send(client.socket, { t: 'presence', room_id: room.id, online });
      }
    }
  }
  const unsubscribe = svc.events.on((event) => {
    for (const client of state.clients.values()) {
      if (!authorized(client) || !canViewEvent(svc.db, client.agent, event)) continue;
      if (client.subscribedRooms && event.room_id && !client.subscribedRooms.has(event.room_id)) continue;
      send(client.socket, { t: 'event', event });
      if (event.type === 'message.created') {
        const payload = JSON.parse(event.payload) as { message: import('./types.js').Message };
        send(client.socket, { t: 'message.created', message: payload.message });
      }
    }
    if (event.type === 'room.joined') presence();
  });
  // Security alerts go to the operator (every workspace) and to supervisors of the alert's workspace.
  const onAlert = ({ alert, created }: { alert: import('./security.js').AlertRow; created: boolean }) => {
    for (const client of state.clients.values()) {
      if (!authorized(client) || client.agent.role !== 'supervisor') continue;
      if (!client.operator && alert.workspace_id !== client.agent.workspace_id) continue;
      if (!client.operator && svc.db.prepare('SELECT 1 FROM agents WHERE id = ? AND guest = 1').get(client.agent.id)) continue;
      send(client.socket, { t: 'security.alert', alert, created });
    }
  };
  svc.security?.on('alert', onAlert);

  app.get('/v1/ws', { websocket: true }, (socket, request) => {
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        if (origin.host !== request.headers.host) { socket.close(4003, 'Invalid origin'); return; }
      } catch { socket.close(4003, 'Invalid origin'); return; }
    }
    if (Object.keys(request.query as object).length) { socket.close(4008, 'Use hello authentication'); return; }
    if (state.clients.size + pending.size >= 100) { socket.close(1013, 'Connection limit'); return; }
    pending.add(socket);
    let client: ClientState | null = null;
    const authTimer = setTimeout(() => socket.close(4008, 'Authentication timeout'), 5_000);
    authTimer.unref();
    socket.on('message', (raw: Buffer) => {
      try {
        if (!client && !svc.limiter.check(`ws-auth:${request.ip}`).allowed) { socket.close(4008, 'Authentication rate limit'); return; }
        let json: unknown;
        try { json = JSON.parse(raw.toString()); } catch { send(socket, { t: 'error', code: 'BAD_FRAME', message: 'Expected JSON object' }); return; }
        const parsed = frameSchema.safeParse(json);
        if (!parsed.success) { send(socket, { t: 'error', code: 'BAD_FRAME', message: 'Invalid frame' }); return; }
        const frame = parsed.data;
        if (!client) {
          if (frame.t !== 'hello') { socket.close(4008, 'Authentication required'); return; }
          let agent: Agent | null = null;
          let session: string | undefined;
          const operator = OPERATOR_TOKEN.test(frame.token);
          if (SESSION_TOKEN.test(frame.token)) {
            // The opening frame is signed with the browser's device key, like every HTTP request.
            const checked = verifySession(svc.db, svc.events, frame.token, frame.proof, 'WS', '/ws');
            if ('agent' in checked) { agent = checked.agent; session = checked.session; }
          } else if (operator) {
            const record = isLocalRequest(request.headers) ? verifyOperator(svc.config.dataDir, frame.token) : null;
            const scope = record ? operatorAgent(svc.db, record, frame.workspace) : null;
            if (scope && 'agent' in scope) agent = scope.agent;
          } else agent = verifyToken(svc.db, frame.token);
          if (!agent) {
            svc.events.append({ type: 'auth.denied', payload: { via: 'ws', source: requestSource(request) } });
            socket.close(4008, 'Invalid credentials'); return;
          }
          client = { socket, agent, tokenHash: hashToken(frame.token), operator, ...(session ? { session } : {}), subscribedRooms: null, alive: true };
          clearTimeout(authTimer);
          pending.delete(socket);
          state.clients.set(socket, client);
          const workspace = svc.db.prepare('SELECT * FROM workspaces WHERE id=?').get(agent.workspace_id) as Workspace;
          send(socket, { t: 'hello.ok', agent, workspace, ...hubIdentity(svc.db), lastEventId: svc.events.lastId(agent.workspace_id) });
          svc.events.append({ type: 'ws.connect', actor_id: agent.id });
          presence();
          return;
        }
        if (!authorized(client)) return;
        const quota = svc.limiter.check(client.agent.id);
        if (!quota.allowed) { send(socket, { t: 'error', code: 'RATE_LIMITED', message: 'Rate limit exceeded' }); return; }
        switch (frame.t) {
          case 'ping': send(socket, { t: 'pong' }); break;
          case 'subscribe':
            if (frame.rooms?.some((roomId) => !canReadRoom(svc.db,client!.agent,roomId))) throw new RoomError('ROOM_NOT_FOUND','Room not found');
            client.subscribedRooms = frame.rooms ? new Set(frame.rooms) : null; presence(); break;
          case 'message.send': svc.rooms.postMessage(frame.room, client.agent.id, frame.body, frame.to); break;
          case 'hello': send(socket, { t: 'error', code: 'BAD_FRAME', message: 'Already authenticated' }); break;
        }
      } catch (error) {
        if (error instanceof RoomError) send(socket, { t: 'error', code: error.code, message: error.message });
        else { request.log.error({ err: error }, 'WebSocket action failed'); send(socket, { t: 'error', code: 'INTERNAL_ERROR', message: 'Internal error' }); }
      }
    });
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => { if (client) client.alive = true; });
    socket.on('close', () => {
      clearTimeout(authTimer);
      pending.delete(socket);
      if (client) {
        state.clients.delete(socket);
        if (closing) return;
        svc.events.append({ type: 'ws.disconnect', actor_id: client.agent.id });
        presence();
      }
    });
  });

  const heartbeat = startHeartbeat(state, 30_000, authorized);
  heartbeat.unref();
  app.addHook('preClose', async () => {
    closing = true;
    clearInterval(heartbeat);
    unsubscribe();
    svc.security?.off('alert', onAlert);
    for (const socket of [...pending, ...state.clients.keys()]) socket.terminate();
  });
}

export function startHeartbeat(state: WsState, intervalMs = 30_000, isAuthorized: (client: ClientState) => boolean = () => true): NodeJS.Timeout {
  return setInterval(() => {
    for (const [socket, client] of state.clients) {
      if (!isAuthorized(client)) continue;
      if (!client.alive) { socket.terminate(); state.clients.delete(socket); continue; }
      client.alive = false;
      socket.ping();
    }
  }, intervalMs);
}
