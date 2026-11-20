import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { buildServer, type BuiltHub } from '../src/server.js';
import { TokenRegistry } from '../src/tokens.js';
import { hashToken } from '../src/auth.js';
import { issueOperator } from '../src/operator.js';
import { SecurityMonitor, parseGateLine, requestSource, type DockerRunner } from '../src/security.js';
import { loadConfig } from '../src/config.js';

// The gate and Docker are faked here; the end-to-end path against real Docker is exercised by hand
// (see docs/security.md, "Security monitoring").
let hub: BuiltHub;
let dir: string;
let dataDir: string;
let workspacesDir: string;
let supervisor: ReturnType<TokenRegistry['issue']>;
let alice: ReturnType<TokenRegistry['issue']>;
let observer: ReturnType<TokenRegistry['issue']>;
let otherLead: ReturnType<TokenRegistry['issue']>;
let room: string;
let otherRoom: string;
let operator: string;
const legacy = 'wks_0000000000000000', client = 'wks_cccccccccccccccc';
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const hex = (n: number) => randomBytes(n).toString('hex');

async function setup(env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'collab-security-'));
  dataDir = join(dir, 'data'); workspacesDir = join(dir, 'ws');
  hub = await buildServer({ HUB_DATA_DIR: dataDir, HUB_WORKSPACES_DIR: workspacesDir, HUB_WEB_DIST: join(dir, 'missing'), HUB_LOG_LEVEL: 'silent', HUB_PORT: '8796', ...env });
  hub.services.db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(client, 'Client project', new Date(Date.now() + 1000).toISOString());
  const registry = new TokenRegistry(hub.services.db);
  supervisor = registry.issue('lead', 'supervisor'); alice = registry.issue('alice', 'agent'); observer = registry.issue('watcher', 'observer');
  otherLead = registry.issue('client-lead', 'supervisor', client);
  room = hub.services.rooms.create({ name: 'Launch site' }, supervisor.agent.id).id;
  otherRoom = hub.services.rooms.create({ name: 'Client room' }, otherLead.agent.id).id;
  hub.services.rooms.join(room, alice.agent.id);
  operator = issueOperator(dataDir, 'Ben').token;
}
afterEach(async () => { vi.restoreAllMocks(); await hub.app.close(); rmSync(dir, { recursive: true, force: true }); });

async function makeSidekick() {
  const { sidekick } = (await hub.app.inject({ method: 'POST', url: '/v1/sidekicks', headers: auth(alice.token), payload: { name: 'Pip' } })).json();
  const token = `ach_${randomBytes(24).toString('base64url')}`;
  hub.services.db.prepare("INSERT INTO tokens (id, agent_id, workspace_id, role, token_hash, created_at) VALUES (?, ?, ?, 'agent', ?, ?)")
    .run(`tok_${hex(8)}`, sidekick.agent_id, legacy, hashToken(token), new Date().toISOString());
  return { id: sidekick.id as string, agentId: sidekick.agent_id as string, token };
}

