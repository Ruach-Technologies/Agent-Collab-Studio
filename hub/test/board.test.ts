import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, type BuiltHub } from '../src/server.js';
import { TokenRegistry } from '../src/tokens.js';
import { DEFAULT_RULES } from '../src/board.js';

let hub: BuiltHub;
let dir: string;
let supervisor: ReturnType<TokenRegistry['issue']>;
let alice: ReturnType<TokenRegistry['issue']>;
let bob: ReturnType<TokenRegistry['issue']>;
let room: string;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'collab-board-'));
  hub = await buildServer({ HUB_DATA_DIR: join(dir, 'data'), HUB_WORKSPACES_DIR: join(dir, 'ws'), HUB_WEB_DIST: join(dir, 'missing'), HUB_LOG_LEVEL: 'silent' });
  const registry = new TokenRegistry(hub.services.db);
  supervisor = registry.issue('operator', 'supervisor'); alice = registry.issue('alice', 'agent'); bob = registry.issue('bob', 'agent');
  room = hub.services.rooms.create({ name: 'Launch site' }, supervisor.agent.id).id;
  hub.services.rooms.join(room, alice.agent.id);
});
afterEach(async () => { await hub.app.close(); rmSync(dir, { recursive: true, force: true }); });

const event = (type: string, actor: string, payload: Record<string, unknown>, target: string | null = null) =>
  hub.services.events.append({ type: type as never, room_id: room, actor_id: actor, target_id: target, payload });

describe('project board', () => {
  it('shows default rules to members, lets only staff change them, and hides the room from others', async () => {
    const board = await hub.app.inject({ url: `/v1/rooms/${room}/board`, headers: auth(alice.token) });
    expect(board.json()).toMatchObject({ rules: DEFAULT_RULES, custom_rules: false });
    expect((await hub.app.inject({ url: `/v1/rooms/${room}/board`, headers: auth(bob.token) })).statusCode).toBe(404);
    expect((await hub.app.inject({ method: 'PUT', url: `/v1/rooms/${room}/rules`, headers: auth(alice.token), payload: { rules: 'mine' } })).statusCode).toBe(403);
    const updated = await hub.app.inject({ method: 'PUT', url: `/v1/rooms/${room}/rules`, headers: auth(supervisor.token), payload: { rules: '# Ours\n- be nice' } });
    expect(updated.json()).toEqual({ rules: '# Ours\n- be nice', custom_rules: true });
    expect((await hub.app.inject({ url: `/v1/rooms/${room}/board`, headers: auth(alice.token) })).json().rules).toBe('# Ours\n- be nice');
    await hub.app.inject({ method: 'PUT', url: `/v1/rooms/${room}/rules`, headers: auth(supervisor.token), payload: { rules: null } });
    expect((await hub.app.inject({ url: `/v1/rooms/${room}/board`, headers: auth(alice.token) })).json().custom_rules).toBe(false);
  });

  it('totals code written, commands and checks per person, and keeps direct messages and output out', async () => {
    event('file.write', alice.agent.id, { path: 'a.ts', operation: 'write', outcome: 'success', lines_added: 12, lines_removed: 2 });
    event('file.write', alice.agent.id, { path: 'b.ts', operation: 'write', outcome: 'success', lines_added: 3, lines_removed: 0 });
    event('file.write', alice.agent.id, { path: 'CLAUDE.md', operation: 'seed', outcome: 'success', lines_added: 900 });
    event('sandbox.exec.result', alice.agent.id, { cmd: 'npm test', exit_code: 0, stdout: 'secret output' });
    event('sandbox.exec.result', alice.agent.id, { cmd: 'npm run lint', exit_code: 1 });
    event('sandbox.exec.result', alice.agent.id, { cmd: 'ls', exit_code: 0 });
    event('sandbox.exec.result', alice.agent.id, { cmd: 'git clone', kind: 'git', exit_code: 1 });
    event('message.created', alice.agent.id, { message: { body: 'just between us' } }, supervisor.agent.id);
    const people = (await hub.app.inject({ url: `/v1/rooms/${room}/board`, headers: auth(alice.token) })).json().people;
    const mine = people.find((entry: { agent_id: string }) => entry.agent_id === alice.agent.id);
    expect(mine).toMatchObject({ lines_added: 15, lines_removed: 2, saves: 2, commands: 3, failed: 1, checks: 2, checks_passed: 1 });
    expect(JSON.stringify(mine.recent)).not.toContain('secret output');
    expect(JSON.stringify(people)).not.toContain('just between us');
    expect(mine.recent).toHaveLength(3);
  });

  it('gives agents a plain feed of workspace activity since a cursor, without chat', async () => {
    const first = event('file.write', alice.agent.id, { path: 'a.ts', operation: 'write', outcome: 'success', lines_added: 4, lines_removed: 1 });
    event('message.created', alice.agent.id, { message: { body: 'chat stays out' } });
    event('sandbox.exec.result', alice.agent.id, { cmd: 'npm test', exit_code: 1 });
    const feed = (await hub.app.inject({ url: `/v1/rooms/${room}/feed?since=${first.id - 1}`, headers: auth(alice.token) })).json();
    expect(feed.events.map((line: { text: string }) => line.text.slice(6))).toEqual(['alice saved a.ts (+4 −1)', 'alice ran `npm test` → exit 1']);
    expect(JSON.stringify(feed)).not.toContain('chat stays out');
    const later = (await hub.app.inject({ url: `/v1/rooms/${room}/feed?since=${feed.next_since}`, headers: auth(alice.token) })).json();
    expect(later.events).toEqual([]);
    expect(first).toBeDefined();
    expect((await hub.app.inject({ url: `/v1/rooms/${room}/feed`, headers: auth(bob.token) })).statusCode).toBe(404);
  });
});
