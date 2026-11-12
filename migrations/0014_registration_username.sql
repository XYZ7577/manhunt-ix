ALTER TABLE accounts ADD COLUMN registration_username TEXT;

UPDATE accounts SET registration_username=username WHERE registration_username IS NULL;

CREATE TRIGGER accounts_capture_registration_username
AFTER INSERT ON accounts
WHEN NEW.registration_username IS NULL
BEGIN
    UPDATE accounts SET registration_username=NEW.username WHERE id=NEW.id;
END;

CREATE TRIGGER account_username_change_invalidates_email_signin
AFTER UPDATE OF username ON accounts
WHEN OLD.username COLLATE BINARY <> NEW.username COLLATE BINARY
BEGIN
    DELETE FROM email_signin_challenges WHERE account_id=NEW.id;
END;
