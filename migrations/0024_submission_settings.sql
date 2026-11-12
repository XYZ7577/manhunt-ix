CREATE TABLE submission_settings (
    id INTEGER PRIMARY KEY CHECK (id=1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES accounts(id)
);

