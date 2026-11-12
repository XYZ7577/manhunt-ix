PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions(id),
    object_key TEXT NOT NULL UNIQUE,
    multipart_upload_id TEXT,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0 AND size <= 2147483648),
    slot TEXT,
    part_size INTEGER NOT NULL,
    part_count INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('creating', 'uploading', 'completing', 'completed', 'aborted', 'expired')),
    evidence_id TEXT UNIQUE,
    lock_token TEXT,
    lock_expires_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS upload_sessions_submission ON upload_sessions(submission_id, created_at);
CREATE INDEX IF NOT EXISTS upload_sessions_expiry ON upload_sessions(state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS upload_active_slot_once
    ON upload_sessions(submission_id, slot)
    WHERE slot IS NOT NULL AND state IN ('creating', 'uploading', 'completing');

CREATE TABLE IF NOT EXISTS upload_parts (
    upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 256),
    size INTEGER NOT NULL CHECK (size > 0 AND size <= 8388608),
    sha256 TEXT NOT NULL,
    etag TEXT,
    state TEXT NOT NULL CHECK (state IN ('uploading', 'uploaded')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (upload_id, part_number)
);

DROP TRIGGER IF EXISTS evidence_submission_limit;
CREATE TRIGGER evidence_submission_limit
BEFORE INSERT ON evidence
WHEN (SELECT COUNT(*) FROM evidence WHERE submission_id = NEW.submission_id)
      + (SELECT COUNT(*) FROM upload_sessions WHERE submission_id = NEW.submission_id AND state IN ('creating', 'uploading', 'completing')) >= 10
BEGIN
    SELECT RAISE(ABORT, 'submission evidence limit exceeded');
END;

CREATE TRIGGER upload_submission_limit
BEFORE INSERT ON upload_sessions
WHEN (SELECT COUNT(*) FROM evidence WHERE submission_id = NEW.submission_id)
      + (SELECT COUNT(*) FROM upload_sessions WHERE submission_id = NEW.submission_id AND state IN ('creating', 'uploading', 'completing')) >= 10
BEGIN
    SELECT RAISE(ABORT, 'submission evidence limit exceeded');
END;

CREATE TRIGGER upload_slot_must_be_available
BEFORE INSERT ON upload_sessions
WHEN NEW.slot IS NOT NULL AND EXISTS (SELECT 1 FROM evidence WHERE submission_id = NEW.submission_id AND slot = NEW.slot)
BEGIN
    SELECT RAISE(ABORT, 'submission slot is already used');
END;

CREATE TRIGGER evidence_slot_must_not_be_reserved
BEFORE INSERT ON evidence
WHEN NEW.slot IS NOT NULL AND EXISTS (
    SELECT 1 FROM upload_sessions
    WHERE submission_id = NEW.submission_id AND slot = NEW.slot AND state IN ('creating', 'uploading', 'completing')
)
BEGIN
    SELECT RAISE(ABORT, 'submission slot is reserved');
END;
