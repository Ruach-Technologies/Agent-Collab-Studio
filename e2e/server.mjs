// Isolated browser fixture; never uses the real hub database or agent tokens.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../hub/dist/server.js';
import { TokenRegistry } from '../hub/dist/tokens.js';
import { issueOperator } from '../hub/dist/operator.js';

const dir = mkdtempSync(join(tmpdir(), 'collab-browser-'));
// Fixture instruction files stand in for the operator's global ones.
writeFileSync(join(dir, 'AGENTS.md'), 'Fixture agent instructions\n');
writeFileSync(join(dir, 'CLAUDE.md'), 'Fixture Claude instructions\n');
const hub = await buildServer({ ...process.env, HUB_DATA_DIR: join(dir, 'data'), HUB_WORKSPACES_DIR: join(dir, 'workspaces'), HUB_LOG_LEVEL: 'silent',
  HUB_SANDBOX_SEED_FILES: `${join(dir, 'AGENTS.md')},${join(dir, 'CLAUDE.md')}`, HUB_SANDBOX_GITHUB_TOKEN: '' });
const tokens = new TokenRegistry(hub.services.db);
const operator = tokens.issue('browser-operator', 'supervisor');
const alice = tokens.issue('browser-alice', 'agent');
const room = hub.services.rooms.create({ name: 'Browser collaboration', project: 'Environment validation' }, operator.agent.id);
hub.services.rooms.join(room.id, alice.agent.id);
hub.services.rooms.postMessage(room.id, alice.agent.id, 'Ready to collaborate');
mkdirSync('e2e/.state', { recursive: true });
const foreignWorkspace = { id: 'wks_ffffffffffffffff', name: 'Other collaboration', created_at: new Date().toISOString() };
hub.services.db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(foreignWorkspace.id, foreignWorkspace.name, foreignWorkspace.created_at);
const foreign = tokens.issue('browser-operator', 'supervisor', foreignWorkspace.id);
const foreignRoom = hub.services.rooms.create({ name: 'Foreign confidential room' }, foreign.agent.id);
hub.services.rooms.postMessage(foreignRoom.id, foreign.agent.id, 'Foreign confidential message');
const operatorToken = issueOperator(join(dir, 'data'), 'browser-operator').token;
writeFileSync('e2e/.state/fixture.json', JSON.stringify({ operatorToken, token: operator.token, alice: alice.token, room: room.id, foreignToken: foreign.token, foreignRoom: foreignRoom.id }), { mode: 0o600 });
await hub.app.listen({ port: 18991, host: '127.0.0.1' });
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  // Only this fixture's room may be removed, never another hub's resources.
  await hub.services.sandbox.destroy(room.id);
  await hub.app.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync('e2e/.state/fixture.json', { force: true });
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
