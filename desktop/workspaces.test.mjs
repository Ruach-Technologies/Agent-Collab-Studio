import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkBase, validateWorkspaceInput, workspaceRequest } from './workspaces.mjs';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Database = createRequire(import.meta.url)('better-sqlite3');
const W = 'wks_1111111111111111';

test('inputs are fixed-shape: unknown actions, roles, keys and ids are refused', () => {
  assert.doesNotThrow(() => validateWorkspaceInput({ action: 'add-staff', workspaceId: W, name: 'Sam', role: 'observer' }));
  for (const input of [
    { action: 'add-staff', workspaceId: W, name: 'Bot', role: 'agent' },
    { action: 'create-agent', workspaceId: W, name: 'x', role: 'agent' },
    { action: 'create-profile', workspaceId: W },
    { action: 'export-sdk', destination: '/tmp/x' },
    { action: 'list', workspaceId: '../other' },
    { action: 'create-room', workspaceId: W, name: 'ok', executable: '/bin/sh' },
    { action: 'create-room', workspaceId: W, name: ' padded' },
    { action: 'toString' },
  ]) assert.throws(() => validateWorkspaceInput(input));
});

test('links use the verified tunnel address, or this Mac when there is none', () => {
  assert.equal(linkBase('https://hub.example.test/'), 'https://hub.example.test');
  for (const bad of [undefined, 'http://evil.test/', 'https://user:pw@x.test/', 'https://x.test/path', 'nonsense']) assert.equal(linkBase(bad), 'http://127.0.0.1:8791');
});

