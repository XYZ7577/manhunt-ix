CREATE TABLE account_approvals (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','disabled')),
    requested_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT REFERENCES accounts(id),
    review_note TEXT,
    notification_attempted_at TEXT,
    notification_email TEXT NOT NULL DEFAULT 'not_sent'
        CHECK(notification_email IN ('sent','failed','sending','not_available','not_sent'))
);
CREATE INDEX account_approvals_status ON account_approvals(status, requested_at);

INSERT INTO account_approvals(account_id,status,requested_at,reviewed_at)
SELECT id, CASE WHEN id LIKE 'demo-account-%' THEN 'disabled' ELSE 'approved' END,
    created_at, CASE WHEN id LIKE 'demo-account-%' THEN NULL ELSE created_at END
FROM accounts;

CREATE TRIGGER new_player_requires_approval
AFTER INSERT ON accounts
WHEN NEW.role = 'player'
BEGIN
    INSERT OR IGNORE INTO account_approvals(account_id,status,requested_at)
    VALUES(NEW.id,'pending',NEW.created_at);
END;
