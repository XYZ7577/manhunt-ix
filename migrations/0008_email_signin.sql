PRAGMA foreign_keys = ON;

CREATE TABLE email_signin_challenges (
    id TEXT PRIMARY KEY,
    binder_hash TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email_snapshot TEXT NOT NULL COLLATE NOCASE,
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('google', 'native')),
    identity_id TEXT NOT NULL,
    identity_subject TEXT,
    identity_identifier TEXT NOT NULL COLLATE NOCASE,
    security_version INTEGER NOT NULL,
    password_hash_snapshot TEXT,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE INDEX email_signin_challenges_binder ON email_signin_challenges(binder_hash, created_at);
CREATE INDEX email_signin_challenges_expiry ON email_signin_challenges(expires_at);

CREATE TRIGGER account_email_mutation_invalidates_signin
AFTER UPDATE OF account_id, email, verified_at ON account_emails
BEGIN
    DELETE FROM email_signin_challenges
    WHERE identity_kind='native' AND identity_id=OLD.id;
END;
CREATE TRIGGER account_email_delete_invalidates_signin
AFTER DELETE ON account_emails
BEGIN
    DELETE FROM email_signin_challenges
    WHERE identity_kind='native' AND identity_id=OLD.id;
END;
CREATE TRIGGER federated_identity_mutation_invalidates_signin
AFTER UPDATE OF account_id, provider, subject, identifier ON federated_identities
BEGIN
    DELETE FROM email_signin_challenges
    WHERE identity_kind='google' AND identity_id=OLD.id;
END;
CREATE TRIGGER federated_identity_delete_invalidates_signin
AFTER DELETE ON federated_identities
BEGIN
    DELETE FROM email_signin_challenges
    WHERE identity_kind='google' AND identity_id=OLD.id;
END;
