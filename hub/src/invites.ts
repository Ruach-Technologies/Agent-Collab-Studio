// Room invites: a supervisor creates a one-time code, the invited person opens a link and chooses
// a name and avatar, and the hub creates a guest identity that belongs to that one room.
//
// The code travels in the link's fragment, so it is never part of a request URL, and reaches the
// hub only in a POST body. Only its SHA-256 hash is stored. Redeeming returns a hub token once.
import { SESSION_TOKEN, deviceKeySchema, startSession, verifySession } from './sessions.js';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashToken, verifyToken } from './auth.js';
import { newId, nowIso } from './db.js';
import { sharedOrigin } from './origin.js';
import { isLocalRequest } from './operator.js';
import type { HubServices } from './types.js';

/** Pixel characters a member can pick. The web client draws them; the hub only stores the id. */
export const AVATAR_IDS = ['sprout', 'ember', 'pebble', 'comet', 'moss', 'tide', 'bolt', 'wisp', 'robo', 'fox', 'owl', 'cat', 'frog', 'crab', 'bat', 'snail'] as const;
export type AvatarId = typeof AVATAR_IDS[number];

const CODE = /^achi_[A-Za-z0-9_-]{32}$/;
const MAX_OPEN_PER_ROOM = 50;
const roomParams = z.object({ id: z.string().regex(/^room_[a-f0-9]{16}$/) });
const inviteParams = z.object({ id: z.string().regex(/^inv_[a-f0-9]{16}$/) });
const agentParams = z.object({ id: z.string().regex(/^agt_[a-f0-9]{16}$/) });
const createSchema = z.object({
  label: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  expires_in_hours: z.number().int().min(1).max(720).default(168),
}).strict();
const codeSchema = z.object({ code: z.string().regex(CODE) }).strict();
/** Letters, digits and a few separators, so a name is usable as an @mention and safe to display. */
const displayName = z.string().trim().regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u);
const avatar = z.enum(AVATAR_IDS);
// The name is only used when a new identity is created; a signed-in guest keeps theirs.
const redeemSchema = z.object({ code: z.string().regex(CODE), name: displayName.optional(), avatar: avatar.optional(), device_key: deviceKeySchema.optional() }).strict();
const profileSchema = z.object({ avatar }).strict();

interface InviteRow {
  id: string; workspace_id: string; room_id: string; label: string | null; created_by: string; created_at: string;
  expires_at: string; redeemed_at: string | null; redeemed_by: string | null; revoked_at: string | null;
}
type InviteState = 'open' | 'used' | 'expired' | 'revoked';
const stateOf = (row: InviteRow): InviteState =>
  row.revoked_at ? 'revoked' : row.redeemed_at ? 'used' : row.expires_at <= nowIso() ? 'expired' : 'open';
const fail = (code: string, message: string) => ({ error: { code, message } });

