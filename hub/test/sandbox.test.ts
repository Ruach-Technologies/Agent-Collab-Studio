import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDb, type DbHandle } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { workspaceGithubToken, loadConfig } from '../src/config.js';
import { SandboxService, checkCommandPolicy, parseGithubRepo, sandboxPath, type SandboxConfig } from '../src/sandbox.js';

let root: string;
let db: DbHandle;
let service: SandboxService;
let events: EventBus;
let dockerBin: string;
let baseConfig: SandboxConfig;
const roomId = 'room_sandbox_test';
const actorId = 'agt_sandbox_test';

function calls(): string[][] {
  const log = path.join(root, 'calls.jsonl');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
}

function state(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, 'containers.json'), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sandbox-test-'));
  db = openDb(path.join(root, 'hub.sqlite'));
  db.prepare(`INSERT INTO agents (id, name, role, created_at) VALUES (?, ?, 'supervisor', ?)`)
    .run(actorId, 'sandbox test', new Date().toISOString());
  db.prepare(`INSERT INTO rooms (id, name, slug, created_by, created_at) VALUES (?, 'test', 'test', ?, ?)`)
    .run(roomId, actorId, new Date().toISOString());
  events = new EventBus(db);
  fs.writeFileSync(path.join(root, 'containers.json'), '{}');
  dockerBin = path.join(root, 'fake-docker');
  fs.writeFileSync(dockerBin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
const store = path.join(root, 'containers.json');
const state = JSON.parse(fs.readFileSync(store, 'utf8'));
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (process.env.GIT_CONFIG_VALUE_1) fs.appendFileSync(path.join(root, 'secrets.jsonl'), JSON.stringify([args[0], process.env.GIT_CONFIG_VALUE_1]) + '\\n');
const save = () => fs.writeFileSync(store, JSON.stringify(state));
const lookup = (id) => state[id] || Object.values(state).find((entry) => entry.Id === id);
const command = args[0];
if (command === 'inspect') {
  const entry = lookup(args.at(-1));
  if (!entry) { console.error('Error: No such container'); process.exit(1); }
  console.log(JSON.stringify([entry]));
} else if (command === 'run' || command === 'create') {
  const name = args[args.indexOf('--name') + 1];
  if (state[name]) { console.error('name conflict'); process.exit(1); }
  const labels = {};
  args.forEach((value, index) => { if (value === '--label') {
    const label = args[index + 1]; const split = label.indexOf('='); labels[label.slice(0, split)] = label.slice(split + 1);
  }});
  const id = (Object.keys(state).length + 1).toString(16).padStart(64, 'a');
  state[name] = { Id: id, State: { Running: command === 'run' }, Config: { Labels: labels }, args };
  save(); console.log(id);
} else if (command === 'start') {
  const entry = lookup(args.at(-1));
  if (!entry) process.exit(1);
  const cmd = entry.args.at(-1);
  const scriptAt = entry.args.indexOf('-c');
  const script = scriptAt > 0 ? entry.args[scriptAt + 1] : '';
  const positional = entry.args.slice(scriptAt + 3);
  const mount = entry.args[entry.args.indexOf('--mount') + 1];
  const workspace = mount.slice(mount.indexOf('src=') + 4, mount.indexOf(',dst='));
  if (script.includes('push --porcelain')) {
    const [url, dir, branch] = positional;
    if (!fs.existsSync(path.join(workspace, dir, '.git'))) { console.error('directory is not a git clone'); process.exit(64); }
    if (url.includes('read-only')) { console.error("remote: Permission to octocat/read-only.git denied to hub-bot.\\nfatal: unable to access '" + url + "/': The requested URL returned error: 403"); process.exit(128); }
    console.log('To ' + url + '\\n*\\trefs/heads/' + branch + ':refs/heads/' + branch + '\\t[new branch]\\nDone');
  } else if (script.includes('git clone')) {
    // Stand-in for the fixed network fetch script: clone when absent, else leave a bare copy.
    const [url, dir, ref, tmp, ...names] = positional;
    if (url.includes('missing-repo')) { console.error('fatal: repository not found'); process.exit(128); }
    const target = path.join(workspace, dir);
    if (fs.existsSync(target)) {
      if (!fs.existsSync(path.join(target, '.git'))) { console.error('target directory exists and is not a git clone'); process.exit(64); }
      fs.mkdirSync(path.join(workspace, tmp));
    } else {
      fs.mkdirSync(path.join(target, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(target, '.git', 'info', 'exclude'), names.map((name) => '/' + name + '\\n').join(''));
      fs.writeFileSync(path.join(target, 'README.md'), 'cloned ' + url + ' ' + ref);
      if (url.includes('has-claude')) fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'repository instructions');
      console.error("Cloning into '" + dir + "'...");
    }
  } else if (script.includes('GIT_OPTIONAL_LOCKS') || script.includes('git checkout') || script.includes('basename')) {
    // Repository views run the real fixed script against the host workspace with real git.
    const real = script.split('/workspace').join(workspace);
    const result = spawnSync('sh', ['-c', real, 'sh', ...positional], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    process.exitCode = result.status === null ? 1 : result.status;
  } else if (script.includes('merge --ff-only')) {
    const [, , tmp, fetched] = positional;
    fs.rmSync(path.join(workspace, tmp), { recursive: true, force: true });
    if (fetched === 'ok') console.log('Already up to date.');
  } else if (cmd === 'oversized-output') {
    process.stdout.write('é'.repeat(400)); process.stderr.write('x'.repeat(400));
  } else if (cmd === 'binary-output') {
    process.stdout.write(Buffer.alloc(400, 255)); process.stderr.write(Buffer.alloc(400, 255));
  } else if (cmd === 'simulate-timeout') {
    console.log('before timeout'); process.exitCode = 124;
  } else if (cmd === 'simulate-stuck') {
    setTimeout(() => {}, 30000);
  } else {
    console.log('command output');
  }
} else if (command === 'rm') {
  const entry = lookup(args.at(-1));
  if (entry) { for (const [name, value] of Object.entries(state)) if (value.Id === entry.Id) delete state[name]; }
  save();
} else if (command === 'exec') {
  const entry = lookup(args[2]);
  if (!entry) process.exit(1);
  if (entry.stopOnExec) { entry.State.Running = false; save(); console.error('container stopped'); process.exit(1); }
  if (entry.failFileHelper) { console.error('helper unavailable'); process.exit(1); }
  let input = '';
  process.stdin.on('data', (chunk) => input += chunk);
  process.stdin.on('end', () => {
    const mount = entry.args[entry.args.indexOf('--mount') + 1];
    const workspace = mount.slice(mount.indexOf('src=') + 4, mount.indexOf(',dst='));
    const helper = args.at(-1).replace("'/workspace'", JSON.stringify(workspace));
    const result = spawnSync('python3', ['-c', helper], {input, encoding:'utf8'});
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    process.exitCode = result.status === null ? 1 : result.status;
  });
} else { console.error('unexpected docker command'); process.exit(1); }
`, { mode: 0o700 });
  baseConfig = {
    dockerBin,
    image: 'sandbox:test',
    workspacesDir: path.join(root, 'workspaces'),
    execTimeoutMs: 1_000,
    maxExecTimeoutMs: 2_000,
    outputCapBytes: 512,
    memLimitMB: 128,
    cpus: 1,
    pidsLimit: 32,
    containerUser: '1000:1000',
    denylist: [],
  };
  service = new SandboxService({ db, events, config: baseConfig });
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sandbox policy', () => {
  it('always applies baseline command policy and treats custom rules literally', () => {
    expect(checkCommandPolicy('curl https://example.test', []).ok).toBe(false);
    expect(checkCommandPolicy('printf harmless', ['[a']).ok).toBe(true);
    expect(checkCommandPolicy('printf hello', []).ok).toBe(true);
    expect(checkCommandPolicy('printf "\\0"', []).ok).toBe(true);
    expect(checkCommandPolicy('bad\0command', []).ok).toBe(false);
  });

  it('rejects absolute, traversal, backslash, and NUL paths', () => {
    for (const name of ['/etc/passwd', '../secret', 'dir/../../secret', 'dir\\secret', 'x\0y']) {
      expect(() => sandboxPath(name)).toThrow();
    }
    expect(sandboxPath('./notes//work.txt')).toBe('notes/work.txt');
    expect(sandboxPath('.')).toBe('');
  });

  it('rejects a host workspace directory symlink', () => {
    const workspaceRoot = path.join(root, 'workspaces');
    fs.mkdirSync(workspaceRoot);
    fs.symlinkSync(root, path.join(workspaceRoot, roomId));
    expect(() => service.workspaceDir(roomId)).toThrow('Invalid room workspace');
  });

  it('rejects a root container user', () => {
    expect(() => new SandboxService({ db, events, config: {
      image: 'test', workspacesDir: root, execTimeoutMs: 100, outputCapBytes: 512,
      memLimitMB: 128, cpus: 1, pidsLimit: 32, containerUser: '0:0', denylist: [],
    } })).toThrow('Invalid sandbox resource policy');
  });
});

describe('sandbox lifecycle', () => {
  it('serializes concurrent provisioning and uses a hardened, labeled container', async () => {
    const [first, second] = await Promise.all([service.provision(roomId, actorId), service.provision(roomId, actorId)]);
    expect(first.id).toBe(second.id);
    expect(first.status).toBe('running');
    const starts = calls().filter((args) => args[0] === 'run');
    expect(starts).toHaveLength(1);
    const args = starts[0]!;
    for (const value of ['--network', 'none', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--memory', '--cpus', '--pids-limit', '--user', '1000:1000', '--log-driver']) {
      expect(args).toContain(value);
    }
    expect(args.join(' ')).not.toContain('docker.sock');
    expect(args.join(' ')).toContain('io.agent-collab-hub.owner=');
    expect(service.get(first.id)?.room_id).toBe(roomId);
  });

  it('allows one active plus four pending operations and rejects excess per-room work with 429', async () => {
    const accepted = Array.from({ length: 5 }, () => service.provision(roomId, actorId));
    await expect(service.provision(roomId, actorId)).rejects.toMatchObject({ code: 'SANDBOX_QUEUE_FULL', status: 429 });
    await expect(service.provision(roomId, actorId)).rejects.toMatchObject({ code: 'SANDBOX_QUEUE_FULL', status: 429 });
    // A saturated room must not block unrelated room queues.
    await expect(service.provision('room_other', actorId)).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    const results = await Promise.all(accepted);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(calls().filter((args) => args[0] === 'run')).toHaveLength(1);
    await expect(service.provision(roomId, actorId)).resolves.toMatchObject({ id: results[0]!.id, status: 'running' });
  });

  it('releases queue reservations after rejected actions', async () => {
    const accepted = Array.from({ length: 5 }, () => service.provision('room_missing', actorId));
    // Attach handlers immediately so the deliberately failed queue is observed.
    const outcomes = Promise.allSettled(accepted);
    await expect(service.provision('room_missing', actorId)).rejects.toMatchObject({ code: 'SANDBOX_QUEUE_FULL', status: 429 });
    const results = await outcomes;
    expect(results.every((result) => result.status === 'rejected' && result.reason.code === 'ROOM_NOT_FOUND')).toBe(true);
    await expect(service.provision('room_missing', actorId)).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
  });

  it('never removes a container without matching ownership labels', async () => {
    fs.writeFileSync(path.join(root, 'containers.json'), JSON.stringify({
      [`ach-sbx-${roomId}`]: { Id: 'b'.repeat(64), State: { Running: true }, Config: { Labels: {} } },
    }));
    await expect(service.provision(roomId, actorId)).rejects.toMatchObject({ code: 'SANDBOX_OWNERSHIP_CONFLICT' });
    expect(calls().some((args) => args[0] === 'rm')).toBe(false);
  });

  it('does not treat Docker failures as an absent container', async () => {
    fs.writeFileSync(dockerBin, '#!/usr/bin/env node\nconsole.error("Cannot connect to Docker at /private/host/socket");process.exit(1);\n', { mode: 0o700 });
    await expect(service.provision(roomId, actorId)).rejects.toMatchObject({ code: 'SANDBOX_DOCKER_UNAVAILABLE' });
    expect(service.status(roomId)).toBeNull();
  });

  it('stops only a verified owned container and marks the row stopped', async () => {
    const sandbox = await service.provision(roomId, actorId);
    await service.destroy(roomId);
    expect(service.get(sandbox.id)).toMatchObject({ status: 'stopped', container_id: null });
    expect(Object.keys(state())).toHaveLength(0);
  });
});

describe('sandbox execution', () => {
  it('runs timeout inside a disposable hardened container and records result/output', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const result = await service.exec(sandbox.id, actorId, 'printf hello', 600);
    expect(result).toMatchObject({ stdout: 'command output\n', timedOut: false, exitCode: 0 });
    expect(result.exec_id).toMatch(/^exec_/);
    const create = calls().find((args) => args[0] === 'create')!;
    expect(create.slice(-7)).toEqual(['sandbox:test', 'timeout', '-k', '1s', '0.6s', 'sh', '-lc', 'printf hello'].slice(-7));
    expect(create).toContain('--read-only');
    expect(Object.keys(state())).toEqual([`ach-sbx-${roomId}`]);
    const history = service.listExecs(sandbox.id);
    expect(history[0]).toMatchObject({ id: result.exec_id, stdout: result.stdout, stderr: '', timed_out: 0 });
    expect(service.getExec(sandbox.id, result.exec_id!)?.stdout).toBe(result.stdout);
    const event = events.since(null).find((row) => row.type === 'sandbox.exec.result')!;
    expect(JSON.parse(event.payload)).toMatchObject({ exec_id: result.exec_id, stdout: result.stdout });
  });

  it('recognizes the in-container timeout and cleans up the execution container', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const result = await service.exec(sandbox.id, actorId, 'simulate-timeout', 500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(Object.keys(state())).toEqual([`ach-sbx-${roomId}`]);
  });

  it('caps combined stdout/stderr by bytes without broken UTF-8 tails', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const result = await service.exec(sandbox.id, actorId, 'oversized-output');
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(512);
    expect(result.stdout).not.toContain('�');
  });

  it('caps binary output even when UTF-8 replacement characters expand', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const result = await service.exec(sandbox.id, actorId, 'binary-output');
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(512);
  });

  it('kills an unresponsive Docker client then removes the execution container', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const result = await service.exec(sandbox.id, actorId, 'simulate-stuck', 1);
    expect(result.timedOut).toBe(true);
    expect(Object.keys(state())).toEqual([`ach-sbx-${roomId}`]);
  }, 10_000);

  it('rejects invalid timeouts and the baseline denylist before starting commands', async () => {
    const sandbox = await service.provision(roomId, actorId);
    for (const timeout of [0, -1, 2_001, 1.5, Number.NaN]) {
      await expect(service.exec(sandbox.id, actorId, 'printf hello', timeout)).rejects.toMatchObject({ code: 'SANDBOX_TIMEOUT_INVALID' });
    }
    await expect(service.exec(sandbox.id, actorId, 'docker ps')).rejects.toMatchObject({ code: 'SANDBOX_CMD_DENIED' });
    expect(calls().filter((args) => args[0] === 'create')).toHaveLength(0);
  });
});

describe('workspace tools', () => {
  it('reports an exited room container honestly and refuses file exec without blaming the path', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const containers = state() as Record<string, { State: { Running: boolean } }>;
    containers[`ach-sbx-${roomId}`]!.State.Running = false;
    fs.writeFileSync(path.join(root, 'containers.json'), JSON.stringify(containers));
    await expect(service.liveStatus(roomId)).resolves.toMatchObject({ id: sandbox.id, status: 'stopped' });
    for (const operation of [
      () => service.listFiles(sandbox.id, '.', actorId),
      () => service.readFile(sandbox.id, 'notes.txt', actorId),
      () => service.writeFile(sandbox.id, 'notes.txt', 'unchanged', actorId),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'SANDBOX_NOT_RUNNING', status: 409 });
    expect(calls().some((args) => args[0] === 'exec')).toBe(false);
    // Read-only status must not disable the separate disposable command workflow.
    expect(service.get(sandbox.id)?.status).toBe('running');
    await expect(service.exec(sandbox.id, actorId, 'printf hello')).resolves.toMatchObject({ exitCode: 0 });
    expect(Object.keys(state())).toEqual([`ach-sbx-${roomId}`]);
  });

  it('distinguishes missing, foreign-owned and unavailable room containers', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const saved = state();
    fs.writeFileSync(path.join(root, 'containers.json'), '{}');
    await expect(service.liveStatus(roomId)).resolves.toMatchObject({ status: 'stopped', container_id: null });
    await expect(service.listFiles(sandbox.id, '.', actorId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_RUNNING' });
    const foreign = structuredClone(saved) as Record<string, { Config: { Labels: Record<string, string> } }>;
    foreign[`ach-sbx-${roomId}`]!.Config.Labels = {};
    fs.writeFileSync(path.join(root, 'containers.json'), JSON.stringify(foreign));
    await expect(service.liveStatus(roomId)).rejects.toMatchObject({ code: 'SANDBOX_OWNERSHIP_CONFLICT' });
    await expect(service.listFiles(sandbox.id, '.', actorId)).rejects.toMatchObject({ code: 'SANDBOX_OWNERSHIP_CONFLICT' });
    fs.writeFileSync(dockerBin, '#!/usr/bin/env node\nconsole.error("Cannot connect to Docker");process.exit(1);\n', { mode: 0o700 });
    await expect(service.liveStatus(roomId)).rejects.toMatchObject({ code: 'SANDBOX_DOCKER_UNAVAILABLE' });
    await expect(service.listFiles(sandbox.id, '.', actorId)).rejects.toMatchObject({ code: 'SANDBOX_DOCKER_UNAVAILABLE' });
  });

  it('maps a stop during file exec separately from a running helper failure', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const saved = state() as Record<string, { State: { Running: boolean }; stopOnExec?: boolean; failFileHelper?: boolean }>;
    saved[`ach-sbx-${roomId}`]!.stopOnExec = true;
    fs.writeFileSync(path.join(root, 'containers.json'), JSON.stringify(saved));
    await expect(service.listFiles(sandbox.id, '.', actorId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_RUNNING', status: 409 });
    saved[`ach-sbx-${roomId}`]!.stopOnExec = false;
    saved[`ach-sbx-${roomId}`]!.failFileHelper = true;
    fs.writeFileSync(path.join(root, 'containers.json'), JSON.stringify(saved));
    await expect(service.listFiles(sandbox.id, '.', actorId)).rejects.toMatchObject({ code: 'SANDBOX_FILE_OPERATION_FAILED', status: 502 });
  });

  it('writes, reads, and lists workspace files with attributable audit events', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const content = 'collaborative notes\n';
    expect(await service.writeFile(sandbox.id, 'notes/pilot.txt', content, actorId)).toEqual({ written: true, bytes: Buffer.byteLength(content), lines_added: 1, lines_removed: 0 });
    expect(await service.readFile(sandbox.id, 'notes/pilot.txt', actorId)).toBe(content);
    expect(await service.listFiles(sandbox.id, 'notes', actorId)).toEqual([{ name: 'pilot.txt', type: 'file', size: Buffer.byteLength(content) }]);
    const fileEvents = events.since(null).filter((row) => row.type.startsWith('file.'));
    expect(fileEvents).toHaveLength(3);
    expect(fileEvents.every((row) => row.actor_id === actorId)).toBe(true);
    expect(fileEvents.map((row) => JSON.parse(row.payload).outcome)).toEqual(['success', 'success', 'success']);
  });

  it.runIf(process.env.HUB_TEST_DOCKER === '1')('runs hardened tools and cleans background descendants against real Docker', async () => {
    const realId = `room_real_${randomBytes(6).toString('hex')}`;
    db.prepare(`INSERT INTO rooms (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(realId, realId, realId, actorId, new Date().toISOString());
    const real = new SandboxService({ db, events, config: {
      image: 'agent-collab-sandbox:local', workspacesDir: path.join(root, 'real-workspaces'),
      execTimeoutMs: 1000, maxExecTimeoutMs: 5000, outputCapBytes: 65536,
      memLimitMB: 128, cpus: 1, pidsLimit: 32, containerUser: '1000:1000', denylist: [],
    } });
    const previousMask = process.umask(0o077);
    try {
      const sandbox = await real.provision(realId, actorId);
      expect(sandbox.status).toBe('running');
      const workspace = real.workspaceDir(realId);
      const hostMode = fs.statSync(workspace).mode & 0o777;
      const rootMode = fs.statSync(path.dirname(workspace)).mode & 0o777;
      const permissions = await real.exec(sandbox.id, actorId, 'id; stat -c "%a %u:%g" /workspace; touch /workspace/permission-probe; printf writable');
      console.log(JSON.stringify({ smoke: 'workspace-permissions', umask: '077', hostMode: hostMode.toString(8), rootMode: rootMode.toString(8), ...permissions }));
      expect(permissions).toMatchObject({ exitCode: 0, stderr: '' });
      expect(permissions.stdout).toContain('writable');
      expect(rootMode).toBe(0o700);
      expect(hostMode & 0o007).toBe(0);
      expect(await real.exec(sandbox.id, actorId, 'printf hello')).toMatchObject({ stdout: 'hello', exitCode: 0 });
      const timeout = await real.exec(sandbox.id, actorId, 'sleep 30', 200);
      console.log(JSON.stringify({ smoke: 'timeout-containment', ...timeout }));
      expect(timeout).toMatchObject({ timedOut: true });
      await real.writeFile(sandbox.id, 'notes/a.txt', 'shared notes', actorId);
      expect(await real.readFile(sandbox.id, 'notes/a.txt', actorId)).toBe('shared notes');
      expect((await real.listFiles(sandbox.id, 'notes', actorId))[0]?.name).toBe('a.txt');
      await real.exec(sandbox.id, actorId, 'ln -s /etc/passwd bad-link');
      await expect(real.readFile(sandbox.id, 'bad-link', actorId)).rejects.toThrow('unsafe');
      await real.exec(sandbox.id, actorId, '(sleep 1; printf escaped > after-exit) &');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect(real.readFile(sandbox.id, 'after-exit', actorId)).rejects.toThrow('unsafe');
      execFileSync('docker', ['stop', '--time', '1', sandbox.container_id!], { timeout: 10_000 });
      expect(await real.liveStatus(realId)).toMatchObject({ status: 'stopped', container_id: sandbox.container_id });
      await expect(real.listFiles(sandbox.id, '.', actorId)).rejects.toMatchObject({ code: 'SANDBOX_NOT_RUNNING', status: 409 });
      // Explicit fixture-only recovery preserves the exact container and bind-mounted files.
      execFileSync('docker', ['start', sandbox.container_id!], { timeout: 10_000 });
      expect(await real.liveStatus(realId)).toMatchObject({ status: 'running', container_id: sandbox.container_id });
      expect(await real.readFile(sandbox.id, 'notes/a.txt', actorId)).toBe('shared notes');
    } finally {
      process.umask(previousMask);
      await real.destroy(realId);
    }
  }, 30_000);

  it('rejects symlink leaves and parent directories without touching outside data', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const workspace = service.workspaceDir(roomId);
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'private');
    fs.symlinkSync(outside, path.join(workspace, 'outside-link'));
    fs.symlinkSync(root, path.join(workspace, 'outside-dir'));
    for (const filename of ['outside-link', 'outside-dir/outside.txt']) {
      await expect(service.readFile(sandbox.id, filename, actorId)).rejects.toMatchObject({ code: 'SANDBOX_PATH_INVALID' });
      await expect(service.writeFile(sandbox.id, filename, 'overwritten', actorId)).rejects.toMatchObject({ code: 'SANDBOX_PATH_INVALID' });
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('private');
    expect(await service.listFiles(sandbox.id, '.', actorId)).toEqual([]);
  });

  it('rejects oversized content by UTF-8 byte count and refuses large reads', async () => {
    const sandbox = await service.provision(roomId, actorId);
    await expect(service.writeFile(sandbox.id, 'large', 'é'.repeat(300), actorId)).rejects.toMatchObject({ code: 'SANDBOX_FILE_TOO_LARGE' });
    fs.writeFileSync(path.join(service.workspaceDir(roomId), 'large'), 'x'.repeat(600));
    await expect(service.readFile(sandbox.id, 'large', actorId)).rejects.toMatchObject({ code: 'SANDBOX_FILE_TOO_LARGE' });
  });

  it('refuses hard-linked writes and nonregular-file reads', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const workspace = service.workspaceDir(roomId);
    fs.writeFileSync(path.join(root, 'outside'), 'untouched');
    fs.linkSync(path.join(root, 'outside'), path.join(workspace, 'hardlink'));
    await expect(service.writeFile(sandbox.id, 'hardlink', 'replacement', actorId)).rejects.toMatchObject({ code: 'SANDBOX_PATH_INVALID' });
    expect(fs.readFileSync(path.join(root, 'outside'), 'utf8')).toBe('untouched');
    await expect(service.readFile(sandbox.id, '.', actorId)).rejects.toMatchObject({ code: 'SANDBOX_PATH_INVALID' });
  });
});

