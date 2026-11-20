-- Client sessions. A client (guest) no longer keeps a permanent hub token: their browser holds a
-- session that ends after a fixed time or on sign-out, and every request must be signed with a key
-- that only that browser has (the public half is stored here), so a copied session token is useless.
-- New sessions come from a passkey or a one-time sign-in link from staff.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  token_hash TEXT NOT NULL UNIQUE,
  device_key TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('invite', 'passkey', 'link')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('signed_out', 'expired', 'revoked', 'replaced'))
);
CREATE INDEX idx_sessions_agent ON sessions(agent_id, ended_at);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  removed_at TEXT
);
CREATE INDEX idx_passkeys_agent ON passkeys(agent_id);

CREATE TABLE signin_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Clients' old permanent tokens stop working: each is replaced by an unknowable value, which keeps
-- the identity active (removing a client still revokes it) while nobody can present it. From now on
-- clients sign in with a link or a passkey. Sidekick identities are guests too and keep their tokens.
UPDATE tokens SET token_hash = lower(hex(randomblob(32)))
  WHERE revoked_at IS NULL AND agent_id IN (SELECT id FROM agents WHERE guest = 1)
    AND agent_id NOT IN (SELECT agent_id FROM sidekicks);
PRAGMA user_version = 9;
