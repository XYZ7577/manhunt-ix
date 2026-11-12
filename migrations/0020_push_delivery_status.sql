ALTER TABLE push_deliveries ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'failed', 'unknown'));
ALTER TABLE push_deliveries ADD COLUMN failed_at TEXT;
ALTER TABLE push_deliveries ADD COLUMN legacy_result_at TEXT;

UPDATE push_deliveries
SET delivery_status='unknown', legacy_result_at=delivered_at, delivered_at=NULL
WHERE delivered_at IS NOT NULL;

CREATE INDEX push_deliveries_pending ON push_deliveries(next_attempt_at, created_at)
    WHERE delivery_status='pending';
CREATE INDEX push_deliveries_failed ON push_deliveries(failed_at DESC)
    WHERE delivery_status='failed';