describe('GitHub repositories and seeded instructions', () => {
  const seededService = (extra: Partial<SandboxConfig> = {}) => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'global agent rules');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'global claude rules');
    return new SandboxService({ db, events, config: {
      ...baseConfig,
      seedFiles: [{ name: 'AGENTS.md', source: path.join(root, 'AGENTS.md') }, { name: 'CLAUDE.md', source: path.join(root, 'CLAUDE.md') }],
      ...extra,
    } });
  };

  it('accepts only GitHub owner/name references', () => {
    expect(parseGithubRepo('octocat/Hello-World')).toEqual({ slug: 'octocat/Hello-World', name: 'Hello-World', url: 'https://github.com/octocat/Hello-World.git' });
    expect(parseGithubRepo('https://github.com/octocat/hello.world.git/').url).toBe('https://github.com/octocat/hello.world.git');
    for (const repo of ['https://gitlab.com/a/b', 'http://github.com/a/b', 'git@github.com:a/b.git', 'a/b/c', 'a/..', '-a/b', 'a/b --upload-pack=x', 'file:///etc', 'https://github.com.evil.test/a/b']) {
      expect(() => parseGithubRepo(repo)).toThrow();
    }
  });

  it('seeds the workspace root on provision, refreshes it, and never follows a planted symlink', async () => {
    const seeded = seededService();
    const sandbox = await seeded.provision(roomId, actorId);
    const workspace = seeded.workspaceDir(roomId);
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe('global agent rules');
    expect(fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8')).toBe('global claude rules');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'updated rules');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'private');
    fs.rmSync(path.join(workspace, 'CLAUDE.md'));
    fs.symlinkSync(outside, path.join(workspace, 'CLAUDE.md'));
    expect((await seeded.provision(roomId, actorId)).id).toBe(sandbox.id);
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe('updated rules');
    expect(fs.readFileSync(outside, 'utf8')).toBe('private');
    const seeds = events.since(null).filter((row) => row.type === 'file.write').map((row) => JSON.parse(row.payload) as { path: string; operation: string });
    expect(seeds.map((seed) => seed.path)).toEqual(['AGENTS.md', 'CLAUDE.md', 'AGENTS.md']);
    expect(seeds.every((seed) => seed.operation === 'seed')).toBe(true);
  });

  it('clones with network only in the fixed fetch container and seeds the repository root', async () => {
    const seeded = seededService();
    const sandbox = await seeded.provision(roomId, actorId);
    const result = await seeded.cloneRepo(sandbox.id, actorId, { repo: 'https://github.com/octocat/has-claude', ref: 'main' });
    expect(result).toMatchObject({ action: 'clone', repo: 'octocat/has-claude', dir: 'has-claude', exitCode: 0, timedOut: false, seeded: ['has-claude/AGENTS.md'] });
    const workspace = seeded.workspaceDir(roomId);
    expect(fs.readFileSync(path.join(workspace, 'has-claude', 'AGENTS.md'), 'utf8')).toBe('global agent rules');
    // A repository's own instructions win over the seeded copy.
    expect(fs.readFileSync(path.join(workspace, 'has-claude', 'CLAUDE.md'), 'utf8')).toBe('repository instructions');
    expect(fs.readFileSync(path.join(workspace, 'has-claude', '.git', 'info', 'exclude'), 'utf8')).toBe('/AGENTS.md\n/CLAUDE.md\n');
    const creates = calls().filter((args) => args[0] === 'create');
    expect(creates).toHaveLength(1);
    const create = creates[0]!;
    expect(create[create.indexOf('--network') + 1]).toBe('bridge');
    expect(create[create.indexOf('--workdir') + 1]).toBe('/tmp');
    for (const value of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--user', '1000:1000']) expect(create).toContain(value);
    expect(create.slice(create.indexOf('sh') + 3)).toEqual(['sh', 'https://github.com/octocat/has-claude.git', 'has-claude', 'main', expect.stringMatching(/^\.ach-fetch-exec_[a-f0-9]{16}$/), 'AGENTS.md', 'CLAUDE.md']);
    expect(Object.keys(state())).toEqual([`ach-sbx-${roomId}`]);
    expect(seeded.listExecs(sandbox.id)[0]).toMatchObject({ id: result.exec_id, cmd: 'git clone https://github.com/octocat/has-claude.git has-claude --branch main', exit_code: 0 });
    // Agent commands stay offline and carry the acting agent's git identity.
    await seeded.exec(sandbox.id, actorId, 'git status');
    const exec = calls().filter((args) => args[0] === 'create').at(-1)!;
    expect(exec[exec.indexOf('--network') + 1]).toBe('none');
    expect(exec).toContain('GIT_AUTHOR_NAME=sandbox test');
    expect(exec).toContain('GIT_CONFIG_KEY_0=safe.directory');
  });

  it('refreshes an existing clone offline from a separately fetched copy', async () => {
    const sandbox = await service.provision(roomId, actorId);
    await service.cloneRepo(sandbox.id, actorId, { repo: 'octocat/Hello-World', dir: 'app' });
    const result = await service.cloneRepo(sandbox.id, actorId, { repo: 'octocat/Hello-World', dir: 'app' });
    expect(result).toMatchObject({ action: 'update', exitCode: 0, stdout: 'Already up to date.\n' });
    const [, fetch, merge] = calls().filter((args) => args[0] === 'create');
    expect(fetch![fetch!.indexOf('--network') + 1]).toBe('bridge');
    expect(merge![merge!.indexOf('--network') + 1]).toBe('none');
    expect(fs.readdirSync(service.workspaceDir(roomId))).toEqual(['app']);
    expect(Object.keys(state())).toEqual([`ach-sbx-${roomId}`]);
  });

  it('reports clone failures and rejects unsafe targets before starting a container', async () => {
    const sandbox = await service.provision(roomId, actorId);
    for (const input of [{ repo: 'a/b', dir: '../x' }, { repo: 'a/b', dir: '.git' }, { repo: 'a/b', dir: 'x/y' }, { repo: 'a/b', ref: '--upload-pack=x' }, { repo: 'a/b', ref: 'a..b' }, { repo: 'https://example.test/a/b' }]) {
      await expect(service.cloneRepo(sandbox.id, actorId, input)).rejects.toMatchObject({ code: 'SANDBOX_REPO_INVALID', status: 400 });
    }
    expect(calls().filter((args) => args[0] === 'create')).toHaveLength(0);
    await expect(service.cloneRepo(sandbox.id, actorId, { repo: 'octocat/missing-repo' })).resolves.toMatchObject({ exitCode: 128, action: 'clone', seeded: [] });
    fs.mkdirSync(path.join(service.workspaceDir(roomId), 'notes'));
    await expect(service.cloneRepo(sandbox.id, actorId, { repo: 'octocat/Hello-World', dir: 'notes' })).resolves.toMatchObject({ exitCode: 64 });
    db.prepare(`INSERT INTO agents (id, name, role, created_at) VALUES ('agt_observer', 'watcher', 'observer', ?)`).run(new Date().toISOString());
    await expect(service.cloneRepo(sandbox.id, 'agt_observer', { repo: 'octocat/Hello-World' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('attaches the operator token to every clone, only through the client environment', async () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const service = seededService({ seedFiles: [], github: { token } });
    const sandbox = await service.provision(roomId, actorId);
    for (const repo of ['someone/else', 'acme/other', 'octocat/private-app']) {
      await expect(service.cloneRepo(sandbox.id, actorId, { repo })).resolves.toMatchObject({ exitCode: 0 });
    }
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const secrets = fs.readFileSync(path.join(root, 'secrets.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(secrets).toEqual([['create', header], ['create', header], ['create', header]]);
    const recorded = JSON.stringify(calls()) + JSON.stringify(events.since(null)) + JSON.stringify(service.listExecs(sandbox.id));
    expect(recorded).not.toContain(token);
    expect(recorded).not.toContain(header.slice(-20));
    expect(calls().filter((args) => args[0] === 'create').at(-1)).toContain('GIT_CONFIG_KEY_1=http.https://github.com/.extraheader');
    // Without a token, clones run anonymously and nothing secret is passed.
    fs.rmSync(path.join(root, 'secrets.jsonl'));
    const anonymous = seededService({ seedFiles: [] });
    await anonymous.cloneRepo(sandbox.id, actorId, { repo: 'octocat/public-app' });
    expect(fs.existsSync(path.join(root, 'secrets.jsonl'))).toBe(false);
  });
});

describe('pull requests', () => {
  const token = 'github_pat_' + 'b'.repeat(40);
  let requests: { method: string; url: string; body: unknown; authorization: string }[];
  const prService = (respond: (method: string, url: string) => { status: number; body: unknown }, github: SandboxConfig['github'] = { token }) => {
    requests = [];
    return new SandboxService({ db, events, config: { ...baseConfig, github, githubFetch: (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      requests.push({ method: init.method!, url, body: init.body ? JSON.parse(init.body as string) : null, authorization: headers.authorization! });
      const { status, body } = respond(init.method!, url);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch } });
  };
  const ok = (method: string) => method === 'GET'
    ? { status: 200, body: { default_branch: 'main' } }
    : { status: 201, body: { html_url: 'https://github.com/octocat/app/pull/7', number: 7 } };
  const cloned = async (svc: SandboxService, repo = 'octocat/app') => {
    const sandbox = await svc.provision(roomId, actorId);
    await svc.cloneRepo(sandbox.id, actorId, { repo });
    return sandbox;
  };

  it('pushes only the named branch from the fixed network script, opens a pull request, and never merges', async () => {
    const svc = prService(ok);
    const sandbox = await cloned(svc);
    const result = await svc.openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch: 'ai/fix-login', title: 'Fix login', body: 'Details' });
    expect(result).toMatchObject({ exitCode: 0, repo: 'octocat/app', branch: 'ai/fix-login', base: 'main', url: 'https://github.com/octocat/app/pull/7', number: 7 });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET https://api.github.com/repos/octocat/app', 'POST https://api.github.com/repos/octocat/app/pulls',
    ]);
    expect(requests[1]!.body).toEqual({ title: 'Fix login', head: 'ai/fix-login', base: 'main', body: 'Details' });
    expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
    const push = calls().filter((args) => args[0] === 'create').at(-1)!;
    expect(push[push.indexOf('--network') + 1]).toBe('bridge');
    expect(push[push.indexOf('--workdir') + 1]).toBe('/tmp');
    const script = push[push.indexOf('-c') + 1]!;
    expect(script).not.toMatch(/--force|\+refs|merge/);
    expect(push.slice(push.indexOf('-c') + 2)).toEqual(['sh', 'https://github.com/octocat/app.git', 'app', 'ai/fix-login', expect.stringMatching(/^\.ach-push-out_[a-f0-9]{16}$/)]);
    const recorded = JSON.stringify(calls()) + JSON.stringify(events.since(null)) + JSON.stringify(svc.listExecs(sandbox.id)) + JSON.stringify(result);
    expect(recorded).not.toContain(token);
    expect(recorded).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
    expect(JSON.parse(events.since(null).filter((row) => row.type === 'sandbox.exec.result').at(-1)!.payload)).toMatchObject({ kind: 'pull_request', pull_request: result.url });
    expect(Object.keys(state())).toEqual([`ach-sbx-${roomId}`]);
  });

  it('refuses the default or base branch, branches outside the prefix, and pull requests without a token', async () => {
    const svc = prService(ok);
    const sandbox = await cloned(svc);
    const before = calls().filter((args) => args[0] === 'create').length;
    for (const branch of ['main', 'feature/x', 'ai/', 'ai/../main', '-x']) {
      await expect(svc.openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch, title: 't' })).rejects.toMatchObject({ status: expect.any(Number), code: expect.stringMatching(/SANDBOX_(BRANCH_NOT_ALLOWED|REPO_INVALID)/) });
    }
    await expect(svc.openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch: 'ai/release', base: 'ai/release', title: 't' })).rejects.toMatchObject({ code: 'SANDBOX_BRANCH_NOT_ALLOWED', status: 403 });
    const loose = prService(ok, { token, prBranchPrefix: 'ma' });
    await expect(loose.openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch: 'main', base: 'develop', title: 't' })).rejects.toMatchObject({ code: 'SANDBOX_BRANCH_NOT_ALLOWED' });
    await expect(prService(ok, {}).openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch: 'ai/x', title: 't' })).rejects.toMatchObject({ code: 'SANDBOX_GITHUB_DENIED', status: 403 });
    expect(requests).toHaveLength(0);
    db.prepare(`INSERT INTO agents (id, name, role, created_at) VALUES ('agt_observer', 'watcher', 'observer', ?)`).run(new Date().toISOString());
    await expect(svc.openPullRequest(sandbox.id, 'agt_observer', { repo: 'octocat/app', branch: 'ai/x', title: 't' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls().filter((args) => args[0] === 'create')).toHaveLength(before);
  });

  it('reports a token without write or pull-request permission as denied', async () => {
    const readOnly = prService(ok);
    const sandbox = await cloned(readOnly, 'octocat/read-only');
    await expect(readOnly.openPullRequest(sandbox.id, actorId, { repo: 'octocat/read-only', branch: 'ai/x', title: 't' })).rejects.toMatchObject({ code: 'SANDBOX_GITHUB_DENIED', status: 403 });
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
    expect(readOnly.listExecs(sandbox.id)[0]).toMatchObject({ exit_code: 128 });
    await readOnly.cloneRepo(sandbox.id, actorId, { repo: 'octocat/app' });
    const noPulls = prService((method) => method === 'GET' ? ok('GET') : { status: 403, body: { message: 'Resource not accessible by personal access token' } });
    await expect(noPulls.openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch: 'ai/x', title: 't' })).rejects.toMatchObject({ code: 'SANDBOX_GITHUB_DENIED' });
    const duplicate = prService((method) => method === 'GET' ? ok('GET') : { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for octocat:ai/x.' }] } });
    await expect(duplicate.openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch: 'ai/x', title: 't' })).rejects.toMatchObject({ code: 'SANDBOX_PULL_REQUEST_FAILED', status: 409, message: expect.stringContaining('already exists') });
    const hidden = prService(() => ({ status: 404, body: { message: 'Not Found' } }));
    await expect(hidden.openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch: 'ai/x', title: 't' })).rejects.toMatchObject({ code: 'SANDBOX_GITHUB_DENIED' });
  });

  it('reads the pull-request prefix from the ignored sandbox env file and never a token', () => {
    const file = path.join(root, 'sandbox.env');
    fs.writeFileSync(file, `# local only\nHUB_SANDBOX_GITHUB_TOKEN="${token}"\nexport HUB_SANDBOX_GITHUB_PR_PREFIX=bot/\nOTHER_SECRET=ignored\n`);
    const env = { HUB_DATA_DIR: path.join(root, 'data'), HUB_WORKSPACES_DIR: path.join(root, 'workspaces'), HUB_SANDBOX_ENV_FILE: file };
    expect(loadConfig(env).sandbox).toMatchObject({ prBranchPrefix: 'bot/' });
    expect(JSON.stringify(loadConfig(env))).not.toContain(token);
  });

  it('works out how to run the room’s app from its workspace', () => {
    const service = prService(ok);
    const dir = service.workspaceDir(roomId);
    expect(service.launchPlan(roomId, 5173)).toBeNull();
    fs.mkdirSync(path.join(dir, 'shop-app', 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'shop-app', 'package.json'), JSON.stringify({ scripts: { dev: 'npm --prefix frontend run dev' } }));
    fs.writeFileSync(path.join(dir, 'shop-app', 'frontend', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }));
    expect(service.launchPlan(roomId, 5173)).toMatchObject({ dir: 'shop-app/frontend', install_dir: 'shop-app/frontend', needs_install: true });
  });

  it('uses only the token saved for the room’s workspace and the repository’s organization', async () => {
    const workspace = (db.prepare('SELECT workspace_id FROM rooms WHERE id = ?').get(roomId) as { workspace_id: string }).workspace_id;
    const kite = 'github_pat_' + 'k'.repeat(40);
    const dataDir = path.join(root, 'tokens');
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'github-tokens.json'), JSON.stringify({
      [workspace]: { 'kite-apps': { owner: 'Kite-Apps', token: kite }, acme: { owner: 'acme', token: 'too-short' } },
      wks_eeeeeeeeeeeeeeee: { octocat: { owner: 'octocat', token } },
    }));
    expect(workspaceGithubToken(dataDir, workspace, 'Kite-Apps')).toBe(kite);
    expect(workspaceGithubToken(dataDir, workspace, 'kite-apps')).toBe(kite);
    expect(workspaceGithubToken(dataDir, workspace, 'acme')).toBeUndefined();
    // Another workspace's token is never used here.
    expect(workspaceGithubToken(dataDir, workspace, 'octocat')).toBeUndefined();
    expect(workspaceGithubToken(dataDir, 'wks_eeeeeeeeeeeeeeee', 'octocat')).toBe(token);
    expect(workspaceGithubToken(dataDir, workspace, '__proto__')).toBeUndefined();
    expect(workspaceGithubToken(path.join(root, 'missing'), workspace, 'Kite-Apps')).toBeUndefined();
    const service = prService(ok, { token: (owner, ws) => workspaceGithubToken(dataDir, ws, owner) });
    const sandbox = await service.provision(roomId, actorId);
    await service.cloneRepo(sandbox.id, actorId, { repo: 'Kite-Apps/web-app' });
    await service.cloneRepo(sandbox.id, actorId, { repo: 'octocat/app' });
    const header = (value: string) => `Authorization: Basic ${Buffer.from(`x-access-token:${value}`).toString('base64')}`;
    const sent = fs.readFileSync(path.join(root, 'secrets.jsonl'), 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as string[])[1]);
    expect(sent).toEqual([header(kite)]);
    await expect(service.openPullRequest(sandbox.id, actorId, { repo: 'octocat/app', branch: 'ai/x', title: 't' })).rejects.toMatchObject({ code: 'SANDBOX_GITHUB_DENIED' });
  });
});

