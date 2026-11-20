/**
 * One hardened room container and a shared workspace per room. Commands run in
 * short-lived containers with the same workspace: exiting PID 1 or removing the
 * execution container also terminates background children. Docker, not the
 * command denylist, is the isolation boundary. Only the fixed GitHub fetch
 * script ever runs with network access; agent commands never do.
 */
import type { EgressGate, EgressProfile } from './egress.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import { newId, nowIso } from './db.js';
import { canReadRoom } from './access.js';
import { detectLaunchPlan, type LaunchPlan } from './launchplan.js';
import type { Agent } from './types.js';

export type SandboxStatus = 'unprovisioned' | 'provisioning' | 'running' | 'stopped' | 'error';

export interface SandboxRow {
  id: string;
  room_id: string;
  container_id: string | null;
  container_name: string;
  image: string;
  status: SandboxStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecResult {
  exec_id?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class SandboxError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export function isSandboxError(err: unknown): err is SandboxError {
  return err instanceof SandboxError;
}

export interface SandboxConfig {
  image: string;
  workspacesDir: string;
  execTimeoutMs: number;
  maxExecTimeoutMs?: number;
  outputCapBytes: number;
  memLimitMB: number;
  cpus: number;
  pidsLimit: number;
  containerUser: string;
  denylist: string[];
  dockerBin?: string;
  /** Host files copied into every workspace root and cloned repository root. */
  seedFiles?: SeedFile[];
  /**
   * GitHub credentials: a fixed token (tests), or the token saved for the room's workspace and the
   * repository's owner, looked up on every request.
   */
  github?: { token?: string | undefined | ((owner: string, workspaceId: string | null) => string | undefined); prBranchPrefix?: string };
  /** Injectable for tests; defaults to the global fetch. */
  githubFetch?: typeof fetch;
  cloneTimeoutMs?: number;
}

export interface SeedFile { name: string; source: string; }

export interface RepoRequest { repo: string; dir?: string | undefined; ref?: string | undefined; }
export interface RepoResult extends ExecResult {
  action: 'clone' | 'update';
  repo: string;
  dir: string;
  seeded: string[];
}

/** Accepts `owner/name` or an https://github.com URL; nothing else is ever fetched. */
export function parseGithubRepo(input: string): { slug: string; name: string; url: string } {
  const match = typeof input === 'string' && input.length <= 300
    ? /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(input.trim())
    : null;
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new SandboxError('SANDBOX_REPO_INVALID', 400, 'Use owner/name or an https://github.com/owner/name URL');
  }
  const slug = `${match[1]}/${match[2]}`;
  return { slug, name: match[2]!, url: `https://github.com/${slug}.git` };
}

// The network container only ever runs this fixed script from /tmp. It never
// runs git inside an existing (agent-writable) repository, whose config or
// hooks could otherwise execute with network access or the clone credential.
const FETCH_SCRIPT = String.raw`
set -eu
url=$1; dir=/workspace/$2; ref=$3; tmp=/workspace/$4; shift 4
if [ -e "$dir" ] || [ -L "$dir" ]; then
  if [ -L "$dir" ] || [ ! -d "$dir/.git" ]; then echo "target directory exists and is not a git clone" >&2; exit 64; fi
  git clone --quiet --bare --no-tags -- "$url" "$tmp"
else
  git clone --no-recurse-submodules ${"${ref:+--branch \"$ref\"}"} -- "$url" "$dir"
  for name in "$@"; do printf '%s\n' "/$name" >> "$dir/.git/info/exclude"; done
fi
`;

export interface PullRequestInput { repo: string; dir?: string | undefined; branch: string; title: string; body?: string | undefined; base?: string | undefined; }
export interface PullRequestResult extends ExecResult { repo: string; branch: string; base: string; url: string; number: number; }

// Runs with network and the credential, so it must not execute anything the
// agent controls. It copies the branch into a fresh repository it creates
// itself (the agent's repository is only read through upload-pack, which runs
// no hooks) and pushes from that copy. No force: existing history is never rewritten.
const PUSH_SCRIPT = String.raw`
set -eu
url=$1; src=/workspace/$2; branch=$3; out=/workspace/$4
if [ -e "$out" ] || [ -L "$out" ]; then echo "push staging path already exists" >&2; exit 66; fi
if [ -L "$src" ] || [ ! -d "$src/.git" ] || [ -L "$src/.git" ]; then echo "directory is not a git clone" >&2; exit 64; fi
trap 'rm -rf "$out"' EXIT
git init --quiet --bare "$out"
git --git-dir="$out" fetch --quiet --no-tags "file://$src" "refs/heads/$branch:refs/heads/$branch" || { echo "branch $branch not found in the workspace clone" >&2; exit 67; }
git --git-dir="$out" push --porcelain "$url" "refs/heads/$branch:refs/heads/$branch"
`;

export interface GitBranch { name: string; sha: string; remote: boolean; current: boolean; }
export interface GitCommit { sha: string; parents: string[]; author: string; date: string; subject: string; }
export interface GitOverview {
  dir: string; branch: string | null; head: string | null; repo: string | null;
  branches: GitBranch[]; commits: GitCommit[]; changes: { code: string; path: string }[];
}
export interface GitCommitDetail extends GitCommit { email: string; message: string; files: { path: string; additions: number | null; deletions: number | null }[]; }

// Read-only repository views. Sections are split on the ASCII group separator,
// records on the record separator and fields on the unit separator.
// Installs npm dependencies with lifecycle scripts off, from the public registry only, then removes
// its download cache. Exit 64: no such folder or package.json; 65: the image has no npm.
const INSTALL_SCRIPT = String.raw`
set -u
cd "/workspace/$1" 2>/dev/null || { echo "There is no folder \"$1\" in the workspace." >&2; exit 64; }
[ -f package.json ] || { echo "There is no package.json in \"$1\", so npm has nothing to install." >&2; exit 64; }
command -v npm >/dev/null 2>&1 || { echo "This workspace was set up without Node, so it cannot install npm packages. Ask the host to set it up with the Node image." >&2; exit 65; }
cache="/workspace/$2"
export npm_config_cache="$cache" npm_config_registry=https://registry.npmjs.org/ npm_config_ignore_scripts=true \
  npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false npm_config_progress=false npm_config_loglevel=warn
if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci; else npm install; fi
status=$?
rm -rf "$cache"
[ "$status" -eq 0 ] && echo "Packages downloaded."
exit "$status"
`;

// Phase two, with no network: runs the downloaded packages' install scripts (native builds use the
// image's compiler and Node's bundled headers).
const INSTALL_SCRIPTS_SCRIPT = String.raw`
set -u
cd "/workspace/$1" || exit 64
export npm_config_nodedir=/usr/local npm_config_cache=/tmp/npm-cache npm_config_update_notifier=false npm_config_fund=false \
  npm_config_audit=false npm_config_loglevel=warn npm_config_offline=true
if npm rebuild --foreground-scripts; then
  echo "Install scripts ran with no internet access."
else
  echo "Some install scripts failed. They run without internet access, so a script that downloads extra files (for example a browser for testing) cannot finish." >&2
  exit 1
fi
`;

const GIT_REPOS_SCRIPT = String.raw`
for entry in /workspace/*/; do [ -d "$entry.git" ] && basename "$entry"; done
exit 0
`;
const GIT_LOG_SCRIPT = String.raw`
cd "/workspace/$1" 2>/dev/null && [ -d .git ] || exit 64
export GIT_OPTIONAL_LOCKS=0
git symbolic-ref -q --short HEAD || true
printf '\035'
git rev-parse -q --verify HEAD || true
printf '\035'
git config --get remote.origin.url || true
printf '\035'
git for-each-ref --format='%(refname)%1f%(objectname)' refs/heads refs/remotes
printf '\035'
git --no-pager log --all --topo-order -n "$2" --format='%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e' 2>/dev/null || true
printf '\035'
git status --porcelain=v1 -z --no-renames -uall | head -c 60000
`;
const GIT_COMMIT_SCRIPT = String.raw`
cd "/workspace/$1" 2>/dev/null && [ -d .git ] || exit 64
export GIT_OPTIONAL_LOCKS=0
git cat-file -e "$2^{commit}" 2>/dev/null || exit 65
if [ -n "$3" ]; then
  git --no-pager show --format= --no-renames --no-color --diff-merges=first-parent "$2" -- "$3"
else
  git --no-pager show --no-patch --format='%H%x1f%P%x1f%an%x1f%aI%x1f%ae%x1f%B' "$2"
  printf '\035'
  git --no-pager show --format= --numstat -z --no-renames --diff-merges=first-parent "$2"
fi
`;
const GIT_CHECKOUT_SCRIPT = String.raw`
cd "/workspace/$1" 2>/dev/null && [ -d .git ] || { echo "not a git repository" >&2; exit 64; }
git checkout "$2" --
`;

// Offline half of an update: fast-forward from the freshly fetched bare copy.
const UPDATE_SCRIPT = String.raw`
set -u
url=$1; dir=/workspace/$2; tmp=/workspace/$3; fetched=$4
trap 'rm -rf "$tmp"' EXIT
[ "$fetched" = ok ] || exit 0
if [ "$(git -C "$dir" config --get remote.origin.url)" != "$url" ]; then echo "target directory is a clone of a different repository" >&2; exit 65; fi
git -C "$dir" fetch --no-recurse-submodules "$tmp" '+refs/heads/*:refs/remotes/origin/*' || exit $?
branch=$(git -C "$dir" symbolic-ref -q --short HEAD) || { echo "detached HEAD: remote refs refreshed, nothing merged"; exit 0; }
git -C "$dir" merge --ff-only "refs/remotes/origin/$branch"
`;

const BASE_DENYLIST = [
  'docker', 'podman', 'nc', 'ncat', 'netcat', 'socat', 'curl', 'wget',
  'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nmap', 'sudo', 'su', 'ping',
  'nslookup', 'dig', 'whois', 'traceroute', 'base64', 'chmod', 'chown',
  'dd', 'mkfs', 'fdisk', 'parted', 'mount', 'umount', 'kill', 'killall',
  'pkill', 'reboot', 'shutdown', 'poweroff', 'halt', 'init', 'systemctl',
  'service', 'crontab', 'chattr', 'lsattr',
];

export function checkCommandPolicy(cmd: string, denylist: string[] = []): { ok: true } | { ok: false; reason: string } {
  if (!cmd.trim() || cmd.includes('\0') || Buffer.byteLength(cmd, 'utf8') > 8_000) {
    return { ok: false, reason: 'invalid command' };
  }
  for (const banned of new Set([...BASE_DENYLIST, ...denylist])) {
    const escaped = banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escaped && new RegExp(`(^|[\\s;&|(/])${escaped}([^\\w-]|$)`, 'i').test(cmd)) {
      return { ok: false, reason: 'command denied by policy' };
    }
  }
  return { ok: true };
}

