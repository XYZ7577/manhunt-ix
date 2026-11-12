PRAGMA foreign_keys = ON;

CREATE TABLE group_disband_challenges (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email_snapshot TEXT NOT NULL COLLATE NOCASE,
    challenge_id TEXT NOT NULL UNIQUE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE INDEX group_disband_challenges_expiry ON group_disband_challenges(expires_at);

CREATE TRIGGER group_disband_challenge_email_change
AFTER UPDATE OF email, verified_at ON account_emails
BEGIN
    DELETE FROM group_disband_challenges WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER group_disband_challenge_contact_remove
AFTER DELETE ON account_emails
BEGIN
    DELETE FROM group_disband_challenges WHERE account_id=OLD.account_id;
END;

CREATE TRIGGER group_disband_challenge_google_remove
AFTER DELETE ON federated_identities
WHEN OLD.provider='google'
BEGIN
    DELETE FROM group_disband_challenges WHERE account_id=OLD.account_id;
END;

CREATE TRIGGER group_disband_challenge_google_change
AFTER UPDATE OF identifier ON federated_identities
WHEN OLD.provider='google'
BEGIN
    DELETE FROM group_disband_challenges WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER group_disband_challenge_security_change
AFTER UPDATE OF security_version ON account_security
BEGIN
    DELETE FROM group_disband_challenges WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER group_disband_challenge_leader_change
AFTER UPDATE OF account_id ON group_leaders
BEGIN
    DELETE FROM group_disband_challenges WHERE group_id=NEW.group_id;
END;

CREATE TRIGGER group_disband_challenge_leader_remove
AFTER DELETE ON group_leaders
BEGIN
    DELETE FROM group_disband_challenges WHERE group_id=OLD.group_id;
END;

CREATE TRIGGER deleted_account_no_group_disband_challenge
BEFORE INSERT ON group_disband_challenges
WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;

CREATE TRIGGER deleted_account_purge_group_disband_challenge
AFTER INSERT ON account_deletions
BEGIN DELETE FROM group_disband_challenges WHERE account_id=NEW.account_id; END;
