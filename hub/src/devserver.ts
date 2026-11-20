/**
 * Live development server for a room's shared workspace, plus the preview origin that shows it.
 *
 * One companion container per sandbox (`ach-dev-<sandboxId>`) runs the room's dev command with the
 * same hardening as every sandbox container: same image and workspace, `--network none`, read-only
 * root, no capabilities, memory/cpu/pids limits and the hub's ownership labels. Because the
 * container has no network, the hub reaches the server through `docker exec -i <container> python3
 * <relay> <port>`: the relay connects to the port on the container's own loopback and pipes bytes
 * over the exec's stdin/stdout. Node's HTTP client runs over that pipe (`createConnection`), so
 * ordinary HTTP/1.1 and WebSocket upgrades (Vite HMR) work without giving the sandbox a network.
 *
 * Sandbox pages are untrusted and the hub web app keeps bearer tokens in browser storage, so
 * previews are never served on the hub's origin. They are served by a separate listener (its own
 * port, therefore its own origin). A room member mints a short-lived single-use ticket through the
 * authenticated API; the preview origin exchanges it for an HttpOnly session cookie scoped to that
 * origin. Every proxied request re-checks that the identity still holds an unrevoked credential and
 * can still read the room. Only hashes of tickets and sessions are kept, in memory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DbHandle, SandboxRow } from './db.js';
import type { EventBus } from './events.js';
import { SandboxError, checkCommandPolicy, isSandboxError, sandboxPath, type SandboxService } from './sandbox.js';
import { canReadRoom } from './access.js';
import { activeAgent } from './auth.js';
import { isLocalRequest, readOperator } from './operator.js';
import { TokenBucketLimiter } from './ratelimit.js';
import { requestSource, securityEvent } from './security.js';
import type { Agent, HubServices } from './types.js';

const KIND = 'dev';
export const DEFAULT_DEV_CMD = 'npm run dev';
export const DEFAULT_DEV_PORT = 5173;
const TICKET_TTL_MS = 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const COOKIE = 'ach_preview';
export const TICKET_PARAM = '__ach_preview_ticket';
const MAX_RELAYS_PER_SANDBOX = 32;
const FETCH_BODY_LIMIT = 64 * 1024;
const LOG_DEFAULT_BYTES = 8 * 1024;
const LOG_MAX_BYTES = 64 * 1024;
const MAX_TICKETS = 2_000;
const MAX_SESSIONS = 5_000;

// PID 1 of the dev container. The command's output goes to a tmpfs log (sandbox containers use
// `--log-driver none`); the log is trimmed so it cannot fill /tmp. When the command ends, its exit
// code is recorded and the container stays up so the log can still be read.
const WRAPPER = String.raw`
log=/tmp/dev.log
: > "$log"
mkdir -p /tmp/home && export HOME=/tmp/home
if ! cd "/workspace/$DEV_DIR" 2>/dev/null; then
  printf 'Folder not found in the workspace: %s\n' "$DEV_DIR" >> "$log"
  echo 127 > /tmp/dev.exit
  exec sleep infinity
fi
( sh -lc "$DEV_CMD" >> "$log" 2>&1 < /dev/null; code=$?; printf '\n[the command stopped with exit code %s]\n' "$code" >> "$log"; echo "$code" > /tmp/dev.exit ) &
while [ ! -e /tmp/dev.exit ]; do
  sleep 2
  if [ "$(wc -c < "$log")" -gt 2097152 ]; then tail -c 262144 "$log" > /tmp/dev.trim && cat /tmp/dev.trim > "$log"; rm -f /tmp/dev.trim; fi
done
exec sleep infinity
`;

// Exit marker, log tail and whether anything listens on the port, in one exec.
const STATUS_PY = String.raw`
import json, socket, sys
port, limit = int(sys.argv[1]), int(sys.argv[2])
out = {'exit_code': None, 'listening': False, 'log': '', 'log_truncated': False}
try:
    with open('/tmp/dev.exit') as f: out['exit_code'] = int(f.read().strip() or '0')
except (OSError, ValueError): pass
try:
    with open('/tmp/dev.log', 'rb') as f:
        f.seek(0, 2); size = f.tell(); f.seek(max(0, size - limit)); data = f.read(limit)
    out['log'] = data.decode('utf-8', 'replace'); out['log_truncated'] = size > limit
except OSError: pass
for host in ('127.0.0.1', '::1'):
    try:
        socket.create_connection((host, port), timeout=1).close(); out['listening'] = True; break
    except OSError: pass
print(json.dumps(out))
`;

// Connects to the dev server on the container's own loopback and pipes the exec's stdio to it.
const RELAY_PY = String.raw`
import os, socket, sys, threading
port = int(sys.argv[1])
conn = None
for host in ('127.0.0.1', '::1'):
    try:
        conn = socket.create_connection((host, port), timeout=5); break
    except OSError: conn = None
if conn is None:
    sys.exit(3)
conn.settimeout(None)
# The hub never half-closes: end of input means its side is gone, so close the connection and exit
# rather than leave a process behind in the container.
def upstream():
    try:
        while True:
            data = os.read(0, 65536)
            if not data: break
            conn.sendall(data)
    except OSError: pass
    try: conn.close()
    except OSError: pass
    os._exit(0)
threading.Thread(target=upstream, daemon=True).start()
out = sys.stdout.buffer
try:
    while True:
        data = conn.recv(65536)
        if not data: break
        out.write(data); out.flush()
except OSError: pass
`;

export type DevServerState = 'stopped' | 'starting' | 'running' | 'exited';

export interface DevServerStatus {
  sandbox_id: string;
  state: DevServerState;
  cmd: string;
  dir: string;
  port: number;
  started_at: string | null;
  started_by: string | null;
  exit_code: number | null;
  listening: boolean;
  log: string;
  log_truncated: boolean;
}

export interface DevServerStartInput { cmd?: string | undefined; port?: number | undefined; dir?: string | undefined; }

export interface DevServerFetchResult {
  path: string;
  status: number;
  content_type: string | null;
  location: string | null;
  body: string | null;
  bytes: number;
  truncated: boolean;
  duration_ms: number;
}

export interface PreviewAccess {
  enabled: boolean;
  /** True when this caller can open the preview origin. */
  reachable: boolean;
  /** Set when previews only work in a browser on the hub's own machine. */
  local_only: boolean;
  message: string | null;
}

