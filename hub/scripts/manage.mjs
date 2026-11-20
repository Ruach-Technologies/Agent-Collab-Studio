#!/usr/bin/env node
import { openManagedDb, manage, ManagementError, githubTokensPath } from './management.mjs';

process.umask(0o077);
let db;
try {
  if (process.argv.length !== 2 || !process.env.HUB_DB) throw new Error();
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 16_384) throw new Error();
  }
  const request = JSON.parse(text);
  db = openManagedDb(process.env.HUB_DB);
  console.log(JSON.stringify({ ok: true, ...manage(db, request, { tokensFile: githubTokensPath(process.env.HUB_DB) }) }));
} catch (error) {
  if (error instanceof ManagementError && error.message.length < 300) console.log(JSON.stringify({ ok: false, message: error.message }));
  else console.log(JSON.stringify({ ok: false, message: 'Workspace management failed. Check the request, unique names, selected scope, database permissions and schema upgrade status. No success is implied.' }));
  process.exitCode = 1;
} finally { db?.close(); }
