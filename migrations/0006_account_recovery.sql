PRAGMA foreign_keys = ON;

CREATE TABLE password_reset_challenges (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    security_version INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE INDEX password_reset_challenges_expiry ON password_reset_challenges(expires_at);

PRAGMA foreign_keys = ON;
