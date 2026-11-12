CREATE TABLE caught_notification_events (
    event_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX caught_notification_events_due ON caught_notification_events(created_at,event_id);

CREATE TABLE caught_email_deliveries (
    event_id TEXT NOT NULL REFERENCES caught_notification_events(event_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email_id TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    locked_until TEXT,
    lock_token TEXT,
    sent_at TEXT,
    PRIMARY KEY(event_id,account_id)
);
CREATE INDEX caught_email_deliveries_due ON caught_email_deliveries(status,next_attempt_at,locked_until,event_id);

CREATE TABLE caught_push_deliveries (
    event_id TEXT NOT NULL REFERENCES caught_notification_events(event_id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    locked_until TEXT,
    lock_token TEXT,
    sent_at TEXT,
    PRIMARY KEY(event_id,subscription_id)
);
CREATE INDEX caught_push_deliveries_due ON caught_push_deliveries(status,next_attempt_at,locked_until,event_id);

CREATE TRIGGER cancel_unapproved_caught_deliveries
AFTER UPDATE OF status ON account_approvals
WHEN NEW.status!='approved' AND OLD.status='approved'
BEGIN
    UPDATE caught_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE account_id=NEW.account_id AND status IN ('pending','sending');
    UPDATE caught_push_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE account_id=NEW.account_id)
            AND status IN ('pending','sending');
END;

CREATE TRIGGER cancel_stale_caught_email_address
AFTER UPDATE OF email,verified_at ON account_emails
WHEN OLD.email IS NOT NEW.email OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS NULL)
BEGIN
    UPDATE caught_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE email_id=OLD.id AND status IN ('pending','sending');
END;
CREATE TRIGGER cancel_removed_caught_email_address
AFTER DELETE ON account_emails
BEGIN
    UPDATE caught_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE email_id=OLD.id AND status IN ('pending','sending');
END;
