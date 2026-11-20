#!/usr/bin/env node
// Emergency local revocation: removes one person's access (tokens, sessions, passkeys, and a
// client's sidekick). Historical identity and message rows are kept.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openManagedDb, manage } from './management.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const agentId = process.argv[2];
if (!/^agt_[a-f0-9]{16}$/.test(agentId ?? '') || process.argv.length !== 3) {
  console.error('usage: revoke-token.mjs <agent-id>'); process.exitCode = 2;
} else {
  let db;
  try {
    db = openManagedDb(process.env.HUB_DB ?? resolve(process.env.HUB_DATA_DIR ?? resolve(root, 'data'), 'hub.sqlite'));
    const agent = db.prepare('SELECT workspace_id FROM agents WHERE id=?').get(agentId);
    if (!agent) throw new Error();
    const { revoked } = manage(db, { command: 'revoke-person', workspaceId: agent.workspace_id, agentId });
    console.log(`Revoked ${revoked} active token(s) for ${agentId}`);
  } catch { console.error('Could not revoke access. Check the agent id and the database version.'); process.exitCode = 1; }
  finally { db?.close(); }
}
