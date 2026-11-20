// Security monitor for the hub operator.
//
// - Reads the egress gate's decision log (`docker logs` with a timestamp cursor), works out which
//   container made each request (sealed-network membership from `docker network inspect`, kept
//   current by `docker events`, with the gate's reverse-DNS name as a fallback for containers that
//   are already gone) and stores it aggregated per source, destination and minute. Host names only.
// - Runs alert rules over that traffic and over the hub's own event log (refusals, failed sign-ins,
//   rate limits), deduplicating by rule and subject.
// - Serves it to the operator (every workspace) and to supervisors (their own workspace).
//
// Everything degrades to "unavailable" when Docker or the gate is absent; nothing here can stop a
// request or break the event spine.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DbHandle, EventRow } from './db.js';
import type { EventInput } from './events.js';
import type { HubServices } from './types.js';

// ---------- shared helpers ----------

/**
 * Where a request came from, for grouping failed sign-ins. Behind the local tunnel the socket is
 * loopback and the tunnel's own (last) forwarding entry is the client; otherwise the socket address.
 */
export function requestSource(request: { ip?: string; headers: IncomingHttpHeaders; socket?: { remoteAddress?: string | undefined } }): string {
  const clean = (value: string) => (value.toLowerCase().startsWith('::ffff:') ? value.slice(7) : value);
  const socketIp = clean(String(request.ip ?? request.socket?.remoteAddress ?? ''));
  if (socketIp === '127.0.0.1' || socketIp === '::1') {
    const last = String(request.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() ?? '';
    if (last && net.isIP(clean(last))) return clean(last);
  }
  return net.isIP(socketIp) ? socketIp : 'unknown';
}

/** Appends a security event without ever failing the request that caused it. */
export function securityEvent(svc: Pick<HubServices, 'db' | 'events'>, input: EventInput): void {
  try { svc.events.append(input); } catch { /* the audit trail must not break the refusal itself */ }
}

// ---------- gate log parsing ----------

export type GateProfile = 'packages' | 'github' | 'sidekick';
export interface GateEntry {
  at: string; profile: GateProfile; decision: 'allow' | 'deny' | 'close' | 'listening'; kind: 'connect' | 'http' | 'hub' | 'none';
  host: string; port: number | null; reason: string | null; client: string | null; peer: string | null;
  bytes_up: number; bytes_down: number; duration_ms: number;
}
const PROFILES = new Set(['packages', 'github', 'sidekick']);
const DECISIONS = new Set(['allow', 'deny', 'close', 'listening']);
const KINDS = new Set(['connect', 'http', 'hub']);
const DOCKER_TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) (.*)$/;
const amount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 1e13) : 0);

/** Parses one gate line (optionally prefixed by Docker's timestamp). Anything malformed is dropped. */
export function parseGateLine(raw: string): { ts: string | null; entry: GateEntry } | null {
  const stamped = DOCKER_TS.exec(raw.trim());
  const ts = stamped?.[1] ?? null;
  const text = stamped ? stamped[2]! : raw.trim();
  if (!text.startsWith('{') || text.length > 4096) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!value || typeof value !== 'object' || !PROFILES.has(String(value.profile)) || !DECISIONS.has(String(value.decision))) return null;
  const atMs = Date.parse(String(value.at ?? ts ?? ''));
  if (!Number.isFinite(atMs)) return null;
  const host = typeof value.host === 'string' && /^[a-z0-9.:[\]-]{1,260}$/i.test(value.host) ? value.host.toLowerCase() : 'invalid';
  const port = Number.isInteger(value.port) && (value.port as number) >= 0 && (value.port as number) <= 65535 ? value.port as number : null;
  const client = typeof value.client === 'string' && net.isIP(value.client) ? value.client : null;
  const peer = typeof value.peer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.peer) ? value.peer : null;
  return { ts, entry: {
    at: new Date(atMs).toISOString(), profile: value.profile as GateProfile, decision: value.decision as GateEntry['decision'],
    kind: KINDS.has(String(value.kind)) ? value.kind as GateEntry['kind'] : 'none', host, port,
    reason: typeof value.reason === 'string' && /^[a-z_]{1,20}$/.test(value.reason) ? value.reason : null,
    client, peer, bytes_up: amount(value.bytes_up), bytes_down: amount(value.bytes_down), duration_ms: amount(value.duration_ms),
  } };
}

// ---------- which container is behind an address ----------

export interface ContainerRecord { id: string; name: string; ip: string | null; labels: Record<string, string>; from: number; until: number | null }

/** Sealed-network membership over time, so an address that is reused later is not misattributed. */
export class ContainerDirectory {
  private readonly records: ContainerRecord[] = [];
  private static readonly SLACK_MS = 5_000;

  upsert(record: ContainerRecord): void {
    const existing = this.records.find((item) => item.id === record.id && item.until === null);
    if (existing) {
      existing.name = record.name || existing.name; existing.labels = Object.keys(record.labels).length ? record.labels : existing.labels;
      if (record.ip) existing.ip = record.ip;
      existing.from = Math.min(existing.from, record.from);
      return;
    }
    this.records.push({ ...record });
    if (this.records.length > 5000) this.records.splice(0, this.records.length - 5000);
  }
  gone(id: string, at: number): void {
    for (const record of this.records) if (record.id === id && record.until === null) record.until = at;
  }
  known(id: string): boolean { return this.records.some((record) => record.id === id && record.until === null); }
  current(): ContainerRecord[] { return this.records.filter((record) => record.until === null); }
  /** The container that held this address at that moment, if any. */
  lookup(ip: string | null, atMs: number): ContainerRecord | null {
    if (!ip) return null;
    let best: ContainerRecord | null = null;
    for (const record of this.records) {
      if (record.ip !== ip) continue;
      if (record.from - ContainerDirectory.SLACK_MS > atMs) continue;
      if (record.until !== null && record.until + ContainerDirectory.SLACK_MS < atMs) continue;
      if (!best || record.from > best.from) best = record;
    }
    return best;
  }
}

export interface Source {
  key: string; kind: string; recognised: boolean; client_ip: string | null; container_id: string | null; container_name: string | null;
  workspace_id: string | null; room_id: string | null; sidekick_id: string | null;
}

// ---------- docker access ----------

export interface DockerResult { code: number | null; stdout: string; stderr: string }
export type DockerRunner = (args: string[], timeoutMs?: number) => Promise<DockerResult>;
export type DockerStreamer = (args: string[], onLine: (line: string) => void, onExit: () => void) => { stop(): void };

const MAX_OUTPUT = 16 * 1024 * 1024;
export const runDocker: DockerRunner = (args, timeoutMs = 30_000) => new Promise((resolve) => {
  let proc: ChildProcessWithoutNullStreams;
  try { proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { resolve({ code: null, stdout: '', stderr: '' }); return; }
  proc.stdin.end();
  let stdout = ''; let stderr = '';
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  proc.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8'); });
  proc.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8'); });
  proc.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout, stderr }); });
  proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
