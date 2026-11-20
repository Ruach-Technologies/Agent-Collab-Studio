import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, type BuiltHub } from '../src/server.js';
import { TokenRegistry } from '../src/tokens.js';
import { hashToken } from '../src/auth.js';
import { randomBytes } from 'node:crypto';
import { POSTS_PER_JOB, SIDEKICK_TOOLS } from '../src/sidekicks.js';

// Container work (sign-in, turns) needs Docker and a real Claude account; these tests cover the
// hub's own rules: who may create and direct a sidekick, and which rooms it can reach.
let hub: BuiltHub;
let dir: string;
let supervisor: ReturnType<TokenRegistry['issue']>;
let alice: ReturnType<TokenRegistry['issue']>;
let bob: ReturnType<TokenRegistry['issue']>;
let room: string;
let other: string;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'collab-sidekick-'));
  hub = await buildServer({ HUB_DATA_DIR: join(dir, 'data'), HUB_WORKSPACES_DIR: join(dir, 'ws'), HUB_WEB_DIST: join(dir, 'missing'), HUB_LOG_LEVEL: 'silent' });
  const registry = new TokenRegistry(hub.services.db);
  supervisor = registry.issue('operator', 'supervisor'); alice = registry.issue('alice', 'agent'); bob = registry.issue('bob', 'agent');
  room = hub.services.rooms.create({ name: 'Launch site' }, supervisor.agent.id).id;
  other = hub.services.rooms.create({ name: 'Second project' }, supervisor.agent.id).id;
  hub.services.rooms.join(room, alice.agent.id); hub.services.rooms.join(room, bob.agent.id);
});
afterEach(async () => { vi.restoreAllMocks(); await hub.app.close(); rmSync(dir, { recursive: true, force: true }); });

const create = (token: string, payload: Record<string, unknown>) => hub.app.inject({ method: 'POST', url: '/v1/sidekicks', headers: auth(token), payload });

