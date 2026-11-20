-- Sidekicks can also be ChatGPT (Codex). SQLite cannot change a CHECK constraint in place, so the
-- table is rebuilt with the same columns and rows; nothing else changes.
CREATE TABLE sidekicks_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
  owner_id TEXT NOT NULL REFERENCES agents(id),
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  signed_in_at TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT
);
INSERT INTO sidekicks_next (id, workspace_id, agent_id, owner_id, provider, signed_in_at, created_at, removed_at)
  SELECT id, workspace_id, agent_id, owner_id, provider, signed_in_at, created_at, removed_at FROM sidekicks;
DROP INDEX idx_sidekicks_owner;
DROP TABLE sidekicks;
ALTER TABLE sidekicks_next RENAME TO sidekicks;
CREATE UNIQUE INDEX idx_sidekicks_owner ON sidekicks(owner_id) WHERE removed_at IS NULL;
PRAGMA user_version = 5;