export function sandboxPath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length > 500 || relPath.includes('\0') ||
      relPath.startsWith('/') || relPath.includes('\\') || relPath.split('/').includes('..')) {
    throw new SandboxError('SANDBOX_PATH_INVALID', 400, 'Use a relative workspace path without traversal');
  }
  return relPath.split('/').filter((segment) => segment !== '' && segment !== '.').join('/');
}

/** One shared byte budget covers both output streams; partial UTF-8 is dropped. */
function runDocker(
  dockerBin: string,
  args: string[],
  opts: { timeoutMs: number; outputCapBytes: number; input?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(dockerBin, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let remaining = Math.max(0, opts.outputCapBytes);
    let timedOut = false;
    let settled = false;
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      const kept = chunk.subarray(0, remaining);
      if (kept.length) chunks.push(kept);
      remaining -= kept.length;
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    // A container rejecting stdin may close the pipe before all input is sent.
    let inputFailed = false;
    child.stdin.on('error', () => { inputFailed = true; });
    const decode = (chunks: Buffer[], budget: number) => {
      const decoded = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
      // Invalid binary output can expand to UTF-8 replacement characters. Cap
      // the encoded text again and drop any final partial multibyte character.
      return new TextDecoder('utf-8').decode(Buffer.from(decoded).subarray(0, budget), { stream: true });
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = decode(stdout, opts.outputCapBytes);
      const err = decode(stderr, Math.max(0, opts.outputCapBytes - Buffer.byteLength(out)));
      resolve({ exitCode: inputFailed && exitCode === 0 ? 1 : exitCode, stdout: out, stderr: err, timedOut, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    child.stdin.end(opts.input);
  });
}

export interface SandboxServiceDeps {
  db: Database.Database;
  events: EventBus;
  config: SandboxConfig;
  /** The sealed network's gate. Without it, networked steps use Docker's normal network (tests only). */
  egress?: EgressGate;
}

export interface ContainerInfo {
  Id: string;
  State: { Running: boolean; StartedAt?: string };
  Config: { Labels: Record<string, string> | null; Env?: string[] | null };
}

const OWNER_LABEL = 'io.agent-collab-hub.owner';
const ROOM_LABEL = 'io.agent-collab-hub.room';
const KIND_LABEL = 'io.agent-collab-hub.kind';

// Descriptor-relative operations reject symlinks at every path component. This
// also avoids a realpath/check/use race with agents changing workspace entries.
const FILE_HELPER = String.raw`
import collections, json, os, stat, sys
request = json.load(sys.stdin)
limit = request['limit']
parts = request['path'].split('/') if request['path'] else []
fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    for part in parts[:-1]:
        try:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        except FileNotFoundError:
            if request['op'] != 'write': raise
            os.mkdir(part, mode=0o770, dir_fd=fd)
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    name = parts[-1] if parts else '.'
    if request['op'] == 'list':
        target = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            entries = []
            with os.scandir(target) as iterator:
                for entry in iterator:
                    if entry.is_symlink(): continue
                    info = entry.stat(follow_symlinks=False)
                    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)): continue
                    entries.append({'name': entry.name, 'type': 'dir' if stat.S_ISDIR(info.st_mode) else 'file', 'size': info.st_size})
                    if len(entries) > 2000: raise OverflowError()
            result = {'entries': entries}
        finally: os.close(target)
    elif request['op'] == 'read':
        target = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            if not stat.S_ISREG(os.fstat(target).st_mode): raise ValueError()
            with os.fdopen(target, 'rb', closefd=False) as stream: data = stream.read(limit + 1)
            if len(data) > limit: raise OverflowError()
            result = {'content': data.decode('utf-8')}
        finally: os.close(target)
    else:
        data = request['content'].encode('utf-8')
        if len(data) > limit: raise OverflowError()
        exclusive = os.O_EXCL if request.get('exclusive') else 0
        # Previous text, only to report how many lines a save added and removed.
        previous = []
        try:
            prior = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                prior_info = os.fstat(prior)
                if stat.S_ISREG(prior_info.st_mode) and prior_info.st_size <= limit:
                    with os.fdopen(prior, 'rb', closefd=False) as stream: previous = stream.read(limit + 1).decode('utf-8', 'replace').splitlines()
            finally: os.close(prior)
        except OSError: previous = []
        try:
            target = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | exclusive, 0o660, dir_fd=fd)
        except FileExistsError:
            target = None
            result = {'written': False, 'bytes': 0}
        if target is not None:
            try:
                info = os.fstat(target)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError()
                os.ftruncate(target, 0)
                with os.fdopen(target, 'wb', closefd=False) as stream: stream.write(data)
                after, before = collections.Counter(request['content'].splitlines()), collections.Counter(previous)
                result = {'written': True, 'bytes': len(data), 'lines_added': sum((after - before).values()), 'lines_removed': sum((before - after).values())}
            finally: os.close(target)
    encoded = json.dumps(result, ensure_ascii=False)
    if len(encoded.encode('utf-8')) > limit * 6 + 8192: raise OverflowError()
    print(encoded)
except OverflowError:
    print(json.dumps({'error': 'too_large'}))
    sys.exit(3)
except (OSError, ValueError, UnicodeError):
    print(json.dumps({'error': 'invalid_path'}))
    sys.exit(2)
finally: os.close(fd)
`;

const MAX_PENDING_PER_ROOM = 4;

export class SandboxService {
  private readonly locks = new Map<string, { tail: Promise<unknown>; outstanding: number }>();
  private readonly owner: string;

  constructor(private deps: SandboxServiceDeps) {
    const cfg = deps.config;
    if (!Number.isSafeInteger(cfg.outputCapBytes) || cfg.outputCapBytes < 128 || cfg.outputCapBytes > 1_048_576 ||
        !Number.isFinite(cfg.cpus) || cfg.cpus <= 0 || !Number.isSafeInteger(cfg.memLimitMB) || cfg.memLimitMB < 16 ||
        !Number.isSafeInteger(cfg.pidsLimit) || cfg.pidsLimit < 1 || !/^([1-9]\d*)(:[1-9]\d*)?$/.test(cfg.containerUser)) {
      throw new SandboxError('SANDBOX_CONFIG_INVALID', 500, 'Invalid sandbox resource policy');
    }
    this.owner = createHash('sha256').update(path.resolve(cfg.workspacesDir)).digest('hex').slice(0, 24);
    this.validateTimeout(cfg.execTimeoutMs);
  }

  private validateTimeout(timeoutMs: number): number {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > Math.min(this.deps.config.maxExecTimeoutMs ?? 120_000, 120_000)) {
      throw new SandboxError('SANDBOX_TIMEOUT_INVALID', 400, 'Invalid sandbox command timeout');
    }
    return timeoutMs;
  }

  private async locked<T>(roomId: string, action: () => Promise<T>): Promise<T> {
    const queue = this.locks.get(roomId) ?? { tail: Promise.resolve(), outstanding: 0 };
    // Reserve one running slot and at most four pending operations per room.
    if (queue.outstanding >= MAX_PENDING_PER_ROOM + 1) {
      throw new SandboxError('SANDBOX_QUEUE_FULL', 429, 'Sandbox room queue is full; retry later');
    }
    queue.outstanding += 1;
    const current = queue.tail.catch(() => {}).then(action);
    queue.tail = current;
    this.locks.set(roomId, queue);
    try { return await current; }
    finally {
      queue.outstanding -= 1;
      if (queue.outstanding === 0) this.locks.delete(roomId);
    }
  }

  private authorize(roomId: string, actorId: string | undefined, write: boolean, supervisor = false): void {
    const actor = actorId ? this.deps.db.prepare('SELECT * FROM agents WHERE id=?').get(actorId) as Agent | undefined : undefined;
    if (!actor || !canReadRoom(this.deps.db,actor,roomId)) throw new SandboxError('ROOM_NOT_FOUND',404,'Room not found');
    if ((write && actor.role === 'observer') || (supervisor && actor.role !== 'supervisor')) throw new SandboxError('FORBIDDEN',403,'Action is not permitted');
  }

  private async docker(args: string[], timeoutMs = 15_000, outputCapBytes = this.deps.config.outputCapBytes, input?: string, env?: Record<string, string>): Promise<ExecResult> {
    return runDocker(this.deps.config.dockerBin ?? 'docker', args, {
      timeoutMs, outputCapBytes, ...(input === undefined ? {} : { input }), ...(env ? { env } : {}),
    });
  }

  private containerName(roomId: string): string { return `ach-sbx-${roomId}`; }

  private rowByRoom(roomId: string): SandboxRow | undefined {
    return this.deps.db.prepare('SELECT * FROM sandboxes WHERE room_id = ?').get(roomId) as SandboxRow | undefined;
  }

  get(id: string): SandboxRow | null {
    return (this.deps.db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(id) as SandboxRow | undefined) ?? null;
  }

  private async inspect(identifier: string): Promise<ContainerInfo | null> {
    const result = await this.docker(['inspect', '--type', 'container', identifier], 15_000, 128 * 1024);
    if (result.exitCode !== 0) {
      // Only an explicit missing-resource response is safe to treat as absent.
      if (/no such (object|container)/i.test(result.stderr)) return null;
      throw new SandboxError('SANDBOX_DOCKER_UNAVAILABLE', 502, 'Could not inspect sandbox container');
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]?.Id || !parsed[0]?.State || !parsed[0]?.Config) throw new Error();
      return parsed[0] as ContainerInfo;
    } catch { throw new SandboxError('SANDBOX_DOCKER_UNAVAILABLE', 502, 'Could not inspect sandbox container'); }
  }

  private assertOwned(info: ContainerInfo, roomId: string, kind: string): void {
    const labels = info.Config.Labels;
    if (labels?.[OWNER_LABEL] !== this.owner || labels[ROOM_LABEL] !== roomId || labels[KIND_LABEL] !== kind) {
      throw new SandboxError('SANDBOX_OWNERSHIP_CONFLICT', 409, 'Container name belongs to another resource');
    }
  }

  private async removeOwned(identifier: string, roomId: string, kind: string): Promise<void> {
    const info = await this.inspect(identifier);
    if (!info) return;
    this.assertOwned(info, roomId, kind);
    const result = await this.docker(['rm', '-f', info.Id]);
    if (result.exitCode !== 0) throw new SandboxError('SANDBOX_CLEANUP_FAILED', 502, 'Could not stop sandbox container');
  }

  /** A dedicated directory only; never accept an agent-controlled host path. */
  workspaceDir(roomId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(roomId)) {
      throw new SandboxError('SANDBOX_PATH_INVALID', 400, 'Invalid room workspace');
    }
    const root = path.resolve(this.deps.config.workspacesDir);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const realRoot = fs.realpathSync(root);
    const dir = path.join(realRoot, roomId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
    if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir) {
      throw new SandboxError('SANDBOX_PATH_INVALID', 400, 'Invalid room workspace');
    }
    return dir;
  }

  /** How to run this room's app in the preview, worked out from the cloned files; null when there is nothing to run. */
  launchPlan(roomId: string, port: number): LaunchPlan | null {
    try { return detectLaunchPlan(this.workspaceDir(roomId), port); } catch { return null; }
  }

  /**
   * Bind-mounted workspaces rarely match the container uid, so git needs an
   * explicit safe.directory; commits are attributed to the acting agent.
   */
  private gitEnv(actorId?: string): Record<string, string> {
    const env: Record<string, string> = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
    const actor = actorId ? this.deps.db.prepare('SELECT id, name FROM agents WHERE id=?').get(actorId) as { id: string; name: string } | undefined : undefined;
    if (actor) {
      const name = actor.name.replace(/[\x00-\x1f\x7f<>]/g, ' ').trim().slice(0, 80) || actor.id;
      const email = `${actor.id}@agents.hub.invalid`;
      Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
    }
    return env;
  }

  private containerArgs(roomId: string, name: string, kind: string, opts: { network?: boolean; egress?: EgressProfile; workdir?: string; env?: Record<string, string>; inheritEnv?: string[] } = {}): string[] {
    const cfg = this.deps.config;
    return [
      '--name', name,
      '--label', `${OWNER_LABEL}=${this.owner}`, '--label', `${ROOM_LABEL}=${roomId}`, '--label', `${KIND_LABEL}=${kind}`,
      // Networked steps get the sealed network and one gate profile; everything else gets no network.
      ...(opts.egress && this.deps.egress ? this.deps.egress.args(opts.egress) : ['--network', opts.egress || opts.network ? 'bridge' : 'none']), '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', `${cfg.memLimitMB}m`, '--memory-swap', `${cfg.memLimitMB}m`, '--cpus', String(cfg.cpus),
      '--pids-limit', String(cfg.pidsLimit), '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--user', cfg.containerUser, '--workdir', opts.workdir ?? '/workspace', '--log-driver', 'none',
      '--mount', `type=bind,src=${this.workspaceDir(roomId)},dst=/workspace`,
      ...Object.entries(opts.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      // Name-only entries take their value from the docker client environment, keeping secrets out of argv.
      ...(opts.inheritEnv ?? []).flatMap((key) => ['--env', key]),
    ];
  }

  async provision(roomId: string, actorId: string): Promise<SandboxRow> {
    return this.locked(roomId, async () => {
      if (!this.deps.db.prepare('SELECT id FROM rooms WHERE id = ? AND archived_at IS NULL').get(roomId)) {
        throw new SandboxError('ROOM_NOT_FOUND', 404, 'Room not found');
      }
      this.authorize(roomId,actorId,true,true);
      const cfg = this.deps.config;
      const existing = this.rowByRoom(roomId);
      const name = this.containerName(roomId);
      const current = await this.inspect(name);
      if (current) {
        this.assertOwned(current, roomId, 'room');
        if (current.State.Running && existing && current.Id === existing.container_id) {
          await this.seed(existing, current.Id, '', false, actorId);
          return existing;
        }
        await this.removeOwned(current.Id, roomId, 'room');
      }
      const id = existing?.id ?? newId('sbx');
      const now = nowIso();
      if (!existing) {
        this.deps.db.prepare(
          `INSERT INTO sandboxes (id, room_id, container_id, container_name, image, status, error, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, 'provisioning', NULL, ?, ?)`,
        ).run(id, roomId, name, cfg.image, now, now);
      } else {
        this.deps.db.prepare(`UPDATE sandboxes SET status = 'provisioning', container_id = NULL, error = NULL, updated_at = ? WHERE id = ?`).run(now, id);
      }
      this.deps.events.append({ type: 'sandbox.requested', room_id: roomId, actor_id: actorId, payload: { sandbox_id: id, image: cfg.image } });
      const result = await this.docker(['run', '-d', ...this.containerArgs(roomId, name, 'room'), cfg.image, 'sleep', 'infinity'], 60_000);
      const containerId = result.stdout.trim();
      if (result.exitCode !== 0 || result.timedOut || !/^[a-f0-9]{12,64}$/.test(containerId)) {
        this.deps.db.prepare(`UPDATE sandboxes SET status = 'error', error = ?, updated_at = ? WHERE id = ?`).run('Sandbox container failed to start', nowIso(), id);
        this.deps.events.append({ type: 'sandbox.error', room_id: roomId, actor_id: actorId, payload: { sandbox_id: id, error: 'Sandbox container failed to start' } });
        await this.removeOwned(name, roomId, 'room');
        throw new SandboxError('SANDBOX_PROVISION_FAILED', 502, 'Sandbox container failed to start');
      }
      this.deps.db.prepare(`UPDATE sandboxes SET container_id = ?, status = 'running', updated_at = ? WHERE id = ?`).run(containerId, nowIso(), id);
      this.deps.events.append({ type: 'sandbox.ready', room_id: roomId, actor_id: actorId, payload: { sandbox_id: id, image: cfg.image, container_id: containerId.slice(0, 12) } });
      await this.seed(this.get(id)!, containerId, '', false, actorId);
      return this.get(id)!;
    });
  }

  async destroy(roomId: string): Promise<void> {
    return this.locked(roomId, async () => {
      const existing = this.rowByRoom(roomId);
      if (!existing) return;
      for (const hook of this.stopHooks) await hook(roomId, existing.id).catch(() => {});
      await this.removeOwned(this.containerName(roomId), roomId, 'room');
      this.deps.db.prepare(`UPDATE sandboxes SET status = 'stopped', container_id = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), existing.id);
      this.deps.events.append({ type: 'sandbox.stopped', room_id: roomId, payload: { sandbox_id: existing.id } });
    });
  }

  private mustRunning(sandboxId: string): SandboxRow & { container_id: string } {
    const rec = this.get(sandboxId);
    if (!rec || rec.status !== 'running' || !rec.container_id) {
      throw new SandboxError('SANDBOX_NOT_RUNNING', 409, 'Sandbox is not provisioned');
    }
    return rec as SandboxRow & { container_id: string };
  }

  async exec(sandboxId: string, actorId: string, cmd: string, timeoutMs?: number): Promise<ExecResult> {
    const rec = this.mustRunning(sandboxId);
    this.authorize(rec.room_id,actorId,true);
    const timeout = this.validateTimeout(timeoutMs ?? this.deps.config.execTimeoutMs);
    const policy = checkCommandPolicy(cmd, this.deps.config.denylist);
    if (!policy.ok) {
      this.deps.events.append({ type: 'sandbox.exec.denied', room_id: rec.room_id, actor_id: actorId, payload: { sandbox_id: sandboxId, reason: policy.reason } });
      throw new SandboxError('SANDBOX_CMD_DENIED', 403, policy.reason);
    }
    return this.locked(rec.room_id, async () => {
      this.mustRunning(sandboxId);
      this.authorize(rec.room_id,actorId,true);
      const execId = newId('exec');
      const name = `ach-exec-${execId}`;
      const started = Date.now();
      this.deps.events.append({ type: 'sandbox.exec.started', room_id: rec.room_id, actor_id: actorId, payload: { sandbox_id: sandboxId, exec_id: execId, cmd } });
      let result: ExecResult;
      try {
        const create = await this.docker([
          'create', ...this.containerArgs(rec.room_id, name, 'exec', { env: this.gitEnv(actorId) }), rec.image,
          'timeout', '-k', '1s', `${timeout / 1_000}s`, 'sh', '-lc', cmd,
        ]);
        if (create.exitCode !== 0) throw new SandboxError('SANDBOX_EXEC_FAILED', 502, 'Could not start sandbox command');
        const output = await this.docker(['start', '-a', name], timeout + 5_000);
        result = { ...output, exec_id: execId, timedOut: output.timedOut || output.exitCode === 124 || output.exitCode === 137, durationMs: Date.now() - started };
      } finally {
        // Removing the execution container kills all descendants, even a shell
        // that exited after backgrounding a child or escaping timeout's group.
        await this.removeOwned(name, rec.room_id, 'exec');
      }
      this.deps.db.prepare(
        `INSERT INTO execs (id, sandbox_id, agent_id, cmd, exit_code, stdout, stderr, timed_out, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(execId, sandboxId, actorId, cmd, result.exitCode, result.stdout, result.stderr, result.timedOut ? 1 : 0, result.durationMs, nowIso());
      this.deps.events.append({
        type: 'sandbox.exec.result', room_id: rec.room_id, actor_id: actorId,
        payload: { sandbox_id: sandboxId, exec_id: execId, cmd, exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timed_out: result.timedOut, duration_ms: result.durationMs },
      });
      return result;
    });
  }

  private tokenFor(slug: string, roomId: string): string | undefined {
    const token = this.deps.config.github?.token;
    if (typeof token !== 'function') return token;
    const room = this.deps.db.prepare('SELECT workspace_id FROM rooms WHERE id = ?').get(roomId) as { workspace_id: string | null } | undefined;
    return token(slug.split('/')[0]!, room?.workspace_id ?? null);
  }


  /**
   * Copy the operator's instruction files into a workspace directory through
   * the no-follow file helper. Best effort: a stopped room container or an
   * unreadable source skips seeding without failing the caller.
   */
  private async seed(rec: SandboxRow, containerId: string, dir: string, exclusive: boolean, actorId?: string): Promise<string[]> {
    const limit = this.deps.config.outputCapBytes;
    const seeded: string[] = [];
    for (const file of this.deps.config.seedFiles ?? []) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(file.name)) continue;
      let content: string;
      try {
        if (fs.statSync(file.source).size > limit) continue;
        content = fs.readFileSync(file.source, 'utf8');
      } catch { continue; }
      const target = dir ? `${dir}/${file.name}` : file.name;
      const result = await this.docker(
        ['exec', '-i', containerId, 'timeout', '-k', '1s', '10s', 'python3', '-c', FILE_HELPER],
        15_000, 8_192, JSON.stringify({ op: 'write', path: target, limit, content, exclusive }),
      );
      let written = false;
      try { written = result.exitCode === 0 && (JSON.parse(result.stdout) as { written?: boolean }).written === true; } catch { /* reported as skipped */ }
      if (!written) continue;
      seeded.push(target);
      this.deps.events.append({ type: 'file.write', room_id: rec.room_id, actor_id: actorId ?? null, payload: { sandbox_id: rec.id, path: target, operation: 'seed', outcome: 'success' } });
    }
    return seeded;
  }

  /**
   * Populate the workspace from GitHub. A new directory is cloned directly; an
   * existing clone is refreshed by fetching a fresh bare copy with network
   * access and fast-forwarding from it in a second, offline container.
   */
  async cloneRepo(sandboxId: string, actorId: string, input: RepoRequest): Promise<RepoResult> {
    const rec = this.mustRunning(sandboxId);
    this.authorize(rec.room_id, actorId, true);
    const cfg = this.deps.config;
    const repo = parseGithubRepo(input.repo);
    const dir = input.dir ?? repo.name;
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(dir) || dir.endsWith('.git')) {
      throw new SandboxError('SANDBOX_REPO_INVALID', 400, 'dir must be a single workspace directory name');
    }
    const ref = input.ref ?? '';
    if (ref && (!/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..'))) {
      throw new SandboxError('SANDBOX_REPO_INVALID', 400, 'ref must be a branch or tag name');
    }
    // The token saved for this workspace and the repository's organization; public repositories clone without one.
    const token = this.tokenFor(repo.slug, rec.room_id);
    const timeout = cfg.cloneTimeoutMs ?? 300_000;
    return this.locked(rec.room_id, async () => {
      this.mustRunning(sandboxId);
      this.authorize(rec.room_id, actorId, true);
      const execId = newId('exec');
      const tmp = `.ach-fetch-${execId}`;
      const cmd = `git clone ${repo.url} ${dir}${ref ? ` --branch ${ref}` : ''}`;
      const started = Date.now();
      const seedNames = (cfg.seedFiles ?? []).map((file) => file.name).filter((name) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(name));
      this.deps.events.append({ type: 'sandbox.exec.started', room_id: rec.room_id, actor_id: actorId, payload: { sandbox_id: sandboxId, exec_id: execId, cmd, kind: 'git' } });
      const run = async (name: string, kind: string, opts: Parameters<SandboxService['containerArgs']>[3], script: string, args: string[], env?: Record<string, string>) => {
        try {
          const create = await this.docker(['create', ...this.containerArgs(rec.room_id, name, kind, opts), rec.image,
            'timeout', '-k', '1s', `${timeout / 1_000}s`, 'sh', '-c', script, 'sh', ...args], 15_000, cfg.outputCapBytes, undefined, env);
          if (create.exitCode !== 0) throw new SandboxError('SANDBOX_EXEC_FAILED', 502, 'Could not start repository operation');
          return await this.docker(['start', '-a', name], timeout + 5_000);
        } finally { await this.removeOwned(name, rec.room_id, kind); }
      };
      await this.sealedNetwork();
      const fetchEnv: Record<string, string> = { ...this.gitEnv(), HOME: '/tmp', GIT_TERMINAL_PROMPT: '0' };
      const secret: Record<string, string> = {};
      if (token) {
        Object.assign(fetchEnv, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader' });
        secret.GIT_CONFIG_VALUE_1 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
      }
      const fetched = await run(`ach-git-${execId}`, 'git',
        { egress: 'github', workdir: '/tmp', env: fetchEnv, inheritEnv: Object.keys(secret) }, FETCH_SCRIPT, [repo.url, dir, ref, tmp, ...seedNames], secret);
      let output = fetched;
      let action: RepoResult['action'] = 'clone';
      // Hub-chosen name directly under the validated workspace root; lstat never follows it.
      const pending = fs.lstatSync(path.join(this.workspaceDir(rec.room_id), tmp), { throwIfNoEntry: false });
      if (pending) {
        action = 'update';
        const ok = fetched.exitCode === 0 && !fetched.timedOut;
        const merged = await run(`ach-exec-${execId}`, 'exec', { env: this.gitEnv(actorId) }, UPDATE_SCRIPT, [repo.url, dir, tmp, ok ? 'ok' : 'failed']);
        const budget = Math.max(0, cfg.outputCapBytes - Buffer.byteLength(fetched.stdout) - Buffer.byteLength(fetched.stderr));
        const clip = (text: string) => Buffer.from(text).subarray(0, budget >> 1).toString('utf8').replace(/\uFFFD$/, '');
        output = ok
          ? { ...merged, stdout: fetched.stdout + clip(merged.stdout), stderr: fetched.stderr + clip(merged.stderr) }
          : fetched;
      }
      const timedOut = output.timedOut || output.exitCode === 124 || output.exitCode === 137;
      const succeeded = output.exitCode === 0 && !timedOut;
      if (!succeeded && /could not read Username|Authentication failed|Repository not found|returned error: 40[34]|Write access to repository not granted/i.test(output.stderr)) {
        const owner = repo.slug.split('/')[0];
        const hint = token
          ? `The GitHub token saved for ${owner} in this workspace can't read ${repo.slug}. Give that token access to the repository on GitHub, or replace it in the desktop app (workspace › GitHub).`
          : `${repo.slug} is private or doesn't exist, and this workspace has no GitHub token for ${owner}. Add one in the desktop app (workspace › GitHub).`;
        output = { ...output, stderr: `${output.stderr}\n${hint}\n` };
      }
      let seeded: string[] = [];
      if (succeeded) {
        const info = rec.container_id ? await this.inspect(rec.container_id).catch(() => null) : null;
        if (info?.State.Running && info.Config.Labels?.[OWNER_LABEL] === this.owner && info.Config.Labels[ROOM_LABEL] === rec.room_id) {
          seeded = [...await this.seed(rec, info.Id, '', true, actorId), ...await this.seed(rec, info.Id, dir, true, actorId)];
        }
      }
      const result: RepoResult = { ...output, exec_id: execId, timedOut, durationMs: Date.now() - started, action, repo: repo.slug, dir, seeded };
      this.deps.db.prepare(
        `INSERT INTO execs (id, sandbox_id, agent_id, cmd, exit_code, stdout, stderr, timed_out, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(execId, sandboxId, actorId, cmd, result.exitCode, result.stdout, result.stderr, timedOut ? 1 : 0, result.durationMs, nowIso());
      this.deps.events.append({
        type: 'sandbox.exec.result', room_id: rec.room_id, actor_id: actorId,
        payload: { sandbox_id: sandboxId, exec_id: execId, cmd, kind: 'git', action, repo: repo.slug, dir, exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timed_out: timedOut, duration_ms: result.durationMs },
      });
      return result;
    });
  }

  private async github(token: string, method: string, apiPath: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await (this.deps.config.githubFetch ?? fetch)(`https://api.github.com${apiPath}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent-collab-hub', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new SandboxError('SANDBOX_GITHUB_UNAVAILABLE', 502, 'Could not reach GitHub'); }
    let data: unknown = {};
    try { data = await response.json(); } catch { /* status alone decides */ }
    return { status: response.status, data: data !== null && typeof data === 'object' ? data as Record<string, unknown> : {} };
  }

  /**
   * Push one workspace branch and open a pull request for it. This is the only
   * write the hub performs on GitHub: it never merges, never force-pushes and
   * never pushes the base or default branch, so merging stays a human action.
   * What actually succeeds is bounded by the operator's token permissions.
   */
  async openPullRequest(sandboxId: string, actorId: string, input: PullRequestInput): Promise<PullRequestResult> {
    const rec = this.mustRunning(sandboxId);
    this.authorize(rec.room_id, actorId, true);
    const cfg = this.deps.config;
    const repo = parseGithubRepo(input.repo);
    const dir = input.dir ?? repo.name;
    const validRef = (ref: string) => /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.lock');
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(dir) || !validRef(input.branch) || (input.base !== undefined && !validRef(input.base))) {
      throw new SandboxError('SANDBOX_REPO_INVALID', 400, 'dir must be a workspace directory and branch/base plain branch names');
    }
    const prefix = cfg.github?.prBranchPrefix ?? 'ai/';
    if (!input.branch.startsWith(prefix) || input.branch === prefix) {
      throw new SandboxError('SANDBOX_BRANCH_NOT_ALLOWED', 403, `Pull request branches must be named ${prefix}<task>`);
    }
    const token = this.tokenFor(repo.slug, rec.room_id);
    if (!token) {
      this.deps.events.append({ type: 'sandbox.exec.denied', room_id: rec.room_id, actor_id: actorId, payload: { sandbox_id: sandboxId, reason: 'no GitHub token for this workspace and organization' } });
      throw new SandboxError('SANDBOX_GITHUB_DENIED', 403, `This workspace has no GitHub token for ${repo.slug.split('/')[0]}. Add one in the desktop app.`);
    }
    const denied = () => new SandboxError('SANDBOX_GITHUB_DENIED', 403, 'The hub GitHub token does not permit this on the repository');
    const timeout = cfg.cloneTimeoutMs ?? 300_000;
    return this.locked(rec.room_id, async () => {
      this.mustRunning(sandboxId);
      this.authorize(rec.room_id, actorId, true);
      const info = await this.github(token, 'GET', `/repos/${repo.slug}`);
      if (info.status !== 200 || typeof info.data.default_branch !== 'string') throw info.status === 401 || info.status === 403 || info.status === 404 ? denied() : new SandboxError('SANDBOX_GITHUB_UNAVAILABLE', 502, 'GitHub repository lookup failed');
      const base = input.base ?? info.data.default_branch;
      if (input.branch === base || input.branch === info.data.default_branch) {
        throw new SandboxError('SANDBOX_BRANCH_NOT_ALLOWED', 403, 'The base or default branch cannot be pushed; work on a separate branch');
      }
      const execId = newId('exec');
      const name = `ach-git-${execId}`;
      const cmd = `git push ${repo.url} ${input.branch} && open pull request into ${base}`;
      const started = Date.now();
      this.deps.events.append({ type: 'sandbox.exec.started', room_id: rec.room_id, actor_id: actorId, payload: { sandbox_id: sandboxId, exec_id: execId, cmd, kind: 'pull_request' } });
      const finish = (output: ExecResult, pr?: { url: string; number: number }) => {
        const timedOut = output.timedOut || output.exitCode === 124 || output.exitCode === 137;
        const result: PullRequestResult = { ...output, exec_id: execId, timedOut, durationMs: Date.now() - started, repo: repo.slug, branch: input.branch, base, url: pr?.url ?? '', number: pr?.number ?? 0 };
        this.deps.db.prepare(
          `INSERT INTO execs (id, sandbox_id, agent_id, cmd, exit_code, stdout, stderr, timed_out, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(execId, sandboxId, actorId, cmd, result.exitCode, result.stdout, result.stderr, timedOut ? 1 : 0, result.durationMs, nowIso());
        this.deps.events.append({
          type: 'sandbox.exec.result', room_id: rec.room_id, actor_id: actorId,
          payload: { sandbox_id: sandboxId, exec_id: execId, cmd, kind: 'pull_request', repo: repo.slug, branch: input.branch, base, pull_request: pr?.url ?? null, exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timed_out: timedOut, duration_ms: result.durationMs },
        });
        return result;
      };
      let pushed: ExecResult;
      await this.sealedNetwork();
      try {
        const env = { ...this.gitEnv(), HOME: '/tmp', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader' };
        const secret = { GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
        const create = await this.docker(['create', ...this.containerArgs(rec.room_id, name, 'git', { egress: 'github', workdir: '/tmp', env, inheritEnv: Object.keys(secret) }), rec.image,
          'timeout', '-k', '1s', `${timeout / 1_000}s`, 'sh', '-c', PUSH_SCRIPT, 'sh', repo.url, dir, input.branch, `.ach-push-${newId('out')}`], 15_000, cfg.outputCapBytes, undefined, secret);
        if (create.exitCode !== 0) throw new SandboxError('SANDBOX_EXEC_FAILED', 502, 'Could not start repository operation');
        pushed = await this.docker(['start', '-a', name], timeout + 5_000);
      } finally { await this.removeOwned(name, rec.room_id, 'git'); }
      if (pushed.exitCode !== 0 || pushed.timedOut) {
        finish(pushed);
        if (/\b403\b|permission to .* denied|write access to repository not granted/i.test(pushed.stderr)) throw denied();
        throw new SandboxError('SANDBOX_PUSH_FAILED', 409, pushed.stderr.trim().split('\n').filter((line) => !/^To https:/.test(line)).slice(-2).join(' ').slice(0, 300) || 'git push failed');
      }
      const created = await this.github(token, 'POST', `/repos/${repo.slug}/pulls`, { title: input.title, head: input.branch, base, ...(input.body ? { body: input.body } : {}) });
      if (created.status !== 201 || typeof created.data.html_url !== 'string') {
        const errors = Array.isArray(created.data.errors) ? created.data.errors as { message?: unknown }[] : [];
        const reason = String(errors[0]?.message ?? created.data.message ?? 'GitHub rejected the pull request').slice(0, 300);
        finish({ ...pushed, exitCode: 1, stderr: `${pushed.stderr}pull request not opened: ${reason}\n` });
        if (created.status === 401 || created.status === 403 || created.status === 404) throw denied();
        throw new SandboxError('SANDBOX_PULL_REQUEST_FAILED', 409, `Branch pushed, but the pull request was not opened: ${reason}`);
      }
      return finish(pushed, { url: created.data.html_url, number: Number(created.data.number) || 0 });
    });
  }

  private async sealedNetwork(): Promise<void> {
    try { await this.deps.egress?.ensure(); }
    catch { throw new SandboxError('SANDBOX_EGRESS_UNAVAILABLE', 503, 'The workspace\'s internet gate is not running. Ask the host to check Docker.'); }
  }

  /**
   * Installs a project's npm dependencies into the workspace: the only step that may download
   * packages. Phase one runs the hub's fixed script in a disposable container on the sealed
   * network, whose gate allows only package registries and GitHub, with install scripts off.
   * Phase two (unless turned off) runs the packages' install scripts in an ordinary offline
   * container, so code from a package can build but cannot send anything anywhere.
   */
  async installDependencies(sandboxId: string, actorId: string, dirInput: string, options: { scripts?: boolean } = {}): Promise<ExecResult & { exec_id: string; dir: string; scripts: boolean }> {
    const scripts = options.scripts !== false;
    let dir = dirInput.trim().replace(/^\.\/?/, '').replace(/\/+$/, '') || '.';
    if (dir === '.') dir = this.launchPlan(this.mustRunning(sandboxId).room_id, 5173)?.install_dir || '.';
    if (dir !== '.' && (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}){0,5}$/.test(dir) || dir.split('/').includes('..'))) {
      throw new SandboxError('VALIDATION_ERROR', 400, 'dir must be a folder inside the workspace, like "." or "my-app"');
    }
    const rec = this.mustRunning(sandboxId);
    this.authorize(rec.room_id, actorId, true);
    const timeout = 360_000;
    return this.locked(rec.room_id, async () => {
      this.mustRunning(sandboxId);
      this.authorize(rec.room_id, actorId, true);
      await this.sealedNetwork();
      const execId = newId('exec');
      const cmd = `install dependencies (${dir}${scripts ? '' : ', no install scripts'})`;
      const name = `ach-install-${execId}`;
      this.deps.events.append({ type: 'sandbox.exec.started', room_id: rec.room_id, actor_id: actorId, payload: { sandbox_id: sandboxId, exec_id: execId, cmd, kind: 'install' } });
      let result: ExecResult;
      try {
        const create = await this.docker(['create', ...this.containerArgs(rec.room_id, name, 'install', { egress: 'packages', workdir: '/tmp', env: { HOME: '/tmp' } }), rec.image,
          'timeout', '-k', '5s', `${timeout / 1_000}s`, 'sh', '-c', INSTALL_SCRIPT, 'sh', dir, `.ach-npm-cache-${execId}`]);
        if (create.exitCode !== 0) throw new SandboxError('SANDBOX_EXEC_FAILED', 502, 'Could not start the install');
        result = await this.docker(['start', '-a', name], timeout + 10_000);
      } finally { await this.removeOwned(name, rec.room_id, 'install'); }
      if (scripts && result.exitCode === 0 && !result.timedOut) {
        const offline = `ach-exec-${execId}`;
        try {
          const create = await this.docker(['create', ...this.containerArgs(rec.room_id, offline, 'exec', { workdir: '/tmp', env: { HOME: '/tmp' } }), rec.image,
            'timeout', '-k', '5s', `${timeout / 1_000}s`, 'sh', '-c', INSTALL_SCRIPTS_SCRIPT, 'sh', dir]);
          if (create.exitCode !== 0) throw new SandboxError('SANDBOX_EXEC_FAILED', 502, 'Could not start the install scripts');
          const built = await this.docker(['start', '-a', offline], timeout + 10_000);
          result = { ...built, stdout: `${result.stdout}${built.stdout}`, stderr: `${result.stderr}${built.stderr}`, durationMs: result.durationMs + built.durationMs };
        } finally { await this.removeOwned(offline, rec.room_id, 'exec'); }
      }
      const timedOut = result.timedOut || result.exitCode === 124 || result.exitCode === 137;
      this.deps.db.prepare(
        `INSERT INTO execs (id, sandbox_id, agent_id, cmd, exit_code, stdout, stderr, timed_out, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(execId, sandboxId, actorId, cmd, result.exitCode, result.stdout, result.stderr, timedOut ? 1 : 0, result.durationMs, nowIso());
      this.deps.events.append({
        type: 'sandbox.exec.result', room_id: rec.room_id, actor_id: actorId,
        payload: { sandbox_id: sandboxId, exec_id: execId, cmd, kind: 'install', dir, scripts, exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timed_out: timedOut, duration_ms: result.durationMs },
      });
      return { ...result, timedOut, exec_id: execId, dir, scripts };
    });
  }

  /** Run one of the fixed git scripts in an offline disposable container with validated arguments only. */
  private async gitScript(rec: SandboxRow, actorId: string | undefined, script: string, args: string[], timeoutMs = 20_000): Promise<ExecResult> {
    const name = `ach-exec-${newId('exec')}`;
    try {
      const create = await this.docker(['create', ...this.containerArgs(rec.room_id, name, 'exec', { env: this.gitEnv(actorId) }), rec.image,
        'timeout', '-k', '1s', `${timeoutMs / 1_000}s`, 'sh', '-c', script, 'sh', ...args]);
      if (create.exitCode !== 0) throw new SandboxError('SANDBOX_EXEC_FAILED', 502, 'Could not start repository operation');
      return await this.docker(['start', '-a', name], timeoutMs + 5_000);
    } finally { await this.removeOwned(name, rec.room_id, 'exec'); }
  }

  private repoDir(dir: string): string {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(dir)) throw new SandboxError('SANDBOX_REPO_INVALID', 400, 'dir must be a single workspace directory name');
    return dir;
  }

  private async gitRead(sandboxId: string, actorId: string, script: string, args: string[]): Promise<string> {
    const rec = this.mustRunning(sandboxId);
    this.authorize(rec.room_id, actorId, false);
    return this.locked(rec.room_id, async () => {
      this.mustRunning(sandboxId);
      this.authorize(rec.room_id, actorId, false);
      const result = await this.gitScript(rec, actorId, script, args);
      if (result.exitCode === 64) throw new SandboxError('SANDBOX_REPO_NOT_FOUND', 404, 'No git repository in that workspace directory');
      if (result.exitCode === 65) throw new SandboxError('SANDBOX_COMMIT_NOT_FOUND', 404, 'Commit not found');
      if (result.exitCode !== 0 || result.timedOut) throw new SandboxError('SANDBOX_GIT_FAILED', 502, 'Could not read the repository');
      return result.stdout;
    });
  }

  /** Workspace directories that contain a git repository. */
  async gitRepos(sandboxId: string, actorId: string): Promise<string[]> {
    const output = await this.gitRead(sandboxId, actorId, GIT_REPOS_SCRIPT, []);
    return output.split('\n').filter((name) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(name)).sort();
  }

  /** Branches, recent history across all branches and uncommitted changes of one clone. */
  async gitOverview(sandboxId: string, actorId: string, dirInput: string, limit = 150): Promise<GitOverview> {
    const dir = this.repoDir(dirInput);
    const count = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 150;
    const [branch = '', head = '', origin = '', refs = '', log = '', status = ''] = (await this.gitRead(sandboxId, actorId, GIT_LOG_SCRIPT, [dir, String(count)])).split('\x1d');
    let repo: string | null = null;
    try { repo = parseGithubRepo(origin.trim()).slug; } catch { /* not a GitHub clone */ }
    const current = branch.trim();
    const branches = refs.split('\n').filter(Boolean).flatMap((line): GitBranch[] => {
      const [ref = '', sha = ''] = line.split('\x1f');
      const remote = ref.startsWith('refs/remotes/');
      const name = ref.replace(/^refs\/(heads|remotes)\//, '');
      return !/^[a-f0-9]{40}$/.test(sha) || name.endsWith('/HEAD') ? [] : [{ name, sha, remote, current: !remote && name === current }];
    });
    const commits = log.split('\x1e').map((record) => record.replace(/^\n/, '')).filter(Boolean).flatMap((record): GitCommit[] => {
      const [sha = '', parents = '', author = '', date = '', subject = ''] = record.split('\x1f');
      return /^[a-f0-9]{40}$/.test(sha) ? [{ sha, parents: parents.split(' ').filter(Boolean), author, date, subject }] : [];
    });
    const changes = status.split('\0').filter((entry) => entry.length > 3).map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
    return { dir, branch: current || null, head: /^[a-f0-9]{40}$/.test(head.trim()) ? head.trim() : null, repo, branches, commits, changes };
  }

  async gitCommit(sandboxId: string, actorId: string, dirInput: string, sha: string): Promise<GitCommitDetail> {
    const dir = this.repoDir(dirInput);
    if (!/^[a-f0-9]{7,40}$/.test(sha)) throw new SandboxError('SANDBOX_REPO_INVALID', 400, 'sha must be a commit id');
    const [meta = '', stat = ''] = (await this.gitRead(sandboxId, actorId, GIT_COMMIT_SCRIPT, [dir, sha, ''])).split('\x1d');
    const [full = '', parents = '', author = '', date = '', email = '', ...message] = meta.split('\x1f');
    const body = message.join('\x1f').trim();
    const files = stat.split('\0').filter(Boolean).flatMap((entry) => {
      const [added = '', deleted = '', ...rest] = entry.replace(/^\n/, '').split('\t');
      const file = rest.join('\t');
      return file ? [{ path: file, additions: /^\d+$/.test(added) ? Number(added) : null, deletions: /^\d+$/.test(deleted) ? Number(deleted) : null }] : [];
    });
    return { sha: full, parents: parents.split(' ').filter(Boolean), author, date, email, subject: body.split('\n')[0] ?? '', message: body, files };
  }

  /** Unified diff of one file in one commit, capped by the sandbox output limit. */
  async gitPatch(sandboxId: string, actorId: string, dirInput: string, sha: string, file: string): Promise<string> {
    const dir = this.repoDir(dirInput);
    const safe = sandboxPath(file);
    if (!/^[a-f0-9]{7,40}$/.test(sha) || !safe) throw new SandboxError('SANDBOX_REPO_INVALID', 400, 'sha and path required');
    return this.gitRead(sandboxId, actorId, GIT_COMMIT_SCRIPT, [dir, sha, safe]);
  }

  /** Switch a clone to another local or fetched branch; recorded like any other command. */
  async gitCheckout(sandboxId: string, actorId: string, dirInput: string, branch: string): Promise<ExecResult> {
    const rec = this.mustRunning(sandboxId);
    this.authorize(rec.room_id, actorId, true);
    const dir = this.repoDir(dirInput);
    if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..')) throw new SandboxError('SANDBOX_REPO_INVALID', 400, 'branch must be a branch name');
    return this.locked(rec.room_id, async () => {
      this.mustRunning(sandboxId);
      this.authorize(rec.room_id, actorId, true);
      const execId = newId('exec');
      const cmd = `git -C ${dir} checkout ${branch}`;
      const started = Date.now();
      this.deps.events.append({ type: 'sandbox.exec.started', room_id: rec.room_id, actor_id: actorId, payload: { sandbox_id: sandboxId, exec_id: execId, cmd, kind: 'git' } });
      const output = await this.gitScript(rec, actorId, GIT_CHECKOUT_SCRIPT, [dir, branch], 60_000);
      const result: ExecResult = { ...output, exec_id: execId, timedOut: output.timedOut || output.exitCode === 124 || output.exitCode === 137, durationMs: Date.now() - started };
      this.deps.db.prepare(
        `INSERT INTO execs (id, sandbox_id, agent_id, cmd, exit_code, stdout, stderr, timed_out, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(execId, sandboxId, actorId, cmd, result.exitCode, result.stdout, result.stderr, result.timedOut ? 1 : 0, result.durationMs, nowIso());
      this.deps.events.append({
        type: 'sandbox.exec.result', room_id: rec.room_id, actor_id: actorId,
        payload: { sandbox_id: sandboxId, exec_id: execId, cmd, kind: 'git', exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timed_out: result.timedOut, duration_ms: result.durationMs },
      });
      return result;
    });
  }

  private async fileOperation(sandboxId: string, op: 'list' | 'read' | 'write', relPath: string, actorId?: string, content?: string): Promise<Record<string, unknown>> {
    const rec = this.mustRunning(sandboxId);
    this.authorize(rec.room_id,actorId,op === 'write');
    const safe = sandboxPath(relPath);
    if (op !== 'list' && !safe) throw new SandboxError('SANDBOX_PATH_INVALID', 400, 'File path required');
    const limit = this.deps.config.outputCapBytes;
    if (content !== undefined && Buffer.byteLength(content, 'utf8') > limit) {
      throw new SandboxError('SANDBOX_FILE_TOO_LARGE', 413, 'File exceeds sandbox size limit');
    }
    return this.locked(rec.room_id, async () => {
      const current = this.mustRunning(sandboxId);
      this.authorize(rec.room_id,actorId,op === 'write');
      const info = await this.inspect(current.container_id);
      if (!info) throw new SandboxError('SANDBOX_NOT_RUNNING', 409, 'Sandbox container is missing; ask a supervisor to restore it');
      this.assertOwned(info, rec.room_id, 'room');
      if (!info.State.Running) throw new SandboxError('SANDBOX_NOT_RUNNING', 409, 'Sandbox container is stopped; ask a supervisor to restore it');
      const result = await this.docker(
        ['exec', '-i', current.container_id, 'timeout', '-k', '1s', '10s', 'python3', '-c', FILE_HELPER],
        15_000, limit * 6 + 8_192, JSON.stringify({ op, path: safe, limit, ...(content === undefined ? {} : { content }) }),
      );
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(result.stdout) as Record<string, unknown>; } catch { /* mapped to a stable error below */ }
      const outcome = result.exitCode === 0 && !result.timedOut ? 'success' : 'denied';
      const lines = op === 'write' && typeof payload.lines_added === 'number' && typeof payload.lines_removed === 'number'
        ? { lines_added: payload.lines_added, lines_removed: payload.lines_removed } : {};
      this.deps.events.append({ type: op === 'write' ? 'file.write' : 'file.read', room_id: rec.room_id, actor_id: actorId ?? null, payload: { sandbox_id: sandboxId, path: safe, operation: op, outcome, ...lines } });
      if (outcome !== 'success') {
        if (payload.error === 'too_large') throw new SandboxError('SANDBOX_FILE_TOO_LARGE', 413, 'File exceeds sandbox size limit');
        if (payload.error === 'invalid_path') throw new SandboxError('SANDBOX_PATH_INVALID', 400, 'Workspace path is unavailable or unsafe');
        // Docker can stop the container between inspection and exec; do not blame its files.
        const latest = await this.inspect(current.container_id);
        if (!latest) throw new SandboxError('SANDBOX_NOT_RUNNING', 409, 'Sandbox container is missing; ask a supervisor to restore it');
        this.assertOwned(latest, rec.room_id, 'room');
        if (!latest.State.Running) throw new SandboxError('SANDBOX_NOT_RUNNING', 409, 'Sandbox container is stopped; ask a supervisor to restore it');
        throw new SandboxError('SANDBOX_FILE_OPERATION_FAILED', 502, 'Could not access workspace files; inspect local sandbox runtime');
      }
      return payload;
    });
  }

  async listFiles(sandboxId: string, relPath: string, actorId?: string): Promise<{ name: string; type: 'file' | 'dir'; size: number }[]> {
    const payload = await this.fileOperation(sandboxId, 'list', relPath, actorId);
    return payload.entries as { name: string; type: 'file' | 'dir'; size: number }[];
  }

  async readFile(sandboxId: string, relPath: string, actorId?: string): Promise<string> {
    const payload = await this.fileOperation(sandboxId, 'read', relPath, actorId);
    return payload.content as string;
  }

  async writeFile(sandboxId: string, relPath: string, content: string, actorId?: string): Promise<{ written: true; bytes: number }> {
    const payload = await this.fileOperation(sandboxId, 'write', relPath, actorId, content);
    return payload as { written: true; bytes: number };
  }

  listExecs(sandboxId: string, limit = 50): ExecRowLite[] {
    const cap = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
    return this.deps.db.prepare(
      `SELECT id, sandbox_id, agent_id, cmd, exit_code, stdout, stderr, timed_out, duration_ms, created_at
       FROM execs WHERE sandbox_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(sandboxId, cap) as ExecRowLite[];
  }

  getExec(sandboxId: string, execId: string): ExecRowLite | null {
    return (this.deps.db.prepare('SELECT * FROM execs WHERE sandbox_id = ? AND id = ?').get(sandboxId, execId) as ExecRowLite | undefined) ?? null;
  }

  status(roomId: string): SandboxRow | null { return this.rowByRoom(roomId) ?? null; }

  // ---- Companion containers (the dev server) share this hardening, ownership and lifecycle ----
  private readonly stopHooks: ((roomId: string, sandboxId: string) => Promise<void>)[] = [];
  /** Runs before the room container is removed, so companion containers stop with the sandbox. */
  onSandboxStop(hook: (roomId: string, sandboxId: string) => Promise<void>): void { this.stopHooks.push(hook); }
  /** The same flags as every sandbox container: no network, read-only root, no capabilities, limits. */
  companionArgs(roomId: string, name: string, kind: string, env: Record<string, string>): string[] {
    return this.containerArgs(roomId, name, kind, { env });
  }
  async inspectCompanion(identifier: string, roomId: string, kind: string): Promise<ContainerInfo | null> {
    const info = await this.inspect(identifier);
    if (info) this.assertOwned(info, roomId, kind);
    return info;
  }
  removeCompanion(identifier: string, roomId: string, kind: string): Promise<void> { return this.removeOwned(identifier, roomId, kind); }
  dockerCommand(args: string[], timeoutMs: number, outputCapBytes: number, input?: string): Promise<ExecResult> {
    return this.docker(args, timeoutMs, outputCapBytes, input);
  }
  get dockerBinary(): string { return this.deps.config.dockerBin ?? 'docker'; }
  /** Throws ROOM_NOT_FOUND / FORBIDDEN exactly like exec (write) or file reads (read). */
  authorizeRoom(roomId: string, actorId: string, write: boolean): void { this.authorize(roomId, actorId, write); }

  /** Observe Docker without changing provisioning metadata or restarting resources. */
  async liveStatus(roomId: string): Promise<SandboxRow | null> {
    const record = this.status(roomId);
    if (!record || record.status !== 'running' || !record.container_id) return record;
    const info = await this.inspect(record.container_id);
    if (!info) return { ...record, status: 'stopped', container_id: null };
    this.assertOwned(info, roomId, 'room');
    return info.State.Running ? record : { ...record, status: 'stopped' };
  }
}

export interface ExecRowLite {
  id: string;
  sandbox_id: string;
  agent_id: string;
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: number;
  duration_ms: number;
  created_at: string;
}
