-- Foreign-key checks are disabled only around this transactional table rebuild.
-- Message rowids and event IDs are deliberately unchanged for existing cursors.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);
INSERT INTO workspaces VALUES ('wks_0000000000000000', 'Legacy workspace', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE hub_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO hub_metadata VALUES ('instance_id', 'hub_' || lower(hex(randomblob(16))));

CREATE TABLE agents_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'wks_0000000000000000' REFERENCES workspaces(id),
  name TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('supervisor','agent','observer')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE(workspace_id, name)
);
INSERT INTO agents_next (rowid,id,name,role,created_at,last_seen_at)
  SELECT rowid,id,name,role,created_at,last_seen_at FROM agents;
DROP TABLE agents;
ALTER TABLE agents_next RENAME TO agents;

CREATE TABLE rooms_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'wks_0000000000000000' REFERENCES workspaces(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  project TEXT,
  created_by TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(workspace_id, slug)
);
INSERT INTO rooms_next (rowid,id,name,slug,project,created_by,created_at,archived_at)
  SELECT rowid,id,name,slug,project,created_by,created_at,archived_at FROM rooms;
DROP TABLE rooms;
ALTER TABLE rooms_next RENAME TO rooms;
ALTER TABLE tokens ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'wks_0000000000000000' REFERENCES workspaces(id);
ALTER TABLE events ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
UPDATE events SET workspace_id = 'wks_0000000000000000'
  WHERE room_id IN (SELECT id FROM rooms) OR actor_id IN (SELECT id FROM agents) OR target_id IN (SELECT id FROM agents);
CREATE INDEX idx_events_workspace ON events(workspace_id,id);
CREATE INDEX idx_tokens_workspace ON tokens(workspace_id,agent_id);

CREATE TRIGGER agent_scope_immutable BEFORE UPDATE OF workspace_id ON agents
WHEN NEW.workspace_id != OLD.workspace_id BEGIN SELECT RAISE(ABORT,'immutable workspace'); END;
CREATE TRIGGER room_scope_insert BEFORE INSERT ON rooms
WHEN NOT EXISTS (SELECT 1 FROM agents WHERE id=NEW.created_by AND workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER room_scope_immutable BEFORE UPDATE OF workspace_id ON rooms
WHEN NEW.workspace_id != OLD.workspace_id BEGIN SELECT RAISE(ABORT,'immutable workspace'); END;
CREATE TRIGGER room_creator_update BEFORE UPDATE OF created_by ON rooms
WHEN NOT EXISTS (SELECT 1 FROM agents WHERE id=NEW.created_by AND workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER token_scope_insert BEFORE INSERT ON tokens
WHEN NOT EXISTS (SELECT 1 FROM agents WHERE id=NEW.agent_id AND workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER token_scope_update BEFORE UPDATE OF workspace_id,agent_id ON tokens
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.agent_id != OLD.agent_id
BEGIN SELECT RAISE(ABORT,'immutable token identity'); END;
CREATE TRIGGER member_scope_insert BEFORE INSERT ON members
WHEN NOT EXISTS (SELECT 1 FROM rooms r JOIN agents a ON a.workspace_id=r.workspace_id WHERE r.id=NEW.room_id AND a.id=NEW.agent_id)
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER member_scope_update BEFORE UPDATE ON members
WHEN NOT EXISTS (SELECT 1 FROM rooms r JOIN agents a ON a.workspace_id=r.workspace_id WHERE r.id=NEW.room_id AND a.id=NEW.agent_id)
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER message_scope_insert BEFORE INSERT ON messages
WHEN NOT EXISTS (SELECT 1 FROM rooms r JOIN agents a ON a.workspace_id=r.workspace_id WHERE r.id=NEW.room_id AND a.id=NEW.sender_id)
 OR (NEW.recipient_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rooms r JOIN agents a ON a.workspace_id=r.workspace_id WHERE r.id=NEW.room_id AND a.id=NEW.recipient_id))
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER message_scope_update BEFORE UPDATE OF room_id,sender_id,recipient_id ON messages
WHEN NOT EXISTS (SELECT 1 FROM rooms r JOIN agents a ON a.workspace_id=r.workspace_id WHERE r.id=NEW.room_id AND a.id=NEW.sender_id)
 OR (NEW.recipient_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rooms r JOIN agents a ON a.workspace_id=r.workspace_id WHERE r.id=NEW.room_id AND a.id=NEW.recipient_id))
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER exec_scope_insert BEFORE INSERT ON execs
WHEN NOT EXISTS (SELECT 1 FROM sandboxes s JOIN rooms r ON r.id=s.room_id JOIN agents a ON a.workspace_id=r.workspace_id WHERE s.id=NEW.sandbox_id AND a.id=NEW.agent_id)
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER exec_scope_update BEFORE UPDATE OF sandbox_id,agent_id ON execs
WHEN NOT EXISTS (SELECT 1 FROM sandboxes s JOIN rooms r ON r.id=s.room_id JOIN agents a ON a.workspace_id=r.workspace_id WHERE s.id=NEW.sandbox_id AND a.id=NEW.agent_id)
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
CREATE TRIGGER sandbox_room_immutable BEFORE UPDATE OF room_id ON sandboxes
WHEN NEW.room_id != OLD.room_id BEGIN SELECT RAISE(ABORT,'immutable sandbox room'); END;
CREATE TRIGGER event_scope_insert BEFORE INSERT ON events
WHEN (NEW.room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rooms WHERE id=NEW.room_id AND workspace_id=NEW.workspace_id))
 OR (NEW.actor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents WHERE id=NEW.actor_id AND workspace_id=NEW.workspace_id))
BEGIN SELECT RAISE(ABORT,'workspace mismatch'); END;
PRAGMA user_version = 1;
