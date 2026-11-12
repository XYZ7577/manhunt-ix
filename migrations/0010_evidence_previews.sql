CREATE TABLE IF NOT EXISTS evidence_previews (
    evidence_id TEXT PRIMARY KEY REFERENCES evidence(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/webp')),
    size INTEGER NOT NULL CHECK (size > 0 AND size <= 204800),
    created_at TEXT NOT NULL
);