interface DevRecord {
  sandboxId: string;
  roomId: string;
  containerId: string;
  cmd: string;
  dir: string;
  port: number;
  startedAt: string | null;
  startedBy: string | null;
  exitReported: boolean;
}

interface Grant { sandboxId: string; roomId: string; agentId: string; operatorHash: string | null; expires: number; }

export interface DevServerConfig {
  /** Preview listener port, or null when previews are disabled. */
  port: number | null;
  host: string;
  publicUrl: string | null;
}

export interface DevServerDeps {
  db: DbHandle;
  events: EventBus;
  sandbox: SandboxService;
  dataDir: string;
  preview: DevServerConfig;
  log?: { warn(message: string): void };
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const stripAnsi = (text: string) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '');
const containerName = (sandboxId: string) => `ach-dev-${sandboxId}`;

/** A child process's stdio presented as a socket, so Node's HTTP client can speak through it. */
class ExecSocket extends Duplex {
  constructor(private readonly child: ChildProcess) {
    super({ allowHalfOpen: false });
    const stdout = child.stdout!;
    stdout.on('data', (chunk: Buffer) => { if (!this.push(chunk)) stdout.pause(); });
    stdout.on('end', () => this.push(null));
    child.stdin!.on('error', () => {});
    child.on('error', (error) => this.destroy(error));
    child.on('close', () => { this.push(null); });
  }
  override _read(): void { this.child.stdout?.resume(); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.child.stdin || this.child.stdin.destroyed) { callback(new Error('relay closed')); return; }
    this.child.stdin.write(chunk, callback);
  }
  override _final(callback: (error?: Error | null) => void): void { this.child.stdin?.end(); callback(); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    // Closing our ends of the pipes also ends the relay's input, so it exits inside the container.
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    callback(error);
  }
  // The parts of net.Socket the HTTP client calls.
  setKeepAlive(): this { return this; }
  setNoDelay(): this { return this; }
  setTimeout(_ms: number, callback?: () => void): this { if (callback) this.once('timeout', callback); return this; }
  ref(): this { return this; }
  unref(): this { return this; }
  get remoteAddress(): string { return '127.0.0.1'; }
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Plain-language status page served by the preview origin itself. */
function page(res: http.ServerResponse, status: number, title: string, message: string): void {
  if (res.headersSent) { res.destroy(); return; }
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1d2433}
main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#4a5468}
@media (prefers-color-scheme:dark){body{background:#14171d;color:#e7eaf0}p{color:#a9b1c1}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** Drops the preview session cookie from the header the dev server receives. */
function withoutSessionCookie(header: string | undefined): string | null {
  const kept = (header ?? '').split(';').map((part) => part.trim()).filter((part) => part && part.split('=')[0]!.trim() !== COOKIE);
  return kept.length ? kept.join('; ') : null;
}

/** Response headers from the dev server, minus hop-by-hop ones and any attempt to set our cookie. */
function responseHeaders(raw: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]!, value = raw[index + 1]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'set-cookie' && value.split('=')[0]!.trim() === COOKIE) continue;
    out.push(name, value);
  }
  return out;
}

