CREATE TABLE announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    published_at TEXT,
    cancelled_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('scheduled','published','cancelled')),
    send_email INTEGER NOT NULL DEFAULT 1 CHECK(send_email IN (0,1)),
    recipient_count INTEGER NOT NULL DEFAULT 0 CHECK(recipient_count >= 0),
    publication_token TEXT
);
CREATE INDEX announcements_due ON announcements(scheduled_for,id) WHERE status='scheduled';
CREATE INDEX announcements_history ON announcements(created_at DESC,id DESC);

CREATE TABLE announcement_recipients (
    announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    read_at TEXT,
    PRIMARY KEY(announcement_id,account_id)
);
CREATE INDEX announcement_recipients_account ON announcement_recipients(account_id,announcement_id);

CREATE TABLE announcement_email_deliveries (
    announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email_id TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    locked_until TEXT,
    lock_token TEXT,
    sent_at TEXT,
    PRIMARY KEY(announcement_id,account_id)
);
CREATE INDEX announcement_email_deliveries_due
    ON announcement_email_deliveries(status,next_attempt_at,locked_until,announcement_id);

CREATE TABLE announcement_push_deliveries (
    announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    locked_until TEXT,
    lock_token TEXT,
    sent_at TEXT,
    PRIMARY KEY(announcement_id,subscription_id)
);
CREATE INDEX announcement_push_deliveries_due
    ON announcement_push_deliveries(status,next_attempt_at,locked_until,announcement_id);

CREATE TRIGGER enqueue_announcement_email
AFTER INSERT ON announcement_recipients
WHEN (SELECT send_email FROM announcements WHERE id=NEW.announcement_id)=1
BEGIN
    INSERT OR IGNORE INTO announcement_email_deliveries(announcement_id,account_id,email_id,email)
    SELECT NEW.announcement_id,NEW.account_id,e.id,e.email
    FROM account_emails e WHERE e.account_id=NEW.account_id AND e.verified_at IS NOT NULL
        AND e.id=(SELECT e2.id FROM account_emails e2 WHERE e2.account_id=NEW.account_id AND e2.verified_at IS NOT NULL
            ORDER BY e2.is_primary DESC,e2.created_at,e2.id LIMIT 1);
END;

CREATE TRIGGER enqueue_announcement_push
AFTER INSERT ON announcement_recipients
BEGIN
    INSERT OR IGNORE INTO announcement_push_deliveries(announcement_id,subscription_id)
    SELECT NEW.announcement_id,p.id FROM push_subscriptions p
    JOIN accounts a ON a.id=p.account_id AND a.role='player' AND a.group_id=p.group_id
    WHERE p.account_id=NEW.account_id;
END;

CREATE TRIGGER cancel_stale_announcement_email_address
AFTER UPDATE OF email,verified_at ON account_emails
WHEN OLD.email IS NOT NEW.email OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS NULL)
BEGIN
    UPDATE announcement_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE email_id=OLD.id AND status IN ('pending','sending');
END;

CREATE TRIGGER cancel_removed_announcement_email_address
AFTER DELETE ON account_emails
BEGIN
    UPDATE announcement_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE email_id=OLD.id AND status IN ('pending','sending');
END;

CREATE TRIGGER cancel_unapproved_announcement_deliveries
AFTER UPDATE OF status ON account_approvals
WHEN NEW.status!='approved' AND OLD.status='approved'
BEGIN
    UPDATE announcement_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE account_id=NEW.account_id AND status IN ('pending','sending');
    UPDATE announcement_push_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE account_id=NEW.account_id)
            AND status IN ('pending','sending');
END;