/** A pretend Docker: the sealed network's members, their labels, and the gate's log. */
function fakeDocker(state: { members: Array<{ id: string; name: string; ip: string; labels: Record<string, string> }>; log: string[]; gateRunning?: boolean; missing?: boolean }) {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    if (state.missing) return { code: null, stdout: '', stderr: '' };
    if (args[0] === 'network' && args[1] === 'inspect') {
      const containers = Object.fromEntries(state.members.map((m) => [m.id, { Name: m.name, IPv4Address: `${m.ip}/16` }]));
      return { code: 0, stdout: JSON.stringify(containers), stderr: '' };
    }
    if (args[0] === 'inspect' && args.includes('ach-egress-gate-8796')) {
      return { code: 0, stdout: `${state.gateRunning === false ? 'false' : 'true'} "2026-11-19T00:00:00Z"\n`, stderr: '' };
    }
    if (args[0] === 'inspect') {
      const ids = args.slice(4);
      const lines = state.members.filter((m) => ids.includes(m.id)).map((m) => [JSON.stringify(m.id), JSON.stringify(`/${m.name}`), JSON.stringify(new Date(Date.now() - 60_000).toISOString()),
        JSON.stringify(m.labels), JSON.stringify({ 'ach-sealed-8796': { IPAddress: m.ip } })].join('\t'));
      return { code: 0, stdout: lines.join('\n'), stderr: '' };
    }
    if (args[0] === 'logs') {
      const since = args[args.indexOf('--since') + 1]!;
      return { code: 0, stdout: state.log.filter((line) => line.slice(0, line.indexOf(' ')) >= since).join('\n'), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { runner, calls };
}
const stamp = (offsetMs = 0) => {
  const at = new Date(Date.now() + offsetMs).toISOString();
  return { at, ts: at.replace('Z', '123456Z') };
};
const gateLine = (entry: Record<string, unknown>, offsetMs = 0) => { const { at, ts } = stamp(offsetMs); return `${ts} ${JSON.stringify({ at, ...entry })}`; };
const ownerLabel = () => createHash('sha256').update(resolve(workspacesDir)).digest('hex').slice(0, 24);

describe('gate log parsing', () => {
  beforeEach(() => setup());
  it('accepts well-formed decisions and drops anything malformed', () => {
    const line = parseGateLine('2026-11-19T10:00:00.123456789Z {"at":"2026-11-19T10:00:00.120Z","profile":"packages","decision":"close","kind":"connect","host":"Registry.npmjs.org","port":443,"client":"172.30.0.5","peer":"ach-install-exec_0123456789abcdef","bytes_up":1200,"bytes_down":-5,"duration_ms":30}');
    expect(line).toMatchObject({ ts: '2026-11-19T10:00:00.123456789Z', entry: { profile: 'packages', decision: 'close', host: 'registry.npmjs.org', port: 443, client: '172.30.0.5', bytes_up: 1200, bytes_down: 0, duration_ms: 30 } });
    expect(parseGateLine('{"at":"x","profile":"packages","decision":"allow"}')).toBeNull();
    expect(parseGateLine('{"at":"2026-11-19T10:00:00Z","profile":"evil","decision":"allow"}')).toBeNull();
    expect(parseGateLine('not json')).toBeNull();
    const odd = parseGateLine('{"at":"2026-11-19T10:00:00Z","profile":"sidekick","decision":"deny","kind":"http","host":"a b/c?token=1","client":"not-an-ip","peer":"bad name"}');
    expect(odd?.entry).toMatchObject({ host: 'invalid', client: null, peer: null });
  });

  it('groups sign-in failures by the tunnel\'s client address, not the loopback socket', () => {
    expect(requestSource({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '10.9.9.9, 203.0.113.7' } })).toBe('203.0.113.7');
    expect(requestSource({ ip: '198.51.100.2', headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('198.51.100.2');
    expect(requestSource({ ip: '::ffff:192.0.2.1', headers: {} })).toBe('192.0.2.1');
  });
});

describe('ingestion, attribution and traffic alerts', () => {
  beforeEach(() => setup());

  it('maps gate lines to containers, rooms and sidekicks, aggregates repeats, and does not re-read old lines', async () => {
    const pip = await makeSidekick();
    const sandboxId = `sbx_${hex(8)}`; const execId = `exec_${hex(8)}`;
    const now = new Date().toISOString();
    hub.services.db.prepare("INSERT INTO sandboxes (id, room_id, container_id, container_name, image, status, created_at, updated_at) VALUES (?, ?, NULL, ?, 'img', 'running', ?, ?)").run(sandboxId, room, `ach-sbx-${room}`, now, now);
    hub.services.db.prepare("INSERT INTO execs (id, sandbox_id, agent_id, cmd, created_at) VALUES (?, ?, ?, 'install dependencies (.)', ?)").run(execId, sandboxId, alice.agent.id, now);
    const sidekickCtr = hex(32), strangerCtr = hex(32);
    const docker = fakeDocker({ members: [
      { id: sidekickCtr, name: `ach-sidekick-${pip.id}`, ip: '172.30.0.3', labels: { 'ach.sidekick': pip.id, 'ach.network': 'ach-sealed-8796' } },
      { id: strangerCtr, name: 'curious-cat', ip: '172.30.0.9', labels: {} },
    ], log: [] });
    const monitor = new SecurityMonitor(hub.services, { docker: docker.runner });
    await monitor.refreshMembership();
    // The stranger is reported as soon as it is seen on the network.
    expect((monitor.alerts(null, {}) as Array<{ rule: string }>).map((alert) => alert.rule)).toEqual(['sealed.unrecognised']);

    docker.calls.length = 0;
    const log = [
      gateLine({ profile: 'sidekick', decision: 'listening', port: 3129 }, -5000),
      gateLine({ profile: 'sidekick', decision: 'allow', kind: 'connect', host: 'api.anthropic.com', port: 443, client: '172.30.0.3' }, -4000),
      gateLine({ profile: 'sidekick', decision: 'allow', kind: 'connect', host: 'api.anthropic.com', port: 443, client: '172.30.0.3' }, -3900),
      gateLine({ profile: 'sidekick', decision: 'close', kind: 'connect', host: 'api.anthropic.com', port: 443, client: '172.30.0.3', bytes_up: 5000, bytes_down: 90000, duration_ms: 100 }, -3800),
      gateLine({ profile: 'sidekick', decision: 'deny', kind: 'connect', host: 'pastebin.com', port: 443, reason: 'host', client: '172.30.0.3' }, -3000),
      gateLine({ profile: 'sidekick', decision: 'deny', kind: 'connect', host: 'pastebin.com', port: 443, reason: 'host', client: '172.30.0.3' }, -2900),
      // A finished install, already gone from the network: identified by the name Docker's resolver gave the gate.
      gateLine({ profile: 'packages', decision: 'allow', kind: 'connect', host: 'registry.npmjs.org', port: 443, client: '172.30.0.4', peer: `ach-install-${execId}` }, -2000),
      gateLine({ profile: 'packages', decision: 'deny', kind: 'connect', host: 'evil.example', port: 443, reason: 'host', client: '172.30.0.4', peer: `ach-install-${execId}` }, -1900),
      gateLine({ profile: 'packages', decision: 'deny', kind: 'http', host: 'host.docker.internal:4000', client: '172.30.0.9' }, -1000),
      'garbage line',
      // A line from an older gate, without the client's address: kept, but never alerted on.
      gateLine({ profile: 'packages', decision: 'deny', kind: 'connect', host: 'old.example', port: 443, reason: 'host' }, -500),
    ];
    const state = { members: [] as never[], log };
    const docker2 = fakeDocker(state);
    (monitor as unknown as { docker: DockerRunner }).docker = docker2.runner;
    expect(await monitor.readGateLog()).toBe(9);

    const rows = monitor.traffic(null, {}) as Array<Record<string, unknown>>;
    const anthropic = rows.find((row) => row.host === 'api.anthropic.com')!;
    expect(anthropic).toMatchObject({ decision: 'allow', count: 2, bytes_up: 5000, bytes_down: 90000, source_kind: 'sidekick', sidekick_id: pip.id, sidekick_name: 'Pip', workspace_id: legacy });
    expect(rows.find((row) => row.host === 'pastebin.com')).toMatchObject({ decision: 'deny', count: 2, sidekick_id: pip.id });
    expect(rows.find((row) => row.host === 'registry.npmjs.org')).toMatchObject({ source_kind: 'install', room_id: room, room_name: 'Launch site', container_name: `ach-install-${execId}` });
    expect(rows.find((row) => row.host === 'host.docker.internal:4000')).toMatchObject({ decision: 'deny', source_kind: 'unknown', container_name: 'curious-cat', workspace_id: null });
    expect(rows.find((row) => row.host === 'old.example')).toMatchObject({ decision: 'deny', source_kind: 'unattributed' });

    const alerts = monitor.alerts(null, {}) as Array<Record<string, unknown>>;
    expect(alerts.find((alert) => alert.rule === 'egress.denied' && String(alert.subject).endsWith('pastebin.com'))).toMatchObject({ severity: 'high', count: 2, sidekick_id: pip.id, workspace_id: legacy });
    expect(alerts.find((alert) => alert.rule === 'egress.denied' && String(alert.subject).endsWith('evil.example'))).toMatchObject({ severity: 'medium', room_id: room });
    expect(alerts.some((alert) => String(alert.subject).includes('old.example') || alert.subject === 'unattributed')).toBe(false);
    // The stranger's traffic joins the alert opened for it, rather than a second one.
    expect(alerts.filter((alert) => alert.rule === 'sealed.unrecognised')).toHaveLength(1);
    expect(alerts.find((alert) => alert.rule === 'sealed.unrecognised')).toMatchObject({ count: 2, subject: `ctr:${strangerCtr.slice(0, 12)}` });

    // Reading again from the cursor stores nothing twice; a new line is picked up and deduplicated into the open alert.
    expect(await monitor.readGateLog()).toBe(0);
    state.log.push(gateLine({ profile: 'sidekick', decision: 'deny', kind: 'connect', host: 'pastebin.com', port: 443, reason: 'host', client: '172.30.0.3' }, 10));
    expect(await monitor.readGateLog()).toBe(1);
    expect((monitor.alerts(null, {}) as Array<Record<string, unknown>>).find((alert) => String(alert.subject).endsWith('pastebin.com'))).toMatchObject({ count: 3 });
  });

  it('flags a source that sends out more than the hourly limit, once', async () => {
    const pip = await makeSidekick();
    const docker = fakeDocker({ members: [{ id: hex(32), name: `ach-sidekick-${pip.id}`, ip: '172.30.0.3', labels: { 'ach.sidekick': pip.id } }], log: [
      gateLine({ profile: 'sidekick', decision: 'close', kind: 'connect', host: 'api.anthropic.com', port: 443, client: '172.30.0.3', bytes_up: 60 * 1024 * 1024, bytes_down: 10, duration_ms: 5000 }, -1000),
    ] });
    const monitor = new SecurityMonitor(hub.services, { docker: docker.runner });
    await monitor.scan(); await monitor.scan();
    const volume = (monitor.alerts(null, {}) as Array<Record<string, unknown>>).filter((alert) => alert.rule === 'egress.volume');
    expect(volume).toHaveLength(1);
    expect(volume[0]).toMatchObject({ severity: 'high', count: 1, sidekick_id: pip.id });
    expect(String(volume[0]!.detail)).toContain('60.0 MB');
  });

  it('reports a stopped gate and keeps working without Docker', async () => {
    const down = fakeDocker({ members: [], log: [], gateRunning: false });
    const monitor = new SecurityMonitor(hub.services, { docker: down.runner });
    await monitor.scan();
    expect(monitor.status()).toMatchObject({ docker: true, gate: { running: false, network_ok: true } });
    expect((monitor.alerts(null, {}) as Array<{ rule: string }>).map((alert) => alert.rule)).toContain('gate.down');

    const absent = new SecurityMonitor(hub.services, { docker: fakeDocker({ members: [], log: [], missing: true }).runner });
    await expect(absent.scan()).resolves.toBeUndefined();
    expect(absent.status()).toMatchObject({ docker: false, gate: { running: null } });
  });

  it('keeps the traffic table bounded by age and row count', async () => {
    await hub.app.close(); rmSync(dir, { recursive: true, force: true });
    await setup({ HUB_SECURITY_MAX_ROWS: '1000', HUB_SECURITY_RETENTION_DAYS: '30' });
    const insert = hub.services.db.prepare(`INSERT INTO security_traffic (agg_key, bucket, first_at, last_at, profile, decision, kind, host, source_key, source_kind, count)
      VALUES (?, ?, ?, ?, 'packages', 'allow', 'connect', 'registry.npmjs.org', 'x', 'install', 1)`);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString(); const recent = new Date().toISOString();
    hub.services.db.transaction(() => {
      for (let i = 0; i < 50; i++) insert.run(`old-${i}`, old.slice(0, 16), old, old);
      for (let i = 0; i < 1200; i++) insert.run(`new-${i}`, recent.slice(0, 16), recent, recent);
    })();
    hub.services.security!.retention(true);
    const left = hub.services.db.prepare('SELECT COUNT(*) AS n, MIN(agg_key) AS first FROM security_traffic').get() as { n: number };
    expect(left.n).toBe(1000);
    expect(hub.services.db.prepare("SELECT COUNT(*) AS n FROM security_traffic WHERE agg_key LIKE 'old-%'").get()).toEqual({ n: 0 });
  });
});

describe('refusals become events and alerts', () => {
  beforeEach(() => setup());

  it('records sidekick tool, people-only and post refusals without bodies, and alerts on tool refusals', async () => {
    const pip = await makeSidekick();
    const call = await hub.app.inject({ method: 'POST', url: '/mcp', headers: auth(pip.token), payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hub_clone_repo', arguments: { repo: 'secret/stuff' } } } });
    expect(call.json().result.content[0].text).toContain('TOOL_NOT_ALLOWED');
    const sandbox = `sbx_${hex(8)}`;
    expect((await hub.app.inject({ method: 'POST', url: `/v1/sandboxes/${sandbox}/repos`, headers: auth(pip.token), payload: { repo: 'a/b' } })).json().error.code).toBe('PEOPLE_ONLY');
    expect((await hub.app.inject({ method: 'POST', url: `/v1/rooms/${room}/messages`, headers: auth(pip.token), payload: { body: 'private words' } })).json().error.code).toBe('SIDEKICK_NOT_WORKING');

    const events = hub.services.db.prepare("SELECT type, room_id, actor_id, payload FROM events WHERE type IN ('sidekick.tool.denied', 'sidekick.people_only.denied', 'sidekick.post.denied') ORDER BY id").all() as Array<{ type: string; room_id: string | null; actor_id: string; payload: string }>;
    expect(events.map((event) => event.type)).toEqual(['sidekick.tool.denied', 'sidekick.people_only.denied', 'sidekick.post.denied']);
    expect(events.every((event) => event.room_id === null && event.actor_id === pip.agentId)).toBe(true);
    expect(JSON.parse(events[0]!.payload)).toEqual({ tool: 'hub_clone_repo', sidekick_id: pip.id });
    expect(JSON.parse(events[1]!.payload)).toEqual({ action: 'clone', sidekick_id: pip.id, sandbox_id: sandbox });
    expect(JSON.parse(events[2]!.payload)).toEqual({ code: 'SIDEKICK_NOT_WORKING', room, sidekick_id: pip.id });
    expect(events.map((event) => event.payload).join(' ')).not.toMatch(/secret\/stuff|private words/);

    await hub.services.security!.scan();
    const alerts = hub.services.security!.alerts(null, {}) as Array<Record<string, unknown>>;
    expect(alerts.filter((alert) => alert.rule === 'sidekick.refused').map((alert) => alert.subject).sort()).toEqual([`${pip.id}|GitHub (clone)`, `${pip.id}|hub_clone_repo`]);
    expect(alerts.find((alert) => alert.rule === 'sidekick.post_outside_job')).toMatchObject({ severity: 'low', sidekick_id: pip.id });
  });

  it('alerts on repeated failed sign-ins from one address and on rate-limit bursts', async () => {
    for (let i = 0; i < 12; i++) await hub.app.inject({ url: '/v1/rooms', headers: { authorization: `Bearer ach_${'x'.repeat(32)}`, 'x-forwarded-for': '203.0.113.7' }, remoteAddress: '127.0.0.1' });
    const limiter = vi.spyOn(hub.services.limiter, 'check');
    for (let i = 0; i < 21; i++) {
      limiter.mockReturnValueOnce({ allowed: false, retryAfterMs: 1000 });
      await hub.app.inject({ url: '/v1/rooms', headers: auth(alice.token) });
    }
    limiter.mockRestore();
    await hub.services.security!.scan();
    const alerts = hub.services.security!.alerts(null, {}) as Array<Record<string, unknown>>;
    expect(alerts.find((alert) => alert.rule === 'auth.failures')).toMatchObject({ subject: '203.0.113.7', severity: 'medium', count: 12 });
    expect(alerts.find((alert) => alert.rule === 'ratelimit.burst')).toMatchObject({ subject: alice.agent.id, actor_id: alice.agent.id, workspace_id: legacy });
  });
});

describe('who can see and acknowledge alerts', () => {
  beforeEach(() => setup());

  it('shows the operator every workspace, a supervisor only theirs, and nobody else anything', async () => {
    const monitor = hub.services.security!;
    const mine = monitor.raise({ rule: 'test.rule', subject: 'a', severity: 'medium', title: 'Legacy alert', detail: 'x', workspace_id: legacy })!;
    const theirs = monitor.raise({ rule: 'test.rule', subject: 'b', severity: 'high', title: 'Client alert', detail: 'y', workspace_id: client })!;
    const global = monitor.raise({ rule: 'test.rule', subject: 'c', severity: 'high', title: 'Hub alert', detail: 'z' })!;
    const ids = async (token: string, query = '', extra: Record<string, string> = {}) => (await hub.app.inject({ url: `/v1/security/alerts${query}`, headers: auth(token, extra) })).json().alerts.map((alert: { id: string }) => alert.id).sort();

    expect(await ids(operator)).toEqual([mine.id, theirs.id, global.id].sort());
    expect(await ids(operator, `?workspace=${client}`)).toEqual([theirs.id]);
    expect(await ids(supervisor.token)).toEqual([mine.id]);
    expect(await ids(otherLead.token)).toEqual([theirs.id]);
    expect((await hub.app.inject({ url: `/v1/security/alerts?workspace=${client}`, headers: auth(supervisor.token) })).statusCode).toBe(404);
    for (const token of [alice.token, observer.token]) {
      for (const url of ['/v1/security/summary', '/v1/security/traffic', '/v1/security/alerts']) expect((await hub.app.inject({ url, headers: auth(token) })).statusCode).toBe(403);
      expect((await hub.app.inject({ method: 'POST', url: `/v1/security/alerts/${mine.id}/ack`, headers: auth(token) })).statusCode).toBe(403);
    }
    const pip = await makeSidekick();
    expect((await hub.app.inject({ url: '/v1/security/alerts', headers: auth(pip.token) })).statusCode).toBe(403);
    expect((await hub.app.inject({ url: '/v1/security/alerts' })).statusCode).toBe(401);
    expect((await hub.app.inject({ url: '/v1/security/alerts?status=bogus', headers: auth(operator) })).statusCode).toBe(400);

    // A supervisor cannot acknowledge another workspace's alert or a hub-wide one; the operator can.
    expect((await hub.app.inject({ method: 'POST', url: `/v1/security/alerts/${theirs.id}/ack`, headers: auth(supervisor.token) })).statusCode).toBe(404);
    expect((await hub.app.inject({ method: 'POST', url: `/v1/security/alerts/${global.id}/ack`, headers: auth(supervisor.token) })).statusCode).toBe(404);
    const acked = await hub.app.inject({ method: 'POST', url: `/v1/security/alerts/${mine.id}/ack`, headers: auth(supervisor.token) });
    expect(acked.json().alert).toMatchObject({ id: mine.id, acknowledged_by: supervisor.agent.id });
    expect((await hub.app.inject({ method: 'POST', url: `/v1/security/alerts/${global.id}/ack`, headers: auth(operator) })).statusCode).toBe(200);
    const audit = hub.services.db.prepare("SELECT actor_id, target_id, payload FROM events WHERE type = 'security.alert.acknowledged' ORDER BY id").all() as Array<{ actor_id: string; target_id: string; payload: string }>;
    expect(audit.map((row) => row.target_id)).toEqual([mine.id, global.id]);
    expect(JSON.parse(audit[1]!.payload)).toMatchObject({ alert_id: global.id, alert_workspace_id: null });
    expect(await ids(supervisor.token)).toEqual([]);
    expect(await ids(supervisor.token, '?status=all')).toEqual([mine.id]);

    // The same condition again opens a new alert after acknowledgement, and bumps it while open.
    const again = monitor.raise({ rule: 'test.rule', subject: 'a', severity: 'medium', title: 'Legacy alert', detail: 'x', workspace_id: legacy })!;
    expect(again.id).not.toBe(mine.id);
    expect(monitor.raise({ rule: 'test.rule', subject: 'a', severity: 'medium', title: 'Legacy alert', detail: 'x', workspace_id: legacy, n: 3 })).toMatchObject({ id: again.id, count: 4 });

    const summary = (await hub.app.inject({ url: '/v1/security/summary?window=1h', headers: auth(operator) })).json();
    expect(summary).toMatchObject({ scope: { all_workspaces: true }, allowed: 0, denied: 0, alerts_open: { high: 1, medium: 1 } });
    expect(summary.status).toMatchObject({ enabled: true, gate: { container: 'ach-egress-gate-8796', network: 'ach-sealed-8796' } });
    expect((await hub.app.inject({ url: '/v1/security/summary', headers: auth(supervisor.token) })).json().alerts_open).toEqual({ low: 0, medium: 1, high: 0 });
  });

  it('pushes new alerts live to the operator and to the workspace\'s supervisors only', async () => {
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address() as { port: number };
    const connect = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`);
      const frames: Array<Record<string, unknown>> = [];
      socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
      await once(socket, 'open');
      socket.send(JSON.stringify({ t: 'hello', token }));
      for (let i = 0; i < 100 && !frames.some((frame) => frame.t === 'hello.ok'); i++) await new Promise((r) => setTimeout(r, 10));
      return { socket, frames };
    };
    const op = await connect(operator); const lead = await connect(supervisor.token); const other = await connect(otherLead.token); const agent = await connect(alice.token);
    hub.services.security!.raise({ rule: 'test.rule', subject: 'live', severity: 'high', title: 'Client alert', detail: 'y', workspace_id: client });
    await new Promise((r) => setTimeout(r, 100));
    const got = (c: { frames: Array<Record<string, unknown>> }) => c.frames.filter((frame) => frame.t === 'security.alert').length;
    expect([got(op), got(lead), got(other), got(agent)]).toEqual([1, 0, 1, 0]);
    for (const c of [op, lead, other, agent]) c.socket.close();
  });
});

describe('schema upgrade to version 8', () => {
  it('adds the security tables to a version-7 database after copying it', async () => {
    await setup();
    const { readFileSync, readdirSync } = await import('node:fs');
    const { default: Database } = await import('better-sqlite3');
    const { LEGACY_SCHEMA, SCHEMA_VERSION, openDb } = await import('../src/db.js');
    const path = join(dir, 'upgrade', 'hub.sqlite');
    openDb(path).close();
    rmSync(path); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    const old = new Database(path);
    old.exec(LEGACY_SCHEMA);
    for (const file of ['001-workspaces.sql', '002-oauth-mcp.sql', '003-invites.sql', '004-sidekicks.sql', '005-sidekick-codex.sql', '006-room-rules.sql', '007-sidekick-live.sql']) {
      old.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    }
    expect(old.pragma('user_version', { simple: true })).toBe(7);
    old.close();
    const upgraded = openDb(path);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'security_%' ORDER BY name").all()).toEqual([{ name: 'security_alerts' }, { name: 'security_state' }, { name: 'security_traffic' }]);
    upgraded.close();
    expect(readdirSync(join(dir, 'upgrade')).filter((name) => name.includes('.pre-security-'))).toHaveLength(1);
  });
});

describe('outbound alert hook', () => {
  it('accepts only https addresses', async () => {
    await setup();
    const config = (url?: string) => loadConfig({ HUB_DATA_DIR: dataDir, HUB_WORKSPACES_DIR: workspacesDir, ...(url ? { HUB_SECURITY_WEBHOOK_URL: url } : {}) }).security.webhookUrl;
    expect(config('http://example.test/hook')).toBeNull();
    expect(config('https://user:pw@example.test/hook')).toBeNull();
    expect(config()).toBeNull();
    expect(config('https://hooks.example.test/a')).toBe('https://hooks.example.test/a');
  });

  it('posts a minimal notice for new high-severity alerts, rate-limited', async () => {
    await setup({ HUB_SECURITY_WEBHOOK_URL: 'https://hooks.example.test/security' });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    let now = Date.now();
    const monitor = new SecurityMonitor(hub.services, { fetch: fetcher as unknown as typeof fetch, now: () => now, docker: fakeDocker({ members: [], log: [] }).runner });
    monitor.raise({ rule: 'test.rule', subject: 'one', severity: 'medium', title: 'Not urgent', detail: 'secret-detail', workspace_id: legacy });
    const first = monitor.raise({ rule: 'test.rule', subject: 'two', severity: 'high', title: 'Urgent', detail: 'secret-detail from pastebin.com', workspace_id: legacy })!;
    monitor.raise({ rule: 'test.rule', subject: 'three', severity: 'high', title: 'Also urgent', detail: 'secret-detail' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.example.test/security');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ source: 'agent-collab-hub', title: 'Urgent', severity: 'high', count: 1 });
    expect(String(init.body)).not.toContain('secret-detail');
    expect((hub.services.db.prepare('SELECT notified_at FROM security_alerts WHERE id = ?').get(first.id) as { notified_at: string | null }).notified_at).not.toBeNull();
    now += 31_000;
    monitor.raise({ rule: 'test.rule', subject: 'four', severity: 'high', title: 'Later', detail: 'z' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
