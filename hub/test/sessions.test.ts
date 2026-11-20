import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { InjectOptions } from 'fastify';
import { buildServer, type BuiltHub } from '../src/server.js';
import { TokenRegistry } from '../src/tokens.js';
import { hashToken } from '../src/auth.js';
import { LEGACY_SCHEMA, SCHEMA_VERSION, openDb } from '../src/db.js';
import { SessionClock } from '../src/sessions.js';
import { bindSession, newDevice, proofFor, signed } from './devices.js';

let hub: BuiltHub;
let dir: string;
let supervisor: ReturnType<TokenRegistry['issue']>;
let alice: ReturnType<TokenRegistry['issue']>;
let room: string;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const inject = (options: { url: string; method?: InjectOptions['method']; headers?: Record<string, string>; payload?: InjectOptions['payload'] }) =>
  hub.app.inject(signed(options as { url: string; method?: string; headers?: Record<string, string> }) as InjectOptions);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'collab-sessions-'));
  hub = await buildServer({ HUB_DATA_DIR: join(dir, 'data'), HUB_WORKSPACES_DIR: join(dir, 'ws'), HUB_WEB_DIST: join(dir, 'missing'), HUB_LOG_LEVEL: 'silent', HUB_PUBLIC_URL: 'https://hub.example.test' });
  const registry = new TokenRegistry(hub.services.db);
  supervisor = registry.issue('operator', 'supervisor'); alice = registry.issue('alice', 'agent');
  room = hub.services.rooms.create({ name: 'Launch site' }, supervisor.agent.id).id;
});
afterEach(async () => { vi.restoreAllMocks(); await hub.app.close(); rmSync(dir, { recursive: true, force: true }); });

