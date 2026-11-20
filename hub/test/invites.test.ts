import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { InjectOptions } from 'fastify';
import { buildServer, type BuiltHub } from '../src/server.js';
import { TokenRegistry } from '../src/tokens.js';
import { LEGACY_SCHEMA, SCHEMA_VERSION, openDb } from '../src/db.js';
import { bindSession, newDevice, signed } from './devices.js';

let hub: BuiltHub;
let dir: string;
let registry: TokenRegistry;
let supervisor: ReturnType<TokenRegistry['issue']>;
let alice: ReturnType<TokenRegistry['issue']>;
let room: string;
let other: string;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const env = (extra: Record<string, string> = {}) => ({ HUB_DATA_DIR: join(dir, 'data'), HUB_WORKSPACES_DIR: join(dir, 'workspaces'), HUB_WEB_DIST: join(dir, 'missing'), HUB_LOG_LEVEL: 'silent', ...extra });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'collab-invite-'));
  hub = await buildServer(env({ HUB_PUBLIC_URL: 'https://hub.example.test' }));
  registry = new TokenRegistry(hub.services.db);
  supervisor = registry.issue('operator', 'supervisor'); alice = registry.issue('alice', 'agent');
  room = hub.services.rooms.create({ name: 'Launch site' }, supervisor.agent.id).id;
  other = hub.services.rooms.create({ name: 'Private planning' }, supervisor.agent.id).id;
});
afterEach(async () => { await hub.app.close(); rmSync(dir, { recursive: true, force: true }); });

const invite = (payload: Record<string, unknown> = {}, token = supervisor.token, target = room) =>
  inject({ method: 'POST', url: `/v1/rooms/${target}/invites`, headers: auth(token), payload });
const inject = (options: { url: string; method?: InjectOptions['method']; headers?: Record<string, string>; payload?: InjectOptions['payload'] }) =>
  hub.app.inject(signed(options as { url: string; method?: string; headers?: Record<string, string> }) as InjectOptions);
// Redeeming an invite as a new person happens in a browser with its own device key.
const post = async (url: string, payload: unknown) => {
  const device = newDevice();
  const body = url === '/v1/invites/redeem' ? { device_key: device.key, ...(payload as object) } : payload as object;
  const response = await hub.app.inject({ method: 'POST', url, payload: body });
  const token = (() => { try { return response.json().session_token as string | undefined; } catch { return undefined; } })();
  if (token) bindSession(token, device.privateKey);
  return response;
};

