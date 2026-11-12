CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    last_notification_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_group ON push_subscriptions(group_id);

CREATE TABLE push_deliveries (
    notification_id INTEGER NOT NULL REFERENCES review_notifications(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    locked_until TEXT,
    delivered_at TEXT,
    PRIMARY KEY(notification_id, subscription_id)
);
CREATE INDEX push_deliveries_due ON push_deliveries(next_attempt_at, created_at) WHERE delivered_at IS NULL;

CREATE TRIGGER purge_reassigned_push_deliveries
BEFORE UPDATE OF account_id,group_id ON push_subscriptions
WHEN OLD.account_id IS NOT NEW.account_id OR OLD.group_id IS NOT NEW.group_id
BEGIN
    DELETE FROM push_deliveries WHERE subscription_id=OLD.id;
END;

CREATE TRIGGER move_push_subscriptions_with_player
AFTER UPDATE OF group_id ON accounts
WHEN NEW.role='player' AND NEW.group_id IS NOT NULL AND OLD.group_id IS NOT NEW.group_id
BEGIN
    UPDATE push_subscriptions
    SET group_id=NEW.group_id,
            last_notification_id=(SELECT COALESCE(MAX(id),0) FROM review_notifications),
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE account_id=NEW.id;
END;

CREATE TRIGGER remove_unassigned_player_push_subscriptions
AFTER UPDATE OF group_id ON accounts
WHEN NEW.role='player' AND NEW.group_id IS NULL AND OLD.group_id IS NOT NULL
BEGIN
    DELETE FROM push_subscriptions WHERE account_id=NEW.id;
END;

CREATE TRIGGER remove_unapproved_player_push_subscriptions
AFTER UPDATE OF status ON account_approvals
WHEN NEW.status!='approved' AND OLD.status='approved'
BEGIN
    DELETE FROM push_subscriptions WHERE account_id=NEW.account_id;
END;

CREATE TRIGGER enqueue_review_push
AFTER INSERT ON review_notifications
BEGIN
    INSERT OR IGNORE INTO push_deliveries(notification_id,subscription_id)
    SELECT NEW.id,p.id FROM push_subscriptions p
    WHERE p.group_id=NEW.group_id AND NEW.id>p.last_notification_id;
END;
