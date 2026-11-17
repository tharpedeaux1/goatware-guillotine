-- Guillotine League schema (Cloudflare D1)

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  owner           TEXT NOT NULL DEFAULT '',
  email           TEXT,
  token           TEXT NOT NULL UNIQUE,
  faab            INTEGER NOT NULL DEFAULT 1000,
  eliminated_week INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- NFL player universe, synced daily from Sleeper. DEF ids are team abbreviations (e.g. KC).
CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  pos        TEXT NOT NULL,
  team       TEXT,
  status     TEXT,
  injury     TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_players_pos ON players(pos);

-- Current rosters and lineup slots. player_id is the key, so a player can only be on one team.
CREATE TABLE IF NOT EXISTS rosters (
  player_id   TEXT PRIMARY KEY,
  team_id     INTEGER NOT NULL,
  slot        TEXT NOT NULL DEFAULT 'BN',
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rosters_team ON rosters(team_id);

-- Players who must be claimed with a FAAB bid (released by a cut team or dropped since the last waiver run).
CREATE TABLE IF NOT EXISTS waiver_wire (
  player_id TEXT PRIMARY KEY,
  since     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS claims (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id        INTEGER NOT NULL,
  player_id      TEXT NOT NULL,
  drop_player_id TEXT,
  bid            INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | won | lost | failed
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);

CREATE TABLE IF NOT EXISTS games (
  season     INTEGER NOT NULL,
  week       INTEGER NOT NULL,
  game_id    TEXT NOT NULL,
  home       TEXT,
  away       TEXT,
  kickoff    TEXT,
  state      TEXT,      -- pre | in | post
  period     INTEGER,
  clock      TEXT,
  detail     TEXT,
  home_score INTEGER,
  away_score INTEGER,
  PRIMARY KEY (season, week, game_id)
);

-- One compact JSON blob per week for live stats and for projections.
CREATE TABLE IF NOT EXISTS stat_blobs (
  season     INTEGER NOT NULL,
  week       INTEGER NOT NULL,
  kind       TEXT NOT NULL, -- stats | proj
  data       TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, kind)
);

CREATE TABLE IF NOT EXISTS team_weeks (
  season     INTEGER NOT NULL,
  week       INTEGER NOT NULL,
  team_id    INTEGER NOT NULL,
  points     REAL NOT NULL,
  bench      REAL NOT NULL DEFAULT 0,
  rank       INTEGER,
  eliminated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season, week, team_id)
);

CREATE TABLE IF NOT EXISTS weekly_lineups (
  season    INTEGER NOT NULL,
  week      INTEGER NOT NULL,
  team_id   INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  slot      TEXT NOT NULL,
  points    REAL,
  PRIMARY KEY (season, week, team_id, player_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  week       INTEGER,
  type       TEXT NOT NULL, -- add | drop | waiver | eliminated | import
  team_id    INTEGER,
  player_id  TEXT,
  detail     TEXT
);
