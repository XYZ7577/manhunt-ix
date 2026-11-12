PRAGMA foreign_keys = ON;

CREATE TABLE email_verification_challenges (
    email_id TEXT PRIMARY KEY REFERENCES account_emails(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email_snapshot TEXT NOT NULL COLLATE NOCASE,
    challenge_id TEXT NOT NULL UNIQUE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE INDEX email_verification_challenges_expiry ON email_verification_challenges(expires_at);

CREATE TRIGGER account_email_mutation_invalidates_verification
AFTER UPDATE OF email, verified_at ON account_emails
BEGIN
    DELETE FROM email_verification_challenges WHERE email_id=NEW.id;
END;