describe('repository views', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.test', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  const seedRepo = () => {
    const repo = path.join(service.workspaceDir(roomId), 'app');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'Initial commit');
    git(repo, 'checkout', '-q', '-b', 'ai/feature');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'tab\tname.txt'), 'x\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'one\ntwo\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'Add feature\n\nLonger explanation.');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/octocat/app.git');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked');
    fs.mkdirSync(path.join(service.workspaceDir(roomId), 'notes'));
    return { repo, feature: git(repo, 'rev-parse', 'ai/feature'), initial: git(repo, 'rev-parse', 'main') };
  };

  it('lists clones, branches, history across branches and uncommitted changes', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const { feature, initial } = seedRepo();
    expect(await service.gitRepos(sandbox.id, actorId)).toEqual(['app']);
    const overview = await service.gitOverview(sandbox.id, actorId, 'app');
    expect(overview).toMatchObject({ dir: 'app', branch: 'ai/feature', head: feature, repo: 'octocat/app', changes: [{ code: '??', path: 'scratch.txt' }] });
    expect(overview.branches).toEqual(expect.arrayContaining([
      { name: 'ai/feature', sha: feature, remote: false, current: true },
      { name: 'main', sha: initial, remote: false, current: false },
      { name: 'origin/main', sha: initial, remote: true, current: false },
    ]));
    expect(overview.commits).toEqual([
      { sha: feature, parents: [initial], author: 'Dev', date: expect.stringMatching(/^\d{4}-/), subject: 'Add feature' },
      { sha: initial, parents: [], author: 'Dev', date: expect.any(String), subject: 'Initial commit' },
    ]);
    expect((await service.gitOverview(sandbox.id, actorId, 'app', 1)).commits).toHaveLength(1);
    // Views never start a networked container and are not recorded as agent commands.
    expect(calls().filter((args) => args[0] === 'create').every((args) => args[args.indexOf('--network') + 1] === 'none')).toBe(true);
    expect(service.listExecs(sandbox.id)).toHaveLength(0);
    expect(Object.keys(state())).toEqual([`ach-sbx-${roomId}`]);
  });

  it('shows the files and patch of a commit and rejects unsafe or unknown targets', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const { feature } = seedRepo();
    const commit = await service.gitCommit(sandbox.id, actorId, 'app', feature.slice(0, 10));
    expect(commit).toMatchObject({ sha: feature, author: 'Dev', email: 'dev@example.test', subject: 'Add feature', message: 'Add feature\n\nLonger explanation.' });
    expect(commit.files).toEqual([{ path: 'README.md', additions: 1, deletions: 0 }, { path: 'src/tab\tname.txt', additions: 1, deletions: 0 }]);
    const patch = await service.gitPatch(sandbox.id, actorId, 'app', feature, 'README.md');
    expect(patch).toContain('+two'); expect(patch).not.toContain('tab');
    await expect(service.gitCommit(sandbox.id, actorId, 'app', 'f'.repeat(40))).rejects.toMatchObject({ code: 'SANDBOX_COMMIT_NOT_FOUND', status: 404 });
    await expect(service.gitOverview(sandbox.id, actorId, 'notes')).rejects.toMatchObject({ code: 'SANDBOX_REPO_NOT_FOUND', status: 404 });
    const before = calls().length;
    for (const attempt of [
      () => service.gitOverview(sandbox.id, actorId, '../app'), () => service.gitOverview(sandbox.id, actorId, 'app/.git'),
      () => service.gitCommit(sandbox.id, actorId, 'app', '--output=x'), () => service.gitCommit(sandbox.id, actorId, 'app', 'HEAD'),
      () => service.gitPatch(sandbox.id, actorId, 'app', feature, '../../etc/passwd'), () => service.gitPatch(sandbox.id, actorId, 'app', feature, '/etc/passwd'),
      () => service.gitCheckout(sandbox.id, actorId, 'app', '--orphan'), () => service.gitCheckout(sandbox.id, actorId, 'app', 'a..b'),
    ]) await expect(attempt()).rejects.toMatchObject({ status: 400 });
    expect(calls()).toHaveLength(before);
  });

  it('checks out a branch as a recorded command and keeps observers read-only', async () => {
    const sandbox = await service.provision(roomId, actorId);
    const { repo } = seedRepo();
    const result = await service.gitCheckout(sandbox.id, actorId, 'app', 'main');
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(service.listExecs(sandbox.id)[0]).toMatchObject({ id: result.exec_id, cmd: 'git -C app checkout main', exit_code: 0 });
    await expect(service.gitCheckout(sandbox.id, actorId, 'app', 'no-such-branch')).resolves.toMatchObject({ exitCode: 128 });
    // A branch that exists only as a fetched remote branch is created locally on checkout.
    git(repo, 'update-ref', 'refs/remotes/origin/ai/remote-only', 'ai/feature');
    await expect(service.gitCheckout(sandbox.id, actorId, 'app', 'ai/remote-only')).resolves.toMatchObject({ exitCode: 0 });
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('ai/remote-only');
    await service.gitCheckout(sandbox.id, actorId, 'app', 'main');
    db.prepare(`INSERT INTO agents (id, name, role, created_at) VALUES ('agt_observer', 'watcher', 'observer', ?)`).run(new Date().toISOString());
    await expect(service.gitCheckout(sandbox.id, 'agt_observer', 'app', 'ai/feature')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.gitOverview(sandbox.id, 'agt_observer', 'app')).resolves.toMatchObject({ branch: 'main' });
    await expect(service.gitOverview(sandbox.id, 'agt_stranger', 'app')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
  });
});
