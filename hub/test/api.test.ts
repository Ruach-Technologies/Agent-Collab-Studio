import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, type BuiltHub } from '../src/server.js';
import { TokenRegistry } from '../src/tokens.js';

let hub: BuiltHub;
let dir: string;
let supervisor: ReturnType<TokenRegistry['issue']>;
let alice: ReturnType<TokenRegistry['issue']>;
let bob: ReturnType<TokenRegistry['issue']>;
let eve: ReturnType<TokenRegistry['issue']>;
let observer: ReturnType<TokenRegistry['issue']>;
let room: string;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'collab-api-'));
  hub = await buildServer({ HUB_DATA_DIR: join(dir, 'data'), HUB_WORKSPACES_DIR: join(dir, 'workspaces'), HUB_WEB_DIST: join(dir, 'missing'), HUB_LOG_LEVEL: 'silent' });
  const registry = new TokenRegistry(hub.services.db);
  supervisor = registry.issue('operator', 'supervisor'); alice = registry.issue('alice', 'agent');
  bob = registry.issue('bob', 'agent'); eve = registry.issue('eve', 'agent'); observer = registry.issue('observer', 'observer');
  room = hub.services.rooms.create({ name: 'Collaboration' }, supervisor.agent.id).id;
  for (const agent of [alice, bob, eve]) hub.services.rooms.join(room, agent.agent.id);
});
afterEach(async () => { await hub.app.close(); rmSync(dir, { recursive: true, force: true }); });

