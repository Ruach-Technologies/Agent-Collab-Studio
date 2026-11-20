import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeRequest, operationEnvironment, validateSettings } from './controller.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = { repository: root, nodePath: process.execPath, npmPath: join(dirname(process.execPath), 'npm'), ngrokPath: '',
  sandboxImage: 'agent-collab-sandbox:local', openConsole: true, tunnelOnLaunch: false, ownerName: 'Alex' };

test('settings are bounded, fixed-schema and permit paths with spaces without shell parsing', () => {
  const settings = validateSettings({ ...base, repository: '/tmp/a checkout; not shell', nodePath: '/tmp/node tools/node', npmPath: '/tmp/node tools/npm' });
  assert.equal(settings.repository, '/tmp/a checkout; not shell');
  for (const patch of [{ repository: 'relative' }, { nodePath: '/bin/bash' }, { nodePath: '/tmp/a:bin/node' },
    { tunnelOnLaunch: 'yes' }, { token: 'secret' }, { ownerName: 'x\n' }, { sandboxImage: 'image; touch /tmp/pwn' }, { ngrokPath: '/tmp/ngrok\n' }]) {
    assert.throws(() => validateSettings({ ...base, ...patch }));
  }
});

test('operation environment never inherits credential, proxy, Node or alternate data overrides', () => {
  const env = operationEnvironment({ ...base, repository: '/tmp/my hub' }, '/tmp/private home');
  assert.equal(env.HUB_DATA_DIR, '/tmp/my hub/data');
  assert.equal(env.HUB_WORKSPACES_DIR, '/tmp/my hub/workspaces');
  assert.equal(env.HUB_HOST, '127.0.0.1'); assert.equal(env.HUB_PORT, '8791');
  assert.equal(env.HUB_SANDBOX_USER, '1000:1000');
  for (const key of ['HUB_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'NGROK_AUTHTOKEN', 'BASH_ENV']) assert.equal(env[key], undefined);
  assert.equal(env.PATH.split(':')[0], dirname(base.nodePath));
});

function mocks() {
  const calls = [];
  const ops = {
    validateRuntime: async () => ({ root: '/tmp/fixture', environment: {} }),
    snapshot: async () => ({ hub: { state: 'stopped' }, tunnel: { state: 'stopped' }, dockerAvailable: false }),
    lock: async () => { calls.push('lock'); return async () => calls.push('unlock'); },
    ensureHub: async () => calls.push('hub'),
    ensureTunnel: async () => calls.push('tunnel'),
    stopOwned: async (_, kind) => calls.push(`stop-${kind}`),
    record: async () => ({ state: 'stopped' }),
    freshStart: async () => { calls.push('fresh'); return { backup: '/tmp/backup' }; },
    upgrade: async () => { calls.push('upgrade'); return { backup: '/tmp/backup' }; },
  };
  return { calls, ops };
}

test('status and settings validation never start a service or take a mutating lock', async () => {
  const { calls, ops } = mocks();
  assert.equal((await executeRequest({ command: 'status', settings: base }, ops)).ok, true);
  assert.equal((await executeRequest({ command: 'validate', settings: base }, ops)).ok, true);
  assert.deepEqual(calls, []);
});

test('workspace catalog reads do not create a mutating operation lock', async () => {
  const { calls, ops } = mocks();
  ops.workspaceRequest = async () => ({ workspaces: [] });
  assert.equal((await executeRequest({ command: 'workspace', workspace: { action: 'list' }, settings: base }, ops)).ok, true);
  assert.deepEqual(calls, []);
});

test('Launch starts only the hub by default; selected tunnel starts after the hub', async () => {
  const { calls, ops } = mocks();
  assert.equal((await executeRequest({ command: 'launch', settings: base }, ops)).ok, true);
  assert.deepEqual(calls, ['lock', 'hub', 'unlock']); calls.length = 0;
  assert.equal((await executeRequest({ command: 'launch', settings: { ...base, tunnelOnLaunch: true } }, ops)).ok, true);
  assert.deepEqual(calls, ['lock', 'hub', 'tunnel', 'unlock']);
});

test('tunnel-only stop never stops the hub', async () => {
  const { calls, ops } = mocks();
  assert.equal((await executeRequest({ command: 'stop-tunnel', settings: base }, ops)).ok, true);
  assert.deepEqual(calls, ['lock', 'stop-tunnel', 'unlock']);
});

test('Stop Hub refuses to strand a running tunnel', async () => {
  const { calls, ops } = mocks(); ops.record = async () => ({ state: 'running' });
  assert.equal((await executeRequest({ command: 'stop-hub', settings: base }, ops)).ok, false);
  assert.deepEqual(calls, ['lock', 'unlock']);
});

test('Stop All stops the tunnel before the hub', async () => {
  const { calls, ops } = mocks();
  assert.equal((await executeRequest({ command: 'stop-all', settings: base }, ops)).ok, true);
  assert.deepEqual(calls, ['lock', 'stop-tunnel', 'stop-hub', 'unlock']);
});

test('Start fresh and Upgrade need their exact confirmation and return the backup folder', async () => {
  const { calls, ops } = mocks();
  for (const confirm of [undefined, 'start fresh', 'yes']) assert.equal((await executeRequest({ command: 'fresh-start', settings: base, ...(confirm ? { confirm } : {}) }, ops)).ok, false);
  assert.equal((await executeRequest({ command: 'upgrade', settings: base, confirm: 'START FRESH' }, ops)).ok, false);
  assert.equal((await executeRequest({ command: 'launch', settings: base, confirm: 'START FRESH' }, ops)).ok, false);
  assert.deepEqual(calls, []);
  const fresh = await executeRequest({ command: 'fresh-start', settings: base, confirm: 'START FRESH' }, ops);
  assert.equal(fresh.ok, true); assert.equal(fresh.data.backup, '/tmp/backup');
  assert.equal((await executeRequest({ command: 'upgrade', settings: base, confirm: 'UPGRADE' }, ops)).ok, true);
  assert.deepEqual(calls, ['lock', 'fresh', 'unlock', 'lock', 'upgrade', 'unlock']);
});

test('deleting a workspace goes through the backed-up path under the lock, never the plain bridge', async () => {
  const { calls, ops } = mocks();
  ops.workspaceRequest = async () => { calls.push('plain'); return {}; };
  ops.deleteWorkspace = async (_, __, ___, input) => { calls.push(`delete:${input.confirmName}`); return { deleted: { name: 'Harbor' }, backup: '/tmp/b' }; };
  const result = await executeRequest({ command: 'workspace', settings: base, workspace: { action: 'delete-workspace', workspaceId: 'wks_1111111111111111', confirmName: 'Harbor' } }, ops);
  assert.equal(result.ok, true); assert.match(result.message, /Harbor/); assert.equal(result.data.backup, '/tmp/b');
  assert.deepEqual(calls, ['lock', 'delete:Harbor', 'unlock']);
});

test('unknown commands and injected settings fail before runtime operations', async () => {
  const { calls, ops } = mocks();
  assert.equal((await executeRequest({ command: 'rm', settings: base }, ops)).ok, false);
  assert.equal((await executeRequest({ command: 'launch', settings: { ...base, token: 'no' } }, ops)).ok, false);
  assert.deepEqual(calls, []);
});

async function fixture(t) {
  const runtime = join(root, '.runtime'); await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'launcher fixture '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'infra/scripts'), { recursive: true });
  await mkdir(join(directory, 'hub/scripts'), { recursive: true });
  await mkdir(join(directory, '.runtime'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'agent-collab-hub' }));
  for (const file of ['infra/scripts/start-hub.sh', 'infra/scripts/start-tunnel.sh', 'hub/scripts/manage.mjs', 'hub/scripts/init-database.mjs']) {
    await writeFile(join(directory, file), '# fixture: never executed by status\n');
  }
  return { directory, settings: { ...base, repository: directory } };
}

