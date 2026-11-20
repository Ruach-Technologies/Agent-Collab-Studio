-- Live sidekicks: the owner's settings for how freely their sidekick joins in, a record of every
-- job it runs (for the usage meter and limits), and where it left off reading each room.
ALTER TABLE sidekicks ADD COLUMN live_mode TEXT NOT NULL DEFAULT 'live' CHECK (live_mode IN ('live', 'mentions', 'owner', 'paused'));
ALTER TABLE sidekicks ADD COLUMN banter TEXT NOT NULL DEFAULT 'chatty' CHECK (banter IN ('chatty', 'brief', 'quiet'));
ALTER TABLE sidekicks ADD COLUMN jobs_per_hour INTEGER NOT NULL DEFAULT 20 CHECK (jobs_per_hour BETWEEN 1 AND 500);
ALTER TABLE sidekicks ADD COLUMN jobs_per_day INTEGER NOT NULL DEFAULT 150 CHECK (jobs_per_day BETWEEN 1 AND 5000);
ALTER TABLE sidekicks ADD COLUMN steps_per_job INTEGER NOT NULL DEFAULT 40 CHECK (steps_per_job BETWEEN 1 AND 200);
ALTER TABLE sidekicks ADD COLUMN tokens_per_day INTEGER CHECK (tokens_per_day IS NULL OR tokens_per_day > 0);

CREATE TABLE sidekick_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sidekick_id TEXT NOT NULL REFERENCES sidekicks(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('owner', 'mention', 'live')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  posts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  duration_ms INTEGER
);
CREATE INDEX idx_sidekick_jobs_time ON sidekick_jobs(sidekick_id, started_at);

ALTER TABLE sidekick_sessions ADD COLUMN chat_cursor INTEGER;
ALTER TABLE sidekick_sessions ADD COLUMN feed_cursor INTEGER;
PRAGMA user_version = 7;
