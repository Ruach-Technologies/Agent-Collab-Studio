// Bearer-token authentication: lookup by SHA-256 hash, roles, request decoration.
//
// Tokens are 24 random bytes, base64url, prefixed ach_. The raw token is shown
// once at issuance; only its SHA-256 hash is stored. Revocation sets
// tokens.revoked_at; the agents row is kept for history.
import { SESSION_MESSAGES, SESSION_TOKEN, verifySession } from './sessions.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DbHandle } from './db.js';
import type { Role, Agent } from './types.js';
import type { EventBus } from './events.js';
import type { TokenBucketLimiter } from './ratelimit.js';
import { OPERATOR_TOKEN, isLocalRequest, operatorAgent, verifyOperator } from './operator.js';
import { requestSource } from './security.js';

export interface AuthContext {
  agent: Agent;
  /** Set when the local operator credential selected this workspace identity. */
  operator?: boolean;
  /** Set when a client signed in with a device-bound session. */
  session?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the bearer guard for every authenticated request. */
    auth: AuthContext | null;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Verify a raw token against the registry. Returns the agent or null. */
export function verifyToken(db: DbHandle, token: string): Agent | null {
  if (!/^ach_[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const hash = hashToken(token);
  const row = db
    .prepare(
      `SELECT a.id, a.workspace_id, a.name, a.role, a.created_at, a.last_seen_at
         FROM tokens t JOIN agents a ON a.id = t.agent_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.workspace_id = a.workspace_id
          -- Clients sign in with sessions; only sidekicks among guests use bearer tokens (per job).
          AND (a.guest = 0 OR EXISTS (SELECT 1 FROM sidekicks s WHERE s.agent_id = a.id AND s.removed_at IS NULL))`,
    )
    .get(hash) as Agent | undefined;
  if (!row) return null;
  markAgentSeen(db, row.id);
  return row;
}

/** The agent row, only while it still holds an unrevoked hub token. */
export function activeAgent(db: DbHandle, agentId: string): Agent | null {
  if (!/^agt_[a-f0-9]{16}$/.test(agentId)) return null;
  return (db.prepare(
    `SELECT a.id, a.workspace_id, a.name, a.role, a.created_at, a.last_seen_at FROM agents a
      WHERE a.id = ? AND EXISTS (SELECT 1 FROM tokens t WHERE t.agent_id = a.id AND t.revoked_at IS NULL AND t.workspace_id = a.workspace_id)`,
  ).get(agentId) as Agent | undefined) ?? null;
}

/** Update the agent's last_seen_at (also stamps tokens.last_used_at). */
export function markAgentSeen(db: DbHandle, agentId: string): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(now, agentId);
  db.prepare(`UPDATE tokens SET last_used_at = ? WHERE agent_id = ? AND revoked_at IS NULL`).run(now, agentId);
}

/** onRequest bearer guard: attaches req.auth or rejects with 401 + audit event. */
/** Auth preHandler: validates bearer credentials and sets req.auth. */
export function bearerGuard(
  db: DbHandle,
  events: EventBus,
  limiter?: TokenBucketLimiter,
  dataDir?: string,
  /** Per-process secret for requests the hub makes to itself on behalf of an already verified MCP caller. */
  internalSecret?: string,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const marker = req.headers['x-hub-internal'];
    if (marker !== undefined) {
      // Never reachable from the network without the secret, which exists only in this process's memory.
      const offered = Buffer.from(String(marker)), expected = Buffer.from(internalSecret ?? '');
      const trusted = expected.length > 0 && offered.length === expected.length && timingSafeEqual(offered, expected);
      const agent = trusted ? activeAgent(db, String(req.headers['x-hub-agent'] ?? '')) : null;
      if (!agent) {
        void events.append({ type: 'auth.denied', payload: { path: req.url.split('?')[0], reason: 'invalid_internal', source: requestSource(req) } });
        void reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or revoked token' } });
        return;
      }
      markAgentSeen(db, agent.id);
      req.auth = { agent };
      if (req.method !== 'GET') events.append({ type: 'auth.ok', actor_id: agent.id, payload: { path: req.url.split('?')[0], method: req.method, via: 'mcp' } });
      return;
    }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      void events.append({ type: 'auth.denied', payload: { path: req.url.split('?')[0], reason: 'missing_token', source: requestSource(req) } });
      void reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Missing bearer token' } });
      return;
    }
    if (SESSION_TOKEN.test(token)) {
      const proof = req.headers['x-hub-proof'];
      const checked = verifySession(db, events, token, typeof proof === 'string' ? proof : undefined, req.method, req.url);
      if ('error' in checked) {
        void events.append({ type: 'auth.denied', payload: { path: req.url.split('?')[0], reason: checked.error.toLowerCase(), source: requestSource(req) } });
        void reply.code(401).send({ error: { code: checked.error, message: SESSION_MESSAGES[checked.error] } });
        return;
      }
      markAgentSeen(db, checked.agent.id);
      req.auth = { agent: checked.agent, session: checked.session };
      if (req.method !== 'GET') events.append({ type: 'auth.ok', actor_id: checked.agent.id, payload: { path: req.url.split('?')[0], method: req.method, via: 'session' } });
      return;
    }
    const operator = dataDir && OPERATOR_TOKEN.test(token) ? verifyOperator(dataDir, token) : null;
    if (operator) {
      const path = req.url.split('?')[0];
      if (!isLocalRequest(req.headers)) {
        void events.append({ type: 'auth.denied', payload: { path, reason: 'operator_not_local', source: requestSource(req) } });
        void reply.code(403).send({ error: { code: 'OPERATOR_LOCAL_ONLY', message: 'Operator access works only on the hub machine at its loopback address' } });
        return;
      }
      const requested = req.headers['x-hub-workspace'];
      const scope = operatorAgent(db, operator, typeof requested === 'string' ? requested : undefined);
      if ('error' in scope) {
        void reply.code(404).send({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } });
        return;
      }
      markAgentSeen(db, scope.agent.id);
      req.auth = { agent: scope.agent, operator: true };
      if (req.method !== 'GET') events.append({ type: 'auth.ok', actor_id: scope.agent.id, payload: { path, method: req.method, via: 'operator' } });
      return;
    }
    const agent = verifyToken(db, token);
    if (!agent) {
      if (limiter && !limiter.check(`invalid:${req.ip}`).allowed) {
        void reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } });
        return;
      }
      void events.append({ type: 'auth.denied', payload: { path: req.url.split('?')[0], reason: 'invalid_token', source: requestSource(req) } });
      void reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or revoked token' } });
      return;
    }
    req.auth = { agent };
    if (req.method !== 'GET') events.append({ type: 'auth.ok', actor_id: agent.id, payload: { path: req.url.split('?')[0], method: req.method } });
  };
}

/** Role gate for handlers: requires req.auth (set by the bearer guard). */
export function requireRole(allowed: readonly Role[], reply: FastifyReply, ctx: AuthContext | null): boolean {
  if (!ctx) {
    void reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    return false;
  }
  if (!allowed.includes(ctx.agent.role)) {
    void reply.code(403).send({ error: { code: 'FORBIDDEN', message: `Role '${ctx.agent.role}' may not perform this action` } });
    return false;
  }
  return true;
}
