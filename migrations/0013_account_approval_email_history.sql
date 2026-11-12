ALTER TABLE account_approvals ADD COLUMN notification_attempt_id TEXT;

CREATE TABLE account_approval_email_attempts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account_approvals(account_id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('sending','sent','failed'))
);
CREATE INDEX account_approval_email_attempts_account ON account_approval_email_attempts(account_id, started_at DESC);
