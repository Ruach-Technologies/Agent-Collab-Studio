import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildServer, type BuiltHub } from '../src/server.js';
import { TokenRegistry } from '../src/tokens.js';
import { isLocalRequest, issueOperator, operatorFile, revokeOperator } from '../src/operator.js';

let hub: BuiltHub;
let dir: string;
let dataDir: string;
let token: string;
let legacyRoom: string;
let clientRoom: string;
const legacy = 'wks_0000000000000000', client = 'wks_cccccccccccccccc';
const auth = (value: string, workspace?: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${value}`, ...(workspace ? { 'x-hub-workspace': workspace } : {}), ...extra });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'collab-operator-'));
  dataDir = join(dir, 'data');
  hub = await buildServer({ HUB_DATA_DIR: dataDir, HUB_WORKSPACES_DIR: join(dir, 'workspaces'), HUB_WEB_DIST: join(dir, 'missing'), HUB_LOG_LEVEL: 'silent' });
  hub.services.db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(client, 'Client project', new Date(Date.now() + 1000).toISOString());
  const registry = new TokenRegistry(hub.services.db);
  legacyRoom = hub.services.rooms.create({ name: 'Legacy room' }, registry.issue('Alex', 'supervisor').agent.id).id;
  clientRoom = hub.services.rooms.create({ name: 'Client room' }, registry.issue('client-lead', 'supervisor', client).agent.id).id;
  registry.issue('Alex', 'agent', client); // same name, not a supervisor: must never be elevated
  token = issueOperator(dataDir, 'Alex').token;
});
afterEach(async () => { await hub.app.close(); rmSync(dir, { recursive: true, force: true }); });

describe('local operator access', () => {
  it('stores only a hash in a private file and replaces the previous credential', () => {
    const file = operatorFile(dataDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(token);
    const next = issueOperator(dataDir, 'Alex').token;
    expect(next).not.toBe(token);
  });

  it('acts as a supervisor in whichever workspace is selected, reusing or creating its identity', async () => {
    const first = await hub.app.inject({ url: '/v1/whoami', headers: auth(token) });
    expect(first.json()).toMatchObject({ operator: true, agent: { name: 'Alex', role: 'supervisor', workspace_id: legacy }, workspace: { id: legacy } });
    const other = await hub.app.inject({ url: '/v1/whoami', headers: auth(token, client) });
    expect(other.json()).toMatchObject({ operator: true, agent: { name: 'Alex (operator)', role: 'supervisor', workspace_id: client } });
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(token, client) })).json().agent.id).toBe(other.json().agent.id);
    expect(hub.services.db.prepare("SELECT role FROM agents WHERE workspace_id=? AND name='Alex'").get(client)).toEqual({ role: 'agent' });
    expect((await hub.app.inject({ url: '/v1/operator/workspaces', headers: auth(token) })).json().workspaces.map((row: { id: string }) => row.id)).toEqual([legacy, client]);
    // Each selection sees only that workspace, and can act there as an ordinary supervisor.
    expect((await hub.app.inject({ url: '/v1/rooms', headers: auth(token) })).json().rooms.map((room: { id: string }) => room.id)).toEqual([legacyRoom]);
    expect((await hub.app.inject({ url: '/v1/rooms', headers: auth(token, client) })).json().rooms.map((room: { id: string }) => room.id)).toEqual([clientRoom]);
    expect((await hub.app.inject({ url: `/v1/rooms/${clientRoom}/messages`, headers: auth(token) })).statusCode).toBeGreaterThanOrEqual(403);
    const created = await hub.app.inject({ method: 'POST', url: '/v1/rooms', headers: auth(token, client), payload: { name: 'Operator room' } });
    expect(created.statusCode).toBe(201); expect(created.json().room.workspace_id).toBe(client);
    const audit = hub.services.db.prepare("SELECT payload FROM events WHERE type='auth.ok' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(audit.payload)).toMatchObject({ via: 'operator', method: 'POST' });
    for (const workspace of ['wks_ffffffffffffffff', 'nonsense']) {
      expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(token, workspace) })).statusCode).toBe(404);
    }
  });

  it('is refused through the tunnel or any proxy, and for unknown, unsafe or revoked credentials', async () => {
    for (const extra of [
      { 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-host': 'finer.ngrok-free.app' }, { host: 'finer.ngrok-free.app' },
      { host: '127.0.0.1.evil.test' }, { forwarded: 'for=203.0.113.9' }, { via: '1.1 proxy' }, { 'ngrok-trace-id': 'abc' },
    ]) {
      const reply = await hub.app.inject({ url: '/v1/whoami', headers: auth(token, undefined, extra) });
      expect(reply.statusCode).toBe(403); expect(reply.json().error.code).toBe('OPERATOR_LOCAL_ONLY');
    }
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(token, undefined, { host: '127.0.0.1:8791', 'ngrok-skip-browser-warning': '1' }) })).statusCode).toBe(200);
    expect(isLocalRequest({ host: 'localhost:8791' })).toBe(true); expect(isLocalRequest({})).toBe(false);
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(`acho_${'x'.repeat(43)}`) })).statusCode).toBe(401);
    chmodSync(operatorFile(dataDir), 0o644);
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(token) })).statusCode).toBe(401);
    chmodSync(operatorFile(dataDir), 0o600);
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(token) })).statusCode).toBe(200);
    expect(revokeOperator(dataDir)).toBe(true);
    expect((await hub.app.inject({ url: '/v1/whoami', headers: auth(token) })).statusCode).toBe(401);
  });

  it('gives ordinary tokens no cross-workspace reach', async () => {
    const supervisor = new TokenRegistry(hub.services.db).issue('regular', 'supervisor');
    const reply = await hub.app.inject({ url: '/v1/whoami', headers: auth(supervisor.token, client) });
    expect(reply.json()).toMatchObject({ operator: false, agent: { workspace_id: legacy } });
    expect((await hub.app.inject({ url: '/v1/operator/workspaces', headers: auth(supervisor.token) })).statusCode).toBe(403);
    expect((await hub.app.inject({ url: '/v1/rooms', headers: auth(supervisor.token, client) })).json().rooms.map((room: { id: string }) => room.id)).toEqual([legacyRoom]);
  });

  it('authenticates the live socket per workspace locally, refuses it when proxied, and drops it on revocation', async () => {
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address() as { port: number };
    const hello = (headers: Record<string, string> = {}) => new Promise<{ frame?: Record<string, any>; closed?: number; socket: WebSocket }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`, { headers });
      socket.on('open', () => socket.send(JSON.stringify({ t: 'hello', token, workspace: client })));
      socket.on('message', (raw) => resolve({ frame: JSON.parse(raw.toString()), socket }));
      socket.on('close', (code) => resolve({ closed: code, socket }));
    });
    const local = await hello();
    expect(local.frame).toMatchObject({ t: 'hello.ok', agent: { name: 'Alex (operator)', workspace_id: client }, workspace: { id: client } });
    expect((await hello({ 'x-forwarded-for': '203.0.113.9' })).closed).toBe(4008);
    const closed = new Promise<number>((resolve) => local.socket.on('close', resolve));
    revokeOperator(dataDir);
    local.socket.send(JSON.stringify({ t: 'ping' }));
    expect(await closed).toBe(4008);
  });
});
