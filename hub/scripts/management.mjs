import { randomBytes, createHash } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

/** The hub schema this tool understands; keep in step with SCHEMA_VERSION in hub/src/db.ts. */
export const SCHEMA_VERSION = 9;
const sha = (value) => createHash('sha256').update(value).digest('hex');

const id = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`;
const stamp = () => new Date().toISOString();
const staffRoles = new Set(['supervisor', 'observer']);
/** A failure whose message is safe and useful to show the operator. */
export class ManagementError extends Error {}
const invalid = () => { throw new ManagementError('Invalid local management request.'); };
function name(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function identity(value, prefix) { if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-f0-9]{16}$`).test(value)) invalid(); return value; }
export function openManagedDb(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ManagementError('Unsafe database path.');
  const db = new Database(path, { fileMustExist: true, timeout: 3000 });
  try {
    if (Number(db.pragma('user_version', { simple: true })) !== SCHEMA_VERSION) throw new ManagementError('This hub database is from a different version. Start fresh or upgrade it from the desktop app; no changes were made.');
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) { db.close(); throw error; }
}
function audit(db, type, workspace, target, detail = {}) {
  db.prepare('INSERT INTO events (type,workspace_id,target_id,payload,created_at) VALUES (?,?,?,?,?)')
    .run(type, workspace, target, JSON.stringify({ via: 'local-cli', ...detail }), stamp());
}
export function issueCredential(db, agent) {
  const token = `ach_${randomBytes(24).toString('base64url')}`;
  const token_id = id('tok');
  db.prepare('INSERT INTO tokens (id,agent_id,workspace_id,role,token_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(token_id, agent.id, agent.workspace_id, agent.role, createHash('sha256').update(token).digest('hex'), stamp());
  audit(db, 'token.issued', agent.workspace_id, agent.id, { token_id });
  return { token, token_id };
}
const SHAPES = {
  list: [[], ['workspaceId']],
  'create-workspace': [['name', 'ownerName'], []],
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
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_TOKEN = /^[A-Za-z0-9_]{20,255}$/;
/** GitHub tokens live beside the database in a private file the hub rereads on every clone. */
export const githubTokensPath = (dbPath) => join(dirname(dbPath), 'github-tokens.json');
function readTokens(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ManagementError('The GitHub token file is unsafe; no changes were made.');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof ManagementError) throw error;
    throw new ManagementError('The GitHub token file could not be read; no changes were made.');
  }
}
function writeTokens(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
/** Organizations with a saved token, never the token itself. */
function githubList(file, workspaceId) {
  if (!file) return [];
  return Object.entries(readTokens(file)).filter(([w]) => workspaceId === null || w === workspaceId)
    .flatMap(([w, owners]) => Object.values(owners ?? {}).filter((e) => e && typeof e.owner === 'string')
      .map((e) => ({ workspace_id: w, owner: e.owner, added_at: e.added_at ?? null })))
    .sort((a, b) => a.owner.localeCompare(b.owner));
}
const INVITE_DAYS = 7;
const LINK_MINUTES = 15;

function staffIdentity(db, workspaceId, name, role) {
  if (!staffRoles.has(role)) invalid();
  if (db.prepare('SELECT 1 FROM agents WHERE workspace_id=? AND name=? COLLATE NOCASE').get(workspaceId, name)) throw new ManagementError('Someone in this workspace already uses that name.');
  const agent = { id: id('agt'), workspace_id: workspaceId, name, role, created_at: stamp(), last_seen_at: null };
  db.prepare('INSERT INTO agents (id,workspace_id,name,role,created_at) VALUES (?,?,?,?,?)').run(agent.id, workspaceId, name, role, agent.created_at);
  audit(db, 'agent.created', workspaceId, agent.id);
  return { agent, ...issueCredential(db, agent) };
}
/** The staff member that invites and links are recorded as coming from: the workspace's first active supervisor. */
function owner(db, workspaceId) {
  const row = db.prepare(`SELECT a.id FROM agents a WHERE a.workspace_id=? AND a.role='supervisor' AND a.guest=0
    AND EXISTS (SELECT 1 FROM tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL) ORDER BY a.created_at, a.id LIMIT 1`).get(workspaceId);
  if (!row) throw new ManagementError('This workspace has no staff member yet. Add yourself as staff first.');
  return row.id;
}
const active = (db, agentId) => Boolean(db.prepare('SELECT 1 FROM tokens WHERE agent_id=? AND revoked_at IS NULL').get(agentId));
const sidekickOf = (db, agentId) => db.prepare('SELECT * FROM sidekicks WHERE agent_id=?').get(agentId);
function endSessions(db, workspaceId, agentId) {
  const now = stamp();
  const rows = db.prepare('SELECT id FROM sessions WHERE agent_id=? AND workspace_id=? AND ended_at IS NULL').all(agentId, workspaceId);
  for (const row of rows) {
    db.prepare("UPDATE sessions SET ended_at=?, end_reason='revoked' WHERE id=? AND ended_at IS NULL").run(now, row.id);
    db.prepare('INSERT INTO events (type,workspace_id,target_id,payload,created_at) VALUES (?,?,?,?,?)')
      .run('session.ended', workspaceId, agentId, JSON.stringify({ via: 'local-cli', session_id: row.id, reason: 'revoked', remaining: 0 }), now);
  }
  return rows.length;
}
function revokeTokens(db, workspaceId, agentId) {
  const result = db.prepare('UPDATE tokens SET revoked_at=? WHERE agent_id=? AND workspace_id=? AND revoked_at IS NULL').run(stamp(), agentId, workspaceId);
  audit(db, 'auth.revoked', workspaceId, agentId, { revoked: result.changes });
  return result.changes;
}

function list(db, workspaceId, tokensFile) {
  const now = stamp();
  const scope = '(? IS NULL OR workspace_id=?)';
  // Every workspace is always listed (the app's sidebar); people, rooms and invites follow the selection.
  const workspaces = db.prepare('SELECT id,name,created_at FROM workspaces ORDER BY created_at,id').all()
    .map((w) => ({ ...w,
      people: db.prepare(`SELECT COUNT(*) AS n FROM agents a WHERE a.workspace_id=? AND NOT EXISTS (SELECT 1 FROM sidekicks s WHERE s.agent_id=a.id)
        AND EXISTS (SELECT 1 FROM tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL)`).get(w.id).n,
      rooms: db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE workspace_id=? AND archived_at IS NULL').get(w.id).n }));
  const agents = db.prepare(`SELECT id,workspace_id,name,role,created_at,last_seen_at,guest FROM agents WHERE ${scope} ORDER BY name COLLATE NOCASE,id`).all(workspaceId, workspaceId);
  const people = [];
  for (const agent of agents) {
    if (!active(db, agent.id)) continue;
    const sidekick = sidekickOf(db, agent.id);
    if (sidekick?.removed_at) continue;
    const base = { id: agent.id, workspace_id: agent.workspace_id, name: agent.name, role: agent.role, created_at: agent.created_at,
      last_seen_at: agent.last_seen_at, active: true, passkeys: 0 };
    if (sidekick) {
      people.push({ ...base, kind: 'sidekick', owner_id: sidekick.owner_id, provider: sidekick.provider, signed_in: Boolean(sidekick.signed_in_at) });
    } else if (agent.guest) {
      const until = db.prepare('SELECT MAX(expires_at) AS at FROM sessions WHERE agent_id=? AND ended_at IS NULL AND expires_at>?').get(agent.id, now).at;
      const own = db.prepare('SELECT s.*, a.name FROM sidekicks s JOIN agents a ON a.id=s.agent_id WHERE s.owner_id=? AND s.removed_at IS NULL').get(agent.id);
      people.push({ ...base, kind: 'client', ...(until ? { session_until: until } : {}),
        passkeys: db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE agent_id=? AND removed_at IS NULL').get(agent.id).n,
        ...(own ? { sidekick: { id: own.id, name: own.name, provider: own.provider, signed_in: Boolean(own.signed_in_at), asleep: !until } } : {}) });
    } else people.push({ ...base, kind: agent.role === 'agent' ? 'agent' : 'staff' });
  }
  const rooms = db.prepare(`SELECT r.id,r.workspace_id,r.name,r.created_at,(SELECT COUNT(*) FROM members m WHERE m.room_id=r.id) AS members,
    (SELECT status FROM sandboxes x WHERE x.room_id=r.id) AS sandbox FROM rooms r WHERE r.archived_at IS NULL AND (? IS NULL OR r.workspace_id=?) ORDER BY r.created_at,r.id`)
    .all(workspaceId, workspaceId).map(({ sandbox, ...room }) => (sandbox ? { ...room, sandbox } : room));
  const invites = db.prepare(`SELECT id,workspace_id,room_id,label,created_at,expires_at,redeemed_at,revoked_at FROM invites WHERE ${scope} ORDER BY created_at DESC LIMIT 200`)
    .all(workspaceId, workspaceId).map(({ redeemed_at, revoked_at, label, ...invite }) => ({ ...invite, ...(label ? { label } : {}),
      state: revoked_at ? 'revoked' : redeemed_at ? 'used' : invite.expires_at <= now ? 'expired' : 'open' }));
  return { instance_id: db.prepare("SELECT value FROM hub_metadata WHERE key='instance_id'").get()?.value ?? null, workspaces, people, rooms, invites,
    github: githubList(tokensFile, workspaceId) };
}

/**
 * Removes a workspace and everything scoped to it: people and their tokens, sessions, passkeys and
 * links, rooms with their messages, sandboxes, invites and events, sidekicks and their jobs, and its
 * security records. Returns the Docker resources and room folders the caller should remove; the
 * desktop app copies the database and moves the folders into a backup first.
 */
function deleteWorkspace(db, workspaceId, confirmName, tokensFile) {
  const workspace = db.prepare('SELECT id, name FROM workspaces WHERE id=?').get(workspaceId);
  if (typeof confirmName !== 'string' || confirmName !== workspace.name) throw new ManagementError('Type the workspace name exactly to delete it.');
  const ids = (sql) => db.prepare(sql).all(workspaceId).map((row) => row.id);
  const rooms = ids('SELECT id FROM rooms WHERE workspace_id=?');
  const sandboxes = db.prepare(`SELECT id, container_name FROM sandboxes WHERE room_id IN (SELECT id FROM rooms WHERE workspace_id=?)`).all(workspaceId);
  const sidekicks = ids('SELECT id FROM sidekicks WHERE workspace_id=?');
  const inRooms = '(SELECT id FROM rooms WHERE workspace_id=@w)';
  const inAgents = '(SELECT id FROM agents WHERE workspace_id=@w)';
  const inSidekicks = '(SELECT id FROM sidekicks WHERE workspace_id=@w)';
  const inSandboxes = `(SELECT id FROM sandboxes WHERE room_id IN ${inRooms})`;
  const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const steps = [
    ['execs', `sandbox_id IN ${inSandboxes} OR agent_id IN ${inAgents}`],
    ['sidekick_jobs', `sidekick_id IN ${inSidekicks} OR room_id IN ${inRooms}`],
    ['sidekick_sessions', `sidekick_id IN ${inSidekicks} OR room_id IN ${inRooms}`],
    ['mcp_read_positions', `agent_id IN ${inAgents} OR room_id IN ${inRooms}`],
    ['messages', `room_id IN ${inRooms} OR sender_id IN ${inAgents} OR recipient_id IN ${inAgents}`],
    ['members', `room_id IN ${inRooms} OR agent_id IN ${inAgents}`],
    ['invites', `workspace_id=@w OR room_id IN ${inRooms}`],
    ['signin_links', `workspace_id=@w OR agent_id IN ${inAgents}`],
    ['sessions', `workspace_id=@w OR agent_id IN ${inAgents}`],
    ['passkeys', `workspace_id=@w OR agent_id IN ${inAgents}`],
    ['oauth_codes', `agent_id IN ${inAgents}`],
    ['oauth_grants', `agent_id IN ${inAgents}`],
    ['sandboxes', `room_id IN ${inRooms}`],
    ['sidekicks', 'workspace_id=@w'],
    ['tokens', `workspace_id=@w OR agent_id IN ${inAgents}`],
    ['rooms', 'workspace_id=@w'],
    ['events', 'workspace_id=@w'],
    ['security_alerts', 'workspace_id=@w'],
    ['security_traffic', 'workspace_id=@w'],
    ['agents', 'workspace_id=@w'],
  ];
  for (const [table, where] of steps) if (has(table)) db.prepare(`DELETE FROM ${table} WHERE ${where}`).run({ w: workspaceId });
  db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  if (tokensFile) {
    const all = readTokens(tokensFile);
    if (Object.hasOwn(all, workspaceId)) { delete all[workspaceId]; writeTokens(tokensFile, all); }
  }
  db.prepare('INSERT INTO events (type,workspace_id,target_id,payload,created_at) VALUES (?,?,?,?,?)')
    .run('workspace.deleted', null, workspaceId, JSON.stringify({ via: 'local-cli', name: workspace.name }), stamp());
  const containers = [...sandboxes.flatMap((row) => [row.container_name, `ach-dev-${row.id}`]), ...sidekicks.map((id) => `ach-sidekick-${id}`)]
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name));
  return { deleted: { id: workspaceId, name: workspace.name }, containers, volumes: sidekicks.map((id) => `ach-sidekick-${id}-home`), rooms };
}

export function manage(db, request, { tokensFile } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) invalid();
  const shape = SHAPES[request.command];
  if (!shape || Object.keys(request).some((key) => key !== 'command' && !shape[0].includes(key) && !shape[1].includes(key))
    || shape[0].some((key) => request[key] === undefined)) invalid();
  return db.transaction(() => {
    if (request.command === 'create-workspace') {
      const workspaceName = name(request.name);
      if (db.prepare('SELECT 1 FROM workspaces WHERE name=? COLLATE NOCASE').get(workspaceName)) throw new ManagementError('A workspace with that name already exists.');
      const workspace = { id: id('wks'), name: workspaceName, created_at: stamp() };
      db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspace.id, workspace.name, workspace.created_at);
      audit(db, 'workspace.created', workspace.id, workspace.id);
      return { workspace, ...staffIdentity(db, workspace.id, name(request.ownerName), 'supervisor') };
    }
    const workspaceId = request.workspaceId === undefined ? null : identity(request.workspaceId, 'wks');
    if (workspaceId && !db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(workspaceId)) throw new ManagementError('Workspace not found.');
    if (request.command === 'list') return list(db, workspaceId, tokensFile);
    if (request.command === 'rename-workspace') {
      const workspaceName = name(request.name);
      if (db.prepare('SELECT 1 FROM workspaces WHERE name=? COLLATE NOCASE AND id<>?').get(workspaceName, workspaceId)) throw new ManagementError('A workspace with that name already exists.');
      db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(workspaceName, workspaceId);
      audit(db, 'workspace.renamed', workspaceId, workspaceId, { name: workspaceName });
      return { workspace: db.prepare('SELECT id,name,created_at FROM workspaces WHERE id=?').get(workspaceId) };
    }
    if (request.command === 'delete-workspace') return deleteWorkspace(db, workspaceId, request.confirmName, tokensFile);
    if (request.command === 'add-github-token' || request.command === 'remove-github-token') {
      if (!tokensFile) throw new ManagementError('GitHub tokens can only be changed from the desktop app.');
      if (typeof request.owner !== 'string' || !OWNER.test(request.owner)) throw new ManagementError('Use the GitHub organization or account name, like acme-inc.');
      const all = readTokens(tokensFile);
      const mine = { ...(Object.hasOwn(all, workspaceId) ? all[workspaceId] : {}) };
      const key = request.owner.toLowerCase();
      if (request.command === 'remove-github-token') {
        const removed = Object.hasOwn(mine, key);
        delete mine[key];
        all[workspaceId] = mine;
        writeTokens(tokensFile, all);
        audit(db, 'github.token.removed', workspaceId, workspaceId, { owner: request.owner });
        return { owner: request.owner, removed };
      }
      if (typeof request.token !== 'string' || !GITHUB_TOKEN.test(request.token)) throw new ManagementError("That doesn't look like a GitHub token. Paste the whole token, starting with github_pat_ or ghp_.");
      const replaced = Object.hasOwn(mine, key);
      mine[key] = { owner: request.owner, token: request.token, added_at: stamp() };
      all[workspaceId] = mine;
      writeTokens(tokensFile, all);
      audit(db, 'github.token.added', workspaceId, workspaceId, { owner: request.owner, replaced });
      return { owner: request.owner, replaced };
    }
    if (request.command === 'add-staff') return staffIdentity(db, workspaceId, name(request.name), request.role);
    if (request.command === 'create-room') {
      const creator = owner(db, workspaceId);
      if (db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE workspace_id=? AND archived_at IS NULL').get(workspaceId).n >= 200) throw new ManagementError('Workspace room limit reached.');
      const roomName = name(request.name);
      const stem = roomName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,56) || 'room';
      let slug = stem, suffix = 1;
      while (db.prepare('SELECT 1 FROM rooms WHERE workspace_id=? AND slug=?').get(workspaceId,slug)) slug = `${stem}-${++suffix}`;
      const room = { id: id('room'), workspace_id: workspaceId, name: roomName, slug, project: null, created_by: creator, created_at: stamp(), archived_at: null };
      db.prepare('INSERT INTO rooms (id,workspace_id,name,slug,created_by,created_at) VALUES (?,?,?,?,?,?)').run(room.id,workspaceId,roomName,slug,creator,room.created_at);
      db.prepare('INSERT INTO members (room_id,agent_id,joined_at) VALUES (?,?,?)').run(room.id,creator,room.created_at);
      db.prepare('INSERT INTO events (type,workspace_id,room_id,actor_id,payload,created_at) VALUES (?,?,?,?,?,?)')
        .run('room.created',workspaceId,room.id,creator,JSON.stringify({via:'local-cli',name:roomName,slug}),room.created_at);
      return { room };
    }
    if (request.command === 'archive-room') {
      // Soft delete: messages, events and workspace files are kept; the room just stops being usable.
      const room = db.prepare('SELECT id,name FROM rooms WHERE id=? AND workspace_id=? AND archived_at IS NULL').get(identity(request.roomId,'room'),workspaceId);
      if (!room) throw new ManagementError('Room not found in workspace.');
      if (db.prepare("SELECT 1 FROM sandboxes WHERE room_id=? AND status IN ('running','provisioning')").get(room.id)) throw new ManagementError('This room has a running workspace; stop it in the Studio before archiving.');
      const now = stamp();
      db.prepare('UPDATE rooms SET archived_at=? WHERE id=?').run(now, room.id);
      db.prepare("UPDATE invites SET revoked_at=? WHERE room_id=? AND revoked_at IS NULL AND redeemed_at IS NULL").run(now, room.id);
      db.prepare('INSERT INTO events (type,workspace_id,room_id,payload,created_at) VALUES (?,?,?,?,?)')
        .run('room.archived',workspaceId,room.id,JSON.stringify({via:'local-cli',name:room.name}),now);
      return { archived: true, room: { id: room.id, name: room.name } };
    }
    if (request.command === 'create-invite') {
      const room = db.prepare('SELECT id FROM rooms WHERE id=? AND workspace_id=? AND archived_at IS NULL').get(identity(request.roomId,'room'),workspaceId);
      if (!room) throw new ManagementError('Room not found in workspace.');
      const label = request.label === undefined || request.label === '' ? null : name(request.label);
      const now = stamp();
      if (db.prepare('SELECT COUNT(*) AS n FROM invites WHERE room_id=? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at>?').get(room.id, now).n >= 50) throw new ManagementError('Too many open invites for this room. Revoke some first.');
      const creator = owner(db, workspaceId);
      const code = `achi_${randomBytes(24).toString('base64url')}`;
      const invite = { id: id('inv'), expires_at: new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString() };
      db.prepare('INSERT INTO invites (id,workspace_id,room_id,code_hash,label,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(invite.id, workspaceId, room.id, sha(code), label, creator, now, invite.expires_at);
      db.prepare('INSERT INTO events (type,workspace_id,room_id,actor_id,payload,created_at) VALUES (?,?,?,?,?,?)')
        .run('invite.created', workspaceId, room.id, creator, JSON.stringify({ via: 'local-cli', invite_id: invite.id, label, expires_at: invite.expires_at }), now);
      return { invite, path: `/join#${code}` };
    }
    if (request.command === 'revoke-invite') {
      const result = db.prepare('UPDATE invites SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL AND redeemed_at IS NULL')
        .run(stamp(), identity(request.inviteId, 'inv'), workspaceId);
      audit(db, 'invite.revoked', workspaceId, request.inviteId, { revoked: result.changes });
      return { revoked: result.changes };
    }
    const agent = db.prepare('SELECT * FROM agents WHERE id=? AND workspace_id=?').get(identity(request.agentId,'agt'), workspaceId);
    if (!agent) throw new ManagementError('Person not found in workspace.');
    const sidekick = sidekickOf(db, agent.id);
    if (request.command === 'issue-token') {
      if (agent.guest || sidekick || !staffRoles.has(agent.role)) throw new ManagementError('Only staff get tokens. Clients sign in with invite and sign-in links.');
      if (!active(db, agent.id)) throw new ManagementError('This person was removed. Add them again as staff.');
      return { agent, ...issueCredential(db, agent) };
    }
    if (request.command === 'end-sessions') return { ended: endSessions(db, workspaceId, agent.id) };
    if (request.command === 'sign-in-link') {
      if (!agent.guest || sidekick || !active(db, agent.id)) throw new ManagementError('Sign-in links are for clients who still have access.');
      const code = `achl_${randomBytes(32).toString('base64url')}`;
      const now = stamp();
      const expires = new Date(Date.now() + LINK_MINUTES * 60_000).toISOString();
      const creator = owner(db, workspaceId);
      db.prepare('INSERT INTO signin_links (id,workspace_id,agent_id,code_hash,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .run(id('lnk'), workspaceId, agent.id, sha(code), creator, now, expires);
      db.prepare('INSERT INTO events (type,workspace_id,actor_id,target_id,payload,created_at) VALUES (?,?,?,?,?,?)')
        .run('signin_link.created', workspaceId, creator, agent.id, JSON.stringify({ via: 'local-cli', expires_at: expires }), now);
      return { path: `/signin#${code}`, expires_at: expires, name: agent.name };
    }
    if (request.command === 'revoke-person') {
      // Removing a client also removes their sidekick; the running hub stops its container on its next sweep.
      let revoked = revokeTokens(db, workspaceId, agent.id);
      endSessions(db, workspaceId, agent.id);
      db.prepare('UPDATE passkeys SET removed_at=? WHERE agent_id=? AND removed_at IS NULL').run(stamp(), agent.id);
      const owned = sidekick ? [sidekick] : db.prepare('SELECT * FROM sidekicks WHERE owner_id=? AND removed_at IS NULL').all(agent.id);
      for (const row of owned) {
        if (row.agent_id !== agent.id) revoked += revokeTokens(db, workspaceId, row.agent_id);
        db.prepare('UPDATE sidekicks SET removed_at=? WHERE id=? AND removed_at IS NULL').run(stamp(), row.id);
      }
      return { revoked };
    }
    invalid();
  })();
}
