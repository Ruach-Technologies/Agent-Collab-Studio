import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DbHandle } from '../src/db.js';

let dir: string;
let db: DbHandle;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'collab-cli-')); db = openDb(join(dir, 'hub.sqlite')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [resolve('scripts', script), ...args], { env: { ...process.env, HUB_DATA_DIR: dir }, encoding: 'utf8' });
}
describe('local revocation', () => {
  it('revokes a person by id, reports zero the second time, and keeps their history', () => {
    const made = spawnSync(process.execPath, [resolve('scripts/manage.mjs')], { env: { ...process.env, HUB_DB: join(dir, 'hub.sqlite') }, input: JSON.stringify({ command: 'create-workspace', name: 'CLI', ownerName: 'Ben' }), encoding: 'utf8' });
    const { agent, token } = JSON.parse(made.stdout);
    expect(JSON.stringify(db.prepare('SELECT * FROM tokens').all())).not.toContain(token);
    expect(run('revoke-token.mjs', [agent.id]).stdout).toContain('Revoked 1');
    expect(run('revoke-token.mjs', [agent.id]).stdout).toContain('Revoked 0');
    expect(db.prepare('SELECT COUNT(*) AS n FROM agents WHERE id = ?').get(agent.id)).toEqual({ n: 1 });
  });
  it('rejects malformed agent ids and extra arguments without changes', () => {
    expect(run('revoke-token.mjs', ['not-an-id']).status).toBe(2);
    expect(run('revoke-token.mjs', ['agt_0000000000000000', '--workspace', 'wks_0000000000000000']).status).toBe(2);
    expect(run('revoke-token.mjs', ['agt_0000000000000000']).status).toBe(1);
  });
});
