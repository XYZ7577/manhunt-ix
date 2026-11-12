PRAGMA foreign_keys = ON;

CREATE TABLE federated_identities (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'sms')),
    subject TEXT NOT NULL,
    identifier TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (provider, subject),
    UNIQUE (provider, identifier)
);
CREATE INDEX federated_identities_account ON federated_identities(account_id, created_at);

CREATE TABLE google_auth_flows (
    id TEXT PRIMARY KEY,
    state_hash TEXT NOT NULL UNIQUE,
    nonce_hash TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    cookie_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('login', 'register', 'link')),
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    group_name TEXT,
    members_json TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumption_token TEXT
);
CREATE INDEX google_auth_flows_expiry ON google_auth_flows(expires_at);

CREATE TABLE sms_auth_challenges (
    id TEXT PRIMARY KEY,
    cookie_hash TEXT NOT NULL,
    phone TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('login', 'register', 'link')),
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    group_name TEXT,
    members_json TEXT,
    provider_sid TEXT,
    state TEXT NOT NULL CHECK (state IN ('sending', 'pending', 'verified', 'expired', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumption_token TEXT
);
CREATE INDEX sms_auth_challenges_expiry ON sms_auth_challenges(state, expires_at);
CREATE INDEX sms_auth_challenges_phone ON sms_auth_challenges(phone, created_at);

CREATE TABLE auth_rate_buckets (
    bucket_key TEXT PRIMARY KEY,
    count INTEGER NOT NULL CHECK (count > 0),
    expires_at TEXT NOT NULL
);
CREATE INDEX auth_rate_buckets_expiry ON auth_rate_buckets(expires_at);
