// Local operator access: one credential that acts as a supervisor in whichever
// workspace the operator selects. It is honoured only for requests made
// directly to the loopback listener, never through the tunnel, and resolves to
// an ordinary per-workspace supervisor identity so every existing workspace
// check, trigger and audit record keeps applying unchanged.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { DbHandle } from './db.js';
import type { Agent } from './types.js';

export const OPERATOR_TOKEN = /^acho_[A-Za-z0-9_-]{43}$/;
export const WORKSPACE_ID = /^wks_[a-f0-9]{16}$/;

export interface OperatorRecord { name: string; token_hash: string; created_at: string; }

export function operatorFile(dataDir: string): string { return path.join(dataDir, 'operator.json'); }

/** The credential lives beside the database as a private file holding only a hash. */
export function readOperator(dataDir: string): OperatorRecord | null {
  try {
    const file = operatorFile(dataDir);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OperatorRecord>;
    if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 60 || /[\x00-\x1f\x7f]/.test(record.name) ||
        typeof record.token_hash !== 'string' || !/^[a-f0-9]{64}$/.test(record.token_hash)) return null;
    return { name: record.name.trim(), token_hash: record.token_hash, created_at: String(record.created_at ?? '') };
  } catch { return null; }
}

/** Replaces any previous operator credential; the plaintext is returned once. */
export function issueOperator(dataDir: string, name: string): { token: string } {
  if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid operator name');
  const token = `acho_${randomBytes(32).toString('base64url')}`;
  const record: OperatorRecord = { name: name.trim(), token_hash: createHash('sha256').update(token).digest('hex'), created_at: new Date().toISOString() };
  const file = operatorFile(dataDir);
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  return { token };
}

export function revokeOperator(dataDir: string): boolean {
  try { fs.unlinkSync(operatorFile(dataDir)); return true; } catch { return false; }
}

export function verifyOperator(dataDir: string, token: string): OperatorRecord | null {
  if (!OPERATOR_TOKEN.test(token)) return null;
  const record = readOperator(dataDir);
  if (!record) return null;
  const offered = createHash('sha256').update(token).digest();
  return timingSafeEqual(offered, Buffer.from(record.token_hash, 'hex')) ? record : null;
}

/**
 * True only for a request addressed to the loopback listener with no sign of a
 * proxy. The tunnel always presents its public hostname and forwarding headers,
 * which a remote caller cannot remove.
 */
export function isLocalRequest(headers: IncomingHttpHeaders): boolean {
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(String(headers.host ?? ''))) return false;
  return !Object.keys(headers).some((name) => {
    const header = name.toLowerCase();
    return header !== 'ngrok-skip-browser-warning' &&
      (header.startsWith('x-forwarded-') || header.startsWith('ngrok-') || header.startsWith('cf-') ||
        ['forwarded', 'via', 'x-real-ip', 'x-original-host', 'true-client-ip'].includes(header));
  });
}

export type OperatorScope = { agent: Agent } | { error: 'WORKSPACE_NOT_FOUND' };

/**
 * The operator's supervisor identity in one workspace, created on first use.
 * Without a requested workspace the oldest one is used.
 */
export function operatorAgent(db: DbHandle, record: OperatorRecord, workspaceId: string | undefined): OperatorScope {
  if (workspaceId !== undefined && !WORKSPACE_ID.test(workspaceId)) return { error: 'WORKSPACE_NOT_FOUND' };
  const workspace = (workspaceId
    ? db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
    : db.prepare('SELECT id FROM workspaces ORDER BY created_at, id LIMIT 1').get()) as { id: string } | undefined;
  if (!workspace) return { error: 'WORKSPACE_NOT_FOUND' };
  const find = db.prepare('SELECT id, workspace_id, name, role, created_at, last_seen_at FROM agents WHERE workspace_id = ? AND name = ? COLLATE NOCASE');
  return db.transaction((): OperatorScope => {
    for (const name of [record.name, `${record.name} (operator)`]) {
      const existing = find.get(workspace.id, name) as Agent | undefined;
      if (existing?.role === 'supervisor') return { agent: existing };
      if (existing) continue; // the name belongs to a non-supervisor identity; never elevate it
      const agent: Agent = { id: `agt_${randomBytes(8).toString('hex')}`, workspace_id: workspace.id, name, role: 'supervisor', created_at: new Date().toISOString(), last_seen_at: null };
      db.prepare('INSERT INTO agents (id, workspace_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(agent.id, agent.workspace_id, agent.name, agent.role, agent.created_at);
      db.prepare('INSERT INTO events (type, workspace_id, target_id, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('agent.created', workspace.id, agent.id, JSON.stringify({ via: 'operator' }), agent.created_at);
      return { agent };
    }
    return { error: 'WORKSPACE_NOT_FOUND' };
  })();
}
