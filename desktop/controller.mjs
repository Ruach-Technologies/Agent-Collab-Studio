import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { WorkspaceError, validateWorkspaceInput, workspaceRequest } from './workspaces.mjs';

const exec = promisify(execFile);
const commands = new Set(['status', 'validate', 'launch', 'start-tunnel', 'stop-tunnel', 'stop-hub', 'stop-all', 'workspace', 'fresh-start', 'upgrade']);
const defaultImage = 'agent-collab-sandbox:local';
/** The hub schema this checkout runs; keep in step with SCHEMA_VERSION in hub/src/db.ts. */
export const SCHEMA_VERSION = 9;
const CONFIRM = { 'fresh-start': 'START FRESH', upgrade: 'UPGRADE' };
class OperationError extends Error {}
function fail(message) { throw new OperationError(message); }

export function validateSettings(input) {
  const keys = ['repository', 'nodePath', 'npmPath', 'ngrokPath', 'sandboxImage', 'openConsole', 'tunnelOnLaunch', 'ownerName'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) fail('Invalid launcher settings.');
  for (const name of ['repository', 'nodePath', 'npmPath']) {
    if (typeof input[name] !== 'string' || !isAbsolute(input[name]) || input[name].length > 4096 || /[\x00-\x1f\x7f]/.test(input[name]) || (name !== 'repository' && input[name].includes(':'))) fail('Select absolute repository, Node and npm paths.');
  }
  if (typeof input.ngrokPath !== 'string' || (input.ngrokPath && (!isAbsolute(input.ngrokPath) || input.ngrokPath.length > 4096 || /[\x00-\x1f\x7f:]/.test(input.ngrokPath)))) fail('The ngrok executable must have an absolute path.');
  if (basename(input.nodePath) !== 'node' || basename(input.npmPath) !== 'npm' || (input.ngrokPath && basename(input.ngrokPath) !== 'ngrok')) fail('Select the node, npm and ngrok executables, not shell commands.');
  if (typeof input.openConsole !== 'boolean' || typeof input.tunnelOnLaunch !== 'boolean') fail('Invalid launch toggles.');
  const ownerName = input.ownerName ?? '';
  if (typeof ownerName !== 'string' || ownerName.length > 80 || ownerName.trim() !== ownerName || /[\x00-\x1f\x7f]/.test(ownerName)) fail('Your name must be up to 80 characters.');
  const sandboxImage = input.sandboxImage || defaultImage;
  if (typeof sandboxImage !== 'string' || sandboxImage.length > 200 || !/^[a-z0-9][a-z0-9._/:@-]*$/.test(sandboxImage) || sandboxImage.includes('..')) fail('Use a valid sandbox image name, without shell arguments.');
  return { ...input, sandboxImage, ownerName };
}

export function operationEnvironment(settings, home = homedir()) {
  const paths = [dirname(settings.nodePath), dirname(settings.npmPath), ...(settings.ngrokPath ? [dirname(settings.ngrokPath)] : []),
    join(home, '.local/bin'), join(home, '.docker/bin'), '/Applications/Docker.app/Contents/Resources/bin', '/opt/homebrew/bin', '/usr/local/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return { HOME: home, PATH: [...new Set(paths)].join(':'), LANG: 'en_US.UTF-8',
    HUB_HOST: '127.0.0.1', HUB_PORT: '8791', HUB_SANDBOX_IMAGE: settings.sandboxImage,
    HUB_DATA_DIR: join(settings.repository, 'data'), HUB_WORKSPACES_DIR: join(settings.repository, 'workspaces'),
    HUB_WEB_DIST: join(settings.repository, 'web/dist'), HUB_SANDBOX_USER: '1000:1000', HUB_LOG_LEVEL: 'info',
    HUB_NODE_BIN: settings.nodePath, HUB_NPM_BIN: settings.npmPath, HUB_NGROK_BIN: settings.ngrokPath || 'ngrok' };
}

