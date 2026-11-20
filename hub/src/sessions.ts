// Client sessions.
//
// A client (guest) does not keep a permanent hub token. Their browser holds a session that ends
// after a fixed time (3 hours by default) or when they sign out. Each session is bound to a key pair
// the browser created and cannot export: the hub keeps only the public key, and every request must
// carry a fresh signature made with the private key. A session token found in storage, a log or on
// disk is therefore useless anywhere else.
//
// New sessions come from (1) redeeming an invite, (2) a passkey (Face ID, Touch ID, Windows Hello,
// a phone), which needs the person to be present, or (3) a one-time sign-in link from staff, valid
// for 15 minutes. When a session ends, everything the client and their sidekick did stays on the
// hub; it just can't be reached until a new session starts.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticatorTransport,
} from '@simplewebauthn/server';
import { activeAgent, hashToken } from './auth.js';
import { newId, nowIso, type DbHandle } from './db.js';
import type { EventBus } from './events.js';
import { isLocalRequest } from './operator.js';
import { sharedOrigin } from './origin.js';
import type { Agent, HubServices } from './types.js';

export const SESSION_TOKEN = /^achs_(ses_[a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;
const LINK_CODE = /^achl_[A-Za-z0-9_-]{43}$/;
const MAX_SKEW_MS = 120_000;
const MAX_ACTIVE_PER_PERSON = 5;
const fail = (code: string, message: string) => ({ error: { code, message } });

export type SessionVia = 'invite' | 'passkey' | 'link';
export interface DeviceKey { kty: 'EC'; crv: 'P-256'; x: string; y: string }
export const deviceKeySchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).passthrough()
  .transform(({ kty, crv, x, y }): DeviceKey => ({ kty, crv, x, y }));

interface SessionRow { id: string; workspace_id: string; agent_id: string; token_hash: string; device_key: string; via: SessionVia; created_at: string; expires_at: string; ended_at: string | null }

// Signatures seen recently, so a captured request can't be replayed within the clock window.
const seen = new Map<string, number>();
function firstUse(signature: string): boolean {
  const now = Date.now();
  if (seen.size > 50_000) for (const [key, at] of seen) if (now - at > MAX_SKEW_MS * 2) seen.delete(key);
  if (seen.has(signature)) return false;
  seen.set(signature, now);
  return true;
}

/** The message a browser signs for one request. */
export function proofMessage(ts: number, method: string, path: string, sessionId: string): string {
  return `${ts}\n${method.toUpperCase()}\n${path}\n${sessionId}`;
}

export function sessionHours(): number {
  const value = Number(process.env.HUB_CLIENT_SESSION_HOURS ?? 3);
  return Number.isFinite(value) && value >= 0.05 && value <= 24 ? value : 3;
}

export function startSession(db: DbHandle, events: EventBus, agent: Pick<Agent, 'id' | 'workspace_id'>, deviceKey: DeviceKey, via: SessionVia): { token: string; id: string; expires_at: string } {
  const id = newId('ses');
  const token = `achs_${id}.${randomBytes(32).toString('base64url')}`;
  const now = new Date();
  const expires = new Date(now.getTime() + sessionHours() * 3600_000).toISOString();
  db.transaction(() => {
    // Keep a few devices signed in at once; the oldest makes way.
    const active = db.prepare('SELECT id FROM sessions WHERE agent_id = ? AND ended_at IS NULL ORDER BY created_at DESC').all(agent.id) as { id: string }[];
    for (const old of active.slice(MAX_ACTIVE_PER_PERSON - 1)) db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'replaced' WHERE id = ?").run(now.toISOString(), old.id);
    db.prepare('INSERT INTO sessions (id, workspace_id, agent_id, token_hash, device_key, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agent.workspace_id, agent.id, hashToken(token), JSON.stringify(deviceKey), via, now.toISOString(), expires);
  })();
  events.append({ type: 'session.started', workspace_id: agent.workspace_id, actor_id: agent.id, payload: { session_id: id, via, expires_at: expires } });
  return { token, id, expires_at: expires };
}

export function endSession(db: DbHandle, events: EventBus, sessionId: string, reason: 'signed_out' | 'expired' | 'revoked'): boolean {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND ended_at IS NULL').get(sessionId) as SessionRow | undefined;
  if (!row) return false;
  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(nowIso(), reason, sessionId);
  const remaining = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ? AND ended_at IS NULL AND expires_at > ?').get(row.agent_id, nowIso()) as { n: number }).n;
  events.append({ type: 'session.ended', workspace_id: row.workspace_id, actor_id: row.agent_id, payload: { session_id: row.id, reason, remaining } });
  return true;
}

/** True while the person has at least one live session. */
export function hasActiveSession(db: DbHandle, agentId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE agent_id = ? AND ended_at IS NULL AND expires_at > ?').get(agentId, nowIso()));
}

/** Clients sign in with sessions; their own bearer tokens are refused (sidekicks keep per-job tokens). */
export function needsSession(db: DbHandle, agentId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM agents a WHERE a.id = ? AND a.guest = 1 AND NOT EXISTS (SELECT 1 FROM sidekicks s WHERE s.agent_id = a.id)').get(agentId));
}

export type SessionCheck = { agent: Agent; session: string } | { error: 'SESSION_INVALID' | 'SESSION_ENDED' | 'SESSION_EXPIRED' | 'PROOF_REQUIRED' | 'PROOF_INVALID' };

/**
 * Checks a session token and the request's proof. `proof` is "<ms timestamp>.<base64url signature>"
 * over proofMessage(ts, method, path, sessionId), made with the session's device key.
 */
export function verifySession(db: DbHandle, events: EventBus, token: string, proof: string | undefined, method: string, path: string): SessionCheck {
  const match = SESSION_TOKEN.exec(token);
  if (!match) return { error: 'SESSION_INVALID' };
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(match[1]) as SessionRow | undefined;
  if (!row) return { error: 'SESSION_INVALID' };
  const offered = Buffer.from(hashToken(token)), stored = Buffer.from(row.token_hash);
  if (offered.length !== stored.length || !timingSafeEqual(offered, stored)) return { error: 'SESSION_INVALID' };
  if (row.ended_at) return { error: 'SESSION_ENDED' };
  if (row.expires_at <= nowIso()) { endSession(db, events, row.id, 'expired'); return { error: 'SESSION_EXPIRED' }; }
  const parts = /^(\d{13})\.([A-Za-z0-9_-]{86})$/.exec(proof ?? '');
  if (!parts) return { error: 'PROOF_REQUIRED' };
  const ts = Number(parts[1]);
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return { error: 'PROOF_INVALID' };
  let ok = false;
  try {
    const key = createPublicKey({ key: JSON.parse(row.device_key) as import('node:crypto').JsonWebKey, format: 'jwk' });
    ok = verifySignature('sha256', Buffer.from(proofMessage(ts, method, path, row.id)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url'));
  } catch { ok = false; }
  if (!ok || !firstUse(parts[2]!)) return { error: 'PROOF_INVALID' };
  // The identity itself can be removed or revoked by staff at any time.
  const agent = activeAgent(db, row.agent_id);
  if (!agent || agent.workspace_id !== row.workspace_id) return { error: 'SESSION_ENDED' };
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { agent, session: row.id };
}

/** Same session checks without a proof, for an already authenticated WebSocket. */
export function sessionStillValid(db: DbHandle, sessionId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL AND expires_at > ?').get(sessionId, nowIso()));
}

export const SESSION_MESSAGES: Record<string, string> = {
  SESSION_INVALID: 'Sign in again to continue.',
  SESSION_ENDED: 'Your session has ended. Sign in again to continue.',
  SESSION_EXPIRED: 'Your session ended after its time limit. Sign in again to continue.',
  PROOF_REQUIRED: 'This session can only be used from the browser that started it.',
  PROOF_INVALID: 'This session can only be used from the browser that started it.',
};

/** Ends sessions that ran out, so their sidekicks go to sleep promptly. */
export class SessionClock {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: DbHandle, private readonly events: EventBus) {}
  start(): void { this.timer = setInterval(() => this.tick(), 30_000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  tick(): number {
    const due = this.db.prepare('SELECT id FROM sessions WHERE ended_at IS NULL AND expires_at <= ?').all(nowIso()) as { id: string }[];
    for (const { id } of due) endSession(this.db, this.events, id, 'expired');
    return due.length;
  }
}

// ---------- passkeys ----------
const challenges = new Map<string, { challenge: string; agentId: string | null; origin: string; rpID: string; at: number }>();
function remember(key: string, value: { challenge: string; agentId: string | null; origin: string; rpID: string }): void {
  const now = Date.now();
  for (const [k, entry] of challenges) if (now - entry.at > 5 * 60_000) challenges.delete(k);
  challenges.set(key, { ...value, at: now });
}

/** The page the browser is on, accepted only if it is this hub's shared address or a local one. */
function pageOrigin(svc: HubServices, request: FastifyRequest): { origin: string; rpID: string } | null {
  const origin = String(request.headers.origin ?? '');
  let url: URL;
  try { url = new URL(origin); } catch { return null; }
  const shared = sharedOrigin(svc);
  if (shared && url.origin === shared) return { origin: url.origin, rpID: url.hostname };
  // On the hub's own machine (directly or through the local web dev server): localhost only.
  if (isLocalRequest(request.headers) && url.protocol === 'http:' && url.hostname === 'localhost') return { origin: url.origin, rpID: 'localhost' };
  return null;
}

const registerVerify = z.object({ response: z.record(z.string(), z.unknown()), label: z.string().trim().max(60).optional() }).strict();
const loginVerify = z.object({ challenge_id: z.string().regex(/^[A-Za-z0-9_-]{22}$/), response: z.record(z.string(), z.unknown()), device_key: deviceKeySchema }).strict();
const linkRedeem = z.object({ code: z.string().regex(LINK_CODE), device_key: deviceKeySchema }).strict();
const agentParams = z.object({ id: z.string().regex(/^agt_[a-f0-9]{16}$/) });
const passkeyParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,1400}$/) });

export function registerSessionRoutes(app: FastifyInstance, svc: HubServices): void {
  const { db, events } = svc;
  const limited = (request: FastifyRequest, bucket: string) => !svc.limiter.check(`${bucket}:${request.ip}`).allowed;
  const sessionOf = (request: FastifyRequest) => request.auth?.session ?? null;
  const view = (agent: Agent) => ({ ...agent, ...(db.prepare('SELECT avatar, guest FROM agents WHERE id = ?').get(agent.id) as { avatar: string | null; guest: number }) });
  const issue = (agent: Agent, deviceKey: DeviceKey, via: SessionVia) => {
    const session = startSession(db, events, agent, deviceKey, via);
    const passkeys = (db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE agent_id = ? AND removed_at IS NULL').get(agent.id) as { n: number }).n;
    return { session_token: session.token, expires_at: session.expires_at, agent: view(agent), passkeys };
  };

  app.get('/v1/session', { preHandler: svc.authGuard }, async (request) => {
    const id = sessionOf(request);
    const row = id ? db.prepare('SELECT id, via, created_at, expires_at FROM sessions WHERE id = ?').get(id) : null;
    const passkeys = db.prepare('SELECT id, label, created_at, last_used_at FROM passkeys WHERE agent_id = ? AND removed_at IS NULL ORDER BY created_at').all(request.auth!.agent.id);
    return { session: row ?? null, passkeys, cycle_hours: sessionHours() };
  });

  app.post('/v1/session/sign-out', { preHandler: svc.authGuard }, async (request) => {
    const id = sessionOf(request);
    if (id) endSession(db, events, id, 'signed_out');
    return { signed_out: Boolean(id) };
  });

  // Staff: a one-time sign-in link for a client (new device, lost passkey, or no passkey yet).
  app.post('/v1/agents/:id/sign-in-link', { preHandler: svc.requireRole(['supervisor']) }, async (request, reply) => {
    const params = agentParams.safeParse(request.params);
    const staff = request.auth!.agent;
    const target = params.success ? db.prepare('SELECT id, workspace_id, name FROM agents WHERE id = ? AND workspace_id = ?').get(params.data.id, staff.workspace_id) as { id: string; workspace_id: string; name: string } | undefined : undefined;
    if (!target || !needsSession(db, target.id) || !activeAgent(db, target.id)) {
      return reply.code(404).send(fail('NOT_FOUND', 'That person cannot get a sign-in link'));
    }
    const code = `achl_${randomBytes(32).toString('base64url')}`;
    const expires = new Date(Date.now() + 15 * 60_000).toISOString();
    db.prepare('INSERT INTO signin_links (id, workspace_id, agent_id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId('lnk'), target.workspace_id, target.id, createHash('sha256').update(code).digest('hex'), staff.id, nowIso(), expires);
    events.append({ type: 'signin_link.created', workspace_id: target.workspace_id, actor_id: staff.id, target_id: target.id, payload: { expires_at: expires } });
    const base = sharedOrigin(svc) ?? (() => { try { return new URL(String(request.headers.origin)).origin; } catch { return null; } })();
    // The code travels in the fragment, which browsers never send to a server or a tunnel log.
    return { url: base ? `${base}/signin#${code}` : null, path: `/signin#${code}`, expires_at: expires, name: target.name };
  });

  app.post('/v1/signin/link', async (request, reply) => {
    if (limited(request, 'signin-link')) return reply.code(429).send(fail('RATE_LIMITED', 'Too many tries. Wait a minute.'));
    const input = linkRedeem.safeParse(request.body);
    if (!input.success) return reply.code(400).send(fail('VALIDATION_ERROR', 'That sign-in link is not complete. Copy the whole link.'));
    const now = nowIso();
    const link = db.prepare('SELECT * FROM signin_links WHERE code_hash = ?').get(createHash('sha256').update(input.data.code).digest('hex')) as
      { id: string; agent_id: string; workspace_id: string; expires_at: string; used_at: string | null } | undefined;
    if (!link || link.used_at || link.expires_at <= now) return reply.code(410).send(fail('LINK_USED', 'This sign-in link has expired or was already used. Ask for a new one.'));
    if (!db.prepare('UPDATE signin_links SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, link.id).changes) return reply.code(410).send(fail('LINK_USED', 'This sign-in link was already used. Ask for a new one.'));
    const agent = activeAgent(db, link.agent_id);
    if (!agent || !needsSession(db, agent.id)) return reply.code(410).send(fail('LINK_USED', 'This sign-in link no longer works. Ask for a new one.'));
    return issue(agent, input.data.device_key, 'link');
  });

  // Passkey: save one while signed in.
  app.post('/v1/passkeys/register/options', { preHandler: svc.authGuard }, async (request, reply) => {
    const agent = request.auth!.agent;
    const page = pageOrigin(svc, request);
    if (!page) return reply.code(400).send(fail('ORIGIN_NOT_ALLOWED', 'Passkeys work only on this hub\'s own address.'));
    if (!needsSession(db, agent.id)) return reply.code(403).send(fail('FORBIDDEN', 'Passkeys are for people who sign in to the Studio as clients.'));
    const existing = db.prepare('SELECT id, transports FROM passkeys WHERE agent_id = ? AND removed_at IS NULL').all(agent.id) as { id: string; transports: string | null }[];
    const options = await generateRegistrationOptions({
      rpName: 'Collab Studio', rpID: page.rpID, userName: agent.name, userDisplayName: agent.name,
      userID: new TextEncoder().encode(agent.id), attestationType: 'none',
      excludeCredentials: existing.map((key) => ({ id: key.id, ...(key.transports ? { transports: JSON.parse(key.transports) as AuthenticatorTransport[] } : {}) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    remember(`register:${agent.id}`, { challenge: options.challenge, agentId: agent.id, ...page });
    return options;
  });

  app.post('/v1/passkeys/register/verify', { preHandler: svc.authGuard }, async (request, reply) => {
    const agent = request.auth!.agent;
    const input = registerVerify.safeParse(request.body);
    const pending = challenges.get(`register:${agent.id}`);
    if (!input.success || !pending) return reply.code(400).send(fail('PASSKEY_FAILED', 'Saving the passkey didn\'t finish. Try again.'));
    challenges.delete(`register:${agent.id}`);
    let result;
    try {
      result = await verifyRegistrationResponse({ response: input.data.response as never, expectedChallenge: pending.challenge, expectedOrigin: pending.origin, expectedRPID: pending.rpID, requireUserVerification: true });
    } catch { return reply.code(400).send(fail('PASSKEY_FAILED', 'Saving the passkey didn\'t finish. Try again.')); }
    if (!result.verified || !result.registrationInfo) return reply.code(400).send(fail('PASSKEY_FAILED', 'Saving the passkey didn\'t finish. Try again.'));
    const { credential } = result.registrationInfo;
    db.prepare('INSERT INTO passkeys (id, workspace_id, agent_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(credential.id, agent.workspace_id, agent.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null, input.data.label ?? null, nowIso());
    events.append({ type: 'passkey.added', workspace_id: agent.workspace_id, actor_id: agent.id, payload: { label: input.data.label ?? null } });
    return { saved: true };
  });

  app.delete('/v1/passkeys/:id', { preHandler: svc.authGuard }, async (request, reply) => {
    const params = passkeyParams.safeParse(request.params);
    const agent = request.auth!.agent;
    if (!params.success || !db.prepare('UPDATE passkeys SET removed_at = ? WHERE id = ? AND agent_id = ? AND removed_at IS NULL').run(nowIso(), params.data.id, agent.id).changes) {
      return reply.code(404).send(fail('NOT_FOUND', 'Passkey not found'));
    }
    events.append({ type: 'passkey.removed', workspace_id: agent.workspace_id, actor_id: agent.id, payload: {} });
    return { removed: true };
  });

  // Passkey: start a new session without typing anything.
  app.post('/v1/passkeys/login/options', async (request, reply) => {
    if (limited(request, 'passkey-login')) return reply.code(429).send(fail('RATE_LIMITED', 'Too many tries. Wait a minute.'));
    const page = pageOrigin(svc, request);
    if (!page) return reply.code(400).send(fail('ORIGIN_NOT_ALLOWED', 'Passkeys work only on this hub\'s own address.'));
    const options = await generateAuthenticationOptions({ rpID: page.rpID, userVerification: 'required', allowCredentials: [] });
    const challengeId = randomBytes(16).toString('base64url');
    remember(`login:${challengeId}`, { challenge: options.challenge, agentId: null, ...page });
    return { challenge_id: challengeId, options };
  });

  app.post('/v1/passkeys/login/verify', async (request, reply) => {
    if (limited(request, 'passkey-login')) return reply.code(429).send(fail('RATE_LIMITED', 'Too many tries. Wait a minute.'));
    const input = loginVerify.safeParse(request.body);
    const pending = input.success ? challenges.get(`login:${input.data.challenge_id}`) : undefined;
    const refused = () => {
      events.append({ type: 'auth.denied', payload: { path: '/v1/passkeys/login/verify', reason: 'passkey_failed' } });
      return reply.code(401).send(fail('PASSKEY_FAILED', 'That passkey didn\'t work here. Ask for a sign-in link instead.'));
    };
    if (!input.success || !pending) return refused();
    challenges.delete(`login:${input.data.challenge_id}`);
    const credentialId = typeof input.data.response.id === 'string' ? input.data.response.id : '';
    const key = db.prepare('SELECT * FROM passkeys WHERE id = ? AND removed_at IS NULL').get(credentialId) as
      { id: string; agent_id: string; public_key: string; counter: number; transports: string | null } | undefined;
    if (!key) return refused();
    let result;
    try {
      result = await verifyAuthenticationResponse({ response: input.data.response as never, expectedChallenge: pending.challenge, expectedOrigin: pending.origin, expectedRPID: pending.rpID,
        credential: { id: key.id, publicKey: Buffer.from(key.public_key, 'base64url'), counter: key.counter, ...(key.transports ? { transports: JSON.parse(key.transports) as AuthenticatorTransport[] } : {}) },
        requireUserVerification: true });
    } catch { return refused(); }
    if (!result.verified) return refused();
    db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(result.authenticationInfo.newCounter, nowIso(), key.id);
    const agent = activeAgent(db, key.agent_id);
    if (!agent || !needsSession(db, agent.id)) return refused();
    return issue(agent, input.data.device_key, 'passkey');
  });
}