describe('authenticated collaboration API', () => {
  it('rejects missing/invalid/revoked credentials and never exposes token hashes', async () => {
    expect((await hub.app.inject({ url: '/v1/agents' })).statusCode).toBe(401);
    expect((await hub.app.inject({ url: '/v1/events', headers: auth('wrong') })).statusCode).toBe(401);
    new TokenRegistry(hub.services.db).revoke(alice.agent.id);
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(alice.token) })).statusCode).toBe(401);
    const response = await hub.app.inject({ url: '/v1/agents', headers: auth(supervisor.token) });
    expect(response.statusCode).toBe(200); expect(response.body).not.toContain('token_hash');
    expect(response.body).not.toContain(supervisor.token);
  });
  it('limits room creation and posting to permitted roles', async () => {
    expect((await hub.app.inject({ method: 'POST', url: '/v1/rooms', headers: auth(alice.token), payload: { name: 'No' } })).statusCode).toBe(403);
    expect((await hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/messages`, headers: auth(observer.token), payload: { body: 'No' } })).statusCode).toBe(403);
    const result = await hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/messages`, headers: auth(alice.token), payload: { body: 'Hello, agents' } });
    expect(result.statusCode).toBe(201); expect(result.json().message.from_agent_id).toBe(alice.agent.id);
  });
  it('keeps DMs out of other agents histories and replay while allowing operators to observe', async () => {
    hub.services.rooms.postMessage(room, alice.agent.id, 'public');
    hub.services.rooms.postMessage(room, alice.agent.id, 'private for bob', bob.agent.id);
    const url = `/v1/rooms/${room}/messages`;
    const third = await hub.app.inject({ url, headers: auth(eve.token) });
    expect(third.json().messages.map((m: { body: string }) => m.body)).toEqual(['public']);
    for (const token of [bob.token, observer.token, supervisor.token]) {
      const reply = await hub.app.inject({ url, headers: auth(token) });
      expect(reply.body).toContain('private for bob');
    }
    expect((await hub.app.inject({ url: '/v1/events', headers: auth(eve.token) })).body).not.toContain('private for bob');
    expect((await hub.app.inject({ url: '/v1/events', headers: auth(supervisor.token) })).body).toContain('private for bob');
  });
  it('hides an archived room from catalogs, membership, posting and sandbox access', async () => {
    hub.services.rooms.postMessage(room, alice.agent.id, 'before archive');
    hub.services.db.prepare('UPDATE rooms SET archived_at=? WHERE id=?').run(new Date().toISOString(), room);
    for (const token of [supervisor.token, alice.token, observer.token]) {
      expect((await hub.app.inject({ url: '/v1/rooms', headers: auth(token) })).json().rooms).toEqual([]);
      expect((await hub.app.inject({ url: `/v1/rooms/${room}/messages`, headers: auth(token) })).statusCode).toBe(404);
      expect((await hub.app.inject({ url: `/v1/rooms/${room}/sandbox`, headers: auth(token) })).statusCode).toBe(404);
    }
    expect((await hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/messages`, headers: auth(alice.token), payload: { body: 'after' } })).statusCode).toBe(404);
    expect((await hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/join`, headers: auth(eve.token) })).statusCode).toBeGreaterThanOrEqual(400);
    expect(hub.services.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id=?').get(room)).toEqual({ n: 1 });
  });
  it('rejects fractional, infinite, negative and unknown query fields', async () => {
    for (const query of ['since=1.5', 'since=-1', 'limit=Infinity', 'unknown=1']) {
      expect((await hub.app.inject({ url: `/v1/events?${query}`, headers: auth(supervisor.token) })).statusCode).toBe(400);
    }
    expect((await hub.app.inject({ url: `/v1/rooms/${room}/messages?since=NaN`, headers: auth(supervisor.token) })).statusCode).toBe(400);
    expect((await hub.app.inject({ url: '/v1/events?type=message.created', headers: auth(supervisor.token) })).json().events).toEqual([]);
  });
  it('authenticates sandbox tools and enforces room membership and observer read-only', async () => {
    const sandbox = 'sbx_0123456789abcdef';
    const now = new Date().toISOString();
    hub.services.db.prepare(`INSERT INTO sandboxes (id,room_id,container_name,image,status,created_at,updated_at) VALUES (?,?,?,?,'stopped',?,?)`)
      .run(sandbox, room, 'test', 'test-image', now, now);
    const outsider = new TokenRegistry(hub.services.db).issue('outsider', 'agent');
    expect((await hub.app.inject({ method: 'POST', url: `/v1/sandboxes/${sandbox}/exec`, payload: { cmd: 'pwd' } })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: `/v1/sandboxes/${sandbox}/exec`, headers: auth(outsider.token), payload: { cmd: 'pwd' } })).statusCode).toBe(403);
    expect((await hub.app.inject({ method: 'PUT', url: `/v1/sandboxes/${sandbox}/file`, headers: auth(observer.token), payload: { path: 'x', content: 'x' } })).statusCode).toBe(403);
    expect((await hub.app.inject({ url: `/v1/rooms/${room}/sandbox`, headers: auth(observer.token) })).json().sandbox.id).toBe(sandbox);
    expect((await hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/sandbox`, headers: auth(alice.token) })).statusCode).toBe(403);
    const repos = `/v1/sandboxes/${sandbox}/repos`;
    expect((await hub.app.inject({ method: 'POST', url: repos, payload: { repo: 'octocat/Hello-World' } })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: repos, headers: auth(observer.token), payload: { repo: 'octocat/Hello-World' } })).statusCode).toBe(403);
    expect((await hub.app.inject({ method: 'POST', url: repos, headers: auth(outsider.token), payload: { repo: 'octocat/Hello-World' } })).statusCode).toBe(403);
    for (const payload of [{}, { repo: 'octocat/Hello-World', depth: 1 }, { repo: 'x' }]) {
      expect((await hub.app.inject({ method: 'POST', url: repos, headers: auth(alice.token), payload })).statusCode).toBe(400);
    }
    const pulls = `/v1/sandboxes/${sandbox}/pulls`, pull = { repo: 'octocat/Hello-World', branch: 'ai/x', title: 'Change' };
    expect((await hub.app.inject({ method: 'POST', url: pulls, payload: pull })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'POST', url: pulls, headers: auth(observer.token), payload: pull })).statusCode).toBe(403);
    expect((await hub.app.inject({ method: 'POST', url: pulls, headers: auth(outsider.token), payload: pull })).statusCode).toBe(403);
    for (const payload of [{ repo: 'octocat/Hello-World', branch: 'ai/x' }, { ...pull, merge: true }, { ...pull, force: true }]) {
      expect((await hub.app.inject({ method: 'POST', url: pulls, headers: auth(alice.token), payload })).statusCode).toBe(400);
    }
    // No route merges, closes or otherwise changes a pull request.
    for (const url of [`${pulls}/1/merge`, `/v1/sandboxes/${sandbox}/merge`]) {
      expect((await hub.app.inject({ method: 'POST', url, headers: auth(supervisor.token), payload: {} })).statusCode).toBe(404);
      expect((await hub.app.inject({ method: 'PUT', url, headers: auth(supervisor.token), payload: {} })).statusCode).toBe(404);
    }
    // The fixture sandbox is stopped, so a well-formed request is refused before any container starts.
    const stopped = await hub.app.inject({ method: 'POST', url: repos, headers: auth(alice.token), payload: { repo: 'octocat/Hello-World' } });
    expect(stopped.statusCode).toBe(409); expect(stopped.json().error.code).toBe('SANDBOX_NOT_RUNNING');
  });
});
