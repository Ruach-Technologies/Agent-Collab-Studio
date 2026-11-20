#!/usr/bin/env node
// Creates a brand-new, empty hub database for a fresh start: the current schema and no
// workspaces at all (the hub's built-in default workspace is removed while it is still unused).
// Refuses to touch an existing file. Run after `npm run build --workspace hub`.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const path = process.env.HUB_DB;
process.umask(0o077);
try {
  if (!path || !path.startsWith('/') || process.argv.length !== 2) throw new Error('usage: HUB_DB=/absolute/path/hub.sqlite init-database.mjs');
  if (existsSync(path)) throw new Error('A database already exists there; nothing was changed.');
  const { openDb, LEGACY_WORKSPACE_ID } = await import(pathToFileURL(resolve(root, 'hub/dist/db.js')).href);
  const db = openDb(path);
  try {
    db.transaction(() => {
      const used = ['agents', 'rooms', 'tokens', 'events', 'invites'].some((table) =>
        db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? LIMIT 1`).get(LEGACY_WORKSPACE_ID));
      if (!used) db.prepare('DELETE FROM workspaces WHERE id = ?').run(LEGACY_WORKSPACE_ID);
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error && error.message.length < 200 ? error.message : 'Could not create the database.' }));
  process.exitCode = 1;
}
