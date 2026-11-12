ALTER TABLE group_invitations ADD COLUMN email_delivery TEXT NOT NULL DEFAULT 'not_sent'
    CHECK(email_delivery IN ('not_sent','sending','sent','failed','not_available'));
ALTER TABLE group_invitations ADD COLUMN email_attempted_at TEXT;