/** A client joins through an invite, in a "browser" with its own device key. */
async function signUp(name = 'Dana') {
  const { code } = (await hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/invites`, headers: auth(supervisor.token), payload: {} })).json();
  const device = newDevice();
  const joined = (await hub.app.inject({ method: 'POST', url: '/v1/invites/redeem', payload: { code, name, device_key: device.key } })).json();
  bindSession(joined.session_token, device.privateKey);
  return { token: joined.session_token as string, agent: joined.agent as { id: string }, device, expires: joined.expires_at as string };
}

describe('client sessions', () => {
  it('only works from the browser that started it: a copied token, a replay or another key is refused', async () => {
    const { token, expires } = await signUp();
    expect(new Date(expires).getTime() - Date.now()).toBeGreaterThan(2.9 * 3600_000);
    expect((await inject({ url: '/v1/whoami', headers: auth(token) })).statusCode).toBe(200);
    // Found in storage or a log: the token alone does nothing.
    const copied = await hub.app.inject({ url: '/v1/whoami', headers: auth(token) });
    expect(copied.statusCode).toBe(401);
    expect(copied.json().error.code).toBe('PROOF_REQUIRED');
    // Signed by some other key.
    const stranger = newDevice();
    expect((await hub.app.inject({ url: '/v1/whoami', headers: { ...auth(token), 'x-hub-proof': proofFor(token, 'GET', '/v1/whoami', stranger.privateKey)! } })).json().error.code).toBe('PROOF_INVALID');
    // A captured request can't be replayed, or reused for a different one.
    const proof = proofFor(token, 'GET', '/v1/whoami')!;
    expect((await hub.app.inject({ url: '/v1/whoami', headers: { ...auth(token), 'x-hub-proof': proof } })).statusCode).toBe(200);
    expect((await hub.app.inject({ url: '/v1/whoami', headers: { ...auth(token), 'x-hub-proof': proof } })).json().error.code).toBe('PROOF_INVALID');
    expect((await hub.app.inject({ url: '/v1/rooms', headers: { ...auth(token), 'x-hub-proof': proofFor(token, 'GET', '/v1/whoami')! } })).json().error.code).toBe('PROOF_INVALID');
    // A stale timestamp is refused.
    const old = proofFor(token, 'GET', '/v1/whoami')!.replace(/^\d+/, String(Date.now() - 10 * 60_000));
    expect((await hub.app.inject({ url: '/v1/whoami', headers: { ...auth(token), 'x-hub-proof': old } })).json().error.code).toBe('PROOF_INVALID');
    expect(JSON.stringify(hub.services.db.prepare('SELECT * FROM sessions').all())).not.toContain(token);
  });

  it('refuses a client\'s permanent bearer token, but not staff or agent tokens', async () => {
    const { agent } = await signUp();
    const raw = `ach_${randomBytes(24).toString('base64url')}`;
    hub.services.db.prepare("INSERT INTO tokens (id, agent_id, workspace_id, role, token_hash, created_at) VALUES ('tok_issued0000000', ?, 'wks_0000000000000000', 'agent', ?, ?)").run(agent.id, hashToken(raw), new Date().toISOString());
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(raw) })).statusCode).toBe(401);
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(alice.token) })).statusCode).toBe(200);
  });

  it('ends on sign-out and when its time is up, and says why', async () => {
    const first = await signUp('Dana');
    expect((await inject({ method: 'POST', url: '/v1/session/sign-out', headers: auth(first.token) })).json()).toEqual({ signed_out: true });
    expect((await inject({ url: '/v1/whoami', headers: auth(first.token) })).json().error.code).toBe('SESSION_ENDED');
    const second = await signUp('Eli');
    hub.services.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE agent_id = ?").run(second.agent.id);
    const clock = new SessionClock(hub.services.db, hub.services.events);
    expect(clock.tick()).toBe(1);
    expect((await inject({ url: '/v1/whoami', headers: auth(second.token) })).json().error.code).toBe('SESSION_ENDED');
    const ended = hub.services.db.prepare("SELECT payload FROM events WHERE type = 'session.ended' ORDER BY id").all() as { payload: string }[];
    expect(ended.map((row) => JSON.parse(row.payload).reason)).toEqual(['signed_out', 'expired']);
  });

  it('lets staff send a one-time sign-in link that starts a fresh session', async () => {
    const { agent } = await signUp();
    expect((await hub.app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/sign-in-link`, headers: auth(alice.token) })).statusCode).toBe(403);
    expect((await hub.app.inject({ method: 'POST', url: `/v1/agents/${alice.agent.id}/sign-in-link`, headers: auth(supervisor.token) })).statusCode).toBe(404);
    const link = (await hub.app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/sign-in-link`, headers: auth(supervisor.token) })).json();
    expect(link.url).toMatch(/^https:\/\/hub\.example\.test\/signin#achl_/);
    const code = link.url.split('#')[1];
    const device = newDevice();
    const signedIn = await hub.app.inject({ method: 'POST', url: '/v1/signin/link', payload: { code, device_key: device.key } });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toMatchObject({ agent: { id: agent.id }, passkeys: 0 });
    bindSession(signedIn.json().session_token, device.privateKey);
    expect((await inject({ url: '/v1/whoami', headers: auth(signedIn.json().session_token) })).json().agent.id).toBe(agent.id);
    expect((await hub.app.inject({ method: 'POST', url: '/v1/signin/link', payload: { code, device_key: newDevice().key } })).json().error.code).toBe('LINK_USED');
    expect(JSON.stringify(hub.services.db.prepare('SELECT * FROM signin_links').all())).not.toContain(code);
  });

  it('offers passkeys only on this hub\'s own address', async () => {
    const { token } = await signUp();
    const options = await hub.app.inject({ method: 'POST', url: '/v1/passkeys/login/options', headers: { origin: 'https://hub.example.test' } });
    expect(options.json().options).toMatchObject({ rpId: 'hub.example.test', userVerification: 'required' });
    expect((await hub.app.inject({ method: 'POST', url: '/v1/passkeys/login/options', headers: { origin: 'https://evil.example' } })).json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await hub.app.inject({ method: 'POST', url: '/v1/passkeys/login/options', headers: { origin: 'http://localhost:5196', host: 'attacker.example', 'x-forwarded-for': '1.2.3.4' } })).json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    const register = await inject({ method: 'POST', url: '/v1/passkeys/register/options', headers: { ...auth(token), origin: 'https://hub.example.test' } });
    expect(register.json()).toMatchObject({ rp: { id: 'hub.example.test' }, authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    expect((await hub.app.inject({ method: 'POST', url: '/v1/passkeys/register/options', headers: { ...auth(supervisor.token), origin: 'https://hub.example.test' } })).statusCode).toBe(403);
    const bogus = await hub.app.inject({ method: 'POST', url: '/v1/passkeys/login/verify', payload: { challenge_id: options.json().challenge_id, response: { id: 'nope' }, device_key: newDevice().key } });
    expect(bogus.json().error.code).toBe('PASSKEY_FAILED');
  });

  it('puts a client\'s sidekick to sleep when their last session ends, and signs it out on a deliberate sign-out', async () => {
    const { token, agent } = await signUp();
    const created = await inject({ method: 'POST', url: '/v1/sidekicks', headers: auth(token), payload: { name: 'Pip' } });
    expect(created.json().sidekick.asleep).toBe(false);
    const sidekick = created.json().sidekick;
    const docker = vi.spyOn(hub.sidekicks as unknown as { docker: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> }, 'docker')
      .mockResolvedValue({ code: 0, stdout: 'true sidekick', stderr: '' });
    hub.services.db.prepare('UPDATE sidekicks SET signed_in_at = ? WHERE id = ?').run(new Date().toISOString(), sidekick.id);
    const signOut = vi.spyOn(hub.sidekicks, 'signOut').mockResolvedValue();
    const turn = vi.spyOn(hub.sidekicks, 'signedIn');
    await inject({ method: 'POST', url: '/v1/session/sign-out', headers: auth(token) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(docker.mock.calls.some(([args]) => args[0] === 'stop')).toBe(true);
    expect(hub.services.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'sidekick.asleep'").get()).toEqual({ n: 1 });
    // Asleep: nothing starts until its owner signs back in.
    await hub.sidekicks.runTurn(sidekick.id, room, 'owner');
    expect(turn).not.toHaveBeenCalled();
    expect(hub.sidekicks.view(hub.sidekicks.get(sidekick.id)!).asleep).toBe(true);
    expect(agent.id).toBe(sidekick.owner_id);
  });
});

describe('schema upgrade to version 9', () => {
  it('scrambles clients\' old tokens, keeps sidekicks\' and staff tokens, after copying the database', async () => {
    const { readdirSync } = await import('node:fs');
    const path = join(dir, 'upgrade', 'hub.sqlite');
    openDb(path).close();
    rmSync(path); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    const old = new Database(path);
    old.exec(LEGACY_SCHEMA);
    for (const file of ['001-workspaces.sql', '002-oauth-mcp.sql', '003-invites.sql', '004-sidekicks.sql', '005-sidekick-codex.sql', '006-room-rules.sql', '007-sidekick-live.sql', '008-security.sql']) {
      old.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    }
    const ws = 'wks_0000000000000000'; const at = '2026-01-01T00:00:00.000Z';
    old.prepare("INSERT INTO agents (id, workspace_id, name, role, created_at, guest) VALUES ('agt_1111111111111111', ?, 'client', 'agent', ?, 1), ('agt_2222222222222222', ?, 'helper', 'agent', ?, 1), ('agt_3333333333333333', ?, 'staff', 'supervisor', ?, 0)").run(ws, at, ws, at, ws, at);
    old.prepare("INSERT INTO sidekicks (id, workspace_id, agent_id, owner_id, provider, created_at) VALUES ('skk_1111111111111111', ?, 'agt_2222222222222222', 'agt_1111111111111111', 'claude', ?)").run(ws, at);
    for (const [id, agent] of [['tok_1', 'agt_1111111111111111'], ['tok_2', 'agt_2222222222222222'], ['tok_3', 'agt_3333333333333333']]) {
      old.prepare("INSERT INTO tokens (id, agent_id, workspace_id, role, token_hash, created_at) VALUES (?, ?, ?, 'agent', ?, ?)").run(id, agent, ws, `hash-${id}`, at);
    }
    old.close();
    const upgraded = openDb(path);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tokens = Object.fromEntries((upgraded.prepare('SELECT id, token_hash, revoked_at FROM tokens').all() as { id: string; token_hash: string; revoked_at: string | null }[]).map((row) => [row.id, row]));
    expect(tokens.tok_1!.token_hash).not.toBe('hash-tok_1');
    expect(tokens.tok_1!.revoked_at).toBeNull();
    expect(tokens.tok_2!.token_hash).toBe('hash-tok_2');
    expect(tokens.tok_3!.token_hash).toBe('hash-tok_3');
    upgraded.close();
    expect(readdirSync(join(dir, 'upgrade')).filter((name) => name.includes('.pre-sessions-'))).toHaveLength(1);
  });
});

describe('live line', () => {
  it('closes a client\'s socket when the session runs out, and says it expired', async () => {
    const { default: WebSocket } = await import('ws');
    const { token, agent } = await signUp();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`);
    const frames: string[] = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    await new Promise((resolve) => socket.on('open', resolve));
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()).t));
    socket.send(JSON.stringify({ t: 'hello', token, proof: proofFor(token, 'WS', '/ws') }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames).toContain('hello.ok');
    hub.services.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE agent_id = ?").run(agent.id);
    hub.services.events.append({ type: 'ws.connect', actor_id: alice.agent.id });
    expect(await closed).toEqual({ code: 4009, reason: 'Session expired' });
  });

  it('refuses a socket hello without the device\'s signature', async () => {
    const { default: WebSocket } = await import('ws');
    const { token } = await signUp();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`);
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    await new Promise((resolve) => socket.on('open', resolve));
    socket.send(JSON.stringify({ t: 'hello', token }));
    expect(await closed).toBe(4008);
  });
});