async function limitedRead(path, max = 8192) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) fail('Unsafe or oversized local operation record; inspect the checkout runtime directory.');
  return readFile(path, 'utf8');
}
async function processInfo(pid) {
  try {
    const [{ stdout: command }, { stdout: uid }] = await Promise.all([
      exec('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 2000, maxBuffer: 16_384 }),
      exec('/bin/ps', ['-p', String(pid), '-o', 'uid='], { timeout: 2000, maxBuffer: 128 }),
    ]);
    return { command: command.trim(), uid: Number(uid.trim()) };
  } catch {
    try { process.kill(pid, 0); return { command: '', uid: -1 }; }
    catch (error) { if (error.code === 'ESRCH') return null; return { command: '', uid: -1 }; }
  }
}
function expectedCommand(command, root, kind) {
  if (kind === 'hub') return command.includes(` ${join(root, 'hub/dist/server.js')}`) && command.endsWith(join(root, 'hub/dist/server.js'));
  return command.includes(`--config ${join(root, 'infra/ngrok/agent-collab-hub.yml')}`) && command.endsWith(' agent-collab-hub');
}
async function record(root, kind) {
  const file = join(root, `.runtime/${kind}.pid`);
  let text;
  try { text = await limitedRead(file); } catch (error) { if (error.code === 'ENOENT') return { state: 'stopped', file }; throw error; }
  let pid;
  pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: 'blocked', detail: 'Invalid PID record; operator inspection required.', file };
  const info = await processInfo(pid);
  if (!info) return { state: 'stale', detail: 'Recorded process is no longer running.', pid, file, text };
  if (info.uid !== process.getuid() || !expectedCommand(info.command, root, kind)) return { state: 'blocked', detail: 'PID belongs to a different process; no action permitted.', pid, file };
  return { state: 'running', pid, file, text };
}
async function listens(pid, port) {
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 2000, maxBuffer: 1024 });
    return stdout.trim().split(/\s+/).includes(String(pid));
  } catch { return false; }
}
function localJSON(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path, timeout: 1200 }, (response) => {
      let bytes = 0, text = '';
      response.on('data', (chunk) => { bytes += chunk.length; if (bytes > 64 * 1024) request.destroy(new Error('Oversized status')); else text += chunk; });
      response.on('end', () => { try { if (response.statusCode !== 200) throw new Error('Not ready'); resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.once('timeout', () => request.destroy(new Error('Status timeout')));
    request.once('error', reject);
  });
}
function service(value) { return { state: value.state, ...(value.detail ? { detail: value.detail } : {}) }; }
const requireHere = createRequire(import.meta.url);
/** better-sqlite3 from the checkout (the packaged app's controller lives outside it), else beside this file. */
function sqlite(root) {
  try { return requireHere(join(root, 'node_modules/better-sqlite3')); } catch { return requireHere('better-sqlite3'); }
}
/** Reads the hub database without changing it: its schema version and open security alerts. */
async function databaseState(root) {
  const path = join(root, 'data/hub.sqlite');
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { database: { state: 'none', version: null, expected: SCHEMA_VERSION }, alerts: { open: 0, high: 0 } }; throw error; }
  let db;
  try {
    const Database = sqlite(root);
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2000 });
    const version = Number(db.pragma('user_version', { simple: true }));
    const state = version === SCHEMA_VERSION ? 'current' : version < SCHEMA_VERSION ? 'outdated' : 'newer';
    let alerts = { open: 0, high: 0 };
    if (state === 'current') {
      const row = db.prepare("SELECT COUNT(*) AS open, COALESCE(SUM(severity = 'high'), 0) AS high FROM security_alerts WHERE acknowledged_at IS NULL").get();
      alerts = { open: Number(row.open), high: Number(row.high) };
    }
    return { database: { state, version, expected: SCHEMA_VERSION }, alerts };
  } catch { return { database: { state: 'unreadable', version: null, expected: SCHEMA_VERSION }, alerts: { open: 0, high: 0 } }; }
  finally { db?.close(); }
}
async function docker(environment, args, timeout = 5000) {
  return exec('/usr/bin/env', ['docker', ...args], { env: environment, timeout, maxBuffer: 256 * 1024 });
}
async function snapshot(root, environment) {
  const [hub, tunnel] = await Promise.all(['hub', 'tunnel'].map((kind) => record(root, kind)));
  if (hub.state === 'running') {
    try { if (!await listens(hub.pid, 8791)) throw new Error(); await localJSON(8791, '/healthz'); }
    catch { hub.state = 'unhealthy'; hub.detail = 'Owned hub process exists but its loopback health check is unavailable.'; }
  }
  let publicUrl;
  if (tunnel.state === 'running') {
    try {
      if (!await listens(tunnel.pid, 4045)) throw new Error();
      const response = await localJSON(4045, '/api/tunnels');
      const entry = response.tunnels?.find((item) => item.name === 'agent-collab-hub' && item.proto === 'https' &&
        ['http://127.0.0.1:8791', '127.0.0.1:8791'].includes(item.config?.addr));
      const url = new URL(entry?.public_url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw new Error();
      publicUrl = url.href;
    } catch { tunnel.state = 'unhealthy'; tunnel.detail = 'Owned tunnel process exists, but its public endpoint is not verified.'; }
  }
  let dockerAvailable = false;
  let gate = { state: 'unknown' };
  try { await docker(environment, ['info', '--format', '{{.ServerVersion}}'], 2000); dockerAvailable = true; } catch {}
  if (dockerAvailable) {
    try {
      const { stdout } = await docker(environment, ['inspect', '--type', 'container', '--format', '{{.State.Running}}', 'ach-egress-gate-8791'], 2000);
      gate = { state: stdout.trim() === 'true' ? 'running' : 'stopped' };
    } catch { gate = { state: 'stopped' }; }
  }
  return { hub: service(hub), tunnel: service(tunnel), publicUrl, dockerAvailable, gate, ...await databaseState(root) };
}

async function validateRuntime(settings) {
  const root = await realpath(settings.repository);
  const stat = await lstat(root);
  if (!stat.isDirectory()) fail('Select the agent-collab-hub repository directory.');
  const manifest = JSON.parse(await limitedRead(join(root, 'package.json')));
  if (manifest.name !== 'agent-collab-hub') fail('Selected folder is not the Agent Collab Hub checkout.');
  for (const script of ['infra/scripts/start-hub.sh', 'infra/scripts/start-tunnel.sh', 'hub/scripts/manage.mjs', 'hub/scripts/init-database.mjs']) {
    if (!(await lstat(join(root, script))).isFile()) fail('Required operation scripts are missing.');
  }
  for (const path of [settings.nodePath, settings.npmPath]) await access(path, constants.X_OK);
  const env = operationEnvironment({ ...settings, repository: root });
  let major;
  try { const { stdout } = await exec(settings.nodePath, ['--version'], { env, timeout: 3000, maxBuffer: 1024 }); major = Number(/^v(\d+)\./.exec(stdout)?.[1]); }
  catch { fail('The selected Node executable did not run.'); }
  if (!(major >= 22)) fail('Node.js 22 or newer is required.');
  if (settings.ngrokPath) await access(settings.ngrokPath, constants.X_OK);
  const runtime = join(root, '.runtime');
  try { const stat = await lstat(runtime); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Runtime directory is unsafe.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { root, environment: env };
}
async function lock(root) {
  const directory = join(root, '.runtime');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'launcher.lock');
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('Another launcher operation is active, or its lock needs operator inspection.'); throw error; }
  const text = JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString('hex') });
  await handle.writeFile(text); await handle.close();
  return async () => { if (await limitedRead(path) === text) await unlink(path); };
}
async function runScript(root, environment, path, args = []) {
  // The runner is selected from validated settings via PATH; peer input is never shell source.
  try {
    if (path.endsWith('.mjs')) await exec(environment.HUB_NODE_BIN, [join(root, path), ...args], { cwd: root, env: environment, timeout: 185_000, maxBuffer: 64 * 1024 });
    else await exec('/bin/bash', [join(root, path), ...args], { cwd: root, env: environment, timeout: 185_000, maxBuffer: 64 * 1024 });
  } catch { fail('Operation did not complete. Inspect this checkout’s private runtime logs and refresh status; no success is implied.'); }
}
async function stopOwned(root, kind) {
  const before = await record(root, kind);
  if (before.state === 'stopped') return;
  if (before.state === 'blocked') fail(`Refusing to stop ${kind}: the PID is not owned by this checkout.`);
  if (before.state === 'stale') {
  } else {
    // Verify the same record immediately before sending the only allowed signal.
    const current = await record(root, kind);
    if (current.state !== 'running' || current.pid !== before.pid) fail('Process ownership changed; no signal was sent.');
    process.kill(current.pid, 'SIGTERM');
    const deadline = Date.now() + 12_000;
    let exited = false;
    while (Date.now() < deadline) {
      const info = await processInfo(current.pid);
      if (!info) { exited = true; break; }
      if (info.uid !== process.getuid() || !expectedCommand(info.command, root, kind)) fail('Process identity changed during shutdown; inspect status.');
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!exited) fail('Process did not exit after SIGTERM; no forced kill was sent.');
  }
  if (await limitedRead(before.file).catch(() => null) === before.text) await unlink(before.file);
  if (kind === 'tunnel') {
    const urlFile = join(root, '.runtime/tunnel-url');
    try { await limitedRead(urlFile); await unlink(urlFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function ensureHub(root, environment, { allowUpgrade = false } = {}) {
  const current = await record(root, 'hub');
  if (current.state === 'running') {
    if (!await listens(current.pid, 8791)) fail('Recorded hub is not listening on the expected loopback port.');
    try { await localJSON(8791, '/healthz'); } catch { fail('Recorded hub process is not healthy; stop it explicitly before restarting.'); }
    return;
  }
  if (current.state === 'blocked') fail('Hub PID is not owned by this checkout.');
  // Never change an existing database as a side effect of Launch.
  const { database } = await databaseState(root);
  if (database.state === 'outdated' && !allowUpgrade) fail('This hub\'s data is from an older version. Choose Start fresh or Upgrade; nothing was changed.');
  if (database.state === 'newer') fail('This hub\'s data is from a newer version than this checkout. Update the checkout; nothing was changed.');
  if (database.state === 'unreadable') fail('The hub database could not be read. Inspect data/hub.sqlite; nothing was changed.');
  await runScript(root, environment, 'infra/scripts/start-hub.sh');
}
/** A private, dated folder for backups outside the checkout. */
async function backupFolder(kind) {
  const base = join(homedir(), 'Library/Application Support/Agent Collab Hub/backups');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const folder = join(base, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(folder, { mode: 0o700 });
  return folder;
}
/** Container names the old database owns (room workspaces, dev servers, sidekicks). */
function ownedContainers(root) {
  let db;
  try {
    const Database = sqlite(root);
    db = new Database(join(root, 'data/hub.sqlite'), { readonly: true, fileMustExist: true });
    const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const names = has('sandboxes') ? db.prepare('SELECT id, container_name FROM sandboxes').all().flatMap((row) => [row.container_name, `ach-dev-${row.id}`]) : [];
    if (has('sidekicks')) names.push(...db.prepare('SELECT id FROM sidekicks').all().map((row) => `ach-sidekick-${row.id}`));
    return names.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name));
  } catch { return []; } finally { db?.close(); }
}
/**
 * Deletes one workspace while the hub keeps running: copies the database into a private backup,
 * removes the workspace's records, takes down its containers and sidekick storage, and moves its
 * room folders into the same backup.
 */
async function deleteWorkspace(root, environment, settings, input, ops) {
  const folder = await backupFolder('delete-workspace');
  let db;
  try {
    const Database = sqlite(root);
    db = new Database(join(root, 'data/hub.sqlite'), { fileMustExist: true, timeout: 5000 });
    db.prepare('VACUUM INTO ?').run(join(folder, 'hub.sqlite'));
  } catch { fail(`Could not back up the database first; nothing was deleted. Backup folder: ${folder}`); }
  finally { db?.close(); }
  const result = await ops.workspaceRequest(input, root, settings, environment);
  if (result.containers?.length) { try { await docker(environment, ['rm', '-f', ...result.containers], 60_000); } catch { /* already gone */ } }
  for (const volume of result.volumes ?? []) {
    if (/^ach-sidekick-skk_[a-f0-9]{16}-home$/.test(volume)) { try { await docker(environment, ['volume', 'rm', '-f', volume], 30_000); } catch { /* already gone */ } }
  }
  await mkdir(join(folder, 'workspaces'), { mode: 0o700 });
  for (const room of result.rooms ?? []) {
    if (!/^room_[a-f0-9]{16}$/.test(room)) continue;
    try { await rename(join(root, 'workspaces', room), join(folder, 'workspaces', room)); } catch { /* no files */ }
  }
  return { deleted: result.deleted, backup: folder };
}
/** Stops everything, moves data and room files into a private backup, and starts an empty hub. */
async function freshStart(root, environment, ops) {
  const tunnelWasUp = (await ops.record(root, 'tunnel')).state === 'running';
  await ops.stopOwned(root, 'tunnel'); await ops.stopOwned(root, 'hub');
  const containers = ownedContainers(root);
  const folder = await backupFolder('fresh-start');
  for (const name of ['data', 'workspaces']) {
    try { await rename(join(root, name), join(folder, name)); }
    catch (error) { if (error.code !== 'ENOENT') fail(`Could not move ${name} into the backup; the hub was left stopped. Backup folder: ${folder}`); }
  }
  // Their files are in the backup; the containers themselves hold nothing to keep.
  if (containers.length) { try { await docker(environment, ['rm', '-f', ...containers], 60_000); } catch { /* already gone */ } }
  await mkdir(join(root, 'data'), { mode: 0o700 }); await mkdir(join(root, 'workspaces'), { mode: 0o700 });
  try { await exec(environment.HUB_NPM_BIN, ['run', 'build', '--workspace', 'hub'], { cwd: root, env: environment, timeout: 180_000, maxBuffer: 1024 * 1024 }); }
  catch { fail(`The hub did not build; it was left stopped. Your old data is in ${folder}.`); }
  try { await exec(environment.HUB_NODE_BIN, [join(root, 'hub/scripts/init-database.mjs')], { cwd: root, env: { ...environment, HUB_DB: join(root, 'data/hub.sqlite') }, timeout: 30_000, maxBuffer: 64 * 1024 }); }
  catch { fail(`Could not create the new database; the hub was left stopped. Your old data is in ${folder}.`); }
  await ops.ensureHub(root, environment);
  if (tunnelWasUp) await ops.ensureTunnel(root, environment, { ngrokPath: environment.HUB_NGROK_BIN });
  return { backup: folder, removedContainers: containers.length };
}
/** Stops the hub, copies the database files aside, and starts the new version, which migrates it. */
async function upgrade(root, environment, ops) {
  const { database } = await databaseState(root);
  if (database.state !== 'outdated') fail('The database does not need an upgrade.');
  const tunnelWasUp = (await ops.record(root, 'tunnel')).state === 'running';
  await ops.stopOwned(root, 'tunnel'); await ops.stopOwned(root, 'hub');
  const folder = await backupFolder('upgrade');
  for (const name of await readdir(join(root, 'data'))) {
    if (/^hub\.sqlite(-wal|-shm)?$/.test(name) || name === 'operator.json') await copyFile(join(root, 'data', name), join(folder, name));
  }
  await ops.ensureHub(root, environment, { allowUpgrade: true });
  if (tunnelWasUp) await ops.ensureTunnel(root, environment, { ngrokPath: environment.HUB_NGROK_BIN });
  return { backup: folder };
}
async function ensureTunnel(root, environment, settings) {
  if (!settings.ngrokPath) fail('Select the installed ngrok executable first.');
  const state = await snapshot(root, environment);
  if (state.hub.state !== 'running') fail('Start a healthy local hub before starting its tunnel.');
  if (state.tunnel.state === 'running') return;
  const process = await record(root, 'tunnel');
  if (process.state === 'running' || process.state === 'blocked') fail('A recorded tunnel needs inspection before starting another one.');
  await runScript(root, environment, 'infra/scripts/start-tunnel.sh');
}

// Dependency injection is an in-process test seam only; JSON requests cannot supply it.
export async function executeRequest(request, overrides = {}) {
  const ops = { validateRuntime, snapshot, record, lock, runScript, stopOwned, ensureHub, ensureTunnel, workspaceRequest, freshStart, upgrade, deleteWorkspace, ...overrides };
  try {
    if (!request || !commands.has(request.command) || Object.keys(request).some((key) => !['command', 'settings', 'workspace', 'confirm'].includes(key)) ||
      (request.command !== 'workspace' && request.workspace !== undefined) || (!CONFIRM[request.command] && request.confirm !== undefined)) fail('Unknown launcher operation.');
    if (CONFIRM[request.command] && request.confirm !== CONFIRM[request.command]) fail(`Type ${CONFIRM[request.command]} to confirm.`);
    const settings = validateSettings(request.settings);
    const { root, environment } = await ops.validateRuntime(settings);
    if (request.command === 'status' || request.command === 'validate') return { ok: true,
      message: request.command === 'validate' ? 'Settings saved. Changes apply on the next hub start; running services were not changed.' : 'Status refreshed.',
      snapshot: await ops.snapshot(root, environment) };
    const workspace = async () => {
      try {
        const publicUrl = request.workspace?.action === 'create-invite' || request.workspace?.action === 'sign-in-link' ? (await ops.snapshot(root, environment)).publicUrl : undefined;
        return { ok: true, message: 'Done.', data: await ops.workspaceRequest(request.workspace, root, settings, environment, publicUrl ? { publicUrl } : {}) };
      } catch (error) {
        return { ok: false, message: error instanceof WorkspaceError && error.message.length < 400 && !/ach[a-z]?_[A-Za-z0-9_-]{20,}/.test(error.message)
          ? error.message : 'Workspace operation failed. Refresh and try again.' };
      }
    };
    if (request.command === 'workspace' && request.workspace?.action === 'list') return workspace();
    const unlock = await ops.lock(root);
    try {
      let data;
      switch (request.command) {
        case 'workspace':
          if (request.workspace?.action === 'delete-workspace') {
            try {
              const deleted = await ops.deleteWorkspace(root, environment, settings, validateWorkspaceInput(request.workspace), ops);
              return { ok: true, message: `Workspace “${deleted.deleted?.name ?? ''}” deleted. A backup is in your private backups folder.`, data: deleted };
            } catch (error) {
              if (error instanceof OperationError) throw error;
              return { ok: false, message: error instanceof WorkspaceError && error.message.length < 400 ? error.message : 'The workspace could not be deleted. Refresh and try again.' };
            }
          }
          return await workspace();
        case 'launch':
          await ops.ensureHub(root, environment);
          if (settings.tunnelOnLaunch) await ops.ensureTunnel(root, environment, settings);
          break;
        case 'start-tunnel': await ops.ensureTunnel(root, environment, settings); break;
        case 'stop-tunnel': await ops.stopOwned(root, 'tunnel'); break;
        case 'stop-hub': {
          if (['running', 'blocked'].includes((await ops.record(root, 'tunnel')).state)) fail('Stop the tunnel first.');
          await ops.stopOwned(root, 'hub'); break;
        }
        case 'stop-all': await ops.stopOwned(root, 'tunnel'); await ops.stopOwned(root, 'hub'); break;
        case 'fresh-start': data = await ops.freshStart(root, environment, ops); break;
        case 'upgrade': data = await ops.upgrade(root, environment, ops); break;
      }
      const message = request.command === 'fresh-start' ? 'The hub started fresh. Your old data is in a private backup.'
        : request.command === 'upgrade' ? 'The hub was upgraded. A copy of the old database is in a private backup.'
          : 'Done. Room files, history and containers were kept.';
      return { ok: true, message, snapshot: await ops.snapshot(root, environment), ...(data ? { data } : {}) };
    } finally { await unlock(); }
  } catch (error) {
    return { ok: false, message: error instanceof OperationError ? error.message : 'Local operation failed. Check executable paths, permissions and private runtime records; no success is implied.' };
  }
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 16_384) fail('Launcher request is too large.');
  }
  let request;
  try { request = JSON.parse(text); } catch { fail('Invalid launcher request.'); }
  const result = await executeRequest(request);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.log(JSON.stringify({ ok: false, message: 'Invalid local launcher request.' })); process.exitCode = 1;
});