describe('room invites', () => {
  it('lets only a supervisor create an invite and returns the code once, in a link fragment', async () => {
    expect((await invite({}, alice.token)).statusCode).toBe(403);
    expect((await invite({ expires_in_hours: 0 })).statusCode).toBe(400);
    const created = await invite({ label: 'Dana' });
    expect(created.statusCode).toBe(201);
    const { code, url, shareable, invite: record } = created.json();
    expect(code).toMatch(/^achi_[A-Za-z0-9_-]{32}$/);
    expect(url).toBe(`https://hub.example.test/join#${code}`);
    expect(shareable).toBe(true);
    expect(record.state).toBe('open');
    const stored = JSON.stringify(hub.services.db.prepare('SELECT * FROM invites').all()) + JSON.stringify(hub.services.db.prepare('SELECT payload FROM events').all());
    expect(stored).not.toContain(code);
    const listed = await inject({ url: `/v1/rooms/${room}/invites`, headers: auth(supervisor.token) });
    expect(listed.body).not.toContain(code);
    expect(listed.json().invites).toHaveLength(1);
    expect((await inject({ url: `/v1/rooms/${room}/invites`, headers: auth(alice.token) })).statusCode).toBe(403);
  });

  it('says a link is not shareable when the hub has no public address', async () => {
    await hub.app.close();
    hub = await buildServer(env({ HUB_DATA_DIR: join(dir, 'local') }));
    // Isolate from a tunnel that may be running on this machine.
    hub.services.config.tunnelUrlFile = join(dir, 'no-tunnel-url');
    const local = new TokenRegistry(hub.services.db).issue('operator', 'supervisor');
    const localRoom = hub.services.rooms.create({ name: 'Local' }, local.agent.id).id;
    const created = await inject({ method: 'POST', url: `/v1/rooms/${localRoom}/invites`, headers: { ...auth(local.token), host: '127.0.0.1:8791' }, payload: {} });
    expect(created.json()).toMatchObject({ shareable: false, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:8791\/join#achi_/) });
    const remote = await inject({ method: 'POST', url: `/v1/rooms/${localRoom}/invites`, headers: { ...auth(local.token), host: 'attacker.example', 'x-forwarded-for': '203.0.113.9' }, payload: {} });
    expect(remote.json()).toMatchObject({ shareable: false, url: null });
  });

  it('previews, then redeems once into a guest identity that is a member of the invited room', async () => {
    const { code } = (await invite({ label: 'Dana' })).json();
    const preview = await post('/v1/invites/preview', { code });
    expect(preview.json()).toMatchObject({ room: { name: 'Launch site' }, invited_by: 'operator', suggested_name: 'Dana' });
    expect(preview.json().avatars).toContain('fox');

    expect((await post('/v1/invites/redeem', { code, name: '<script>' })).statusCode).toBe(400);
    expect((await post('/v1/invites/redeem', { code, name: 'Dana', avatar: 'dragon' })).statusCode).toBe(400);
    expect((await post('/v1/invites/redeem', { code, name: 'ALICE' })).json().error.code).toBe('NAME_TAKEN');
    const joined = await post('/v1/invites/redeem', { code, name: 'Dana', avatar: 'fox' });
    expect(joined.statusCode).toBe(201);
    const { session_token: token, agent } = joined.json();
    expect(token).toMatch(/^achs_ses_/);
    expect(joined.json().token).toBeNull();
    expect(agent).toMatchObject({ name: 'Dana', role: 'agent', avatar: 'fox', guest: true });
    expect(hub.services.rooms.isMember(room, agent.id)).toBe(true);

    expect((await post('/v1/invites/redeem', { code, name: 'Dana Two' })).json().error.code).toBe('INVITE_USED');
    expect((await post('/v1/invites/preview', { code })).json().error.code).toBe('INVITE_USED');
    const who = (await inject({ url: '/v1/whoami', headers: auth(token) })).json();
    expect(who.agent).toMatchObject({ id: agent.id, avatar: 'fox', guest: true });
    const members = (await inject({ url: `/v1/rooms/${room}/members`, headers: auth(token) })).json().members;
    expect(members.find((member: { agent_id: string }) => member.agent_id === agent.id)).toMatchObject({ name: 'Dana', avatar: 'fox', guest: 1 });
    expect((await inject({ method: 'POST', url: `/v1/rooms/${room}/messages`, headers: auth(token), payload: { body: 'Hello' } })).statusCode).toBe(201);
    const stored = JSON.stringify(hub.services.db.prepare('SELECT * FROM tokens').all()) + JSON.stringify(hub.services.db.prepare('SELECT payload FROM events').all());
    expect(stored).not.toContain(token);
  });

  it('gives exactly one of two simultaneous redemptions the identity', async () => {
    const { code } = (await invite()).json();
    const results = await Promise.all([post('/v1/invites/redeem', { code, name: 'First' }), post('/v1/invites/redeem', { code, name: 'Second' })]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 410]);
    expect(hub.services.db.prepare('SELECT COUNT(*) AS total FROM agents WHERE guest = 1').get()).toEqual({ total: 1 });
  });

  it('refuses unknown, expired and revoked codes', async () => {
    expect((await post('/v1/invites/preview', { code: `achi_${'x'.repeat(32)}` })).json().error.code).toBe('INVITE_INVALID');
    expect((await post('/v1/invites/preview', { code: 'nope' })).statusCode).toBe(400);
    const expired = (await invite()).json();
    hub.services.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', expired.invite.id);
    expect((await post('/v1/invites/redeem', { code: expired.code, name: 'Late' })).json().error.code).toBe('INVITE_EXPIRED');
    const revoked = (await invite()).json();
    expect((await inject({ method: 'DELETE', url: `/v1/invites/${revoked.invite.id}`, headers: auth(alice.token) })).statusCode).toBe(403);
    expect((await inject({ method: 'DELETE', url: `/v1/invites/${revoked.invite.id}`, headers: auth(supervisor.token) })).json()).toEqual({ revoked: true });
    expect((await post('/v1/invites/redeem', { code: revoked.code, name: 'Gone' })).json().error.code).toBe('INVITE_EXPIRED');
    const archived = (await invite({}, supervisor.token, other)).json();
    hub.services.db.prepare('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), other);
    expect((await post('/v1/invites/redeem', { code: archived.code, name: 'Nowhere' })).json().error.code).toBe('INVITE_INVALID');
  });

  it('confines a guest to the invited room while ordinary agents keep the workspace catalogue', async () => {
    const { code } = (await invite()).json();
    const { session_token: token, agent } = (await post('/v1/invites/redeem', { code, name: 'Dana' })).json();
    hub.services.rooms.join(other, alice.agent.id);
    const rooms = (await inject({ url: '/v1/rooms', headers: auth(token) })).json().rooms;
    expect(rooms.map((entry: { id: string }) => entry.id)).toEqual([room]);
    expect((await inject({ method: 'POST', url: `/v1/rooms/${other}/join`, headers: auth(token) })).json().error.code).toBe('INVITE_REQUIRED');
    expect((await inject({ url: `/v1/rooms/${other}/messages`, headers: auth(token) })).statusCode).toBe(403);
    expect((await inject({ method: 'POST', url: `/v1/rooms/${room}/join`, headers: auth(token) })).statusCode).toBe(200);
    expect((await inject({ url: '/v1/rooms', headers: auth(alice.token) })).json().rooms).toHaveLength(2);
    // alice is only in the other room, so the guest's roster does not include her.
    const roster = (await inject({ url: '/v1/agents', headers: auth(token) })).json().agents.map((entry: { name: string }) => entry.name);
    expect(roster.sort()).toEqual(['Dana', 'operator']);
    expect((await inject({ method: 'POST', url: `/v1/rooms/${room}/invites`, headers: auth(token), payload: {} })).statusCode).toBe(403);
    expect(agent.guest).toBe(true);
  });

  it('adds a second project room to a signed-in guest instead of creating another login', async () => {
    const first = (await invite()).json();
    const { session_token: token, agent } = (await post('/v1/invites/redeem', { code: first.code, name: 'Dana', avatar: 'fox' })).json();
    const second = (await invite({}, supervisor.token, other)).json();
    const redeem = (code: string, bearer?: string, payload: Record<string, unknown> = {}) =>
      inject({ method: 'POST', url: '/v1/invites/redeem', headers: bearer ? auth(bearer) : {}, payload: { code, ...payload } });

    const added = await redeem(second.code, token);
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ token: null, session_token: null, agent: { id: agent.id, name: 'Dana', avatar: 'fox', guest: true }, room: { id: other } });
    const rooms = (await inject({ url: '/v1/rooms', headers: auth(token) })).json().rooms.map((entry: { id: string }) => entry.id).sort();
    expect(rooms).toEqual([room, other].sort());
    expect(hub.services.db.prepare('SELECT COUNT(*) AS total FROM agents WHERE guest = 1').get()).toEqual({ total: 1 });
    expect((await redeem(second.code, token)).json().error.code).toBe('INVITE_USED');

    // An ordinary agent's token is not a guest identity, and a new visitor still has to give a name.
    const third = (await invite()).json();
    expect((await redeem(third.code, alice.token)).statusCode).toBe(400);
    expect((await redeem(third.code)).json().error.code).toBe('VALIDATION_ERROR');
  });

  it('lets a member change avatar and a supervisor remove a guest, but not an ordinary agent', async () => {
    const { code } = (await invite()).json();
    const { session_token: token, agent } = (await post('/v1/invites/redeem', { code, name: 'Dana' })).json();
    expect((await inject({ method: 'PATCH', url: '/v1/me', headers: auth(token), payload: { avatar: 'nope' } })).statusCode).toBe(400);
    expect((await inject({ method: 'PATCH', url: '/v1/me', headers: auth(token), payload: { avatar: 'owl' } })).json().agent.avatar).toBe('owl');
    expect((await inject({ url: '/v1/whoami', headers: auth(token) })).json().agent.avatar).toBe('owl');
    expect((await inject({ method: 'POST', url: `/v1/agents/${agent.id}/remove`, headers: auth(alice.token) })).statusCode).toBe(403);
    expect((await inject({ method: 'POST', url: `/v1/agents/${alice.agent.id}/remove`, headers: auth(supervisor.token) })).statusCode).toBe(403);
    expect((await inject({ method: 'POST', url: `/v1/agents/${agent.id}/remove`, headers: auth(supervisor.token) })).json()).toEqual({ removed: true });
    expect((await inject({ url: '/v1/whoami', headers: auth(token) })).statusCode).toBe(401);
  });
});

