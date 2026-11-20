-- Additive: each project room can carry its own rules, shown to everyone in the room.
-- NULL means the room shows the hub's default rules.
ALTER TABLE rooms ADD COLUMN rules TEXT;
PRAGMA user_version = 6;