export const streamDocker: DockerStreamer = (args, onLine, onExit) => {
  let proc: ChildProcessWithoutNullStreams | null = null;
  try { proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { setImmediate(onExit); return { stop() {} }; }
  proc.stdin.end();
  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) onLine(line); }
    if (buffer.length > 1024 * 1024) buffer = '';
  });
  proc.stderr.resume();
  proc.on('error', () => onExit());
  proc.on('close', () => onExit());
  return { stop() { proc?.kill('SIGTERM'); proc = null; } };
};

// ---------- the monitor ----------

export type Severity = 'low' | 'medium' | 'high';
export interface AlertRow {
  id: string; rule: string; subject: string; severity: Severity; workspace_id: string | null; room_id: string | null; actor_id: string | null;
  sidekick_id: string | null; title: string; detail: string; count: number; first_seen: string; last_seen: string;
  acknowledged_at: string | null; acknowledged_by: string | null; notified_at: string | null;
}
export interface RaiseInput {
  rule: string; subject: string; severity: Severity; title: string; detail: string; at?: string; n?: number;
  workspace_id?: string | null; room_id?: string | null; actor_id?: string | null; sidekick_id?: string | null;
  /** For standing conditions: after a person acknowledges, stay quiet this long. */
  quietAfterAckMs?: number;
  /** Only mark an open alert as still current; keep its count and detail. */
  touch?: boolean;
}
export interface MonitorOptions {
  docker?: DockerRunner;
  stream?: DockerStreamer;
  fetch?: typeof fetch;
  now?: () => number;
}
export interface MonitorStatus {
  enabled: boolean; monitoring: boolean; docker: boolean | null;
  gate: { container: string; network: string; running: boolean | null; network_ok: boolean | null; started_at: string | null };
  last_scan_at: string | null; last_read_at: string | null; last_error: string | null; live_membership: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };
const REASONS: Record<string, string> = {
  host: 'that site is not on its allowlist', port: 'only HTTPS on port 443 is allowed', address: 'that name points at a private or local address',
};
const KIND_LABEL: Record<string, string> = {
  sidekick: 'A sidekick', install: 'A dependency install', git: 'A GitHub step', exec: 'A workspace command', room: 'A workspace container',
  dev: 'A dev server', sandbox: 'A workspace container', unknown: 'An unrecognised container',
};
const MINUTE = 60_000; const HOUR = 60 * MINUTE; const DAY = 24 * HOUR;
const ALERT_EVENTS = ['auth.denied', 'ratelimit.hit', 'devserver.preview.denied', 'sidekick.tool.denied', 'sidekick.people_only.denied', 'sidekick.post.denied'];

export class SecurityMonitor extends EventEmitter {
  readonly directory = new ContainerDirectory();
  private readonly docker: DockerRunner;
  private readonly stream: DockerStreamer;
  private readonly fetcher: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly owner: string;
  private readonly network: string;
  private readonly gateName: string;
  private timer: NodeJS.Timeout | null = null;
  private watcher: { stop(): void } | null = null;
  private watcherRestart: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;
  private stopped = false;
  private lastRetention = 0;
  private notices: number[] = [];
  private state: MonitorStatus;

  constructor(private readonly svc: HubServices, options: MonitorOptions = {}) {
    super();
    this.setMaxListeners(50);
    this.docker = options.docker ?? runDocker;
    this.stream = options.stream ?? streamDocker;
    this.fetcher = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    this.now = options.now ?? Date.now;
    // The same owner label the sandbox service puts on every container it starts.
    this.owner = createHash('sha256').update(path.resolve(svc.config.workspacesDir)).digest('hex').slice(0, 24);
    this.network = svc.egress?.network ?? `ach-sealed-${svc.config.port}`;
    this.gateName = svc.egress?.container ?? `ach-egress-gate-${svc.config.port}`;
    this.state = { enabled: svc.config.egress.enabled, monitoring: false, docker: null,
      gate: { container: this.gateName, network: this.network, running: null, network_ok: null, started_at: null },
      last_scan_at: null, last_read_at: null, last_error: null, live_membership: false };
    // Rules start from the present; earlier history is not replayed as new alerts.
    if (this.getState('events.cursor') === null) this.setState('events.cursor', String(svc.events.lastId()));
  }

  // ---------- lifecycle ----------
  start(): void {
    if (this.timer || !this.svc.config.security.monitor) return;
    this.stopped = false;
    this.state.monitoring = true;
    if (this.state.enabled) this.watch();
    this.timer = setInterval(() => { void this.scan().catch(() => undefined); }, this.svc.config.security.intervalMs);
    this.timer.unref();
    setTimeout(() => { if (!this.stopped) void this.scan().catch(() => undefined); }, 1_000).unref();
  }
  stop(): void {
    this.stopped = true;
    this.state.monitoring = false;
    if (this.timer) clearInterval(this.timer);
    if (this.watcherRestart) clearTimeout(this.watcherRestart);
    this.timer = null; this.watcherRestart = null;
    this.watcher?.stop(); this.watcher = null;
  }

  status(): MonitorStatus { return { ...this.state, gate: { ...this.state.gate } }; }