test('real bridge ignores stale URL, refuses unrelated PID, and does not signal it', async (t) => {
  const { directory, settings } = await fixture(t);
  await writeFile(join(directory, '.runtime/tunnel-url'), 'https://stale.example.test/');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  await writeFile(join(directory, '.runtime/tunnel.pid'), String(child.pid));
  const result = await executeRequest({ command: 'status', settings });
  assert.equal(result.ok, true); assert.equal(result.snapshot.tunnel.state, 'blocked');
  assert.equal(result.snapshot.publicUrl, undefined);
  const stop = await executeRequest({ command: 'stop-tunnel', settings });
  assert.equal(stop.ok, false); assert.match(stop.message, /not owned/);
  process.kill(child.pid, 0);
});

test('Launch refuses an old database without migrating it or starting scripts, and status reports it', async (t) => {
  const { directory, settings } = await fixture(t);
  await mkdir(join(directory, 'data'));
  const Database = (await import('node:module')).createRequire(import.meta.url)('better-sqlite3');
  const old = new Database(join(directory, 'data/hub.sqlite')); old.pragma('user_version = 1'); old.close();
  const status = await executeRequest({ command: 'status', settings });
  assert.deepEqual(status.snapshot.database, { state: 'outdated', version: 1, expected: 9 });
  const result = await executeRequest({ command: 'launch', settings });
  assert.equal(result.ok, false); assert.match(result.message, /older version/);
  const check = new Database(join(directory, 'data/hub.sqlite'), { readonly: true });
  assert.equal(check.pragma('user_version', { simple: true }), 1); check.close();
  await assert.rejects(readFile(join(directory, '.runtime/hub.pid')), { code: 'ENOENT' });
});
test('workspace bridge never returns raw filesystem or credential errors', async () => {
  const { ops } = mocks();
  ops.workspaceRequest = async () => { throw new Error('private path SECRET_FILE and credential SECRET_CREDENTIAL'); };
  const result = await executeRequest({ command: 'workspace', settings: base, workspace: { action: 'list' } }, ops);
  assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('JSON bridge works with minimal Finder PATH and invalid requests expose no supplied secrets', async (t) => {
  const { settings } = await fixture(t);
  const run = (input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'desktop/controller.mjs')], {
      env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', HUB_TOKEN: 'ach_NEVER_ECHO_THIS', NODE_OPTIONS: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = ''; child.stdout.on('data', (c) => stdout += c); child.stderr.on('data', (c) => stderr += c);
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
  const valid = await run({ command: 'status', settings });
  assert.equal(valid.code, 0); assert.equal(JSON.parse(valid.stdout).snapshot.hub.state, 'stopped');
  const invalid = await run({ command: 'unknown', settings: { ...settings, token: 'SECRET_INPUT' } });
  assert.equal(invalid.code, 1); assert.doesNotMatch(invalid.stdout + invalid.stderr, /SECRET_INPUT|NEVER_ECHO_THIS/);
});

test('real bridge cleans up a stale PID under lock without following old public URL', async (t) => {
  const { directory, settings } = await fixture(t);
  await writeFile(join(directory, '.runtime/tunnel.pid'), '2147483647');
  await writeFile(join(directory, '.runtime/tunnel-url'), 'https://stale.example.test/');
  const result = await executeRequest({ command: 'stop-tunnel', settings });
  assert.equal(result.ok, true);
  await assert.rejects(readFile(join(directory, '.runtime/tunnel.pid')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, '.runtime/tunnel-url')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, '.runtime/launcher.lock')), { code: 'ENOENT' });
});