test('a fresh database has no workspaces, and the operator builds one end to end', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = join(root, 'data', 'hub.sqlite');
  await mkdir(join(root, 'data'));
  await exec(process.execPath, [join(repo, 'hub/scripts/init-database.mjs')], { env: { ...process.env, HUB_DB: db } });
  await assert.rejects(exec(process.execPath, [join(repo, 'hub/scripts/init-database.mjs')], { env: { ...process.env, HUB_DB: db } }));
  const settings = { nodePath: process.execPath, ownerName: 'Alex' };
  const run = (input, extra = {}) => workspaceRequest(input, repo, settings, { ...process.env }, {
    ...extra, manage: (request) => import('../hub/scripts/management.mjs').then(({ openManagedDb, manage }) => {
      const handle = openManagedDb(db);
      try { return manage(handle, request, { tokensFile: join(root, 'data', 'github-tokens.json') }); } finally { handle.close(); }
    }) });

  assert.deepEqual((await run({ action: 'list' })).workspaces, []);
  const created = await run({ action: 'create-workspace', name: 'Sunrise' });
  assert.match(created.token, /^ach_/);
  assert.equal(created.agent.name, 'Alex');
  const workspaceId = created.workspace.id;
  await assert.rejects(run({ action: 'create-workspace', name: 'sunrise' }), /already exists/);
  const room = (await run({ action: 'create-room', workspaceId, name: 'Website' })).room;
  const invite = await run({ action: 'create-invite', workspaceId, roomId: room.id, label: 'Dana' }, { publicUrl: 'https://hub.example.test/' });
  assert.match(invite.url, /^https:\/\/hub\.example\.test\/join#achi_[A-Za-z0-9_-]{32}$/);
  assert.equal(invite.path, undefined);

  // A client who joined (as the hub would record it), with a sidekick.
  const handle = new Database(db);
  const now = new Date().toISOString();
  handle.prepare("INSERT INTO agents (id, workspace_id, name, role, created_at, guest) VALUES ('agt_aaaaaaaaaaaaaaaa', ?, 'Dana', 'agent', ?, 1), ('agt_bbbbbbbbbbbbbbbb', ?, 'Pip', 'agent', ?, 1)").run(workspaceId, now, workspaceId, now);
  handle.prepare("INSERT INTO tokens (id, agent_id, workspace_id, role, token_hash, created_at) VALUES ('tok_aaaaaaaaaaaaaaaa', 'agt_aaaaaaaaaaaaaaaa', ?, 'agent', ?, ?), ('tok_bbbbbbbbbbbbbbbb', 'agt_bbbbbbbbbbbbbbbb', ?, 'agent', ?, ?)")
    .run(workspaceId, createHash('sha256').update(randomBytes(8)).digest('hex'), now, workspaceId, createHash('sha256').update(randomBytes(8)).digest('hex'), now);
  handle.prepare("INSERT INTO sidekicks (id, workspace_id, agent_id, owner_id, provider, created_at) VALUES ('skk_aaaaaaaaaaaaaaaa', ?, 'agt_bbbbbbbbbbbbbbbb', 'agt_aaaaaaaaaaaaaaaa', 'claude', ?)").run(workspaceId, now);
  handle.prepare("INSERT INTO sessions (id, workspace_id, agent_id, token_hash, device_key, via, created_at, expires_at, last_used_at) VALUES ('ses_aaaaaaaaaaaaaaaa', ?, 'agt_aaaaaaaaaaaaaaaa', 'h1', '{}', 'invite', ?, ?, ?)")
    .run(workspaceId, now, new Date(Date.now() + 3600_000).toISOString(), now);
  handle.close();

  const listed = await run({ action: 'list', workspaceId });
  const dana = listed.people.find((person) => person.name === 'Dana');
  assert.equal(dana.kind, 'client');
  assert.ok(dana.session_until);
  assert.deepEqual(dana.sidekick, { id: 'skk_aaaaaaaaaaaaaaaa', name: 'Pip', provider: 'claude', signed_in: false, asleep: false });
  assert.equal(listed.people.find((person) => person.name === 'Pip').kind, 'sidekick');
  assert.equal(listed.invites[0].state, 'open');
  assert.equal(listed.workspaces[0].people, 2);

  const link = await run({ action: 'sign-in-link', workspaceId, agentId: 'agt_aaaaaaaaaaaaaaaa' });
  assert.match(link.url, /^http:\/\/127\.0\.0\.1:8791\/signin#achl_[A-Za-z0-9_-]{43}$/);
  await assert.rejects(run({ action: 'sign-in-link', workspaceId, agentId: created.agent.id }), /clients/);
  await assert.rejects(run({ action: 'issue-token', workspaceId, agentId: 'agt_aaaaaaaaaaaaaaaa' }), /Only staff/);

  assert.deepEqual(await run({ action: 'end-sessions', workspaceId, agentId: 'agt_aaaaaaaaaaaaaaaa' }), { ended: 1 });
  assert.equal(await run({ action: 'revoke-person', workspaceId, agentId: 'agt_aaaaaaaaaaaaaaaa' }).then((r) => r.revoked), 2);
  const after = await run({ action: 'list', workspaceId });
  assert.deepEqual(after.people.map((person) => person.name), ['Alex']);
  const check = new Database(db, { readonly: true });
  const stored = JSON.stringify([check.prepare('SELECT * FROM invites').all(), check.prepare('SELECT * FROM signin_links').all(), check.prepare('SELECT * FROM tokens').all()]);
  check.close();
  for (const secret of [created.token, invite.url.split('#')[1], link.url.split('#')[1]]) assert.ok(!stored.includes(secret));

  // Deleting one workspace removes everything in it and nothing else.
  const other = await run({ action: 'create-workspace', name: 'Harbor' });
  await run({ action: 'create-room', workspaceId: other.workspace.id, name: 'Site' });
  const seed = new Database(db);
  seed.prepare("INSERT INTO sandboxes (id, room_id, container_name, image, status, created_at, updated_at) VALUES ('sbx_aaaaaaaaaaaaaaaa', ?, 'ach-sbx-x', 'img', 'running', ?, ?)").run(room.id, now, now);
  seed.prepare("INSERT INTO messages (id, room_id, sender_id, body, created_at) VALUES ('msg_aaaaaaaaaaaaaaaa', ?, ?, 'hello', ?)").run(room.id, created.agent.id, now);
  seed.close();
  // GitHub tokens: saved per workspace and organization, listed without the value, private file.
  const tokensFile = join(root, 'data', 'github-tokens.json');
  const pat = 'github_pat_' + 'a'.repeat(40);
  await assert.rejects(run({ action: 'add-github-token', workspaceId, owner: 'Kite-Apps', token: 'nope' }), /GitHub token/);
  await assert.rejects(run({ action: 'add-github-token', workspaceId, owner: '../x', token: pat }), /organization/);
  assert.deepEqual(await run({ action: 'add-github-token', workspaceId, owner: 'Kite-Apps', token: pat }), { owner: 'Kite-Apps', replaced: false });
  assert.equal((await run({ action: 'add-github-token', workspaceId, owner: 'kite-apps', token: pat })).replaced, true);
  await run({ action: 'add-github-token', workspaceId: other.workspace.id, owner: 'Harbor-Org', token: pat });
  const withTokens = await run({ action: 'list', workspaceId });
  assert.deepEqual(withTokens.github.map((g) => g.owner), ['kite-apps']);
  assert.ok(!JSON.stringify(withTokens).includes(pat));
  assert.equal((await stat(tokensFile)).mode & 0o777, 0o600);
  await run({ action: 'add-github-token', workspaceId, owner: 'Widgets', token: pat });
  assert.equal((await run({ action: 'remove-github-token', workspaceId, owner: 'WIDGETS' })).removed, true);
  assert.deepEqual((await run({ action: 'list', workspaceId })).github.map((g) => g.owner), ['kite-apps']);

  await assert.rejects(run({ action: 'delete-workspace', workspaceId, confirmName: 'sunrise' }), /exactly/);
  const removed = await run({ action: 'delete-workspace', workspaceId, confirmName: 'Sunrise' });
  assert.deepEqual(removed.deleted, { id: workspaceId, name: 'Sunrise' });
  assert.deepEqual(removed.containers.sort(), ['ach-dev-sbx_aaaaaaaaaaaaaaaa', 'ach-sbx-x', 'ach-sidekick-skk_aaaaaaaaaaaaaaaa']);
  assert.deepEqual(removed.volumes, ['ach-sidekick-skk_aaaaaaaaaaaaaaaa-home']);
  assert.deepEqual(removed.rooms, [room.id]);
  const left = await run({ action: 'list' });
  assert.deepEqual(left.workspaces.map((w) => w.name), ['Harbor']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(tokensFile, 'utf8'))), [other.workspace.id]);
  const audit = new Database(db, { readonly: true });
  for (const table of ['agents', 'tokens', 'rooms', 'messages', 'members', 'invites', 'sessions', 'sidekicks', 'sandboxes', 'signin_links', 'passkeys']) {
    const columns = audit.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);
    const where = columns.includes('workspace_id') ? 'workspace_id = ?' : columns.includes('room_id') ? 'room_id IN (?)' : null;
    if (where) assert.equal(audit.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(columns.includes('workspace_id') ? workspaceId : room.id).n, 0, table);
  }
  assert.equal(audit.prepare('SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ?').get(other.workspace.id).n, 1);
  assert.equal(audit.prepare('PRAGMA foreign_key_check').all().length, 0);
  audit.close();
});
