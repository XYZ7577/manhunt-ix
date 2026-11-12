PRAGMA foreign_keys = ON;

CREATE TABLE group_disbands (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE RESTRICT,
    disbanded_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    disbanded_at TEXT NOT NULL
);
