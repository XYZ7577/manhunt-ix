CREATE TABLE account_group_requests (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    members_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE _migration_0016_rejected_groups (
    account_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL UNIQUE
);
INSERT INTO _migration_0016_rejected_groups(account_id,group_id)
SELECT a.id,g.id
FROM accounts a
JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='rejected'
JOIN groups g ON g.id=a.group_id AND g.created_at=a.created_at
JOIN group_leaders gl ON gl.group_id=g.id AND gl.account_id=a.id
WHERE a.role='player'
    AND (SELECT COUNT(*) FROM accounts other WHERE other.group_id=g.id)=1
    AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.group_id=g.id)
    AND NOT EXISTS (SELECT 1 FROM group_invitations i WHERE i.group_id=g.id);

INSERT INTO account_group_requests(account_id,group_id,name,members_json,created_at)
SELECT a.id,g.id,g.name,g.members_json,a.created_at
FROM accounts a
JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='pending'
JOIN groups g ON g.id=a.group_id AND g.created_at=a.created_at
JOIN group_leaders gl ON gl.group_id=g.id AND gl.account_id=a.id
WHERE a.role='player'
    AND (SELECT COUNT(*) FROM accounts other WHERE other.group_id=g.id)=1
    AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.group_id=g.id)
    AND NOT EXISTS (SELECT 1 FROM group_invitations i WHERE i.group_id=g.id);

DELETE FROM group_leaders
WHERE group_id IN (SELECT group_id FROM account_group_requests)
      OR group_id IN (SELECT group_id FROM _migration_0016_rejected_groups);

UPDATE accounts SET group_id=NULL
WHERE id IN (SELECT account_id FROM account_group_requests)
      OR id IN (SELECT account_id FROM _migration_0016_rejected_groups);

DELETE FROM groups
WHERE id IN (SELECT group_id FROM account_group_requests)
      OR id IN (SELECT group_id FROM _migration_0016_rejected_groups);

DROP TABLE _migration_0016_rejected_groups;