  /** One collection and rule pass; concurrent callers share it. */
  scan(): Promise<void> {
    this.scanning ??= this.runScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async runScan(): Promise<void> {
    if (this.state.enabled) {
      try { await this.refreshMembership(); await this.readGateLog(); }
      catch { this.state.last_error = 'Could not read the gate'; }
    }
    try { this.eventRules(); this.volumeRule(); this.retention(); }
    catch { this.state.last_error = 'The alert rules could not run'; }
    this.state.last_scan_at = new Date(this.now()).toISOString();
  }

  // ---------- sealed-network membership ----------
  private watch(): void {
    if (this.stopped || this.watcher) return;
    this.watcher = this.stream(['events', '--filter', 'type=network', '--filter', `network=${this.network}`, '--format', '{{json .}}'],
      (line) => { void this.onDockerEvent(line); },
      () => {
        this.watcher = null; this.state.live_membership = false;
        if (!this.stopped) { this.watcherRestart = setTimeout(() => { this.watcherRestart = null; this.watch(); }, 30_000); this.watcherRestart.unref(); }
      });
    this.state.live_membership = true;
  }

  private async onDockerEvent(line: string): Promise<void> {
    let event: { Action?: string; Actor?: { Attributes?: Record<string, string> }; timeNano?: number; time?: number };
    try { event = JSON.parse(line) as typeof event; } catch { return; }
    const attributes = event.Actor?.Attributes ?? {};
    const container = attributes.container;
    if (attributes.name !== this.network || !container || !/^[a-f0-9]{12,64}$/.test(container)) return;
    const at = event.timeNano ? Math.floor(event.timeNano / 1e6) : event.time ? event.time * 1000 : this.now();
    if (event.Action === 'disconnect') { this.directory.gone(container, at); return; }
    if (event.Action === 'connect') {
      const [record] = await this.inspect([container]);
      if (record) this.directory.upsert({ ...record, from: Math.min(record.from, at) });
    }
  }

  /** Inspects containers for their name, labels, start time and sealed-network address. */
  private async inspect(ids: string[]): Promise<ContainerRecord[]> {
    if (!ids.length) return [];
    const result = await this.docker(['inspect', '--type', 'container', '--format', '{{json .Id}}\t{{json .Name}}\t{{json .State.StartedAt}}\t{{json .Config.Labels}}\t{{json .NetworkSettings.Networks}}', ...ids]);
    const records: ContainerRecord[] = [];
    for (const line of result.stdout.split('\n')) {
      const parts = line.split('\t');
      if (parts.length !== 5) continue;
      try {
        const id = JSON.parse(parts[0]!) as string;
        const name = String(JSON.parse(parts[1]!) ?? '').replace(/^\//, '');
        const started = Date.parse(String(JSON.parse(parts[2]!)));
        const labels = (JSON.parse(parts[3]!) ?? {}) as Record<string, string>;
        const networks = (JSON.parse(parts[4]!) ?? {}) as Record<string, { IPAddress?: string }>;
        const ip = networks[this.network]?.IPAddress;
        if (!/^[a-f0-9]{64}$/.test(id)) continue;
        records.push({ id, name, labels, ip: ip && net.isIP(ip) ? ip : null, from: Number.isFinite(started) && started > 0 ? started : this.now(), until: null });
      } catch { /* skip */ }
    }
    return records;
  }

  async refreshMembership(): Promise<void> {
    const inspected = await this.docker(['network', 'inspect', '--format', '{{json .Containers}}', this.network]);
    if (inspected.code === null) { this.state.docker = false; this.state.gate.network_ok = null; this.state.gate.running = null; return; }
    this.state.docker = true;
    const gate = await this.docker(['inspect', '--type', 'container', '--format', '{{.State.Running}} {{json .State.StartedAt}}', this.gateName]);
    const [running, started] = gate.stdout.trim().split(' ');
    this.state.gate.running = gate.code === 0 && running === 'true';
    try { this.state.gate.started_at = gate.code === 0 && started ? String(JSON.parse(started)) : null; } catch { this.state.gate.started_at = null; }
    if (inspected.code !== 0) {
      // No sealed network yet: nothing has needed the internet, so the gate is not expected to run.
      this.state.gate.network_ok = false;
      for (const record of this.directory.current()) this.directory.gone(record.id, this.now());
      return;
    }
    this.state.gate.network_ok = true;
    let members: Record<string, { Name?: string; IPv4Address?: string }> = {};
    try { members = (JSON.parse(inspected.stdout.trim() || 'null') ?? {}) as typeof members; } catch { members = {}; }
    const ids = Object.keys(members).filter((id) => /^[a-f0-9]{64}$/.test(id));
    const fresh = ids.filter((id) => !this.directory.known(id));
    for (const record of await this.inspect(fresh)) {
      if (!record.ip) record.ip = members[record.id]?.IPv4Address?.split('/')[0] ?? null;
      this.directory.upsert(record);
    }
    const present = new Set(ids);
    for (const record of this.directory.current()) if (!present.has(record.id)) this.directory.gone(record.id, this.now());

    const at = new Date(this.now()).toISOString();
    if (!this.state.gate.running) {
      this.raise({ rule: 'gate.down', subject: this.gateName, severity: 'high', at, n: 0, touch: true, quietAfterAckMs: HOUR,
        title: 'The egress gate is not running',
        detail: `The sealed network ${this.network} exists but its gate (${this.gateName}) is not running, so installs, GitHub steps and sidekicks cannot reach the internet and their traffic is not being logged. The hub restarts it the next time something needs it; check Docker if this persists.` });
    }
    // Every container on the sealed network should be one the hub started.
    for (const record of this.directory.current()) {
      const source = this.identify(record, null, record.ip);
      if (source.recognised) continue;
      this.raise({ rule: 'sealed.unrecognised', subject: source.key, severity: 'high', at, n: 0, touch: true, quietAfterAckMs: DAY,
        title: 'Unrecognised container on the sealed network',
        detail: `Container ${record.name || record.id.slice(0, 12)} (${record.ip ?? 'no address'}) is attached to ${this.network} but was not started by this hub. Anything on this network can use the gate.` });
    }
  }

  // ---------- reading the gate's log ----------
  async readGateLog(): Promise<number> {
    const cursor = this.getState('gate.cursor');
    const since = cursor ?? new Date(this.now() - DAY).toISOString();
    const result = await this.docker(['logs', '--timestamps', '--since', since, this.gateName], 60_000);
    if (result.code !== 0) {
      if (result.code !== null && this.state.gate.running) this.state.last_error = 'Could not read the gate log';
      return 0;
    }
    this.state.last_read_at = new Date(this.now()).toISOString();
    this.state.last_error = null;
    return this.ingest(result.stdout, cursor);
  }

  /** Stores a batch of gate lines and runs the traffic rules. Returns the number of lines stored. */
  ingest(text: string, cursor: string | null = this.getState('gate.cursor')): number {
    const seenAtCursor = new Set((this.getState('gate.cursor.seen') ?? '').split('\n').filter(Boolean));
    let lastTs = cursor; let lastSeen = new Set(seenAtCursor);
    const denies = new Map<string, { input: RaiseInput; n: number }>();
    let stored = 0;
    const upsert = this.svc.db.prepare(`INSERT INTO security_traffic (agg_key, bucket, first_at, last_at, profile, decision, kind, host, port, reason, source_key, source_kind,
        client_ip, container_id, container_name, workspace_id, room_id, sidekick_id, count, bytes_up, bytes_down, duration_ms)
      VALUES (@agg_key, @bucket, @at, @at, @profile, @decision, @kind, @host, @port, @reason, @source_key, @source_kind,
        @client_ip, @container_id, @container_name, @workspace_id, @room_id, @sidekick_id, @count, @bytes_up, @bytes_down, @duration_ms)
      ON CONFLICT(agg_key) DO UPDATE SET count = count + excluded.count, bytes_up = bytes_up + excluded.bytes_up, bytes_down = bytes_down + excluded.bytes_down,
        duration_ms = duration_ms + excluded.duration_ms, first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at)`);
    this.svc.db.transaction(() => {
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        const parsed = parseGateLine(raw);
        const ts = parsed?.ts ?? null;
        if (ts && cursor) {
          if (ts < cursor) continue;
          if (ts === cursor && seenAtCursor.has(digest(raw))) continue;
        }
        if (ts) {
          if (ts !== lastTs) { lastTs = ts; lastSeen = new Set(); }
          lastSeen.add(digest(raw));
        }
        if (!parsed) continue;
        const { entry } = parsed;
        if (entry.decision === 'listening') { this.state.gate.started_at ??= entry.at; continue; }
        const atMs = Date.parse(entry.at);
        const close = entry.decision === 'close';
        const openedAt = new Date(close ? atMs - entry.duration_ms : atMs).toISOString();
        const source = this.attribute(entry, atMs);
        const decision = close ? 'allow' : entry.decision;
        const bucket = openedAt.slice(0, 16);
        upsert.run({
          agg_key: [bucket, source.key, entry.profile, decision, entry.kind, entry.host, entry.port ?? '', entry.reason ?? ''].join('|'),
          bucket, at: close ? openedAt : entry.at, profile: entry.profile, decision, kind: entry.kind, host: entry.host, port: entry.port, reason: entry.reason,
          source_key: source.key, source_kind: source.kind, client_ip: source.client_ip, container_id: source.container_id, container_name: source.container_name,
          workspace_id: source.workspace_id, room_id: source.room_id, sidekick_id: source.sidekick_id,
          count: close ? 0 : 1, bytes_up: entry.bytes_up, bytes_down: entry.bytes_down, duration_ms: entry.duration_ms,
        });
        stored += 1;
        if (source.kind === 'unattributed') continue;
        if (!source.recognised && source.kind !== 'gate') {
          const key = `unrecognised|${source.key}`;
          const existing = denies.get(key);
          if (existing) existing.n += close ? 0 : 1;
          else denies.set(key, { n: close ? 0 : 1, input: { rule: 'sealed.unrecognised', subject: source.key, severity: 'high', at: entry.at, quietAfterAckMs: DAY,
            title: 'Unrecognised container on the sealed network',
            detail: `${source.container_name ? `Container ${source.container_name}` : `An unknown client at ${source.client_ip ?? 'an unknown address'}`} used the gate (${entry.profile} profile), most recently ${decision === 'deny' ? 'trying' : 'reaching'} ${entry.host}. It was not started by this hub.` } });
        } else if (decision === 'deny' && source.kind !== 'gate') {
          const key = `deny|${source.key}|${entry.host}`;
          const existing = denies.get(key);
          const who = KIND_LABEL[source.kind] ?? 'A container';
          const what = entry.kind === 'http' ? 'plain HTTP goes only to the hub\'s own MCP endpoint' : REASONS[entry.reason ?? ''] ?? 'the gate refused it';
          if (existing) existing.n += 1;
          else denies.set(key, { n: 1, input: { rule: 'egress.denied', subject: `${source.key}|${entry.host}`, severity: source.kind === 'sidekick' ? 'high' : 'medium', at: entry.at,
            workspace_id: source.workspace_id, room_id: source.room_id, sidekick_id: source.sidekick_id,
            title: `${who} tried to reach a blocked address`,
            detail: `${who}${source.container_name ? ` (${source.container_name})` : ''} on the ${entry.profile} profile was refused ${entry.host}${entry.port ? `:${entry.port}` : ''}: ${what}.${source.kind === 'sidekick' ? ' A sidekick reaching for other sites can be a sign of a prompt-injection attempt.' : ''}` } });
        }
      }
      if (lastTs) { this.setState('gate.cursor', lastTs); this.setState('gate.cursor.seen', [...lastSeen].slice(-500).join('\n')); }
    })();
    for (const { input, n } of denies.values()) this.raise({ ...input, n });
    return stored;
  }

  /** Which container (and so which room, sidekick and workspace) a gate line came from. */
  attribute(entry: Pick<GateEntry, 'client' | 'peer'>, atMs: number): Source {
    const record = this.directory.lookup(entry.client, atMs);
    if (record) return this.identify(record, entry.peer, entry.client);
    if (entry.peer) return this.fromName(entry.peer, null, entry.client);
    // Lines from a gate older than this monitor carry no client address: stored, never alerted on.
    if (!entry.client) return { ...this.unknown(null, null, null), key: 'unattributed', kind: 'unattributed' };
    return this.unknown(entry.client, null, null);
  }

  private unknown(ip: string | null, id: string | null, name: string | null): Source {
    return { key: id ? `ctr:${id.slice(0, 12)}` : name ? `name:${name}` : `ip:${ip ?? 'unknown'}`, kind: 'unknown', recognised: false,
      client_ip: ip, container_id: id, container_name: name, workspace_id: null, room_id: null, sidekick_id: null };
  }

  identify(record: ContainerRecord, peer: string | null, ip: string | null): Source {
    const { db } = this.svc;
    const labels = record.labels ?? {};
    const base = { client_ip: ip, container_id: record.id, container_name: record.name || peer };
    if (record.name === this.gateName && labels['io.agent-collab-hub.egress-gate']) {
      return { ...base, key: 'gate', kind: 'gate', recognised: true, workspace_id: null, room_id: null, sidekick_id: null };
    }
    const sidekickId = labels['ach.sidekick'];
    if (sidekickId && /^skk_[a-f0-9]{16}$/.test(sidekickId)) {
      const row = db.prepare('SELECT workspace_id FROM sidekicks WHERE id = ?').get(sidekickId) as { workspace_id: string } | undefined;
      if (row && record.name === `ach-sidekick-${sidekickId}`) return { ...base, key: `sidekick:${sidekickId}`, kind: 'sidekick', recognised: true, workspace_id: row.workspace_id, room_id: null, sidekick_id: sidekickId };
      return this.unknown(ip, record.id, record.name || peer);
    }
    const roomId = labels['io.agent-collab-hub.room'];
    if (roomId) {
      const room = /^room_[a-f0-9]{16}$/.test(roomId) ? db.prepare('SELECT workspace_id FROM rooms WHERE id = ?').get(roomId) as { workspace_id: string } | undefined : undefined;
      if (!room || labels['io.agent-collab-hub.owner'] !== this.owner) return this.unknown(ip, record.id, record.name || peer);
      const kind = /^[a-z]{1,20}$/.test(labels['io.agent-collab-hub.kind'] ?? '') ? labels['io.agent-collab-hub.kind']! : 'sandbox';
      const exec = /^ach-(?:install|git|exec)-(exec_[a-f0-9]{16})$/.exec(record.name)?.[1];
      return { ...base, key: exec ? `name:${record.name}` : `ctr:${record.id.slice(0, 12)}`, kind, recognised: true, workspace_id: room.workspace_id, room_id: roomId, sidekick_id: null };
    }
    return this.unknown(ip, record.id, record.name || peer);
  }

  /** For a container that is already gone: the hub's own naming scheme, checked against its records. */
  fromName(name: string, id: string | null, ip: string | null): Source {
    const { db } = this.svc;
    const base = { client_ip: ip, container_id: id, container_name: name };
    const sidekick = /^ach-sidekick-(skk_[a-f0-9]{16})$/.exec(name)?.[1];
    if (sidekick) {
      const row = db.prepare('SELECT workspace_id FROM sidekicks WHERE id = ?').get(sidekick) as { workspace_id: string } | undefined;
      if (row) return { ...base, key: `sidekick:${sidekick}`, kind: 'sidekick', recognised: true, workspace_id: row.workspace_id, room_id: null, sidekick_id: sidekick };
    }
    const step = /^ach-(install|git|exec)-(exec_[a-f0-9]{16})$/.exec(name);
    if (step) {
      const row = db.prepare('SELECT r.id AS room_id, r.workspace_id FROM execs e JOIN sandboxes s ON s.id = e.sandbox_id JOIN rooms r ON r.id = s.room_id WHERE e.id = ?').get(step[2]) as { room_id: string; workspace_id: string } | undefined;
      // The step's record is written when it finishes; until then the name alone says it is the hub's.
      return { ...base, key: `name:${name}`, kind: step[1]!, recognised: true, workspace_id: row?.workspace_id ?? null, room_id: row?.room_id ?? null, sidekick_id: null };
    }
    const room = /^ach-sbx-(room_[a-f0-9]{16})$/.exec(name)?.[1];
    if (room) {
      const row = db.prepare('SELECT workspace_id FROM rooms WHERE id = ?').get(room) as { workspace_id: string } | undefined;
      if (row) return { ...base, key: `name:${name}`, kind: 'room', recognised: true, workspace_id: row.workspace_id, room_id: room, sidekick_id: null };
    }
    const dev = /^ach-dev-(sbx_[a-f0-9]{16})$/.exec(name)?.[1];
    if (dev) {
      const row = db.prepare('SELECT r.id AS room_id, r.workspace_id FROM sandboxes s JOIN rooms r ON r.id = s.room_id WHERE s.id = ?').get(dev) as { room_id: string; workspace_id: string } | undefined;
      if (row) return { ...base, key: `name:${name}`, kind: 'dev', recognised: true, workspace_id: row.workspace_id, room_id: row.room_id, sidekick_id: null };
    }
    if (name === this.gateName) return { ...base, key: 'gate', kind: 'gate', recognised: true, workspace_id: null, room_id: null, sidekick_id: null };
    return this.unknown(ip, id, name);
  }

  // ---------- rules over the hub's own events ----------
  eventRules(): void {
    const { db } = this.svc;
    let cursor = Number(this.getState('events.cursor') ?? 0);
    const placeholders = ALERT_EVENTS.map(() => '?').join(', ');
    const select = db.prepare(`SELECT * FROM events WHERE id > ? AND type IN (${placeholders}) ORDER BY id ASC LIMIT 2000`);
    const lastId = this.svc.events.lastId();
    let drained = false;
    for (let round = 0; round < 10 && !drained; round++) {
      const rows = select.all(cursor, ...ALERT_EVENTS) as EventRow[];
      if (rows.length) { this.applyEventRules(rows); cursor = rows.at(-1)!.id; }
      drained = rows.length < 2000;
    }
    // Once caught up, skip past the unrelated events too; otherwise resume where this pass stopped.
    this.setState('events.cursor', String(drained ? Math.max(cursor, lastId) : cursor));
  }

  private applyEventRules(rows: EventRow[]): void {
    const { db } = this.svc;
    const payload = (row: EventRow): Record<string, unknown> => { try { return JSON.parse(row.payload) as Record<string, unknown>; } catch { return {}; } };
    const text = (value: unknown, max = 80) => (typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '');
    const bursts = new Map<string, { type: string; source: string; n: number; last: EventRow }>();
    for (const row of rows) {
      const p = payload(row);
      if (row.type === 'auth.denied' || row.type === 'devserver.preview.denied' || row.type === 'ratelimit.hit') {
        const source = row.type === 'ratelimit.hit' ? (row.actor_id ?? text(p.source, 64)) : text(p.source, 64) || 'unknown';
        const key = `${row.type}|${source}`;
        const entry = bursts.get(key) ?? { type: row.type, source, n: 0, last: row };
        entry.n += 1; entry.last = row; bursts.set(key, entry);
      } else if (row.type === 'sidekick.tool.denied' || row.type === 'sidekick.people_only.denied') {
        const sidekick = text(p.sidekick_id, 40);
        const tool = row.type === 'sidekick.people_only.denied' ? `GitHub (${text(p.action, 30) || 'github'})` : text(p.tool, 64) || 'a tool';
        const name = this.agentName(row.actor_id);
        this.raise({ rule: 'sidekick.refused', subject: `${sidekick || row.actor_id}|${tool}`, severity: 'medium', at: row.created_at,
          workspace_id: row.workspace_id, actor_id: row.actor_id, sidekick_id: sidekick || null,
          title: 'A sidekick asked for something it is not allowed to do',
          detail: `${name} tried to use ${tool}, which sidekicks cannot use. The hub refused it. Repeated attempts can mean the sidekick was told to by something it read.` });
      } else if (row.type === 'sidekick.post.denied' && p.code === 'SIDEKICK_NOT_WORKING') {
        const sidekick = text(p.sidekick_id, 40);
        this.raise({ rule: 'sidekick.post_outside_job', subject: sidekick || row.actor_id || 'unknown', severity: 'low', at: row.created_at,
          workspace_id: row.workspace_id, actor_id: row.actor_id, sidekick_id: sidekick || null,
          title: 'A sidekick identity posted outside a job',
          detail: `${this.agentName(row.actor_id)}'s hub identity tried to post while it was not working on a job. Its sidekick only posts during a job, so something else may be using that identity.` });
      }
    }
    const now = this.now();
    const windowCount = (type: string, source: string, sinceMs: number): number => {
      const since = new Date(now - sinceMs).toISOString();
      if (type === 'ratelimit.hit' && /^agt_[a-f0-9]{16}$/.test(source)) {
        return (db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at >= ? AND actor_id = ?').get(type, since, source) as { n: number }).n;
      }
      return (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at >= ? AND COALESCE(json_extract(payload, '$.source'), 'unknown') = ?").get(type, since, source) as { n: number }).n;
    };
    let authTotal = 0;
    for (const burst of bursts.values()) {
      const at = burst.last.created_at;
      if (burst.type === 'auth.denied') {
        authTotal += burst.n;
        const n = windowCount('auth.denied', burst.source, 10 * MINUTE);
        if (n >= 10) this.raise({ rule: 'auth.failures', subject: burst.source, severity: n >= 50 ? 'high' : 'medium', at, n: burst.n,
          title: 'Repeated failed sign-ins from one address',
          detail: `${n} requests with a missing, wrong or revoked credential came from ${burst.source} in the last 10 minutes. Someone may be guessing tokens or using an old one.` });
      } else if (burst.type === 'ratelimit.hit') {
        const n = windowCount('ratelimit.hit', burst.source, 5 * MINUTE);
        const actor = /^agt_[a-f0-9]{16}$/.test(burst.source) ? burst.source : null;
        if (n >= 20) this.raise({ rule: 'ratelimit.burst', subject: burst.source, severity: 'medium', at, n: burst.n,
          workspace_id: burst.last.workspace_id, actor_id: actor,
          title: 'Rate limit hit repeatedly',
          detail: `${actor ? this.agentName(actor) : burst.source} hit the hub's rate limit ${n} times in the last 5 minutes. A runaway script or agent loop is the usual cause.` });
      } else {
        const n = windowCount('devserver.preview.denied', burst.source, 10 * MINUTE);
        if (n >= 20) this.raise({ rule: 'preview.denied', subject: burst.source, severity: 'low', at, n: burst.n,
          title: 'Repeated refused preview requests',
          detail: `${n} preview requests from ${burst.source} were refused in the last 10 minutes (expired, revoked or missing preview links).` });
      }
    }
    if (authTotal) {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'auth.denied' AND created_at >= ?").get(new Date(now - 10 * MINUTE).toISOString()) as { n: number }).n;
      if (n >= 100) this.raise({ rule: 'auth.failures', subject: 'all sources', severity: 'high', n: authTotal,
        title: 'Many failed sign-ins across the hub',
        detail: `${n} requests with a missing, wrong or revoked credential in the last 10 minutes, from any address.` });
    }
  }

  /** Data leaving: more than the configured amount sent out by one source in the last hour. */
  volumeRule(): void {
    const limit = this.svc.config.security.egressUpBytesPerHour;
    const since = new Date(this.now() - HOUR).toISOString();
    const rows = this.svc.db.prepare(`SELECT source_key, source_kind, MAX(container_name) AS container_name, MAX(workspace_id) AS workspace_id, MAX(room_id) AS room_id,
        MAX(sidekick_id) AS sidekick_id, SUM(bytes_up) AS up, GROUP_CONCAT(DISTINCT CASE WHEN bytes_up > 0 THEN host END) AS hosts
      FROM security_traffic WHERE last_at >= ? AND source_kind != 'gate' GROUP BY source_key HAVING SUM(bytes_up) > ?`).all(since, limit) as
      Array<{ source_key: string; source_kind: string; container_name: string | null; workspace_id: string | null; room_id: string | null; sidekick_id: string | null; up: number; hosts: string }>;
    for (const row of rows) {
      const who = KIND_LABEL[row.source_kind] ?? 'A container';
      this.raise({ rule: 'egress.volume', subject: row.source_key, severity: 'high', n: 0, quietAfterAckMs: HOUR,
        workspace_id: row.workspace_id, room_id: row.room_id, sidekick_id: row.sidekick_id,
        title: 'Unusual amount of data sent out',
        detail: `${who}${row.container_name ? ` (${row.container_name})` : ''} sent ${(row.up / 1024 / 1024).toFixed(1)} MB out through the gate in the last hour (to ${String(row.hosts ?? 'unknown').split(',').slice(0, 5).join(', ')}). Uploads this large are unusual for installs and sidekicks.` });
    }
  }

  retention(force = false): void {
    if (!force && this.now() - this.lastRetention < 10 * MINUTE) return;
    this.lastRetention = this.now();
    const { db } = this.svc;
    const { retentionDays, maxRows } = this.svc.config.security;
    db.prepare('DELETE FROM security_traffic WHERE last_at < ?').run(new Date(this.now() - retentionDays * DAY).toISOString());
    db.prepare('DELETE FROM security_traffic WHERE id <= (SELECT id FROM security_traffic ORDER BY id DESC LIMIT 1 OFFSET ?)').run(maxRows);
    db.prepare('DELETE FROM security_alerts WHERE acknowledged_at IS NOT NULL AND last_seen < ?').run(new Date(this.now() - 90 * DAY).toISOString());
    db.prepare(`DELETE FROM security_alerts WHERE acknowledged_at IS NOT NULL AND id IN (SELECT id FROM security_alerts WHERE acknowledged_at IS NOT NULL
      ORDER BY last_seen DESC LIMIT -1 OFFSET 5000)`).run();
  }

  // ---------- alerts ----------
  /** Opens an alert, or bumps the open one for the same rule and subject. */
  raise(input: RaiseInput): AlertRow | null {
    const { db } = this.svc;
    const at = input.at ?? new Date(this.now()).toISOString();
    const n = input.n ?? 1;
    const subject = input.subject.slice(0, 300);
    const open = db.prepare('SELECT * FROM security_alerts WHERE rule = ? AND subject = ? AND acknowledged_at IS NULL').get(input.rule, subject) as AlertRow | undefined;
    if (open && input.touch) {
      db.prepare('UPDATE security_alerts SET last_seen = max(last_seen, ?) WHERE id = ?').run(at, open.id);
      return open;
    }
    if (open) {
      const severity = SEVERITY_RANK[input.severity] > SEVERITY_RANK[open.severity] ? input.severity : open.severity;
      if (n === 0 && open.detail === input.detail && severity === open.severity) return open;
      db.prepare('UPDATE security_alerts SET count = count + ?, last_seen = max(last_seen, ?), detail = ?, severity = ? WHERE id = ?').run(n, at, input.detail.slice(0, 1000), severity, open.id);
      const updated = db.prepare('SELECT * FROM security_alerts WHERE id = ?').get(open.id) as AlertRow;
      if (n > 0) this.emit('alert', { alert: updated, created: false });
      return updated;
    }
    if (input.quietAfterAckMs) {
      const recent = db.prepare('SELECT 1 FROM security_alerts WHERE rule = ? AND subject = ? AND acknowledged_at >= ?')
        .get(input.rule, subject, new Date(this.now() - input.quietAfterAckMs).toISOString());
      if (recent) return null;
    }
    const row: AlertRow = { id: `sal_${randomBytes(8).toString('hex')}`, rule: input.rule, subject, severity: input.severity,
      workspace_id: input.workspace_id ?? null, room_id: input.room_id ?? null, actor_id: input.actor_id ?? null, sidekick_id: input.sidekick_id ?? null,
      title: input.title.slice(0, 200), detail: input.detail.slice(0, 1000), count: Math.max(1, n), first_seen: at, last_seen: at,
      acknowledged_at: null, acknowledged_by: null, notified_at: null };
    db.prepare(`INSERT INTO security_alerts (id, rule, subject, severity, workspace_id, room_id, actor_id, sidekick_id, title, detail, count, first_seen, last_seen)
      VALUES (@id, @rule, @subject, @severity, @workspace_id, @room_id, @actor_id, @sidekick_id, @title, @detail, @count, @first_seen, @last_seen)`).run(row);
    this.emit('alert', { alert: row, created: true });
    if (row.severity === 'high') void this.notify(row);
    return row;
  }

  /** Posts a minimal high-severity notice to the operator's https hook, at most 20 an hour. */
  async notify(alert: AlertRow): Promise<boolean> {
    const url = this.svc.config.security.webhookUrl;
    if (!url || !this.fetcher) return false;
    const now = this.now();
    this.notices = this.notices.filter((at) => now - at < HOUR);
    if (this.notices.length >= 20 || (this.notices.length && now - this.notices.at(-1)! < 30_000)) return false;
    this.notices.push(now);
    try {
      const response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'agent-collab-hub', title: alert.title, severity: alert.severity, rule: alert.rule, count: alert.count,
          first_seen: alert.first_seen, last_seen: alert.last_seen, open_alerts: this.openCount(null) }) });
      if (!response.ok) return false;
      this.svc.db.prepare('UPDATE security_alerts SET notified_at = ? WHERE id = ?').run(new Date(now).toISOString(), alert.id);
      return true;
    } catch { return false; }
  }

  private openCount(workspace: string | null): number {
    return (this.svc.db.prepare('SELECT COUNT(*) AS n FROM security_alerts WHERE acknowledged_at IS NULL AND (@w IS NULL OR workspace_id = @w)').get({ w: workspace }) as { n: number }).n;
  }

  acknowledge(scope: string | null, id: string, actorId: string): AlertRow | null {
    const { db } = this.svc;
    const row = db.prepare('SELECT * FROM security_alerts WHERE id = @id AND (@w IS NULL OR workspace_id = @w)').get({ id, w: scope }) as AlertRow | undefined;
    if (!row) return null;
    if (row.acknowledged_at) return row;
    const at = new Date(this.now()).toISOString();
    db.prepare('UPDATE security_alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND acknowledged_at IS NULL').run(at, actorId, id);
    securityEvent(this.svc, { type: 'security.alert.acknowledged', actor_id: actorId, target_id: id,
      payload: { alert_id: id, rule: row.rule, severity: row.severity, alert_workspace_id: row.workspace_id } });
    return db.prepare('SELECT * FROM security_alerts WHERE id = ?').get(id) as AlertRow;
  }

  // ---------- queries ----------
  summary(scope: string | null, windowMs: number) {
    const { db } = this.svc;
    const since = new Date(this.now() - windowMs).toISOString();
    const where = 'last_at >= @since AND (@w IS NULL OR workspace_id = @w)';
    const params = { since, w: scope };
    const totals = db.prepare(`SELECT decision, SUM(count) AS requests, SUM(bytes_up) AS bytes_up, SUM(bytes_down) AS bytes_down FROM security_traffic WHERE ${where} GROUP BY decision`).all(params) as
      Array<{ decision: string; requests: number; bytes_up: number; bytes_down: number }>;
    const pick = (decision: string) => totals.find((row) => row.decision === decision);
    return {
      window: { since, ms: windowMs },
      allowed: pick('allow')?.requests ?? 0, denied: pick('deny')?.requests ?? 0,
      bytes_up: (pick('allow')?.bytes_up ?? 0) + (pick('deny')?.bytes_up ?? 0), bytes_down: (pick('allow')?.bytes_down ?? 0) + (pick('deny')?.bytes_down ?? 0),
      by_profile: db.prepare(`SELECT profile, SUM(CASE WHEN decision = 'allow' THEN count ELSE 0 END) AS allowed, SUM(CASE WHEN decision = 'deny' THEN count ELSE 0 END) AS denied,
        SUM(bytes_up) AS bytes_up, SUM(bytes_down) AS bytes_down FROM security_traffic WHERE ${where} GROUP BY profile ORDER BY profile`).all(params),
      top_destinations: db.prepare(`SELECT host, SUM(CASE WHEN decision = 'allow' THEN count ELSE 0 END) AS allowed, SUM(CASE WHEN decision = 'deny' THEN count ELSE 0 END) AS denied,
        SUM(bytes_up) AS bytes_up, SUM(bytes_down) AS bytes_down FROM security_traffic WHERE ${where} GROUP BY host ORDER BY allowed + denied DESC, host LIMIT 15`).all(params),
      top_sources: db.prepare(`SELECT t.source_key, t.source_kind, MAX(t.container_name) AS container_name, MAX(t.workspace_id) AS workspace_id, MAX(t.room_id) AS room_id, MAX(t.sidekick_id) AS sidekick_id,
        MAX(r.name) AS room_name, MAX(a.name) AS sidekick_name,
        SUM(CASE WHEN t.decision = 'allow' THEN t.count ELSE 0 END) AS allowed, SUM(CASE WHEN t.decision = 'deny' THEN t.count ELSE 0 END) AS denied,
        SUM(t.bytes_up) AS bytes_up, SUM(t.bytes_down) AS bytes_down
        FROM security_traffic t LEFT JOIN rooms r ON r.id = t.room_id LEFT JOIN sidekicks s ON s.id = t.sidekick_id LEFT JOIN agents a ON a.id = s.agent_id
        WHERE t.last_at >= @since AND (@w IS NULL OR t.workspace_id = @w) GROUP BY t.source_key ORDER BY denied DESC, allowed DESC LIMIT 15`).all(params),
      alerts_open: db.prepare(`SELECT severity, COUNT(*) AS n FROM security_alerts WHERE acknowledged_at IS NULL AND (@w IS NULL OR workspace_id = @w) GROUP BY severity`).all({ w: scope })
        .reduce((acc: Record<Severity, number>, row) => { const r = row as { severity: Severity; n: number }; acc[r.severity] = r.n; return acc; }, { low: 0, medium: 0, high: 0 }),
      status: this.status(),
    };
  }

  traffic(scope: string | null, filter: TrafficFilter) {
    const rows = this.svc.db.prepare(`SELECT t.id, t.bucket, t.first_at, t.last_at, t.profile, t.decision, t.kind, t.host, t.port, t.reason, t.source_key, t.source_kind,
        t.client_ip, t.container_name, t.workspace_id, w.name AS workspace_name, t.room_id, r.name AS room_name, t.sidekick_id, a.name AS sidekick_name,
        t.count, t.bytes_up, t.bytes_down, t.duration_ms
      FROM security_traffic t LEFT JOIN workspaces w ON w.id = t.workspace_id LEFT JOIN rooms r ON r.id = t.room_id
        LEFT JOIN sidekicks s ON s.id = t.sidekick_id LEFT JOIN agents a ON a.id = s.agent_id
      WHERE t.last_at >= @since AND (@w IS NULL OR t.workspace_id = @w) AND (@room IS NULL OR t.room_id = @room) AND (@sidekick IS NULL OR t.sidekick_id = @sidekick)
        AND (@profile IS NULL OR t.profile = @profile) AND (@decision IS NULL OR t.decision = @decision) AND (@kind IS NULL OR t.source_kind = @kind)
        AND (@host IS NULL OR t.host = @host)
      ORDER BY t.last_at DESC, t.id DESC LIMIT @limit`).all({
      since: filter.since ?? new Date(this.now() - DAY).toISOString(), w: scope, room: filter.room ?? null, sidekick: filter.sidekick ?? null,
      profile: filter.profile ?? null, decision: filter.decision ?? null, kind: filter.source_kind ?? null, host: filter.host ?? null, limit: filter.limit ?? 200,
    });
    return rows;
  }

  alerts(scope: string | null, filter: { status?: 'open' | 'acknowledged' | 'all' | undefined; severity?: Severity | undefined; limit?: number | undefined }) {
    const status = filter.status ?? 'open';
    return this.svc.db.prepare(`SELECT al.*, w.name AS workspace_name, r.name AS room_name, a.name AS actor_name
      FROM security_alerts al LEFT JOIN workspaces w ON w.id = al.workspace_id LEFT JOIN rooms r ON r.id = al.room_id LEFT JOIN agents a ON a.id = al.actor_id
      WHERE (@w IS NULL OR al.workspace_id = @w) AND (@severity IS NULL OR al.severity = @severity)
        AND (@status = 'all' OR (@status = 'open' AND al.acknowledged_at IS NULL) OR (@status = 'acknowledged' AND al.acknowledged_at IS NOT NULL))
      ORDER BY al.acknowledged_at IS NOT NULL, CASE al.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, al.last_seen DESC LIMIT @limit`)
      .all({ w: scope, severity: filter.severity ?? null, status, limit: filter.limit ?? 200 });
  }

  // ---------- small helpers ----------
  private agentName(id: string | null): string {
    if (!id) return 'Someone';
    return (this.svc.db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'Someone';
  }
  private getState(key: string): string | null {
    return (this.svc.db.prepare('SELECT value FROM security_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  private setState(key: string, value: string): void {
    this.svc.db.prepare('INSERT INTO security_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

const digest = (line: string) => createHash('sha256').update(line).digest('hex').slice(0, 16);

export interface TrafficFilter {
  since?: string | undefined; room?: string | undefined; sidekick?: string | undefined; profile?: GateProfile | undefined; decision?: 'allow' | 'deny' | undefined;
  source_kind?: string | undefined; host?: string | undefined; limit?: number | undefined; workspace?: string | undefined;
}

// ---------- routes ----------

const WINDOWS: Record<string, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const workspaceParam = z.string().regex(/^wks_[a-f0-9]{16}$/).optional();
const summaryQuery = z.object({ window: z.enum(['1h', '24h', '7d', '30d']).default('24h'), workspace: workspaceParam }).strict();
const trafficQuery = z.object({
  workspace: workspaceParam,
  room: z.string().regex(/^room_[a-f0-9]{16}$/).optional(),
  sidekick: z.string().regex(/^skk_[a-f0-9]{16}$/).optional(),
  profile: z.enum(['packages', 'github', 'sidekick']).optional(),
  decision: z.enum(['allow', 'deny']).optional(),
  source_kind: z.string().regex(/^[a-z]{1,20}$/).optional(),
  host: z.string().regex(/^[a-z0-9.:[\]-]{1,260}$/i).transform((value) => value.toLowerCase()).optional(),
  since: z.string().datetime().optional(),
  window: z.enum(['1h', '24h', '7d', '30d']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
}).strict();
const alertsQuery = z.object({
  workspace: workspaceParam, status: z.enum(['open', 'acknowledged', 'all']).default('open'), severity: z.enum(['low', 'medium', 'high']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
}).strict();
const alertParams = z.object({ id: z.string().regex(/^sal_[a-f0-9]{16}$/) }).strict();

export function registerSecurityRoutes(app: FastifyInstance, svc: HubServices, monitor: SecurityMonitor): void {
  const guard = svc.requireRole(['supervisor']);
  /** The operator sees every workspace (or one it names); a supervisor only their own. */
  function scope(request: FastifyRequest, reply: FastifyReply, requested: string | undefined): { workspace: string | null } | null {
    const agent = request.auth!.agent;
    const flags = svc.db.prepare('SELECT a.guest, EXISTS (SELECT 1 FROM sidekicks s WHERE s.agent_id = a.id) AS sidekick FROM agents a WHERE a.id = ?').get(agent.id) as { guest: number; sidekick: number } | undefined;
    if (!flags || flags.guest || flags.sidekick) { void reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Security monitoring is for the hub operator and supervisors' } }); return null; }
    if (request.auth!.operator) {
      if (requested && !svc.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(requested)) { void reply.code(404).send({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } }); return null; }
      return { workspace: requested ?? null };
    }
    if (requested && requested !== agent.workspace_id) { void reply.code(404).send({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } }); return null; }
    return { workspace: agent.workspace_id };
  }
  const invalid = (reply: FastifyReply, message: string) => reply.code(400).send({ error: { code: 'INVALID_QUERY', message } });

  app.get('/v1/security/summary', { preHandler: guard }, async (request, reply) => {
    const query = summaryQuery.safeParse(request.query ?? {});
    if (!query.success) return invalid(reply, 'window must be 1h, 24h, 7d or 30d; optional workspace');
    const visible = scope(request, reply, query.data.workspace);
    if (!visible) return;
    return { scope: { workspace_id: visible.workspace, all_workspaces: visible.workspace === null }, ...monitor.summary(visible.workspace, WINDOWS[query.data.window]!) };
  });

  app.get('/v1/security/traffic', { preHandler: guard }, async (request, reply) => {
    const query = trafficQuery.safeParse(request.query ?? {});
    if (!query.success) return invalid(reply, 'Invalid traffic filter');
    const visible = scope(request, reply, query.data.workspace);
    if (!visible) return;
    const { window, since, ...filter } = query.data;
    const from = since ?? (window ? new Date(Date.now() - WINDOWS[window]!).toISOString() : undefined);
    return { traffic: monitor.traffic(visible.workspace, { ...filter, ...(from ? { since: new Date(from).toISOString() } : {}) }) };
  });

  app.get('/v1/security/alerts', { preHandler: guard }, async (request, reply) => {
    const query = alertsQuery.safeParse(request.query ?? {});
    if (!query.success) return invalid(reply, 'Invalid alert filter');
    const visible = scope(request, reply, query.data.workspace);
    if (!visible) return;
    const { workspace: _workspace, ...filter } = query.data;
    return { alerts: monitor.alerts(visible.workspace, filter) };
  });

  app.post('/v1/security/alerts/:id/ack', { preHandler: guard }, async (request, reply) => {
    const params = alertParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid alert id' } });
    const visible = scope(request, reply, undefined);
    if (!visible) return;
    const alert = monitor.acknowledge(visible.workspace, params.data.id, request.auth!.agent.id);
    if (!alert) return reply.code(404).send({ error: { code: 'ALERT_NOT_FOUND', message: 'Alert not found' } });
    return { alert };
  });

  /** Reads the gate now instead of waiting for the next pass. */
  app.post('/v1/security/refresh', { preHandler: guard }, async (request, reply) => {
    const visible = scope(request, reply, undefined);
    if (!visible) return;
    if (!svc.limiter.check(`security-refresh:${request.auth!.agent.id}`, 10).allowed) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Wait a few seconds before refreshing again' } });
    await monitor.scan();
    return { status: monitor.status() };
  });
}
