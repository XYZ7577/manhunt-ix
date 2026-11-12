CREATE INDEX submissions_pending_review_order
    ON submissions(COALESCE(submitted_at, created_at), id)
    WHERE status = 'pending';

CREATE INDEX submissions_all_review_order
    ON submissions(COALESCE(submitted_at, created_at), id);
