PRAGMA foreign_keys = ON;

CREATE TABLE group_leaders (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TRIGGER group_leader_player_insert
BEFORE INSERT ON group_leaders
WHEN NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id=NEW.account_id AND a.role='player' AND a.group_id=NEW.group_id
)
BEGIN
    SELECT RAISE(ABORT, 'group leader must be a player account in the same group');
END;

CREATE TRIGGER group_leader_player_update
BEFORE UPDATE OF group_id,account_id ON group_leaders
WHEN NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id=NEW.account_id AND a.role='player' AND a.group_id=NEW.group_id
)
BEGIN
    SELECT RAISE(ABORT, 'group leader must be a player account in the same group');
END;

CREATE TRIGGER group_leader_account_membership_guard
BEFORE UPDATE OF group_id,role ON accounts
WHEN EXISTS (
    SELECT 1 FROM group_leaders gl
    WHERE gl.account_id=OLD.id AND (NEW.group_id IS NOT gl.group_id OR NEW.role<>'player')
)
BEGIN
    SELECT RAISE(ABORT, 'remove group leadership before changing leader membership');
END;

CREATE TABLE group_invitations (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    invited_by TEXT NOT NULL REFERENCES accounts(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
    accepted_at TEXT,
    accepted_by TEXT REFERENCES accounts(id)
);
CREATE UNIQUE INDEX group_invitations_pending_email
    ON group_invitations(email COLLATE NOCASE) WHERE status='pending';
CREATE INDEX group_invitations_group_status
    ON group_invitations(group_id,status,expires_at);

INSERT INTO group_leaders(group_id,account_id,created_at)
SELECT g.id, (
    SELECT a.id FROM accounts a
    WHERE a.group_id=g.id AND a.role='player'
    ORDER BY a.created_at, a.username COLLATE NOCASE, a.id
    LIMIT 1
), g.created_at
FROM groups g
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.group_id=g.id AND a.role='player')
ON CONFLICT(group_id) DO NOTHING;

UPDATE account_emails
SET is_primary=0
WHERE account_id IN (
    SELECT account_id FROM federated_identities WHERE provider='google'
);

UPDATE account_emails
SET verified_at=(
            SELECT fi.created_at FROM federated_identities fi
            WHERE fi.account_id=account_emails.account_id AND fi.provider='google'
                AND fi.identifier=account_emails.email COLLATE NOCASE
            ORDER BY fi.created_at DESC,fi.subject ASC LIMIT 1
        ),
        is_primary=CASE WHEN email=(
            SELECT fi.identifier FROM federated_identities fi
            WHERE fi.account_id=account_emails.account_id AND fi.provider='google'
            ORDER BY fi.created_at DESC,fi.identifier COLLATE NOCASE ASC,fi.subject ASC LIMIT 1
        ) COLLATE NOCASE THEN 1 ELSE 0 END
WHERE EXISTS (
    SELECT 1 FROM federated_identities fi
    WHERE fi.account_id=account_emails.account_id AND fi.provider='google'
        AND fi.identifier=account_emails.email COLLATE NOCASE
);

INSERT OR IGNORE INTO account_emails(id,account_id,email,is_primary,verified_at,created_at)
SELECT lower(hex(randomblob(16))),fi.account_id,fi.identifier,
    CASE WHEN fi.identifier=(
        SELECT latest.identifier FROM federated_identities latest
        WHERE latest.account_id=fi.account_id AND latest.provider='google'
        ORDER BY latest.created_at DESC,latest.identifier COLLATE NOCASE ASC,latest.subject ASC LIMIT 1
    ) COLLATE NOCASE THEN 1 ELSE 0 END,
    fi.created_at,fi.created_at
FROM federated_identities fi
WHERE fi.provider='google'
    AND NOT EXISTS (
        SELECT 1 FROM account_emails e
        WHERE e.account_id=fi.account_id AND e.email=fi.identifier COLLATE NOCASE
    );

