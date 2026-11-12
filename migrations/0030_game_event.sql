CREATE TABLE game_event_config (
    id INTEGER PRIMARY KEY CHECK(id=1),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    target_latitude REAL,
    target_longitude REAL,
    picture_url TEXT,
    winner_account_id TEXT REFERENCES accounts(id),
    winner_group_id TEXT REFERENCES groups(id),
    winner_guess_id TEXT,
    winner_reward TEXT CHECK(winner_reward IN ('revive','immunity')),
    winner_immunity_until TEXT,
    configured_by TEXT REFERENCES accounts(id),
    updated_at TEXT NOT NULL,
    CHECK((target_latitude IS NULL AND target_longitude IS NULL) OR
                (target_latitude BETWEEN -90 AND 90 AND target_longitude BETWEEN -180 AND 180))
);

CREATE TABLE game_player_states (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'survivor' CHECK(status IN ('survivor','hunter')),
    dead INTEGER NOT NULL DEFAULT 0 CHECK(dead IN (0,1)),
    immunity_until TEXT,
    caught_at TEXT,
    catch_event_id TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX game_player_states_dead ON game_player_states(dead,account_id);

CREATE TABLE game_guesses (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    group_id TEXT NOT NULL REFERENCES groups(id),
    maps_url TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    distance_m REAL,
    submitted_at TEXT NOT NULL,
    correct INTEGER NOT NULL CHECK(correct IN (0,1)),
    reward TEXT CHECK(reward IN ('revive','immunity'))
);
CREATE INDEX game_guesses_group ON game_guesses(group_id,submitted_at);

INSERT INTO game_event_config(id,starts_at,ends_at,updated_at)
VALUES(1,'2026-11-13T05:30:00.000Z','2026-11-13T06:00:00.000Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
