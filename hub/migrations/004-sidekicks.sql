-- Additive: client sidekicks. A sidekick is an ordinary agent identity (agent_id) that belongs to one
-- owner and runs in its own container; the owner's AI login lives only inside that container.
-- Existing rows are untouched.
CREATE TABLE sidekicks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
  owner_id TEXT NOT NULL REFERENCES agents(id),
  provider TEXT NOT NULL CHECK (provider IN ('claude')),
  signed_in_at TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE UNIQUE INDEX idx_sidekicks_owner ON sidekicks(owner_id) WHERE removed_at IS NULL;
-- One conversation per sidekick and room, so a sidekick remembers each project separately.
CREATE TABLE sidekick_sessions (
  sidekick_id TEXT NOT NULL REFERENCES sidekicks(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sidekick_id, room_id)
);
PRAGMA user_version = 4;
