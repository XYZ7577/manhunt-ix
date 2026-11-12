PRAGMA foreign_keys = ON;

CREATE TABLE account_deletions (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
    deleted_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    deleted_at TEXT NOT NULL,
    deletion_token TEXT NOT NULL UNIQUE
);

CREATE TABLE group_deletions (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE RESTRICT,
    deleted_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    deleted_at TEXT NOT NULL,
    deletion_token TEXT NOT NULL UNIQUE
);

CREATE TRIGGER deleted_account_no_sessions
BEFORE INSERT ON sessions WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_security
BEFORE INSERT ON account_security WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_emails
BEFORE INSERT ON account_emails WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_contacts
BEFORE INSERT ON account_contacts WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_identity
BEFORE INSERT ON federated_identities WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_google_flow
BEFORE INSERT ON google_auth_flows WHEN NEW.account_id IS NOT NULL AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_sms_challenge
BEFORE INSERT ON sms_auth_challenges WHEN NEW.account_id IS NOT NULL AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_push
BEFORE INSERT ON push_subscriptions WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_signin_challenge
BEFORE INSERT ON email_signin_challenges WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_totp_challenge
BEFORE INSERT ON totp_challenges WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_password_reset
BEFORE INSERT ON password_reset_challenges WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_recovery_code
BEFORE INSERT ON totp_recovery_codes WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_notification_read
BEFORE INSERT ON notification_reads WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_no_announcement_recipient
BEFORE INSERT ON announcement_recipients WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_account_approval_stays_disabled
BEFORE UPDATE OF status ON account_approvals
WHEN EXISTS(SELECT 1 FROM account_deletions WHERE account_id=NEW.account_id) AND NEW.status!='disabled'
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_player_stays_anonymized
BEFORE UPDATE OF username,display_name,role,group_id,password_salt,password_hash,registration_username ON accounts
WHEN OLD.username='deleted-player-'||(SELECT deletion_token FROM account_deletions WHERE account_id=OLD.id)
    AND (NEW.username IS NOT OLD.username OR NEW.display_name IS NOT OLD.display_name OR NEW.role IS NOT OLD.role
        OR NEW.group_id IS NOT OLD.group_id OR NEW.password_salt IS NOT OLD.password_salt
        OR NEW.password_hash IS NOT OLD.password_hash OR NEW.registration_username IS NOT OLD.registration_username)
BEGIN SELECT RAISE(ABORT, 'deleted account'); END;
CREATE TRIGGER deleted_group_no_membership
BEFORE UPDATE OF group_id ON accounts WHEN NEW.group_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM group_deletions WHERE group_id=NEW.group_id)
BEGIN SELECT RAISE(ABORT, 'deleted group'); END;
