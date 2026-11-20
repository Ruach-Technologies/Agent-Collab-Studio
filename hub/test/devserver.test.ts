import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, type DbHandle } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { RoomService } from '../src/rooms.js';
import { TokenRegistry } from '../src/tokens.js';
import { SandboxService } from '../src/sandbox.js';
import { DevServerService, TICKET_PARAM } from '../src/devserver.js';
import { buildServer } from '../src/server.js';

// A fake docker CLI: containers live in a JSON file; `exec` of the relay runs the real relay script
// on this machine, so it connects to the test's upstream server on 127.0.0.1.
const FAKE_DOCKER = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = process.env.FAKE_DOCKER_ROOT;
const store = path.join(root, 'containers.json');
const state = JSON.parse(fs.readFileSync(store, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
const save = () => fs.writeFileSync(store, JSON.stringify(state));
const lookup = (id) => state[id] || Object.values(state).find((entry) => entry.Id === id);
const command = args[0];
if (command === 'inspect') {
  const entry = lookup(args.at(-1));
  if (!entry) { console.error('Error: No such container'); process.exit(1); }
  console.log(JSON.stringify([entry]));
} else if (command === 'run') {
  const name = args[args.indexOf('--name') + 1];
  if (state[name]) { console.error('name conflict'); process.exit(1); }
  const labels = {}; const env = [];
  args.forEach((value, index) => {
    if (value === '--label') { const label = args[index + 1]; const at = label.indexOf('='); labels[label.slice(0, at)] = label.slice(at + 1); }
    if (value === '--env') env.push(args[index + 1]);
  });
  const id = (Object.keys(state).length + 1 + Date.now()).toString(16).padStart(64, 'b');
  state[name] = { Id: id, State: { Running: !fs.existsSync(path.join(root, 'fail-run')), StartedAt: '2026-01-01T00:00:00Z' }, Config: { Labels: labels, Env: env }, args };
  save(); console.log(id);
} else if (command === 'rm') {
  const entry = lookup(args.at(-1));
  if (entry) for (const [name, value] of Object.entries(state)) if (value.Id === entry.Id) delete state[name];
  save();
} else if (command === 'exec') {
  const interactive = args[1] === '-i';
  const entry = lookup(args[interactive ? 2 : 1]);
  if (!entry || !entry.State.Running) { console.error('container not running'); process.exit(1); }
  const script = args[args.indexOf('-c') + 1];
  if (script.includes('/tmp/dev.exit')) {
    const exit = fs.existsSync(path.join(root, 'dev-exit')) ? Number(fs.readFileSync(path.join(root, 'dev-exit'), 'utf8')) : null;
    console.log(JSON.stringify({ exit_code: exit, listening: exit === null, log: '\u001b[32mready\u001b[39m in 12 ms\n', log_truncated: false }));
  } else if (script.includes('create_connection')) {
    const child = spawn('python3', ['-c', script, args.at(-1)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
  } else { process.exit(0); }
} else { console.error('unexpected docker command ' + command); process.exit(1); }
`;

let root: string;
let db: DbHandle;
let events: EventBus;
let sandbox: SandboxService;
let dev: DevServerService;
let rooms: RoomService;
let registry: TokenRegistry;
let supervisor: ReturnType<TokenRegistry['issue']>;
let member: ReturnType<TokenRegistry['issue']>;
let observer: ReturnType<TokenRegistry['issue']>;
let outsider: ReturnType<TokenRegistry['issue']>;
let roomId: string;
let upstream: http.Server;
let upstreamPort: number;
let previewPort: number;
let seen: http.IncomingHttpHeaders[];
let upgradeClosed = false;

const calls = (): string[][] => fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
const freePort = () => new Promise<number>((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });
const typesOf = (prefix: string) => (db.prepare('SELECT type, actor_id, payload FROM events WHERE type LIKE ? ORDER BY id').all(`${prefix}%`) as { type: string; actor_id: string | null; payload: string }[]);
const local = { host: '127.0.0.1:8791' };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-devserver-test-'));
  fs.writeFileSync(path.join(root, 'containers.json'), '{}');
  fs.writeFileSync(path.join(root, 'calls.jsonl'), '');
  const dockerBin = path.join(root, 'fake-docker');
  fs.writeFileSync(dockerBin, FAKE_DOCKER, { mode: 0o700 });
  process.env.FAKE_DOCKER_ROOT = root;
  db = openDb(path.join(root, 'hub.sqlite'));
  events = new EventBus(db);
  rooms = new RoomService({ db, events });
  registry = new TokenRegistry(db);
  supervisor = registry.issue('lead', 'supervisor');
  member = registry.issue('builder', 'agent');
  observer = registry.issue('client', 'observer');
  outsider = registry.issue('stranger', 'agent');
  roomId = rooms.create({ name: 'Preview room' }, supervisor.agent.id).id;
  rooms.join(roomId, member.agent.id);
  sandbox = new SandboxService({ db, events, config: {
    dockerBin, image: 'sandbox:test', workspacesDir: path.join(root, 'workspaces'), execTimeoutMs: 1_000, maxExecTimeoutMs: 2_000,
    outputCapBytes: 4_096, memLimitMB: 128, cpus: 1, pidsLimit: 32, containerUser: '1000:1000', denylist: [],
  } });
  previewPort = await freePort();
  dev = new DevServerService({ db, events, sandbox, dataDir: root, preview: { port: previewPort, host: '127.0.0.1', publicUrl: null } });
  seen = []; upgradeClosed = false;
  upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['app=1; Path=/', 'ach_preview=stolen; Path=/'] });
    res.end(`<h1>sandbox page ${req.url}</h1>`);
  });
  upstream.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]));
    // The relay closes its connection once the preview client goes away.
    socket.on('end', () => { upgradeClosed = true; socket.end(); });
  });
  upstreamPort = await new Promise<number>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as net.AddressInfo).port)));
});

afterEach(async () => {
  await dev.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function running() {
  const row = await sandbox.provision(roomId, supervisor.agent.id);
  await dev.start(row.id, member.agent.id, { cmd: 'npm run dev', port: upstreamPort });
  return row.id;
}

describe('dev server lifecycle', () => {
  it('starts one hardened, owned, network-less container per sandbox with the command and port', async () => {
    const id = await running();
    const run = calls().filter((args) => args[0] === 'run').at(-1)!;
    expect(run[run.indexOf('--name') + 1]).toBe(`ach-dev-${id}`);
    for (const flag of [['--network', 'none'], ['--read-only'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--pids-limit', '32'], ['--memory', '128m'], ['--log-driver', 'none']]) {
      expect(run.join(' ')).toContain(flag.join(' '));
    }
    expect(run).toContain('io.agent-collab-hub.kind=dev');
    expect(run).toContain(`io.agent-collab-hub.room=${roomId}`);
    expect(run).toContain('DEV_CMD=npm run dev');
    expect(run).toContain(`PORT=${upstreamPort}`);
    expect(run).toContain('HOST=0.0.0.0');
    expect(typesOf('devserver.started')).toEqual([expect.objectContaining({ actor_id: member.agent.id })]);
    const status = await dev.status(id, observer.agent.id);
    expect(status).toMatchObject({ state: 'running', cmd: 'npm run dev', port: upstreamPort, listening: true, started_by: member.agent.id });
    expect(status.log).toBe('ready in 12 ms\n');
  });

  it('applies the exec rules: writers only, members only, validated input', async () => {
    const row = await sandbox.provision(roomId, supervisor.agent.id);
    await expect(dev.start(row.id, observer.agent.id, {})).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(dev.start(row.id, outsider.agent.id, {})).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND', status: 404 });
    await expect(dev.status(row.id, outsider.agent.id)).rejects.toMatchObject({ status: 404 });
    await expect(dev.start(row.id, member.agent.id, { port: 80 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(dev.start(row.id, member.agent.id, { cmd: 'curl https://example.com' })).rejects.toMatchObject({ code: 'SANDBOX_CMD_DENIED' });
    await expect(dev.start(row.id, member.agent.id, { cmd: 'npm run dev\nrm -rf /' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(dev.start(row.id, member.agent.id, { dir: '../etc' })).rejects.toMatchObject({ code: 'SANDBOX_PATH_INVALID' });
    expect(calls().filter((args) => args[0] === 'run' && args.includes('io.agent-collab-hub.kind=dev'))).toHaveLength(0);
  });

  it('refuses to start without a running sandbox', async () => {
    const row = await sandbox.provision(roomId, supervisor.agent.id);
    db.prepare(`UPDATE sandboxes SET status = 'stopped' WHERE id = ?`).run(row.id);
    await expect(dev.start(row.id, member.agent.id, {})).rejects.toMatchObject({ code: 'SANDBOX_NOT_RUNNING', status: 409 });
  });

  it('restart replaces the container; an exited command is reported once with its log', async () => {
    const id = await running();
    const first = (JSON.parse(fs.readFileSync(path.join(root, 'containers.json'), 'utf8')) as Record<string, { Id: string }>)[`ach-dev-${id}`]!.Id;
    await dev.start(id, member.agent.id, { cmd: 'node server.js', port: 3000, dir: 'app' });
    expect(calls().some((args) => args[0] === 'rm' && args.at(-1) === first)).toBe(true);
    expect(JSON.parse(typesOf('devserver.started').at(-1)!.payload)).toMatchObject({ cmd: 'node server.js', port: 3000, dir: 'app', restarted: true });
    fs.writeFileSync(path.join(root, 'dev-exit'), '1');
    expect(await dev.status(id, member.agent.id)).toMatchObject({ state: 'exited', exit_code: 1 });
    expect(await dev.status(id, member.agent.id)).toMatchObject({ state: 'exited' });
    expect(typesOf('devserver.exited')).toHaveLength(1);
  });

  it('stops with the sandbox, on request, and when the sandbox is gone; adopts a container after a restart', async () => {
    const id = await running();
    expect(await dev.stop(id, member.agent.id)).toEqual({ stopped: true });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'containers.json'), 'utf8'))[`ach-dev-${id}`]).toBeUndefined();
    expect(await dev.status(id, member.agent.id)).toMatchObject({ state: 'stopped', cmd: 'npm run dev', port: upstreamPort });
    await expect(dev.stop(id, observer.agent.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await dev.start(id, member.agent.id, { port: upstreamPort });
    await sandbox.destroy(roomId);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'containers.json'), 'utf8'))[`ach-dev-${id}`]).toBeUndefined();
    expect(JSON.parse(typesOf('devserver.stopped').at(-1)!.payload)).toMatchObject({ reason: 'sandbox_stopped' });

    // A fresh service (hub restart) adopts the running container from its labels and environment.
    await sandbox.provision(roomId, supervisor.agent.id);
    await dev.start(id, member.agent.id, { cmd: 'npm start', port: upstreamPort });
    const restarted = new DevServerService({ db, events, sandbox, dataDir: root, preview: { port: null, host: '127.0.0.1', publicUrl: null } });
    expect(await restarted.status(id, member.agent.id)).toMatchObject({ state: 'running', cmd: 'npm start', port: upstreamPort, started_by: null });
    db.prepare(`UPDATE sandboxes SET status = 'stopped' WHERE id = ?`).run(id);
    await restarted.sweep();
    expect(JSON.parse(fs.readFileSync(path.join(root, 'containers.json'), 'utf8'))[`ach-dev-${id}`]).toBeUndefined();
  });

  it('stops the dev server when the room container dies outside the hub', async () => {
    const id = await running();
    const store = path.join(root, 'containers.json');
    const state = JSON.parse(fs.readFileSync(store, 'utf8'));
    const roomName = Object.keys(state).find((name) => name.startsWith('ach-sbx-'))!;
    state[roomName].State.Running = false;
    fs.writeFileSync(store, JSON.stringify(state));
    expect(sandbox.get(id)?.status).toBe('running');
    await dev.sweep();
    expect(JSON.parse(fs.readFileSync(store, 'utf8'))[`ach-dev-${id}`]).toBeUndefined();
    expect(JSON.parse(typesOf('devserver.stopped').at(-1)!.payload)).toMatchObject({ reason: 'sandbox_stopped' });
  });

  it('fetches a path through the exec relay for agents', async () => {
    const id = await running();
    const result = await dev.fetchPath(id, observer.agent.id, '/about?x=1');
    expect(result).toMatchObject({ status: 200, content_type: 'text/html', body: '<h1>sandbox page /about?x=1</h1>', truncated: false });
    expect(seen.at(-1)!.host).toBe(`localhost:${upstreamPort}`);
    await expect(dev.fetchPath(id, observer.agent.id, '//evil.example/')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await expect(dev.fetchPath(id, observer.agent.id, '/')).rejects.toMatchObject({ code: 'DEVSERVER_UNREACHABLE', status: 502 });
  });
});

describe('preview origin', () => {
  const base = () => `http://127.0.0.1:${previewPort}`;
  async function signIn(agentId: ReturnType<TokenRegistry['issue']>, id: string, pathname = '/') {
    const ticket = dev.ticket(id, agentId.agent, false, local, pathname);
    expect(ticket.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${previewPort}/`));
    const response = await fetch(ticket.url!, { redirect: 'manual' });
    return { ticket, response, cookie: /^(ach_preview=[^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? '' };
  }

  it('exchanges a single-use ticket for an HttpOnly cookie and proxies with hub credentials stripped', async () => {
    const id = await running();
    await dev.listen();
    const { ticket, response, cookie } = await signIn(member, id, '/deep/page?q=1');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/deep/page?q=1');
    expect(response.headers.get('set-cookie')).toMatch(/^ach_preview=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect((await fetch(ticket.url!, { redirect: 'manual' })).status).toBe(401);
    // Only hashes are kept in memory.
    const internals = dev as unknown as { tickets: Map<string, unknown>; sessions: Map<string, unknown> };
    expect([...internals.sessions.keys()].every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(JSON.stringify([...internals.sessions.entries()])).not.toContain(cookie.slice('ach_preview='.length));

    const page = await fetch(`${base()}/deep/page?q=1`, { headers: { cookie: `${cookie}; theirs=1`, authorization: `Bearer ${member.token}`, origin: base(), 'x-hub-agent': 'x' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<h1>sandbox page /deep/page?q=1</h1>');
    expect(page.headers.getSetCookie()).toEqual(['app=1; Path=/']);
    expect(seen.at(-1)).toMatchObject({ host: `localhost:${upstreamPort}`, cookie: 'theirs=1', origin: `http://localhost:${upstreamPort}` });
    expect(seen.at(-1)!.authorization).toBeUndefined();
    expect(seen.at(-1)!['x-hub-agent']).toBeUndefined();
    expect(typesOf('devserver.preview.opened')).toEqual([expect.objectContaining({ actor_id: member.agent.id })]);
  });

  it('rejects missing, forged and expired sessions and re-checks membership and revocation on every request', async () => {
    const id = await running();
    await dev.listen();
    expect((await fetch(`${base()}/`)).status).toBe(401);
    expect((await fetch(`${base()}/`, { headers: { cookie: `ach_preview=${'A'.repeat(43)}` } })).status).toBe(401);
    expect((await fetch(`${base()}/?${TICKET_PARAM}=nope`, { redirect: 'manual' })).status).toBe(401);
    expect(() => dev.ticket(id, outsider.agent, false, local)).toThrow('Room not found');

    const viewer = await signIn(observer, id);
    expect((await fetch(`${base()}/`, { headers: { cookie: viewer.cookie } })).status).toBe(200);
    const builder = await signIn(member, id);
    expect((await fetch(`${base()}/`, { headers: { cookie: builder.cookie } })).status).toBe(200);
    db.prepare('DELETE FROM members WHERE room_id = ? AND agent_id = ?').run(roomId, member.agent.id);
    expect((await fetch(`${base()}/`, { headers: { cookie: builder.cookie } })).status).toBe(403);
    db.prepare('UPDATE tokens SET revoked_at = ? WHERE agent_id = ?').run(new Date().toISOString(), observer.agent.id);
    expect((await fetch(`${base()}/`, { headers: { cookie: viewer.cookie } })).status).toBe(403);
  });

  it('says the server is not running instead of proxying, and proxies WebSocket upgrades', async () => {
    const id = await running();
    await dev.listen();
    const { cookie } = await signIn(supervisor, id);
    const frame = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(previewPort, '127.0.0.1', () => socket.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${previewPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${cookie}\r\n\r\n`));
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString('latin1'); if (data.includes('hello')) { socket.destroy(); resolve(data); } });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); reject(new Error(`no frame: ${data}`)); }, 8_000);
    });
    expect(frame).toMatch(/^HTTP\/1\.1 101 /);
    expect(frame).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(seen.length).toBe(0);
    for (let i = 0; i < 50 && !upgradeClosed; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upgradeClosed).toBe(true);

    await dev.stop(id, supervisor.agent.id);
    const stopped = await fetch(`${base()}/`, { headers: { cookie } });
    expect(stopped.status).toBe(503);
    expect(await stopped.text()).toContain('The dev server is not running');
  });

  it('tells a remote caller the preview is local-only unless a public preview address is configured', async () => {
    const id = await running();
    const remote = { host: 'hub.example.com', 'x-forwarded-proto': 'https' };
    expect(dev.ticket(id, member.agent, false, remote)).toMatchObject({ url: null, access: { reachable: false, local_only: true } });
    const tunnelled = new DevServerService({ db, events, sandbox, dataDir: root, preview: { port: previewPort, host: '127.0.0.1', publicUrl: 'https://preview.example.com' } });
    expect(tunnelled.ticket(id, member.agent, false, remote).url).toMatch(/^https:\/\/preview\.example\.com\/\?__ach_preview_ticket=/);
    expect(dev.ticket(id, member.agent, false, { host: 'localhost:8791' }).url).toMatch(new RegExp(`^http://localhost:${previewPort}/`));
    const disabled = new DevServerService({ db, events, sandbox, dataDir: root, preview: { port: null, host: '127.0.0.1', publicUrl: null } });
    expect(disabled.previewAccess(local)).toMatchObject({ enabled: false, reachable: false });
  });
});

describe('dev server routes', () => {
  it('validates input, keeps observers to read-only routes and frames only the preview origin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-devserver-routes-'));
    const hub = await buildServer({ HUB_DATA_DIR: path.join(dir, 'data'), HUB_WORKSPACES_DIR: path.join(dir, 'ws'), HUB_WEB_DIST: path.join(dir, 'missing'), HUB_LOG_LEVEL: 'silent', HUB_PORT: '8801', HUB_PREVIEW_PORT: '9911' });
    try {
      const tokens = new TokenRegistry(hub.services.db);
      const lead = tokens.issue('lead', 'supervisor'); const watcher = tokens.issue('watcher', 'observer'); const stranger = tokens.issue('stranger', 'agent');
      const room = hub.services.rooms.create({ name: 'Routes' }, lead.agent.id).id;
      const sbx = 'sbx_00112233445566ff';
      hub.services.db.prepare(`INSERT INTO sandboxes (id, room_id, container_id, container_name, image, status, error, created_at, updated_at)
        VALUES (?, ?, 'abc', 'ach-sbx', 'img', 'running', NULL, ?, ?)`).run(sbx, room, new Date().toISOString(), new Date().toISOString());
      const call = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
        hub.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
      expect((await call(watcher.token, 'POST', `/v1/sandboxes/${sbx}/dev-server`, {})).statusCode).toBe(403);
      expect((await call(watcher.token, 'DELETE', `/v1/sandboxes/${sbx}/dev-server`)).statusCode).toBe(403);
      expect((await call(stranger.token, 'POST', `/v1/sandboxes/${sbx}/dev-server/ticket`, {})).statusCode).toBe(403);
      expect((await call(lead.token, 'POST', `/v1/sandboxes/${sbx}/dev-server`, { port: 22 })).statusCode).toBe(400);
      expect((await call(lead.token, 'POST', `/v1/sandboxes/${sbx}/dev-server`, { cmd: 'x', extra: 1 })).statusCode).toBe(400);
      expect((await call(lead.token, 'POST', `/v1/sandboxes/${sbx}/dev-server/fetch`, { path: 'no-slash' })).statusCode).toBe(400);
      expect((await call(lead.token, 'POST', `/v1/sandboxes/sbx_bad/dev-server/ticket`, {})).statusCode).toBe(400);
      const ticket = await call(watcher.token, 'POST', `/v1/sandboxes/${sbx}/dev-server/ticket`, { path: '/app' });
      expect(ticket.statusCode).toBe(201);
      expect(ticket.json().url).toMatch(/^http:\/\/localhost:9911\/app\?__ach_preview_ticket=[A-Za-z0-9_-]{43}$/);
      const csp = String((await call(lead.token, 'GET', '/v1/whoami')).headers['content-security-policy']);
      expect(csp).toContain('frame-src http://127.0.0.1:9911 http://localhost:9911;');
      expect(csp).toContain("frame-ancestors 'none'");
    } finally {
      await hub.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