describe('sidekicks', () => {
  it('creates one sidekick per person, in every room its owner is in, and follows the owner into new rooms', async () => {
    expect((await create(alice.token, { name: 'Pip', avatar: 'dragon' })).statusCode).toBe(400);
    expect((await create(alice.token, { name: 'BOB' })).json().error.code).toBe('NAME_TAKEN');
    const created = await create(alice.token, { name: 'Pip', avatar: 'frog' });
    expect(created.statusCode).toBe(201);
    const sidekick = created.json().sidekick;
    expect(sidekick).toMatchObject({ name: 'Pip', avatar: 'frog', owner_id: alice.agent.id, sign_in: 'signed_out', provider: 'claude' });
    expect((await create(alice.token, { name: 'Second' })).json().error.code).toBe('SIDEKICK_EXISTS');

    expect(hub.services.rooms.isMember(room, sidekick.agent_id)).toBe(true);
    expect(hub.services.rooms.isMember(other, sidekick.agent_id)).toBe(false);
    const members = (await hub.app.inject({ url: `/v1/rooms/${room}/members`, headers: auth(bob.token) })).json().members;
    expect(members.find((member: { agent_id: string }) => member.agent_id === sidekick.agent_id)).toMatchObject({ name: 'Pip', avatar: 'frog', sidekick_of: alice.agent.id, guest: 1 });

    expect((await hub.app.inject({ method: 'POST', url: `/v1/rooms/${other}/join`, headers: auth(alice.token) })).statusCode).toBe(200);
    expect(hub.services.rooms.isMember(other, sidekick.agent_id)).toBe(true);
    expect((await hub.app.inject({ url: '/v1/sidekicks/mine', headers: auth(alice.token) })).json().sidekick.id).toBe(sidekick.id);
    expect((await hub.app.inject({ url: '/v1/sidekicks/mine', headers: auth(bob.token) })).json().sidekick).toBeNull();
  });

  it('lets only the owner manage the sidekick', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    for (const [method, url] of [['POST', `/v1/sidekicks/${sidekick.id}/sign-in`], ['POST', `/v1/sidekicks/${sidekick.id}/sign-out`], ['DELETE', `/v1/sidekicks/${sidekick.id}`]] as const) {
      expect((await hub.app.inject({ method, url, headers: auth(bob.token) })).statusCode).toBe(404);
      expect((await hub.app.inject({ method, url, headers: auth(supervisor.token) })).statusCode).toBe(404);
    }
    expect((await hub.app.inject({ method: 'POST', url: `/v1/sidekicks/${sidekick.id}/sign-in/code`, headers: auth(alice.token), payload: { code: 'has spaces' } })).statusCode).toBe(400);
  });

  const post = (token: string, body: string, to?: string) => hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/messages`, headers: auth(token), payload: to ? { body, to } : { body } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  const watchTurns = () => {
    hub.sidekicks.directDelayMs = 20; hub.sidekicks.liveDelayMs = 40;
    const turns: Array<[string, string]> = [];
    vi.spyOn(hub.sidekicks, 'runTurn').mockImplementation(async (_id, roomId, trigger) => { turns.push([roomId, trigger ?? 'owner']); });
    return turns;
  };
  const settings = (token: string, id: string, payload: Record<string, unknown>) => hub.app.inject({ method: 'PATCH', url: `/v1/sidekicks/${id}/settings`, headers: auth(token), payload });
  const tokenFor = (agentId: string) => {
    const token = `ach_${randomBytes(24).toString('base64url')}`;
    hub.services.db.prepare("INSERT INTO tokens (id, agent_id, workspace_id, role, token_hash, created_at) VALUES (?, ?, 'wks_0000000000000000', 'agent', ?, ?)")
      .run(`tok_${agentId.slice(4)}`, agentId, hashToken(token), new Date().toISOString());
    return token;
  };

  it('is fully live by default: wakes for room chat, batches a burst into one job, and takes the strongest reason', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    expect(sidekick.settings).toMatchObject({ live_mode: 'live', banter: 'chatty', jobs_per_hour: 20, jobs_per_day: 150, steps_per_job: 40, tokens_per_day: null });
    expect(sidekick.usage).toMatchObject({ hour_jobs: 0, day_jobs: 0, day_tokens: 0 });
    const turns = watchTurns();
    await post(bob.token, 'anyone around?');
    await settle();
    expect(turns).toEqual([[room, 'live']]);
    await post(bob.token, 'hello again');
    await post(bob.token, '@Pip can you look at this?');
    await post(alice.token, '@pip make the button bigger');
    await settle();
    expect(turns).toEqual([[room, 'live'], [room, 'owner']]);
    await post(bob.token, 'psst', sidekick.agent_id);
    await settle();
    expect(turns.at(-1)).toEqual([room, 'mention']);
  });

  it('follows its owner\'s live setting: mentions only, owner only, or paused', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    const turns = watchTurns();
    expect((await settings(alice.token, sidekick.id, { live_mode: 'mentions' })).json().sidekick.settings.live_mode).toBe('mentions');
    await post(bob.token, 'hello everyone'); await settle();
    expect(turns).toEqual([]);
    await post(bob.token, '@Pip hi'); await settle();
    expect(turns).toEqual([[room, 'mention']]);
    await settings(alice.token, sidekick.id, { live_mode: 'owner' });
    await post(bob.token, '@Pip delete everything'); await post(bob.token, 'please do it', sidekick.agent_id); await settle();
    expect(turns).toHaveLength(1);
    await post(alice.token, 'and run the tests', sidekick.agent_id); await settle();
    expect(turns.at(-1)).toEqual([room, 'owner']);
    await settings(alice.token, sidekick.id, { live_mode: 'paused' });
    await post(alice.token, '@Pip are you there?'); await settle();
    expect(turns).toHaveLength(2);
    expect((await settings(bob.token, sidekick.id, { live_mode: 'live' })).statusCode).toBe(404);
    expect((await settings(alice.token, sidekick.id, { jobs_per_hour: 0 })).statusCode).toBe(400);
    expect((await settings(alice.token, sidekick.id, { banter: 'brief', steps_per_job: 10, tokens_per_day: 50000 })).json().sidekick.settings)
      .toMatchObject({ live_mode: 'paused', banter: 'brief', steps_per_job: 10, tokens_per_day: 50000 });
  });

  it('keeps sidekicks from chattering at each other, and stops when its owner says stop', async () => {
    const pip = (await create(alice.token, { name: 'Pip' })).json().sidekick;
    const rook = (await create(bob.token, { name: 'Rook' })).json().sidekick;
    const turns = watchTurns();
    const stop = vi.spyOn(hub.sidekicks, 'stopJob').mockResolvedValue(true);
    // A sidekick's own message never wakes another one unless it addresses it.
    hub.services.rooms.postMessage(room, rook.agent_id, 'done with the header'); await settle();
    expect(turns).toEqual([]);
    for (let i = 0; i < 4; i += 1) hub.services.rooms.postMessage(room, i % 2 ? pip.agent_id : rook.agent_id, i % 2 ? '@Rook thanks' : '@Pip your turn');
    await settle();
    turns.length = 0;
    hub.services.rooms.postMessage(room, rook.agent_id, '@Pip again?'); await settle();
    expect(turns).toEqual([]);
    await post(alice.token, '@Pip stop'); await settle();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(turns.filter(([, trigger]) => trigger === 'owner')).toEqual([]);
  });

  it('lets a sidekick post updates only while it is working, within its owner\'s banter budget', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    const token = tokenFor(sidekick.agent_id);
    const say = (body: string) => hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/messages`, headers: auth(token), payload: { body } });
    expect((await say('hi')).json().error.code).toBe('SIDEKICK_NOT_WORKING');
    await settings(alice.token, sidekick.id, { banter: 'brief' });
    const job = { jobId: 1, roomId: room, trigger: 'owner', startedAt: new Date().toISOString(), posts: 0, postLimit: POSTS_PER_JOB.brief, lastPostAt: 0, steps: 0, proc: null, stopped: false, container: 'x' };
    (hub.sidekicks as unknown as { active: Map<string, typeof job> }).active.set(sidekick.id, job);
    expect((await say('starting on the header')).statusCode).toBe(201);
    expect((await say('too soon')).json().error.code).toBe('UPDATE_TOO_SOON');
    job.lastPostAt = 0;
    expect((await say('header done')).statusCode).toBe(201);
    job.lastPostAt = 0;
    expect((await say('one more')).json().error.code).toBe('UPDATE_LIMIT');
    expect((await hub.app.inject({ method: 'POST', url: `/v1/rooms/${other}/messages`, headers: auth(token), payload: { body: 'x' } })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('shows a sidekick only its own tools over MCP, and none for posting when it is set to quiet', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    const token = tokenFor(sidekick.agent_id);
    const list = async () => ((await hub.app.inject({ method: 'POST', url: '/mcp', headers: auth(token), payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json().result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(await list()).toEqual([...SIDEKICK_TOOLS].sort());
    await settings(alice.token, sidekick.id, { banter: 'quiet' });
    expect(await list()).toEqual(SIDEKICK_TOOLS.filter((tool) => tool !== 'hub_post_message').sort());
    const call = await hub.app.inject({ method: 'POST', url: '/mcp', headers: auth(token), payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hub_join_room', arguments: { room_id: other } } } });
    expect(call.json().result.isError).toBe(true);
    expect(call.json().result.content[0].text).toContain('TOOL_NOT_ALLOWED');
    // The endpoint is for sidekicks only: people's tokens and anything arriving through a tunnel are refused.
    const person = await hub.app.inject({ method: 'POST', url: '/mcp', headers: auth(alice.token), payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });
    expect(person.statusCode).toBe(401);
    expect(person.headers['www-authenticate']).toBeUndefined();
    const tunneled = await hub.app.inject({ method: 'POST', url: '/mcp', headers: { ...auth(token), 'x-forwarded-for': '203.0.113.9' }, payload: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
    expect(tunneled.statusCode).toBe(401);
    for (const path of ['/.well-known/oauth-authorization-server', '/oauth/authorize']) expect((await hub.app.inject({ url: path })).statusCode).toBe(404);
  });

  it('records jobs for the usage meter and enforces the owner\'s limits', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    await settings(alice.token, sidekick.id, { jobs_per_hour: 2 });
    const insert = hub.services.db.prepare("INSERT INTO sidekick_jobs (sidekick_id, room_id, trigger, started_at, finished_at, outcome, input_tokens, output_tokens, duration_ms) VALUES (?, ?, 'owner', ?, ?, 'done', 1000, 200, 90000)");
    const now = new Date().toISOString();
    insert.run(sidekick.id, room, now, now); insert.run(sidekick.id, room, now, now);
    const view = (await hub.app.inject({ url: '/v1/sidekicks/mine', headers: auth(alice.token) })).json().sidekick;
    expect(view.usage).toMatchObject({ hour_jobs: 2, day_jobs: 2, day_tokens: 2400, day_minutes: 3 });
    const signedIn = vi.spyOn(hub.sidekicks, 'signedIn');
    await hub.sidekicks.runTurn(sidekick.id, room, 'owner');
    expect(signedIn).not.toHaveBeenCalled();
    const said = hub.services.rooms.messages(room, alice.agent).at(-1)!;
    expect(said.from_agent_id).toBe(sidekick.agent_id);
    expect(said.body).toContain('2 jobs an hour');
  });

  it('forgets saved conversations on removal and sweeps only removed sidekicks\' leftovers', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    hub.services.db.prepare("INSERT INTO sidekick_sessions (sidekick_id, room_id, session_id, updated_at) VALUES (?, ?, 'thread-1', ?)").run(sidekick.id, room, new Date().toISOString());
    const docker = vi.spyOn(hub.sidekicks as unknown as { docker: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> }, 'docker')
      .mockImplementation(async (args: string[]) => ({ code: args[0] === 'inspect' || (args[0] === 'volume' && args[1] === 'inspect') ? 1 : 0, stdout: '', stderr: '' }));
    expect((await hub.app.inject({ method: 'DELETE', url: `/v1/sidekicks/${sidekick.id}`, headers: auth(alice.token) })).statusCode).toBe(200);
    expect(hub.services.db.prepare('SELECT COUNT(*) AS n FROM sidekick_sessions WHERE sidekick_id = ?').get(sidekick.id)).toEqual({ n: 0 });
    expect(docker.mock.calls.map(([args]) => args.slice(0, 2).join(' '))).toEqual(expect.arrayContaining(['rm -f', 'volume rm']));
    // A leftover of the removed sidekick is swept; one belonging to an active or unknown sidekick is not.
    const active = (await create(bob.token, { name: 'Rook' })).json().sidekick;
    docker.mockClear();
    docker.mockImplementation(async (args: string[]) => {
      if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: `ach-sidekick-${sidekick.id}-home\nach-sidekick-${active.id}-home\nach-sidekick-skk_0000000000000000-home\nother\n`, stderr: '' };
      if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
      return { code: args[0] === 'inspect' || args[1] === 'inspect' ? 1 : 0, stdout: '', stderr: '' };
    });
    expect(await hub.sidekicks.sweep()).toBe(1);
    const removed = docker.mock.calls.filter(([args]) => args[0] === 'volume' && args[1] === 'rm').map(([args]) => args[3]);
    expect(removed).toEqual([`ach-sidekick-${sidekick.id}-home`]);
  });

  it('removes the sidekick from every room and ends its access', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    vi.spyOn(hub.sidekicks as unknown as { docker: () => Promise<unknown> }, 'docker').mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    expect((await hub.app.inject({ method: 'DELETE', url: `/v1/sidekicks/${sidekick.id}`, headers: auth(alice.token) })).json()).toEqual({ removed: true });
    expect(hub.services.rooms.isMember(room, sidekick.agent_id)).toBe(false);
    expect(hub.services.db.prepare("SELECT COUNT(*) AS left FROM events WHERE type = 'room.left' AND actor_id = ? AND room_id = ?").get(sidekick.agent_id, room)).toEqual({ left: 1 });
    expect(hub.services.db.prepare('SELECT COUNT(*) AS open FROM tokens WHERE agent_id = ? AND revoked_at IS NULL').get(sidekick.agent_id)).toEqual({ open: 0 });
    expect((await hub.app.inject({ url: '/v1/sidekicks/mine', headers: auth(alice.token) })).json().sidekick).toBeNull();
    // The name is free again for a new sidekick.
    expect((await create(alice.token, { name: 'Pip' })).statusCode).toBe(201);
  });

  it('keeps GitHub with people: a sidekick cannot clone or open a pull request', async () => {
    const { sidekick } = (await create(alice.token, { name: 'Pip' })).json();
    const token = 'ach_' + 'S'.repeat(32);
    const { createHash } = await import('node:crypto');
    hub.services.db.prepare("INSERT INTO tokens (id, agent_id, workspace_id, role, token_hash, created_at) VALUES ('tok_aaaaaaaaaaaaaaaa', ?, ?, 'agent', ?, ?)")
      .run(sidekick.agent_id, alice.agent.workspace_id, createHash('sha256').update(token).digest('hex'), new Date().toISOString());
    const sandbox = 'sbx_0123456789abcdef';
    const clone = await hub.app.inject({ method: 'POST', url: `/v1/sandboxes/${sandbox}/repos`, headers: auth(token), payload: { repo: 'owner/name' } });
    const pull = await hub.app.inject({ method: 'POST', url: `/v1/sandboxes/${sandbox}/pulls`, headers: auth(token), payload: { repo: 'owner/name', branch: 'ai/x', title: 't' } });
    expect([clone.json().error.code, pull.json().error.code]).toEqual(['PEOPLE_ONLY', 'PEOPLE_ONLY']);
    // A person reaches the normal checks (here: the sandbox does not exist).
    expect((await hub.app.inject({ method: 'POST', url: `/v1/sandboxes/${sandbox}/repos`, headers: auth(alice.token), payload: { repo: 'owner/name' } })).json().error.code).not.toBe('PEOPLE_ONLY');
  });
});

describe('schema upgrade to version 5', () => {
  it('keeps existing sidekicks and allows ChatGPT ones after copying the database', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { default: Database } = await import('better-sqlite3');
    const { LEGACY_SCHEMA, SCHEMA_VERSION, openDb } = await import('../src/db.js');
    const path = join(dir, 'upgrade', 'hub.sqlite');
    openDb(path).close();
    rmSync(path); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    const old = new Database(path);
    old.exec(LEGACY_SCHEMA);
    for (const file of ['001-workspaces.sql', '002-oauth-mcp.sql', '003-invites.sql', '004-sidekicks.sql']) old.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    const ws = 'wks_0000000000000000';
    old.prepare("INSERT INTO agents (id, workspace_id, name, role, created_at) VALUES ('agt_1111111111111111', ?, 'owner', 'agent', '2026-01-01T00:00:00.000Z'), ('agt_2222222222222222', ?, 'helper', 'agent', '2026-01-01T00:00:00.000Z')").run(ws, ws);
    old.prepare("INSERT INTO sidekicks (id, workspace_id, agent_id, owner_id, provider, signed_in_at, created_at) VALUES ('skk_1111111111111111', ?, 'agt_2222222222222222', 'agt_1111111111111111', 'claude', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(ws);
    expect(() => old.prepare("UPDATE sidekicks SET provider = 'codex'").run()).toThrow();
    old.close();
    const upgraded = openDb(path);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(upgraded.prepare('SELECT id, provider, signed_in_at FROM sidekicks').all()).toEqual([{ id: 'skk_1111111111111111', provider: 'claude', signed_in_at: '2026-01-02T00:00:00.000Z' }]);
    upgraded.prepare("UPDATE sidekicks SET provider = 'codex'").run();
    expect(() => upgraded.prepare("INSERT INTO sidekicks (id, workspace_id, agent_id, owner_id, provider, created_at) VALUES ('skk_3333333333333333', ?, 'agt_1111111111111111', 'agt_2222222222222222', 'claude', 'x')").run(ws)).not.toThrow();
    expect(() => upgraded.prepare("INSERT INTO sidekicks (id, workspace_id, agent_id, owner_id, provider, created_at) VALUES ('skk_4444444444444444', ?, 'agt_9999999999999999', 'agt_1111111111111111', 'claude', 'x')").run(ws)).toThrow();
    upgraded.close();
    expect(readdirSync(join(dir, 'upgrade')).filter((name) => name.includes('.pre-codex-'))).toHaveLength(1);
  });
});
