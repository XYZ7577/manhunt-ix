PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    members_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('player', 'admin')),
    group_id TEXT REFERENCES groups(id),
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id),
    task_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'approved', 'changes_requested')),
    attempt INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    review_note TEXT,
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT REFERENCES accounts(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_draft_per_group_task
    ON submissions(group_id, task_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS one_attempt_per_group_task
    ON submissions(group_id, task_id, attempt);
CREATE INDEX IF NOT EXISTS submissions_group ON submissions(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, created_at);

CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions(id),
    object_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    slot TEXT,
    metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_submission ON evidence(submission_id, uploaded_at);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_slot_once
    ON evidence(submission_id, slot) WHERE slot IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS evidence_submission_limit
BEFORE INSERT ON evidence
WHEN (SELECT COUNT(*) FROM evidence WHERE submission_id = NEW.submission_id) >= 10
BEGIN
    SELECT RAISE(ABORT, 'submission evidence limit exceeded');
END;

CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_started_at TEXT NOT NULL
);
