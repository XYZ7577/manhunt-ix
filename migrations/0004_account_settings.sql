PRAGMA foreign_keys = ON;

CREATE TABLE account_security (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    password_set INTEGER NOT NULL DEFAULT 1 CHECK (password_set IN (0, 1)),
    totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
    totp_secret_ciphertext TEXT,
    totp_pending_ciphertext TEXT,
    totp_pending_expires_at TEXT,
    totp_pending_attempts INTEGER NOT NULL DEFAULT 0 CHECK (totp_pending_attempts BETWEEN 0 AND 5),
    totp_pending_security_version INTEGER,
    totp_last_step INTEGER,
    security_version INTEGER NOT NULL DEFAULT 0,
    security_claim TEXT,
    updated_at TEXT NOT NULL
);

INSERT INTO account_security(account_id, password_set, updated_at)
SELECT id, CASE WHEN username LIKE 'google:%' OR username LIKE 'sms:%' THEN 0 ELSE 1 END, created_at FROM accounts;

CREATE TABLE account_emails (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    verified_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX account_emails_account ON account_emails(account_id, created_at);
CREATE UNIQUE INDEX account_emails_account_email ON account_emails(account_id, email COLLATE NOCASE);

CREATE TABLE account_contacts (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    phone TEXT,
    phone_verified_at TEXT
);

INSERT INTO account_emails(id, account_id, email, is_primary, verified_at, created_at)
SELECT lower(hex(randomblob(16))), id, username, 1, NULL, created_at
FROM accounts
WHERE instr(username, '@') > 1 AND instr(username, '.') > instr(username, '@') + 1
ON CONFLICT DO NOTHING;

INSERT INTO account_contacts(account_id, phone, phone_verified_at)
SELECT id, username, NULL FROM accounts
WHERE username GLOB '+[1-9]*' AND length(username) BETWEEN 9 AND 16
ON CONFLICT(account_id) DO NOTHING;

CREATE TABLE totp_recovery_codes (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(account_id, code_hash)
);

CREATE TABLE totp_challenges (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    security_version INTEGER NOT NULL,
    password_hash_snapshot TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE INDEX totp_challenges_expiry ON totp_challenges(expires_at);

