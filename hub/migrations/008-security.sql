-- Additive: security monitoring. Egress-gate decisions (host names only, aggregated per source,
-- destination and minute), alerts that need a person, and the monitor's read positions.
CREATE TABLE security_traffic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agg_key TEXT NOT NULL UNIQUE,
  bucket TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  profile TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  kind TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER,
  reason TEXT,
  source_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  client_ip TEXT,
  container_id TEXT,
  container_name TEXT,
  workspace_id TEXT,
  room_id TEXT,
  sidekick_id TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  bytes_up INTEGER NOT NULL DEFAULT 0,
  bytes_down INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_security_traffic_time ON security_traffic(last_at);
CREATE INDEX idx_security_traffic_workspace ON security_traffic(workspace_id, last_at);
CREATE INDEX idx_security_traffic_source ON security_traffic(source_key, last_at);

CREATE TABLE security_alerts (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  subject TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  workspace_id TEXT,
  room_id TEXT,
  actor_id TEXT,
  sidekick_id TEXT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  notified_at TEXT
);
-- At most one open alert per rule and subject; a repeat bumps its count.
CREATE UNIQUE INDEX idx_security_alerts_open ON security_alerts(rule, subject) WHERE acknowledged_at IS NULL;
CREATE INDEX idx_security_alerts_seen ON security_alerts(last_seen);
CREATE INDEX idx_security_alerts_workspace ON security_alerts(workspace_id, last_seen);

CREATE TABLE security_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 8;
