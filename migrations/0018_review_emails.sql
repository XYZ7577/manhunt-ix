CREATE TABLE review_email_deliveries (
    notification_id INTEGER NOT NULL REFERENCES review_notifications(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    email_id TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    locked_until TEXT,
    lock_token TEXT,
    sent_at TEXT,
    PRIMARY KEY(notification_id, account_id)
);
CREATE INDEX review_email_deliveries_due
    ON review_email_deliveries(status, next_attempt_at, locked_until, notification_id);

CREATE TRIGGER enqueue_review_email
AFTER INSERT ON review_notifications
BEGIN
    INSERT OR IGNORE INTO review_email_deliveries(notification_id,account_id,group_id,email_id,email)
    SELECT NEW.id,a.id,NEW.group_id,e.id,e.email
    FROM accounts a
    JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved'
    JOIN account_emails e ON e.account_id=a.id AND e.verified_at IS NOT NULL
    WHERE a.role='player' AND a.group_id=NEW.group_id
        AND e.id=(SELECT e2.id FROM account_emails e2
            WHERE e2.account_id=a.id AND e2.verified_at IS NOT NULL
            ORDER BY e2.is_primary DESC,e2.created_at,e2.id LIMIT 1);
END;

CREATE TRIGGER cancel_stale_review_email_address
AFTER UPDATE OF email,verified_at ON account_emails
WHEN OLD.email IS NOT NEW.email OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS NULL)
BEGIN
    UPDATE review_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE email_id=OLD.id AND status IN ('pending','sending');
END;

CREATE TRIGGER cancel_removed_review_email_address
AFTER DELETE ON account_emails
BEGIN
    UPDATE review_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE email_id=OLD.id AND status IN ('pending','sending');
END;

CREATE TRIGGER cancel_unapproved_review_email
AFTER UPDATE OF status ON account_approvals
WHEN NEW.status!='approved' AND OLD.status='approved'
BEGIN
    UPDATE review_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE account_id=NEW.account_id AND status IN ('pending','sending');
END;

CREATE TRIGGER cancel_moved_review_email
AFTER UPDATE OF group_id ON accounts
WHEN NEW.role='player' AND OLD.group_id IS NOT NEW.group_id
BEGIN
    UPDATE review_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE account_id=NEW.id AND status IN ('pending','sending');
END;
