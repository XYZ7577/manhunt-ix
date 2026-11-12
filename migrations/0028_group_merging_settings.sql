CREATE TABLE group_merging_settings (
    id INTEGER PRIMARY KEY CHECK (id=1),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES accounts(id)
);

INSERT INTO group_merging_settings(id,enabled,updated_at,updated_by)
VALUES(1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