export class DevServerService {
  private readonly records = new Map<string, DevRecord>();
  private readonly lastSettings = new Map<string, { cmd: string; dir: string; port: number }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly tickets = new Map<string, Grant>();
  private readonly sessions = new Map<string, Grant>();
  private readonly relays = new Map<string, number>();
  private readonly limiter = new TokenBucketLimiter({ capacity: 2_000, refillPerSecond: 200 });
  private readonly invalidLimiter = new TokenBucketLimiter({ capacity: 30, refillPerSecond: 0.5 });
  /** Bounds how many refusal records one address can write. */
  private readonly deniedLimiter = new TokenBucketLimiter({ capacity: 30, refillPerSecond: 0.2 });
  private server: http.Server | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DevServerDeps) {
    // Stopping the sandbox stops its dev server first.
    deps.sandbox.onSandboxStop(async (_roomId, sandboxId) => { await this.stop(sandboxId, null, 'sandbox_stopped'); });
  }

  // ---------------------------------------------------------------- lifecycle

  private serial<T>(sandboxId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sandboxId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.queues.set(sandboxId, current);
    void current.catch(() => {}).finally(() => { if (this.queues.get(sandboxId) === current) this.queues.delete(sandboxId); });
    return current;
  }

  private row(sandboxId: string): SandboxRow {
    const row = this.deps.sandbox.get(sandboxId);
    if (!row) throw new SandboxError('SANDBOX_NOT_FOUND', 404, 'Sandbox not found');
    return row;
  }

  private defaults(sandboxId: string): { cmd: string; dir: string; port: number } {
    return this.lastSettings.get(sandboxId) ?? { cmd: DEFAULT_DEV_CMD, dir: '', port: DEFAULT_DEV_PORT };
  }

  /** In-memory record, or one adopted from a container that survived a hub restart. */
  private async record(row: SandboxRow): Promise<DevRecord | null> {
    const known = this.records.get(row.id);
    if (known) return known;
    const info = await this.deps.sandbox.inspectCompanion(containerName(row.id), row.room_id, KIND);
    if (!info || !info.State.Running) return null;
    const env = new Map((info.Config.Env ?? []).map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
    const port = Number(env.get('PORT'));
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return null;
    const adopted: DevRecord = {
      sandboxId: row.id, roomId: row.room_id, containerId: info.Id, cmd: env.get('DEV_CMD') ?? '', dir: env.get('DEV_DIR') ?? '',
      port, startedAt: info.State.StartedAt ?? null, startedBy: null, exitReported: false,
    };
    this.records.set(row.id, adopted);
    this.lastSettings.set(row.id, { cmd: adopted.cmd, dir: adopted.dir, port });
    return adopted;
  }

  private validate(input: DevServerStartInput): { cmd: string; dir: string; port: number } {
    const cmd = (input.cmd ?? DEFAULT_DEV_CMD).trim();
    if (!cmd || cmd.length > 512 || /[\0\r\n]/.test(cmd)) throw new SandboxError('VALIDATION_ERROR', 400, 'Command must be one line of 1–512 characters');
    const policy = checkCommandPolicy(cmd);
    if (!policy.ok) throw new SandboxError('SANDBOX_CMD_DENIED', 403, policy.reason);
    const port = input.port ?? DEFAULT_DEV_PORT;
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new SandboxError('VALIDATION_ERROR', 400, 'Port must be between 1024 and 65535');
    const dir = input.dir === undefined || input.dir.trim() === '' ? '' : sandboxPath(input.dir.trim());
    if (dir.length > 200) throw new SandboxError('VALIDATION_ERROR', 400, 'Folder path is too long');
    return { cmd, dir, port };
  }

  async start(sandboxId: string, actorId: string, input: DevServerStartInput): Promise<DevServerStatus> {
    const row = this.row(sandboxId);
    this.deps.sandbox.authorizeRoom(row.room_id, actorId, true);
    const settings = this.validate(input);
    // Neither a command nor a folder given: run the app the way the cloned files say to.
    if (input.cmd === undefined && !settings.dir) {
      const plan = this.deps.sandbox.launchPlan(row.room_id, settings.port);
      if (plan && checkCommandPolicy(plan.cmd).ok) { settings.cmd = plan.cmd; settings.dir = sandboxPath(plan.dir); }
    }
    return this.serial(sandboxId, async () => {
      const current = this.row(sandboxId);
      this.deps.sandbox.authorizeRoom(current.room_id, actorId, true);
      if (current.status !== 'running' || !current.container_id) throw new SandboxError('SANDBOX_NOT_RUNNING', 409, 'Set up the workspace before starting a dev server');
      const name = containerName(sandboxId);
      const restarted = this.records.has(sandboxId) || !!(await this.deps.sandbox.inspectCompanion(name, current.room_id, KIND));
      this.records.delete(sandboxId);
      await this.deps.sandbox.removeCompanion(name, current.room_id, KIND);
      this.lastSettings.set(sandboxId, settings);
      const env = { HOST: '0.0.0.0', PORT: String(settings.port), BROWSER: 'none', DEV_CMD: settings.cmd, DEV_DIR: settings.dir };
      const result = await this.deps.sandbox.dockerCommand(
        ['run', '-d', ...this.deps.sandbox.companionArgs(current.room_id, name, KIND, env), current.image, 'sh', '-c', WRAPPER], 60_000, 4_096);
      const containerId = result.stdout.trim();
      if (result.exitCode !== 0 || result.timedOut || !/^[a-f0-9]{12,64}$/.test(containerId)) {
        this.deps.events.append({ type: 'devserver.error', room_id: current.room_id, actor_id: actorId, payload: { sandbox_id: sandboxId, error: 'Dev server container failed to start' } });
        await this.deps.sandbox.removeCompanion(name, current.room_id, KIND).catch(() => {});
        throw new SandboxError('DEVSERVER_START_FAILED', 502, 'Could not start the dev server; inspect local sandbox runtime');
      }
      const record: DevRecord = { sandboxId, roomId: current.room_id, containerId, ...settings, startedAt: new Date().toISOString(), startedBy: actorId, exitReported: false };
      this.records.set(sandboxId, record);
      this.deps.events.append({ type: 'devserver.started', room_id: current.room_id, actor_id: actorId,
        payload: { sandbox_id: sandboxId, cmd: settings.cmd, dir: settings.dir, port: settings.port, restarted } });
      return this.describe(record, 'starting', { exit_code: null, listening: false, log: '', log_truncated: false });
    });
  }

  /** `actorId` null is the hub itself (sandbox stopped, room archived). */
  async stop(sandboxId: string, actorId: string | null, reason = 'requested'): Promise<{ stopped: boolean }> {
    if (actorId) this.deps.sandbox.authorizeRoom(this.row(sandboxId).room_id, actorId, true);
    return this.serial(sandboxId, async () => {
      const row = this.deps.sandbox.get(sandboxId);
      const known = this.records.get(sandboxId);
      const roomId = row?.room_id ?? known?.roomId;
      if (!roomId) return { stopped: false };
      if (actorId) this.deps.sandbox.authorizeRoom(roomId, actorId, true);
      const existing = await this.deps.sandbox.inspectCompanion(containerName(sandboxId), roomId, KIND);
      if (existing) await this.deps.sandbox.removeCompanion(existing.Id, roomId, KIND);
      this.records.delete(sandboxId);
      const stopped = !!(existing || known);
      if (stopped) this.deps.events.append({ type: 'devserver.stopped', room_id: roomId, actor_id: actorId, payload: { sandbox_id: sandboxId, reason } });
      return { stopped };
    });
  }

  private describe(record: DevRecord | null, state: DevServerState, probe: { exit_code: number | null; listening: boolean; log: string; log_truncated: boolean }, sandboxId?: string): DevServerStatus {
    const id = record?.sandboxId ?? sandboxId!;
    const settings = record ?? this.defaults(id);
    return { sandbox_id: id, state, cmd: settings.cmd, dir: settings.dir, port: settings.port, started_at: record?.startedAt ?? null,
      started_by: record?.startedBy ?? null, ...probe };
  }

  private async probe(record: DevRecord, logBytes: number): Promise<{ exit_code: number | null; listening: boolean; log: string; log_truncated: boolean }> {
    const result = await this.deps.sandbox.dockerCommand(
      ['exec', record.containerId, 'timeout', '-k', '1s', '8s', 'python3', '-c', STATUS_PY, String(record.port), String(logBytes)], 12_000, logBytes * 4 + 4_096);
    try {
      const parsed = JSON.parse(result.stdout) as { exit_code: unknown; listening: unknown; log: unknown; log_truncated: unknown };
      return {
        exit_code: typeof parsed.exit_code === 'number' ? parsed.exit_code : null, listening: parsed.listening === true,
        log: typeof parsed.log === 'string' ? stripAnsi(parsed.log) : '', log_truncated: parsed.log_truncated === true,
      };
    } catch {
      return { exit_code: null, listening: false, log: '', log_truncated: false };
    }
  }

  async status(sandboxId: string, actorId: string, logBytes = LOG_DEFAULT_BYTES): Promise<DevServerStatus> {
    const row = this.row(sandboxId);
    this.deps.sandbox.authorizeRoom(row.room_id, actorId, false);
    const bytes = Math.min(Math.max(Math.trunc(logBytes) || 0, 0), LOG_MAX_BYTES);
    const empty = { exit_code: null, listening: false, log: '', log_truncated: false };
    const record = await this.record(row);
    if (!record) return this.describe(null, 'stopped', empty, sandboxId);
    const info = await this.deps.sandbox.inspectCompanion(record.containerId, row.room_id, KIND);
    if (!info || !info.State.Running) {
      // Gone from under us (removed by hand, Docker restarted): forget it.
      this.records.delete(sandboxId);
      await this.deps.sandbox.removeCompanion(containerName(sandboxId), row.room_id, KIND).catch(() => {});
      this.deps.events.append({ type: 'devserver.stopped', room_id: row.room_id, payload: { sandbox_id: sandboxId, reason: 'container_gone' } });
      return this.describe(null, 'stopped', empty, sandboxId);
    }
    const probe = await this.probe(record, Math.max(bytes, 0));
    const state: DevServerState = probe.exit_code !== null ? 'exited' : probe.listening ? 'running' : 'starting';
    if (state === 'exited' && !record.exitReported) {
      record.exitReported = true;
      this.deps.events.append({ type: 'devserver.exited', room_id: row.room_id, payload: { sandbox_id: sandboxId, exit_code: probe.exit_code } });
    }
    return this.describe(record, state, probe);
  }

  // ---------------------------------------------------------------- reaching the server

  private openRelay(record: DevRecord): ExecSocket {
    const open = this.relays.get(record.sandboxId) ?? 0;
    if (open >= MAX_RELAYS_PER_SANDBOX) throw new SandboxError('DEVSERVER_BUSY', 503, 'Too many open preview connections; try again shortly');
    this.relays.set(record.sandboxId, open + 1);
    const child = spawn(this.deps.sandbox.dockerBinary, ['exec', '-i', record.containerId, 'python3', '-c', RELAY_PY, String(record.port)], { stdio: ['pipe', 'pipe', 'ignore'] });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (this.relays.get(record.sandboxId) ?? 1) - 1;
      if (left > 0) this.relays.set(record.sandboxId, left); else this.relays.delete(record.sandboxId);
    };
    child.once('exit', release);
    child.once('error', release);
    return new ExecSocket(child);
  }

  /** GET one path through the dev server, so an agent can check that a page renders or an API answers. */
  async fetchPath(sandboxId: string, actorId: string, path: string): Promise<DevServerFetchResult> {
    const row = this.row(sandboxId);
    this.deps.sandbox.authorizeRoom(row.room_id, actorId, false);
    if (typeof path !== 'string' || path.length > 2_000 || !/^\/(?!\/)[^\s\x00-\x1f\x7f]*$/.test(path)) {
      throw new SandboxError('VALIDATION_ERROR', 400, 'Path must start with a single / and contain no spaces');
    }
    const record = await this.record(row);
    if (!record) throw new SandboxError('DEVSERVER_NOT_RUNNING', 409, 'The dev server is not running; start it first');
    const relay = this.openRelay(record);
    const started = Date.now();
    return new Promise<DevServerFetchResult>((resolve, reject) => {
      const request = http.request({
        method: 'GET', path, createConnection: () => relay as unknown as Socket,
        headers: { host: `localhost:${record.port}`, accept: '*/*', 'user-agent': 'agent-collab-hub-dev-fetch', connection: 'close' },
      });
      const timer = setTimeout(() => request.destroy(new Error('timeout')), 15_000);
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        let total = 0, kept = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (kept < FETCH_BODY_LIMIT) { const part = chunk.subarray(0, FETCH_BODY_LIMIT - kept); chunks.push(part); kept += part.length; }
          if (total > 16 * 1024 * 1024) response.destroy();
        });
        const finish = () => {
          clearTimeout(timer);
          relay.destroy();
          const type = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null;
          const textual = !type || /^(text\/|application\/(json|javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded|[\w.+-]+\+(json|xml))|image\/svg\+xml)/i.test(type);
          const body = Buffer.concat(chunks);
          resolve({
            path, status: response.statusCode ?? 0, content_type: type, location: typeof response.headers.location === 'string' ? response.headers.location : null,
            body: textual ? stripAnsi(new TextDecoder('utf-8').decode(body)) : null, bytes: total, truncated: total > kept, duration_ms: Date.now() - started,
          });
        };
        response.on('end', finish);
        response.on('close', finish);
        response.on('error', finish);
      });
      request.on('error', () => {
        clearTimeout(timer);
        relay.destroy();
        reject(new SandboxError('DEVSERVER_UNREACHABLE', 502, `Nothing answered on port ${record.port} inside the workspace; check the dev server log`));
      });
      request.end();
    });
  }

  // ---------------------------------------------------------------- preview access

  /** Whether the caller (by the headers it reached the hub with) can open the preview origin. */
  previewAccess(headers: http.IncomingHttpHeaders): PreviewAccess {
    const { port, publicUrl } = this.deps.preview;
    if (port === null) return { enabled: false, reachable: false, local_only: false, message: 'Live previews are turned off on this hub.' };
    if (isLocalRequest(headers) || publicUrl) return { enabled: true, reachable: true, local_only: !publicUrl, message: null };
    return { enabled: true, reachable: false, local_only: true,
      message: 'The live preview can only be opened in a browser on the hub’s own computer. Ask the hub operator to set HUB_PREVIEW_PUBLIC_URL to share it.' };
  }

  private previewBase(headers: http.IncomingHttpHeaders): string | null {
    const { port, publicUrl } = this.deps.preview;
    if (port === null) return null;
    if (isLocalRequest(headers)) {
      // Same host name as the hub page, so the browser treats both as one site.
      const host = /^localhost(:\d+)?$/i.test(String(headers.host ?? '')) ? 'localhost' : '127.0.0.1';
      return `http://${host}:${port}`;
    }
    return publicUrl;
  }

  /** A single-use, one-minute link that signs this browser in to the preview origin. */
  ticket(sandboxId: string, agent: Agent, operator: boolean, headers: http.IncomingHttpHeaders, path = '/'): { url: string | null; expires_at: string | null; access: PreviewAccess } {
    const row = this.row(sandboxId);
    this.deps.sandbox.authorizeRoom(row.room_id, agent.id, false);
    const access = this.previewAccess(headers);
    const base = access.reachable ? this.previewBase(headers) : null;
    if (!base) return { url: null, expires_at: null, access };
    if (!/^\/(?!\/)[^\s\x00-\x1f\x7f#]*$/.test(path)) throw new SandboxError('VALIDATION_ERROR', 400, 'Path must start with a single /');
    this.prune();
    if (this.tickets.size >= MAX_TICKETS) throw new SandboxError('RATE_LIMITED', 429, 'Too many preview links; try again shortly');
    const token = randomBytes(32).toString('base64url');
    const expires = Date.now() + TICKET_TTL_MS;
    const operatorHash = operator ? readOperator(this.deps.dataDir)?.token_hash ?? null : null;
    this.tickets.set(sha(token), { sandboxId, roomId: row.room_id, agentId: agent.id, operatorHash, expires });
    const url = new URL(path, base);
    url.searchParams.set(TICKET_PARAM, token);
    return { url: url.toString(), expires_at: new Date(expires).toISOString(), access };
  }

  /** The identity behind a grant must still hold a credential and still be able to read the room. */
  private grantValid(grant: Grant): boolean {
    let agent = activeAgent(this.deps.db, grant.agentId);
    if (!agent && grant.operatorHash && readOperator(this.deps.dataDir)?.token_hash === grant.operatorHash) {
      agent = (this.deps.db.prepare('SELECT id, workspace_id, name, role, created_at, last_seen_at FROM agents WHERE id = ?').get(grant.agentId) as Agent | undefined) ?? null;
    }
    return !!agent && canReadRoom(this.deps.db, agent, grant.roomId);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, grant] of this.tickets) if (grant.expires <= now) this.tickets.delete(key);
    for (const [key, grant] of this.sessions) if (grant.expires <= now) this.sessions.delete(key);
  }

  private secureRequest(req: http.IncomingMessage): boolean {
    const publicUrl = this.deps.preview.publicUrl;
    if (!publicUrl?.startsWith('https:')) return false;
    return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https' || String(req.headers.host ?? '') === new URL(publicUrl).host;
  }

  /** A refused preview request, for the operator's security view (no paths, cookies or tickets). */
  private denied(req: http.IncomingMessage, reason: string, grant?: Grant): void {
    const source = requestSource({ headers: req.headers, socket: req.socket });
    if (!this.deniedLimiter.check(source).allowed) return;
    securityEvent(this.deps, { type: 'devserver.preview.denied', actor_id: grant?.agentId ?? null,
      payload: { reason, source, upgrade: req.headers.upgrade !== undefined, ...(grant ? { sandbox_id: grant.sandboxId, room: grant.roomId } : {}) } });
  }

  private exchange(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ticket: string): void {
    const hash = sha(ticket);
    const grant = this.tickets.get(hash);
    this.tickets.delete(hash);
    if (!grant || grant.expires <= Date.now()) {
      this.denied(req, grant ? 'ticket_expired' : 'ticket_invalid');
      if (!this.invalidLimiter.check(`ip:${req.socket.remoteAddress ?? '?'}`).allowed) return page(res, 429, 'Too many attempts', 'Wait a minute, then open the preview from the Studio again.');
      return page(res, 401, 'This preview link has expired', 'Preview links work once and only for a minute. Go back to the Studio and open the Preview tab again.');
    }
    if (!this.grantValid(grant)) { this.denied(req, 'ticket_revoked', grant); return page(res, 403, 'No access to this preview', 'You are no longer a member of this project, or your sign-in was revoked.'); }
    const previous = readCookie(req.headers.cookie, COOKIE);
    if (previous) this.sessions.delete(sha(previous));
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) return page(res, 503, 'Preview is busy', 'Too many preview sessions are open; try again later.');
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha(token), { ...grant, expires: Date.now() + SESSION_TTL_MS });
    this.deps.events.append({ type: 'devserver.preview.opened', room_id: grant.roomId, actor_id: grant.agentId, payload: { sandbox_id: grant.sandboxId } });
    url.searchParams.delete(TICKET_PARAM);
    const location = `${url.pathname.replace(/^\/+/, '/')}${url.search}`;
    const attributes = this.secureRequest(req) ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax';
    res.writeHead(303, {
      location, 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; ${attributes}; Max-Age=${SESSION_TTL_MS / 1000}`,
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-length': 0,
    });
    res.end();
  }

  private session(req: http.IncomingMessage): { ok: true; key: string; record: DevRecord } | { ok: false; status: number; title: string; message: string } {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      this.denied(req, 'session_missing');
      return { ok: false, status: 401, title: 'Open this preview from the Studio', message: 'Go to your project in Collab Studio and open the Preview tab.' };
    }
    const key = sha(token);
    const grant = this.sessions.get(key);
    if (!grant || grant.expires <= Date.now()) {
      this.sessions.delete(key);
      this.denied(req, grant ? 'session_expired' : 'session_invalid');
      return { ok: false, status: 401, title: 'This preview session has ended', message: 'Go back to the Studio and open the Preview tab again.' };
    }
    if (!this.grantValid(grant)) {
      this.sessions.delete(key);
      this.denied(req, 'session_revoked', grant);
      return { ok: false, status: 403, title: 'No access to this preview', message: 'You are no longer a member of this project, or your sign-in was revoked.' };
    }
    const row = this.deps.sandbox.get(grant.sandboxId);
    const record = this.records.get(grant.sandboxId);
    if (!row || row.status !== 'running' || !record) return { ok: false, status: 503, title: 'The dev server is not running', message: 'Start it from the Preview tab in the Studio, then reload.' };
    return { ok: true, key, record };
  }

  private forwardHeaders(req: http.IncomingMessage, record: DevRecord, upgrade: boolean): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    const local = `http://localhost:${record.port}`;
    const seenAs = [`http://${req.headers.host ?? ''}`, `https://${req.headers.host ?? ''}`];
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name === 'authorization' || name === 'host' || name.startsWith('x-hub-') ||
          name.startsWith('x-forwarded-') || name === 'forwarded') continue;
      if (name === 'cookie') { const kept = withoutSessionCookie(String(value)); if (kept) headers.cookie = kept; continue; }
      if (name === 'origin' && seenAs.includes(String(value))) { headers.origin = local; continue; }
      if (name === 'referer') {
        const prefix = seenAs.find((origin) => String(value).startsWith(`${origin}/`));
        headers.referer = prefix ? local + String(value).slice(prefix.length) : String(value);
        continue;
      }
      headers[name] = value;
    }
    // Dev servers (Vite among them) only answer requests addressed to localhost.
    headers.host = `localhost:${record.port}`;
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = String(req.headers.upgrade ?? 'websocket'); }
    else headers.connection = 'close';
    return headers;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://preview.invalid'); } catch { return page(res, 400, 'Bad request', 'The address is not valid.'); }
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket !== null) return this.exchange(req, res, url, ticket);
    const session = this.session(req);
    if (!session.ok) {
      if (session.status === 401 && !this.invalidLimiter.check(`ip:${req.socket.remoteAddress ?? '?'}`).allowed) return page(res, 429, 'Too many attempts', 'Wait a minute, then open the preview from the Studio again.');
      return page(res, session.status, session.title, session.message);
    }
    if (!this.limiter.check(session.key).allowed) return page(res, 429, 'Slow down', 'The preview received too many requests; it will recover in a moment.');
    let relay: ExecSocket;
    try { relay = this.openRelay(session.record); } catch { return page(res, 503, 'Preview is busy', 'Too many open connections to this dev server; reload in a moment.'); }
    const upstream = http.request({ method: req.method, path: req.url, headers: this.forwardHeaders(req, session.record, false), createConnection: () => relay as unknown as Socket });
    upstream.on('response', (response) => {
      res.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders(response.rawHeaders));
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      relay.destroy();
      page(res, 502, 'The dev server is not answering yet', `Nothing is listening on port ${session.record.port} inside the workspace. It may still be starting; check its log in the Preview tab, then reload.`);
    });
    res.on('close', () => { upstream.destroy(); relay.destroy(); });
    req.pipe(upstream);
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => {});
    const refuse = (status: number, reason: string) => socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    const session = this.session(req);
    if (!session.ok) return void refuse(session.status, session.status === 503 ? 'Service Unavailable' : session.status === 403 ? 'Forbidden' : 'Unauthorized');
    if (!this.limiter.check(session.key).allowed) return void refuse(429, 'Too Many Requests');
    let relay: ExecSocket;
    try { relay = this.openRelay(session.record); } catch { return void refuse(503, 'Service Unavailable'); }
    const upstream = http.request({ method: req.method, path: req.url, headers: this.forwardHeaders(req, session.record, true), createConnection: () => relay as unknown as Socket });
    const headerLines = (raw: string[]) => {
      let text = '';
      for (let index = 0; index + 1 < raw.length; index += 2) {
        const name = raw[index]!, value = raw[index + 1]!;
        if (name.toLowerCase() === 'set-cookie' && value.split('=')[0]!.trim() === COOKIE) continue;
        if (/[\r\n]/.test(name + value)) continue;
        text += `${name}: ${value}\r\n`;
      }
      return text;
    };
    upstream.on('upgrade', (response, upstreamSocket: Socket, upstreamHead: Buffer) => {
      socket.write(`HTTP/1.1 101 ${response.statusMessage ?? 'Switching Protocols'}\r\n${headerLines(response.rawHeaders)}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const done = () => { socket.destroy(); upstreamSocket.destroy(); };
      upstreamSocket.on('error', done); upstreamSocket.on('close', done); socket.on('close', done);
    });
    upstream.on('response', (response) => {
      // The dev server declined the upgrade: pass its answer through and close.
      socket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}\r\n${headerLines(responseHeaders(response.rawHeaders))}connection: close\r\n\r\n`);
      response.pipe(socket);
    });
    upstream.on('error', () => { relay.destroy(); refuse(502, 'Bad Gateway'); });
    socket.on('close', () => { upstream.destroy(); relay.destroy(); });
    upstream.end();
  }

  /** Starts the preview listener (when enabled) and the watchdog that stops orphaned dev servers. */
  async listen(): Promise<{ listening: boolean; port: number | null }> {
    this.watchdog ??= setInterval(() => { void this.sweep(); }, 15_000);
    this.watchdog.unref();
    const { port, host } = this.deps.preview;
    if (port === null) return { listening: false, port: null };
    const server = http.createServer((req, res) => {
      try { this.handle(req, res); } catch { page(res, 500, 'Preview error', 'Something went wrong showing this preview.'); }
    });
    server.on('upgrade', (req, socket, head) => {
      try { this.handleUpgrade(req, socket as Socket, head); } catch { (socket as Socket).destroy(); }
    });
    server.on('clientError', (_error, socket) => { socket.destroy(); });
    return new Promise((resolve) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        this.deps.log?.warn(`preview listener unavailable on ${host}:${port}: ${error.code ?? error.message}`);
        resolve({ listening: false, port });
      });
      server.listen(port, host, () => { this.server = server; resolve({ listening: true, port }); });
    });
  }

  async close(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  /**
   * Stops dev servers whose sandbox stopped (in the database or because its
   * room container died outside the hub) or whose room was archived by
   * another process.
   */
  async sweep(): Promise<void> {
    this.prune();
    // Adopt dev containers this process has not seen (left over from a hub restart) so they are judged too.
    const rows = this.deps.db.prepare('SELECT * FROM sandboxes').all() as SandboxRow[];
    for (const row of rows) if (!this.records.has(row.id)) await this.record(row).catch(() => null);
    for (const record of [...this.records.values()]) {
      const room = this.deps.db.prepare('SELECT 1 FROM rooms WHERE id = ? AND archived_at IS NULL').get(record.roomId);
      let live = room ? await this.deps.sandbox.liveStatus(record.roomId).catch(() => null) : null;
      if (live && live.id !== record.sandboxId) live = null;
      if (!live || live.status !== 'running') await this.stop(record.sandboxId, null, 'sandbox_stopped').catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- REST routes

const sandboxParams = z.object({ id: z.string().regex(/^sbx_[a-f0-9]{16}$/) });
const startSchema = z.object({
  cmd: z.string().trim().min(1).max(512).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  dir: z.string().max(200).optional(),
}).strict();
const planQuery = z.object({ port: z.coerce.number().int().min(1024).max(65535).optional() }).strict();
const logQuery = z.object({ bytes: z.coerce.number().int().min(0).max(LOG_MAX_BYTES).optional() }).strict();
const ticketSchema = z.object({ path: z.string().min(1).max(2_000).regex(/^\/(?!\/)/).optional() }).strict();
const fetchSchema = z.object({ path: z.string().min(1).max(2_000).regex(/^\/(?!\/)[^\s\x00-\x1f\x7f]*$/) }).strict();

export function registerDevServerRoutes(app: FastifyInstance, svc: HubServices, devServers: DevServerService): void {
  function accessible(request: FastifyRequest, reply: FastifyReply): SandboxRow | null {
    const parsed = sandboxParams.safeParse(request.params);
    if (!parsed.success) { void reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid sandbox id' } }); return null; }
    const row = svc.db.prepare('SELECT s.* FROM sandboxes s JOIN rooms r ON r.id=s.room_id WHERE s.id=? AND r.workspace_id=?').get(parsed.data.id, request.auth!.agent.workspace_id) as SandboxRow | undefined;
    if (!row) { void reply.code(404).send({ error: { code: 'SANDBOX_NOT_FOUND', message: 'Sandbox not found' } }); return null; }
    if (!canReadRoom(svc.db, request.auth!.agent, row.room_id)) { void reply.code(403).send({ error: { code: 'NOT_MEMBER', message: 'Not a room member' } }); return null; }
    return row;
  }
  async function perform<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | void> {
    try { return await action(); }
    catch (error) {
      if (isSandboxError(error)) { void reply.code(error.status).send({ error: { code: error.code, message: error.message } }); return; }
      throw error;
    }
  }
  const base = '/v1/sandboxes/:id/dev-server';

  app.get(base, { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    return perform(reply, async () => ({ dev_server: await devServers.status(row.id, request.auth!.agent.id), preview: devServers.previewAccess(request.headers) }));
  });

  // Same rule as running a command: room members who can write, not observers.
  app.post(base, { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const input = startSchema.safeParse(request.body ?? {});
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Optional cmd (1–512 characters), port (1024–65535) and dir (workspace folder)' } });
    return perform(reply, async () => {
      const devServer = await devServers.start(row.id, request.auth!.agent.id, input.data);
      reply.code(201);
      return { dev_server: devServer, preview: devServers.previewAccess(request.headers) };
    });
  });

  // How Start would run this workspace's app: folder, command, framework and whether packages need installing.
  app.get(`${base}/plan`, { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const query = planQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Optional port 1024–65535' } });
    return { plan: svc.sandbox.launchPlan(row.room_id, query.data.port ?? DEFAULT_DEV_PORT) };
  });

  app.delete(base, { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    return perform(reply, () => devServers.stop(row.id, request.auth!.agent.id));
  });

  app.get(`${base}/logs`, { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const query = logQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Optional bytes 0–${LOG_MAX_BYTES}` } });
    return perform(reply, async () => {
      const status = await devServers.status(row.id, request.auth!.agent.id, query.data.bytes ?? LOG_MAX_BYTES);
      return { state: status.state, log: status.log, log_truncated: status.log_truncated };
    });
  });

  // Observers may watch the preview too; the ticket only signs this browser in to the preview origin.
  app.post(`${base}/ticket`, { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const input = ticketSchema.safeParse(request.body ?? {});
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Optional path starting with a single /' } });
    return perform(reply, async () => {
      const ticket = devServers.ticket(row.id, request.auth!.agent, request.auth!.operator === true, request.headers, input.data.path);
      reply.code(ticket.url ? 201 : 200);
      return ticket;
    });
  });

  app.post(`${base}/fetch`, { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const input = fetchSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'path required: starts with a single /, no spaces' } });
    return perform(reply, () => devServers.fetchPath(row.id, request.auth!.agent.id, input.data.path));
  });
}
