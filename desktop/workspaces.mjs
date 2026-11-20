// The desktop app's workspace, people and link management. Every change goes through the local
// management CLI (hub/scripts/manage.mjs), which works on the hub database with this Mac account's
// authority; there is no admin endpoint on the network. Tokens and links are returned once to the
// app and never written anywhere else.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const id = (prefix, value) => typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9]{16}$`).test(value);
export class WorkspaceError extends Error {}
function requireValue(condition, message = 'Invalid workspace operation.') { if (!condition) throw new WorkspaceError(message); }

/** Allowed keys per action: [required, optional]. */
const SHAPES = {
  list: [[], ['workspaceId']],
  'create-workspace': [['name'], []],
  'rename-workspace': [['workspaceId', 'name'], []],
  'add-staff': [['workspaceId', 'name', 'role'], []],
  'issue-token': [['workspaceId', 'agentId'], []],
  'revoke-person': [['workspaceId', 'agentId'], []],
  'end-sessions': [['workspaceId', 'agentId'], []],
  'create-room': [['workspaceId', 'name'], []],
  'archive-room': [['workspaceId', 'roomId'], []],
  'create-invite': [['workspaceId', 'roomId'], ['label']],
  'revoke-invite': [['workspaceId', 'inviteId'], []],
  'sign-in-link': [['workspaceId', 'agentId'], []],
  'delete-workspace': [['workspaceId', 'confirmName'], []],
  'add-github-token': [['workspaceId', 'owner', 'token'], []],
  'remove-github-token': [['workspaceId', 'owner'], []],
};
const text = (value, max = 80) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

export function validateWorkspaceInput(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(SHAPES, input.action));
  const [required, optional] = SHAPES[input.action];
  requireValue(Object.keys(input).every((key) => key === 'action' || required.includes(key) || optional.includes(key)));
  requireValue(required.every((key) => input[key] !== undefined));
  for (const [key, prefix] of [['workspaceId', 'wks'], ['agentId', 'agt'], ['roomId', 'room'], ['inviteId', 'inv']]) {
    if (input[key] !== undefined) requireValue(id(prefix, input[key]));
  }
  if (input.name !== undefined) requireValue(text(input.name), 'Names must be 1–80 characters.');
  if (input.confirmName !== undefined) requireValue(typeof input.confirmName === 'string' && input.confirmName.length <= 80, 'Type the workspace name to confirm.');
  if (input.label !== undefined) requireValue(input.label === '' || text(input.label), 'The label must be up to 80 characters.');
  if (input.owner !== undefined) requireValue(typeof input.owner === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(input.owner), 'Use the GitHub organization or account name, like acme-inc.');
  if (input.token !== undefined) requireValue(typeof input.token === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(input.token), "That doesn't look like a GitHub token.");
  if (input.role !== undefined) requireValue(['supervisor', 'observer'].includes(input.role), 'Staff are either supervisors or observers.');
  return input;
}

export function runJSON(node, script, request, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [script], { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('Local management timed out; refresh before retrying.')); }, 15_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 512 * 1024) { child.kill('SIGTERM'); finish(new Error('Local management response exceeded its limit.')); }
    });
    child.once('error', () => finish(new Error('Could not start local workspace management. Build the hub first.')));
    child.stdin.on('error', () => {});
    child.once('close', () => {
      try {
        const result = JSON.parse(output);
        requireValue(result && typeof result.ok === 'boolean');
        if (!result.ok) throw new WorkspaceError(typeof result.message === 'string' && result.message.length < 400 ? result.message : 'Workspace operation failed.');
        const { ok, ...data } = result;
        finish(null, data);
      } catch (error) { finish(error instanceof WorkspaceError ? error : new WorkspaceError('Invalid local management response.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** The address links should use: the verified tunnel address when it is up, otherwise this Mac. */
export function linkBase(publicUrl) {
  try {
    const url = new URL(publicUrl);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') return url.origin;
  } catch { /* not running */ }
  return 'http://127.0.0.1:8791';
}

export async function workspaceRequest(input, root, settings, environment, dependencies = {}) {
  validateWorkspaceInput(input);
  const manage = dependencies.manage ?? ((request) => runJSON(settings.nodePath, join(root, 'hub/scripts/manage.mjs'), request,
    { cwd: root, env: { ...environment, HUB_DB: join(root, 'data/hub.sqlite') } }));
  const { action, ...request } = input;
  if (action === 'create-workspace') {
    requireValue(text(settings.ownerName), 'Add your name in Settings first.');
    request.ownerName = settings.ownerName;
  }
  if (action === 'create-invite' && request.label === '') delete request.label;
  const result = await manage({ command: action, ...request });
  // Links carry their secret in the #fragment and are handed to the app exactly once.
  if ((action === 'create-invite' || action === 'sign-in-link') && typeof result.path === 'string') {
    const { path, ...rest } = result;
    requireValue(/^\/(join|signin)#ach[il]_[A-Za-z0-9_-]{32,43}$/.test(path), 'Invalid link from local management.');
    return { ...rest, url: `${linkBase(dependencies.publicUrl)}${path}` };
  }
  return result;
}
