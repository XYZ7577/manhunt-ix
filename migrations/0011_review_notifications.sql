CREATE TABLE review_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('approved','changes_requested')),
    feedback TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('decision','feedback')),
    created_at TEXT NOT NULL
);
CREATE INDEX review_notifications_group ON review_notifications(group_id,id DESC);
CREATE TABLE notification_reads (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    notification_id INTEGER NOT NULL REFERENCES review_notifications(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL,
    PRIMARY KEY(account_id,notification_id)
);

CREATE TRIGGER notify_submission_review
AFTER UPDATE OF status,review_note ON submissions
WHEN NEW.status IN ('approved','changes_requested')
    AND (OLD.status IS NOT NEW.status OR OLD.review_note IS NOT NEW.review_note)
BEGIN
    INSERT INTO review_notifications(submission_id,group_id,task_id,status,feedback,kind,created_at)
    VALUES(NEW.id,NEW.group_id,NEW.task_id,NEW.status,NEW.review_note,
        CASE WHEN OLD.status IS NOT NEW.status THEN 'decision' ELSE 'feedback' END,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

INSERT INTO review_notifications(submission_id,group_id,task_id,status,feedback,kind,created_at)
SELECT s.id,s.group_id,s.task_id,s.status,s.review_note,'decision',COALESCE(s.reviewed_at,s.created_at)
FROM submissions s WHERE s.status IN ('approved','changes_requested')
AND NOT EXISTS(SELECT 1 FROM submissions n WHERE n.group_id=s.group_id AND n.task_id=s.task_id AND n.attempt>s.attempt);