export function registerInviteRoutes(app: FastifyInstance, svc: HubServices): void {
  const { db, events } = svc;
  const isGuest = (id: string) => (db.prepare('SELECT guest FROM agents WHERE id = ?').get(id) as { guest: number } | undefined)?.guest === 1;
  const profile = (id: string) => {
    const row = db.prepare('SELECT avatar, guest FROM agents WHERE id = ?').get(id) as { avatar: string | null; guest: number } | undefined;
    return { avatar: row?.avatar ?? null, guest: row?.guest === 1 };
  };
  const byCode = (code: string) => db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(hashToken(code)) as InviteRow | undefined;
  /** Looks an invite up for the join page; every unusable state has its own plain explanation. */
  function usable(code: string, ip: string): { invite: InviteRow } | { status: number; body: ReturnType<typeof fail> } {
    const invite = byCode(code);
    const room = invite ? svc.rooms.get(invite.room_id, invite.workspace_id) : null;
    if (!invite || !room) {
      if (!svc.limiter.check(`invalid:${ip}`).allowed) return { status: 429, body: fail('RATE_LIMITED', 'Rate limit exceeded') };
      events.append({ type: 'auth.denied', payload: { path: '/v1/invites', reason: 'invalid_invite' } });
      return { status: 404, body: fail('INVITE_INVALID', 'This invite link is not valid. Ask for a new one.') };
    }
    const state = stateOf(invite);
    if (state === 'used') return { status: 410, body: fail('INVITE_USED', 'This invite link has already been used. Ask for a new one.') };
    if (state !== 'open') return { status: 410, body: fail('INVITE_EXPIRED', 'This invite link is no longer active. Ask for a new one.') };
    return { invite };
  }

  app.post('/v1/rooms/:id/invites', { preHandler: svc.requireRole(['supervisor']) }, async (request, reply) => {
    const params = roomParams.safeParse(request.params);
    const input = createSchema.safeParse(request.body ?? {});
    if (!params.success || !input.success) return reply.code(400).send(fail('VALIDATION_ERROR', 'Valid room id, optional label (1–80 characters) and expires_in_hours (1–720) required'));
    const actor = request.auth!.agent;
    const room = svc.rooms.get(params.data.id, actor.workspace_id);
    if (!room) return reply.code(404).send(fail('ROOM_NOT_FOUND', 'Room not found'));
    const now = nowIso();
    const open = db.prepare('SELECT COUNT(*) AS total FROM invites WHERE room_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?').get(room.id, now) as { total: number };
    if (open.total >= MAX_OPEN_PER_ROOM) return reply.code(409).send(fail('INVITE_LIMIT', 'Too many open invites for this room. Revoke some first.'));
    const code = `achi_${randomBytes(24).toString('base64url')}`;
    const id = newId('inv');
    const expires = new Date(Date.now() + input.data.expires_in_hours * 3_600_000).toISOString();
    db.prepare('INSERT INTO invites (id, workspace_id, room_id, code_hash, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, room.workspace_id, room.id, hashToken(code), input.data.label ?? null, actor.id, now, expires);
    events.append({ type: 'invite.created', room_id: room.id, actor_id: actor.id, payload: { invite_id: id, label: input.data.label ?? null, expires_at: expires } });
    // A link is only worth sending when it uses the address people outside this machine can reach.
    const shared = sharedOrigin(svc);
    const origin = shared ?? (isLocalRequest(request.headers) ? `http://${String(request.headers.host)}` : null);
    return reply.code(201).send({
      invite: { id, room_id: room.id, label: input.data.label ?? null, created_at: now, expires_at: expires, state: 'open' },
      code, url: origin ? `${origin}/join#${code}` : null, shareable: shared !== null,
    });
  });

  app.get('/v1/rooms/:id/invites', { preHandler: svc.requireRole(['supervisor']) }, async (request, reply) => {
    const params = roomParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail('VALIDATION_ERROR', 'Invalid room id'));
    if (!svc.rooms.get(params.data.id, request.auth!.agent.workspace_id)) return reply.code(404).send(fail('ROOM_NOT_FOUND', 'Room not found'));
    const rows = db.prepare(`SELECT i.*, a.name AS redeemed_name FROM invites i LEFT JOIN agents a ON a.id = i.redeemed_by
      WHERE i.room_id = ? ORDER BY i.created_at DESC, i.id LIMIT 200`).all(params.data.id) as (InviteRow & { redeemed_name: string | null })[];
    return { invites: rows.map((row) => ({ id: row.id, room_id: row.room_id, label: row.label, created_at: row.created_at, expires_at: row.expires_at,
      redeemed_at: row.redeemed_at, redeemed_by: row.redeemed_by, redeemed_name: row.redeemed_name, revoked_at: row.revoked_at, state: stateOf(row) })) };
  });

  app.delete('/v1/invites/:id', { preHandler: svc.requireRole(['supervisor']) }, async (request, reply) => {
    const params = inviteParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail('VALIDATION_ERROR', 'Invalid invite id'));
    const invite = db.prepare('SELECT * FROM invites WHERE id = ? AND workspace_id = ?').get(params.data.id, request.auth!.agent.workspace_id) as InviteRow | undefined;
    if (!invite) return reply.code(404).send(fail('INVITE_NOT_FOUND', 'Invite not found'));
    const changed = db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND redeemed_at IS NULL').run(nowIso(), invite.id).changes;
    if (changed) events.append({ type: 'invite.revoked', room_id: invite.room_id, actor_id: request.auth!.agent.id, payload: { invite_id: invite.id } });
    return { revoked: changed === 1 };
  });

  // The two calls below are made by the join page before the visitor has any identity.
  app.post('/v1/invites/preview', async (request, reply) => {
    const input = codeSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send(fail('VALIDATION_ERROR', 'A valid invite code is required'));
    const found = usable(input.data.code, request.ip);
    if (!('invite' in found)) return reply.code(found.status).send(found.body);
    const room = svc.rooms.get(found.invite.room_id)!;
    const inviter = db.prepare('SELECT name FROM agents WHERE id = ?').get(found.invite.created_by) as { name: string };
    const taken = (db.prepare('SELECT name FROM agents WHERE workspace_id = ?').all(found.invite.workspace_id) as { name: string }[]).length;
    return { room: { name: room.name, project: room.project }, invited_by: inviter.name, expires_at: found.invite.expires_at,
      suggested_name: found.invite.label, members: taken, avatars: AVATAR_IDS };
  });

  app.post('/v1/invites/redeem', async (request, reply) => {
    const input = redeemSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', 'Choose a name of 1–40 letters, numbers, spaces, dots, dashes or underscores, starting with a letter or number'));
    }
    const found = usable(input.data.code, request.ip);
    if (!('invite' in found)) return reply.code(found.status).send(found.body);
    const { invite } = found;

    // Someone already signed in as a guest of the same workspace keeps one identity across projects:
    // the invite adds this room to it instead of creating a second login.
    const bearer = /^Bearer (\S{1,200})$/.exec(String(request.headers.authorization ?? ''))?.[1];
    const proof = request.headers['x-hub-proof'];
    const signedIn = bearer && SESSION_TOKEN.test(bearer) ? verifySession(db, events, bearer, typeof proof === 'string' ? proof : undefined, request.method, request.url) : null;
    const current = signedIn && 'agent' in signedIn ? signedIn.agent : bearer ? verifyToken(db, bearer) : null;
    if (current && current.workspace_id === invite.workspace_id && isGuest(current.id)) {
      const now = nowIso();
      const claimed = db.transaction((): boolean => {
        if (!db.prepare('UPDATE invites SET redeemed_at = ?, redeemed_by = ? WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?').run(now, current.id, invite.id, now).changes) return false;
        db.prepare('INSERT OR IGNORE INTO members (room_id, agent_id, joined_at) VALUES (?, ?, ?)').run(invite.room_id, current.id, now);
        return true;
      })();
      if (!claimed) return reply.code(410).send(fail('INVITE_USED', 'This invite link has already been used. Ask for a new one.'));
      events.append({ type: 'invite.redeemed', room_id: invite.room_id, actor_id: current.id, payload: { invite_id: invite.id, name: current.name, existing: true } });
      events.append({ type: 'room.joined', room_id: invite.room_id, actor_id: current.id });
      return reply.code(200).send({ token: null, session_token: null, agent: { ...current, ...profile(current.id) }, room: svc.rooms.get(invite.room_id) });
    }

    if (!input.data.name) return reply.code(400).send(fail('VALIDATION_ERROR', 'Choose a name to show in the room'));
    if (!input.data.device_key) return reply.code(400).send(fail('UPDATE_REQUIRED', 'Reload this page to join: this browser is using an older version of the Studio.'));
    const name = input.data.name.replace(/\s+/g, ' ');
    if (db.prepare('SELECT 1 FROM agents WHERE workspace_id = ? AND name = ? COLLATE NOCASE').get(invite.workspace_id, name)) {
      return reply.code(409).send(fail('NAME_TAKEN', 'Someone here already uses that name. Pick another.'));
    }
    const token = `ach_${randomBytes(24).toString('base64url')}`;
    const agentId = newId('agt');
    const now = nowIso();
    const claimed = db.transaction((): boolean => {
      // The conditional update is what makes the code single use under concurrent requests.
      if (!db.prepare('UPDATE invites SET redeemed_at = ?, redeemed_by = NULL WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?').run(now, invite.id, now).changes) return false;
      db.prepare("INSERT INTO agents (id, workspace_id, name, role, created_at, avatar, guest) VALUES (?, ?, ?, 'agent', ?, ?, 1)").run(agentId, invite.workspace_id, name, now, input.data.avatar ?? null);
      // The identity's token is never handed out: clients sign in with sessions. It only marks the identity active.
      db.prepare("INSERT INTO tokens (id, agent_id, workspace_id, role, token_hash, created_at) VALUES (?, ?, ?, 'agent', ?, ?)").run(newId('tok'), agentId, invite.workspace_id, hashToken(token), now);
      db.prepare('INSERT INTO members (room_id, agent_id, joined_at) VALUES (?, ?, ?)').run(invite.room_id, agentId, now);
      db.prepare('UPDATE invites SET redeemed_by = ? WHERE id = ?').run(agentId, invite.id);
      return true;
    })();
    if (!claimed) return reply.code(410).send(fail('INVITE_USED', 'This invite link has already been used. Ask for a new one.'));
    events.append({ type: 'agent.created', workspace_id: invite.workspace_id, target_id: agentId, payload: { via: 'invite', invite_id: invite.id } });
    events.append({ type: 'invite.redeemed', room_id: invite.room_id, actor_id: agentId, payload: { invite_id: invite.id, name } });
    events.append({ type: 'room.joined', room_id: invite.room_id, actor_id: agentId });
    const session = startSession(db, events, { id: agentId, workspace_id: invite.workspace_id }, input.data.device_key, 'invite');
    return reply.code(201).send({
      token: null,
      session_token: session.token,
      expires_at: session.expires_at,
      agent: { id: agentId, workspace_id: invite.workspace_id, name, role: 'agent', created_at: now, last_seen_at: null, avatar: input.data.avatar ?? null, guest: true },
      room: svc.rooms.get(invite.room_id),
    });
  });

  app.patch('/v1/me', { preHandler: svc.authGuard }, async (request, reply) => {
    const input = profileSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send(fail('VALIDATION_ERROR', 'Choose one of the available avatars'));
    const agent = request.auth!.agent;
    db.prepare('UPDATE agents SET avatar = ? WHERE id = ?').run(input.data.avatar, agent.id);
    events.append({ type: 'agent.updated', actor_id: agent.id, target_id: agent.id, payload: { avatar: input.data.avatar } });
    return { agent: { ...agent, avatar: input.data.avatar } };
  });

  // Removing a guest ends their access everywhere at once; ordinary identities stay a local operator action.
  app.post('/v1/agents/:id/remove', { preHandler: svc.requireRole(['supervisor']) }, async (request, reply) => {
    const params = agentParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(fail('VALIDATION_ERROR', 'Invalid agent id'));
    const actor = request.auth!.agent;
    const target = db.prepare('SELECT id, guest FROM agents WHERE id = ? AND workspace_id = ?').get(params.data.id, actor.workspace_id) as { id: string; guest: number } | undefined;
    if (!target) return reply.code(404).send(fail('AGENT_NOT_FOUND', 'Agent not found'));
    if (!target.guest) return reply.code(403).send(fail('FORBIDDEN', 'Only invited guests can be removed here'));
    const revoked = db.prepare('UPDATE tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL').run(nowIso(), target.id).changes;
    events.append({ type: 'auth.revoked', workspace_id: actor.workspace_id, actor_id: actor.id, target_id: target.id, payload: { via: 'supervisor', revoked } });
    return { removed: revoked > 0 };
  });
}
