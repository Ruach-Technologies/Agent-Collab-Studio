-- Additive: one-time room invites, and a small profile on agents (chosen avatar, guest confinement).
-- Only the SHA-256 hash of an invite code is stored. Existing rows keep working unchanged:
-- both new agent columns are nullable or defaulted.
ALTER TABLE agents ADD COLUMN avatar TEXT;
ALTER TABLE agents ADD COLUMN guest INTEGER NOT NULL DEFAULT 0;
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_by TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by TEXT REFERENCES agents(id),
  revoked_at TEXT
);
CREATE INDEX idx_invites_room ON invites(room_id);
PRAGMA user_version = 3;