describe('schema upgrade to version 3', () => {
  it('adds invites and profile columns to a version-2 database after copying it', () => {
    const path = join(dir, 'upgrade', 'hub.sqlite');
    openDb(path).close();
    rmSync(path); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    const old = new Database(path);
    old.exec(LEGACY_SCHEMA);
    old.exec(readFileSync(new URL('../migrations/001-workspaces.sql', import.meta.url), 'utf8'));
    old.exec(readFileSync(new URL('../migrations/002-oauth-mcp.sql', import.meta.url), 'utf8'));
    old.prepare("INSERT INTO agents (id, workspace_id, name, role, created_at) VALUES ('agt_1111111111111111', 'wks_0000000000000000', 'kept', 'agent', '2026-01-01T00:00:00.000Z')").run();
    old.close();
    const upgraded = openDb(path);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(upgraded.prepare("SELECT name, avatar, guest FROM agents WHERE id = 'agt_1111111111111111'").get()).toEqual({ name: 'kept', avatar: null, guest: 0 });
    expect(upgraded.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE name = 'invites'").get()).toEqual({ total: 1 });
    upgraded.close();
    const backups = readdirSync(join(dir, 'upgrade')).filter((name) => name.includes('.pre-invites-'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(dir, 'upgrade', backups[0]!));
    expect(backup.pragma('user_version', { simple: true })).toBe(2);
    backup.close();
  });
});
