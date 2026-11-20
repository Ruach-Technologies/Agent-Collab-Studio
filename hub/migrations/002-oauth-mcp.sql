-- Additive: connector sign-in (OAuth) records and per-agent MCP read positions.
-- Only SHA-256 hashes of codes and tokens are stored. No existing table is changed.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  resource TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_oauth_grants_agent ON oauth_grants(agent_id);
CREATE TABLE mcp_read_positions (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  cursor INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, room_id)
);
PRAGMA user_version = 2;
