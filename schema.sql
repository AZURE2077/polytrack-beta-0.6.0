-- Run this once to set up your D1 database:
-- wrangler d1 execute polytrack-db --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  token_hash  TEXT PRIMARY KEY,
  nickname    TEXT NOT NULL DEFAULT 'Anonymous',
  car_colors  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id        TEXT NOT NULL,
  user_token_hash TEXT NOT NULL,
  frames          INTEGER NOT NULL,
  recording       TEXT NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(track_id, user_token_hash)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_track ON leaderboard_entries(track_id, frames ASC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_user  ON leaderboard_entries(user_token_hash);
