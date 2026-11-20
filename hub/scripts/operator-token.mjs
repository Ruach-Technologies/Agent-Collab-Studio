#!/usr/bin/env node
// Issue, inspect or revoke the single local operator credential. The running hub
// reads the private record on each use, so no restart is needed.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueOperator, readOperator, revokeOperator, operatorFile } from '../dist/operator.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = resolve(process.env.HUB_DATA_DIR ?? resolve(root, 'data'));
const [command, name] = process.argv.slice(2);
process.umask(0o077);
try {
  if (command === 'issue' && name && process.argv.length === 4) {
    const { token } = issueOperator(dataDir, name);
    console.log(`operator: ${name}\ntoken:    ${token}`);
    console.log('(shown once; any earlier operator token stopped working. It is accepted only at http://127.0.0.1 on this machine.)');
  } else if (command === 'revoke' && process.argv.length === 3) {
    console.log(revokeOperator(dataDir) ? 'Operator credential revoked.' : 'No operator credential was present.');
  } else if (command === 'status' && process.argv.length === 3) {
    const record = readOperator(dataDir);
    console.log(record ? `operator: ${record.name} (issued ${record.created_at})\nrecord:   ${operatorFile(dataDir)}` : 'No operator credential is configured.');
  } else {
    console.error('usage: operator-token.mjs issue <name> | status | revoke');
    process.exitCode = 2;
  }
} catch { console.error('Operator credential operation failed. Build the hub and check the data directory.'); process.exitCode = 1; }
