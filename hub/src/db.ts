/**
 * Database schema and migrations for the agent-collab-hub.
 * better-sqlite3, WAL mode, single process owner.
 *
 * Design notes:
 * - Tokens are stored SHA-256 hashed; the plaintext token exists only at issuance time.
 * - Every observable action appends a row to `events` (the observability spine).
 * - `messages.room_id` + `messages.recipient_id` model both room posts (recipient NULL)
 *   and agent-to-agent DMs within a room.
 * - `sandboxes.execs` records every container command for audit + UI replay.
 */
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const LEGACY_WORKSPACE_ID = 'wks_0000000000000000';
export const SCHEMA_VERSION = 9;

export { Database };
export type DbHandle = BetterSqliteDatabase;

export type HubRole = 'supervisor' | 'agent' | 'observer';

export interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  role: HubRole;
  created_at: string;
  last_seen_at: string | null;
}

export interface TokenRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  role: HubRole;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface RoomRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  project: string | null;
  created_by: string;
  created_at: string;
  archived_at: string | null;
}

export interface MemberRow {
  room_id: string;
  agent_id: string;
  joined_at: string;
}

export interface MessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  recipient_id: string | null;
  body: string;
  created_at: string;
}

export interface SandboxRow {
  id: string;
  room_id: string;
  container_id: string | null;
  container_name: string;
  image: string;
  status: 'unprovisioned' | 'provisioning' | 'running' | 'stopped' | 'error';
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecRow {
  id: string;
  sandbox_id: string;
  agent_id: string;
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
  created_at: string;
}

export type EventType =
  | 'auth.ok'
  | 'auth.denied'
  | 'auth.revoked'
  | 'agent.created'
  | 'workspace.created'
  | 'token.issued'
  | 'room.created'
  | 'room.joined'
  | 'room.archived'
  | 'message.created'
  | 'ws.connect'
  | 'ws.disconnect'
  | 'sandbox.requested'
  | 'sandbox.ready'
  | 'sandbox.error'
  | 'sandbox.exec.started'
  | 'sandbox.exec.result'
  | 'file.read'
  | 'file.write'
  | 'ratelimit.hit'
  | 'sandbox.stopped'
  | 'sandbox.exec.denied'
  | 'oauth.client.registered'
  | 'oauth.authorized'
  | 'oauth.granted'
  | 'oauth.revoked'
  | 'invite.created'
  | 'invite.redeemed'
  | 'invite.revoked'
  | 'agent.updated'
  | 'room.left'
  | 'room.rules_updated'
  | 'sidekick.created'
  | 'sidekick.signed_in'
  | 'sidekick.removed'
  | 'sidekick.turn.started'
  | 'sidekick.activity'
  | 'sidekick.turn.finished'
  | 'sidekick.settings_updated'
  | 'sidekick.stopped'
  | 'sidekick.cleanup_pending'
  | 'sidekick.cleaned_up'
  | 'sidekick.asleep'
  | 'session.started'
  | 'session.ended'
  | 'passkey.added'
  | 'passkey.removed'
  | 'signin_link.created'
  | 'devserver.started'
  | 'devserver.stopped'
  | 'devserver.exited'
  | 'devserver.error'
  | 'devserver.preview.opened'
  | 'devserver.preview.denied'
  | 'sidekick.tool.denied'
  | 'sidekick.post.denied'
  | 'sidekick.people_only.denied'
  | 'security.alert.acknowledged'
  | 'server.started';

export interface EventRow {
  id: number;
  workspace_id: string | null;
  type: EventType;
  room_id: string | null;
  actor_id: string | null;
  target_id: string | null;
  payload: string; // JSON
  created_at: string;
}

export const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('supervisor','agent','observer')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL CHECK (role IN ('supervisor','agent','observer')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_agent ON tokens(agent_id);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  project TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  sender_id TEXT NOT NULL REFERENCES agents(id),
  recipient_id TEXT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id),
  container_id TEXT,
  container_name TEXT NOT NULL,
  image TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unprovisioned'
    CHECK (status IN ('unprovisioned','provisioning','running','stopped','error')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execs (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  cmd TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  timed_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execs_sandbox_time ON execs(sandbox_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  room_id TEXT,
  actor_id TEXT,
  target_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`;

export function openDb(dbPath: string, options: { allowLegacyMigration?: boolean } = {}): DbHandle {
  const existing = dbPath !== ':memory:' && existsSync(dbPath);
  if (existing && (lstatSync(dbPath).isSymbolicLink() || !lstatSync(dbPath).isFile())) throw new Error('Unsafe database path');
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { timeout: 3000 });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version > SCHEMA_VERSION) throw new Error('Database schema is newer than this hub');
    if (version < 1) {
      if (existing && db.prepare("SELECT 1 FROM sqlite_master WHERE name='agents'").get()) {
        if (options.allowLegacyMigration === false) throw new Error('Legacy database upgrade requires an explicitly approved stopped cutover and HUB_ALLOW_WORKSPACE_MIGRATION=1');
        const backup = `${dbPath}.pre-workspaces-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(LEGACY_SCHEMA);
        db.exec(readFileSync(new URL('../migrations/001-workspaces.sql', import.meta.url), 'utf8'));
        if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Database migration failed foreign-key validation');
      })();
    }
    if (version < 2) {
      // Additive only (sign-in records and read positions). A version-1 database is copied first
      // because an older hub build refuses to open a version-2 file.
      if (existing && version === 1) {
        const backup = `${dbPath}.pre-oauth-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.transaction(() => { db.exec(readFileSync(new URL('../migrations/002-oauth-mcp.sql', import.meta.url), 'utf8')); })();
    }
    if (version < 3) {
      // Additive (invites, avatar and guest columns). Copied first for the same reason as above.
      if (existing && version === 2) {
        const backup = `${dbPath}.pre-invites-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.transaction(() => { db.exec(readFileSync(new URL('../migrations/003-invites.sql', import.meta.url), 'utf8')); })();
    }
    if (version < 4) {
      // Additive (sidekicks). Copied first for the same reason as above.
      if (existing && version === 3) {
        const backup = `${dbPath}.pre-sidekicks-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.transaction(() => { db.exec(readFileSync(new URL('../migrations/004-sidekicks.sql', import.meta.url), 'utf8')); })();
    }
    if (version < 5) {
      // Rebuilds the sidekicks table (same rows) to allow ChatGPT sidekicks. Copied first; foreign
      // keys are paused only for the table swap and checked before it commits.
      if (existing && version === 4) {
        const backup = `${dbPath}.pre-codex-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(readFileSync(new URL('../migrations/005-sidekick-codex.sql', import.meta.url), 'utf8'));
        if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Database migration failed foreign-key validation');
      })();
    }
    if (version < 6) {
      // Additive (room rules). Copied first for the same reason as above.
      if (existing && version === 5) {
        const backup = `${dbPath}.pre-rules-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.transaction(() => { db.exec(readFileSync(new URL('../migrations/006-room-rules.sql', import.meta.url), 'utf8')); })();
    }
    if (version < 7) {
      // Additive (live sidekick settings, job records, read positions). Copied first as above.
      if (existing && version === 6) {
        const backup = `${dbPath}.pre-live-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.transaction(() => { db.exec(readFileSync(new URL('../migrations/007-sidekick-live.sql', import.meta.url), 'utf8')); })();
    }
    if (version < 8) {
      // Additive (security monitoring: gate traffic, alerts, read positions). Copied first as above.
      if (existing && version === 7) {
        const backup = `${dbPath}.pre-security-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.transaction(() => { db.exec(readFileSync(new URL('../migrations/008-security.sql', import.meta.url), 'utf8')); })();
    }
    if (version < 9) {
      // Client sessions, passkeys and sign-in links; clients' permanent tokens are revoked. Copied first as above.
      if (existing && version === 8) {
        const backup = `${dbPath}.pre-sessions-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`;
        const previousMask = process.umask(0o077);
        try { db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600); }
        finally { process.umask(previousMask); }
      }
      db.transaction(() => { db.exec(readFileSync(new URL('../migrations/009-sessions.sql', import.meta.url), 'utf8')); })();
    }
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) { db.close(); throw error; }
}

export function hubIdentity(db: DbHandle): { instance_id: string } {
  const row = db.prepare("SELECT value FROM hub_metadata WHERE key='instance_id'").get() as { value: string };
  return { instance_id: row.value };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const rand = randomBytes(8).toString('hex');
  return `${prefix}_${rand}`;
}
