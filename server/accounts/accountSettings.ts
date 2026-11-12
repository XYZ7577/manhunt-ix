import type { Account } from '../../shared/types';
import type { AccountSettings, SettingsEmail, SettingsMember } from '../../shared/accounts/settings';
import { decryptTotpSecret, encryptTotpSecret, randomTotpSecret, verifyTotp } from './totp';
import type { EmailEnv } from '../email/email';
import { canVerifyEmail, sendVerifyCode, verifyEmailCode } from './emailVerification';
import {
    PASSWORD_ERROR,
    USERNAME_ERROR,
    validPassword,
    validUsername,
} from '../../shared/accounts/credentials';
import { authError, authJson } from './authResponse';

export interface SettingsEnv extends EmailEnv {
    DB: D1Database;
    TOTP_ENCRYPTION_KEY?: string;
    APP_ORIGIN?: string;
}
export interface SettingsDeps {
    currentAccount(request: Request, env: SettingsEnv): Promise<Account | null>;
    createSession(
        request: Request,
        env: SettingsEnv,
        accountId: string,
        guard?: { securityVersion: number; passwordHash?: string; requireNoTotp?: boolean },
    ): Promise<string>;
    passwordHash(password: string): Promise<{ salt: string; hash: string }>;
    passwordMatches?(password: string, salt: string, expected: string): Promise<boolean>;
    providerFetch?: typeof fetch;
}

const enc = new TextEncoder();
const CHALLENGE_COOKIE = 'manhunt_totp_challenge';
const STEP_UP_WINDOW_MS = 15 * 60_000;
const STEP_UP_MAX_CHECKS = 20;
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const b64url = (bytes: Uint8Array) =>
    btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) =>
    hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
const secure = (request: Request) => (new URL(request.url).protocol === 'https:' ? '; Secure' : '');

function cookie(request: Request, name: string): string | null {
    return (
        request.headers
            .get('Cookie')
            ?.split(';')
            .map((v) => v.trim())
            .find((v) => v.startsWith(`${name}=`))
            ?.slice(name.length + 1) ?? null
    );
}
function cookieHeader(request: Request, name: string, value: string, age: number) {
    return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure(request)}`;
}
async function body(request: Request): Promise<Record<string, unknown> | null> {
    try {
        const value = await request.json();
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}
function text(v: unknown) {
    return typeof v === 'string' ? v.trim() : '';
}
function validEmail(v: string) {
    return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function encryptionKey(env: SettingsEnv) {
    return env.TOTP_ENCRYPTION_KEY || '';
}
function encryptionReady(env: SettingsEnv) {
    try {
        return Uint8Array.from(atob(encryptionKey(env)), (c) => c.charCodeAt(0)).length === 32;
    } catch {
        return false;
    }
}

async function ensureSecurity(env: SettingsEnv, accountId: string) {
    await env.DB.prepare(
        "INSERT OR IGNORE INTO account_security(account_id,password_set,updated_at) SELECT id,CASE WHEN username LIKE 'google:%' OR username LIKE 'sms:%' THEN 0 ELSE 1 END,? FROM accounts WHERE id=?",
    )
        .bind(now(), accountId)
        .run();
    return env.DB.prepare('SELECT * FROM account_security WHERE account_id=?').bind(accountId).first<any>();
}

async function recentSessionExpiresAt(
    request: Request,
    env: SettingsEnv,
    accountId: string,
): Promise<string | null> {
    const token = cookie(request, 'manhunt_session');
    if (!token) return null;
    const row = await env.DB.prepare(
        'SELECT created_at FROM sessions WHERE token_hash=? AND account_id=? AND expires_at>?',
    )
        .bind(await digest(token), accountId, now())
        .first<{ created_at: string }>();
    if (!row) return null;
    const created = Date.parse(row.created_at);
    const age = Date.now() - created;
    if (!Number.isFinite(created) || age < 0 || age >= 5 * 60_000) return null;
    return new Date(created + 5 * 60_000).toISOString();
}

async function recentSession(request: Request, env: SettingsEnv, accountId: string): Promise<boolean> {
    return (await recentSessionExpiresAt(request, env, accountId)) !== null;
}

async function reserveStepUpCheck(env: SettingsEnv, accountId: string): Promise<boolean> {
    const timestamp = Date.now();
    const current = new Date(timestamp).toISOString();
    const expiry = new Date(timestamp + STEP_UP_WINDOW_MS).toISOString();
    const key = `factor:${await digest(accountId)}`;
    try {
        const row = await env.DB.prepare(
            `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET
        count=CASE WHEN auth_rate_buckets.expires_at<=? THEN 1 ELSE auth_rate_buckets.count+1 END,
        expires_at=CASE WHEN auth_rate_buckets.expires_at<=? THEN excluded.expires_at ELSE auth_rate_buckets.expires_at END
      RETURNING count`,
        )
            .bind(key, expiry, current, current)
            .first<{ count: number }>();
        return !!row && row.count <= STEP_UP_MAX_CHECKS;
    } catch {
        return false;
    }
}

async function verifyCode(
    env: SettingsEnv,
    accountId: string,
    code: string,
    expectedVersion: number,
): Promise<boolean> {
    if (!encryptionKey(env)) return false;
    const security = await ensureSecurity(env, accountId);
    if (
        !security?.totp_enabled ||
        !security.totp_secret_ciphertext ||
        Number(security.security_version) !== expectedVersion
    )
        return false;
    if (!(await reserveStepUpCheck(env, accountId))) return false;
    let secret: string;
    try {
        secret = await decryptTotpSecret(security.totp_secret_ciphertext, encryptionKey(env));
    } catch {
        return false;
    }
    const step = await verifyTotp(secret, code);
    if (step !== null) {
        const result = await env.DB.prepare(
            'UPDATE account_security SET totp_last_step=?,updated_at=? WHERE account_id=? AND totp_enabled=1 AND security_version=? AND (totp_last_step IS NULL OR totp_last_step<?)',
        )
            .bind(step, now(), accountId, expectedVersion, step)
            .run();
        if (result.meta.changes) return true;
    }
    const normalized = code.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z2-9]{12}$/.test(normalized)) return false;
    const codeHash = await digest(`${accountId}:${normalized}`);
    const deleted = await env.DB.prepare(
        'DELETE FROM totp_recovery_codes WHERE account_id=? AND code_hash=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND totp_enabled=1)',
    )
        .bind(accountId, codeHash, accountId, expectedVersion)
        .run();
    return !!deleted.meta.changes;
}

export async function verifyAuthCode(
    env: SettingsEnv,
    accountId: string,
    code: string,
    expectedVersion: number,
): Promise<boolean> {
    return verifyCode(env, accountId, code, expectedVersion);
}

function makeRecoveryCodes(): string[] {
    return Array.from({ length: 10 }, () => {
        const raw = randomTotpSecret(crypto.getRandomValues(new Uint8Array(8))).slice(0, 12);
        return `${raw.slice(0, 6)}-${raw.slice(6, 12)}`;
    });
}
async function replaceRecoveryCodes(
    env: SettingsEnv,
    accountId: string,
    codes: string[],
    expectedVersion: number,
): Promise<boolean> {
    const nextVersion = expectedVersion + 1;
    const claim = id();
    const statements: D1PreparedStatement[] = [
        env.DB.prepare(
            'UPDATE account_security SET security_version=?,security_claim=?,updated_at=? WHERE account_id=? AND security_version=? AND totp_enabled=1',
        ).bind(nextVersion, claim, now(), accountId, expectedVersion),
        env.DB.prepare(
            'DELETE FROM totp_recovery_codes WHERE account_id=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=? AND totp_enabled=1)',
        ).bind(accountId, accountId, nextVersion, claim),
    ];
    for (const code of codes)
        statements.push(
            env.DB.prepare(
                'INSERT INTO totp_recovery_codes(account_id,code_hash,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=? AND totp_enabled=1)',
            ).bind(
                accountId,
                await digest(`${accountId}:${code.toUpperCase().replace(/[\s-]/g, '')}`),
                now(),
                accountId,
                nextVersion,
                claim,
            ),
        );
    const results = await env.DB.batch(statements);
    return !!results[0]?.meta.changes;
}

type PasswordProofFailure = { code: string; error: string; status: number };

async function passwordProofFailure(
    request: Request,
    env: SettingsEnv,
    accountId: string,
    security: any,
    password: unknown,
    deps: SettingsDeps,
): Promise<PasswordProofFailure | null> {
    if (!security.password_set)
        return (await recentSession(request, env, accountId))
            ? null
            : {
                  code: 'recent_sign_in_required',
                  error: 'Sign in again, then return within five minutes to set your first password.',
                  status: 403,
              };
    if (!(await reserveStepUpCheck(env, accountId)))
        return {
            code: 'security_check_limited',
            error: 'Too many password checks. Wait 15 minutes before trying again.',
            status: 429,
        };
    const current = typeof password === 'string' ? password : '';
    if (!current)
        return {
            code: 'current_password_required',
            error: 'Enter your current password to change it.',
            status: 403,
        };
    if (!deps.passwordMatches)
        return {
            code: 'incorrect_current_password',
            error: 'Current password is incorrect.',
            status: 403,
        };
    const accountRow = await env.DB.prepare('SELECT password_salt,password_hash FROM accounts WHERE id=?')
        .bind(accountId)
        .first<any>();
    if (
        accountRow &&
        (await deps.passwordMatches(current, accountRow.password_salt, accountRow.password_hash))
    )
        return null;
    return {
        code: 'incorrect_current_password',
        error: 'Current password is incorrect.',
        status: 403,
    };
}

async function requirePasswordOrRecent(
    request: Request,
    env: SettingsEnv,
    accountId: string,
    security: any,
    password: unknown,
    deps: SettingsDeps,
): Promise<boolean> {
    return !(await passwordProofFailure(request, env, accountId, security, password, deps));
}

async function requireTotpSetupProof(
    request: Request,
    env: SettingsEnv,
    accountId: string,
    security: any,
    password: unknown,
    deps: SettingsDeps,
): Promise<string | null> {
    if (typeof password === 'string' && password.length > 0) {
        if (!security.password_set)
            return 'This account has no Manhunt IX website password. Sign out and sign in with Google again, then return within five minutes.';
        if (!(await reserveStepUpCheck(env, accountId)))
            return 'Too many security checks. Wait 15 minutes or sign in again before trying.';
        const current = await env.DB.prepare('SELECT password_salt,password_hash FROM accounts WHERE id=?')
            .bind(accountId)
            .first<any>();
        if (
            current &&
            deps.passwordMatches &&
            (await deps.passwordMatches(password, current.password_salt, current.password_hash))
        )
            return null;
        return 'That is not the Manhunt IX website password. Enter the correct password or sign in with Google again and return within five minutes.';
    }
    if (await recentSession(request, env, accountId)) return null;
    return security.password_set
        ? 'Enter your current Manhunt IX website password, or sign out and sign in again, then return within five minutes.'
        : 'Your sign-in confirmation has expired. Sign out and sign in with Google again, then return within five minutes.';
}

async function revokeOtherAuthState(request: Request, env: SettingsEnv, accountId: string): Promise<void> {
    const thisToken = cookie(request, 'manhunt_session');
    const thisHash = thisToken ? await digest(thisToken) : '';
    await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE account_id=? AND token_hash<>?').bind(accountId, thisHash),
        env.DB.prepare('DELETE FROM totp_challenges WHERE account_id=?').bind(accountId),
        env.DB.prepare('DELETE FROM google_auth_flows WHERE account_id=? AND consumed_at IS NULL').bind(
            accountId,
        ),
        env.DB.prepare(
            "DELETE FROM sms_auth_challenges WHERE account_id=? AND state IN ('sending','pending','verified')",
        ).bind(accountId),
    ]);
}

async function rotateCurrentSession(
    request: Request,
    env: SettingsEnv,
    deps: SettingsDeps,
    accountId: string,
    version: number,
    requireNoTotp: boolean,
): Promise<string> {
    const row = await env.DB.prepare('SELECT password_hash FROM accounts WHERE id=?')
        .bind(accountId)
        .first<{ password_hash: string }>();
    if (!row) throw new Error('Account not found.');
    const setCookie = await deps.createSession(request, env, accountId, {
        securityVersion: version,
        passwordHash: row.password_hash,
        requireNoTotp,
    });
    const oldToken = cookie(request, 'manhunt_session');
    if (oldToken)
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash=? AND account_id=?')
            .bind(await digest(oldToken), accountId)
            .run();
    return setCookie;
}

async function loadSettings(request: Request, env: SettingsEnv, account: Account): Promise<AccountSettings> {
    const security = await ensureSecurity(env, account.id);
    const emails = await env.DB.prepare(
        'SELECT id,email,verified_at,is_primary FROM account_emails WHERE account_id=? ORDER BY is_primary DESC,created_at,id',
    )
        .bind(account.id)
        .all<any>();
    let members: SettingsMember[] = [];
    if (account.groupId) {
        const roster = await env.DB.prepare('SELECT members_json FROM groups WHERE id=?')
            .bind(account.groupId)
            .first<{ members_json: string }>();
        const names: string[] = roster ? JSON.parse(roster.members_json) : [];
        const seen = new Set<string>();
        members = names
            .map((displayName) => ({ displayName, username: '', role: 'player' as const }))
            .filter((member) => {
                const key = member.displayName.trim().toLocaleLowerCase();
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }
    return {
        emails: emails.results.map((row: any) => ({
            id: row.id,
            email: row.email,
            verified: !!row.verified_at,
            primary: !!row.is_primary,
        })),
        members,
        canRenameGroup:
            account.role === 'player' &&
            !!account.groupId &&
            !!(await env.DB.prepare(
                `SELECT 1 FROM group_leaders gl
      JOIN accounts a ON a.id=gl.account_id AND a.role='player' AND a.group_id=gl.group_id
      WHERE gl.group_id=? AND gl.account_id=? AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gl.group_id)`,
            )
                .bind(account.groupId, account.id)
                .first()),
        hasPassword: !!security.password_set,
        emailVerificationAvailable: canVerifyEmail(env),
        recentSignInExpiresAt: await recentSessionExpiresAt(request, env, account.id),
        twoFactor: { enabled: !!security.totp_enabled },
    };
}

async function changeDisplayName(
    env: SettingsEnv,
    account: Account,
    input: Record<string, unknown> | null,
): Promise<Response> {
    const displayName = text(input?.displayName);
    if (!displayName) return authError('Enter your full name.');
    if (displayName.length > 80) return authError('Your full name must be 80 characters or fewer.');
    const changed = await env.DB.prepare(
        `UPDATE accounts SET display_name=? WHERE id=?
    AND EXISTS(SELECT 1 FROM account_approvals aa WHERE aa.account_id=accounts.id AND aa.status='approved')
    AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=accounts.id)`,
    )
        .bind(displayName, account.id)
        .run();
    if (!changed.meta.changes)
        return authError('Your account could not be updated. Refresh and try again.', 409);
    return authJson({ account: { ...account, displayName } satisfies Account });
}

async function changeGroupName(
    env: SettingsEnv,
    account: Account,
    input: Record<string, unknown> | null,
): Promise<Response> {
    const groupName = text(input?.groupName);
    if (!groupName) return authError('Enter a group name.');
    if (groupName.length > 60) return authError('The group name must be 60 characters or fewer.');
    if (account.role !== 'player' || !account.groupId)
        return authError('Only the current group owner can change this group name.', 403);
    const changed = await env.DB.prepare(
        `UPDATE groups SET name=? WHERE id=?
    AND EXISTS(SELECT 1 FROM accounts actor JOIN account_approvals aa ON aa.account_id=actor.id AND aa.status='approved'
      WHERE actor.id=? AND actor.role='player' AND actor.group_id=groups.id
      AND NOT EXISTS(SELECT 1 FROM account_deletions ad WHERE ad.account_id=actor.id))
    AND EXISTS(SELECT 1 FROM group_leaders gl WHERE gl.group_id=groups.id AND gl.account_id=?)
    AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=groups.id)
    AND NOT EXISTS(SELECT 1 FROM group_deletions d WHERE d.group_id=groups.id)`,
    )
        .bind(groupName, account.groupId, account.id, account.id)
        .run();
    if (!changed.meta.changes)
        return authError('Only the current group owner can change this group name.', 403);
    return authJson({ group: { id: account.groupId, name: groupName } });
}

async function changeUsername(
    env: SettingsEnv,
    account: Account,
    input: Record<string, unknown> | null,
): Promise<Response> {
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    if (!validUsername(username)) return authError(USERNAME_ERROR);
    if (username === account.username) return authJson({ account });
    const googleIdentity = await env.DB.prepare(
        `SELECT 1 FROM federated_identities
    WHERE provider='google' AND identifier=? COLLATE NOCASE AND account_id<>? LIMIT 1`,
    )
        .bind(username, account.id)
        .first();
    if (googleIdentity) return authError('That username is already in use.', 409);
    try {
        const changed = await env.DB.prepare(
            `UPDATE accounts SET username=? WHERE id=? AND username=? COLLATE BINARY
      AND NOT EXISTS(SELECT 1 FROM federated_identities f
        WHERE f.provider='google' AND f.identifier=? COLLATE NOCASE AND f.account_id<>accounts.id)`,
        )
            .bind(username, account.id, account.username, username)
            .run();
        if (!changed.meta.changes) {
            const current = await env.DB.prepare('SELECT username FROM accounts WHERE id=?')
                .bind(account.id)
                .first<{ username: string }>();
            if (current?.username !== username)
                return authError('Your username changed elsewhere. Refresh and try again.', 409);
        }
    } catch {
        return authError('That username is already in use.', 409);
    }
    return authJson({ account: { ...account, username } });
}

async function issueChallenge(
    request: Request,
    env: SettingsEnv,
    accountId: string,
    proof?: { securityVersion: number; passwordHash?: string },
): Promise<Response | null> {
    const security = await ensureSecurity(env, accountId);
    if (!security.totp_enabled) return null;
    if (!encryptionReady(env))
        return authError(
            'Authenticator verification is unavailable because server encryption is not configured.',
            503,
        );
    const recent = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM totp_challenges WHERE account_id=? AND created_at>?',
    )
        .bind(accountId, new Date(Date.now() - 15 * 60_000).toISOString())
        .first<{ count: number }>();
    if ((recent?.count ?? 0) >= 10)
        return authError('Too many authenticator challenges. Try again later.', 429);
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const issued = await env.DB.prepare(
        'INSERT INTO totp_challenges(token_hash,account_id,security_version,password_hash_snapshot,created_at,expires_at) SELECT ?,a.id,s.security_version,a.password_hash,?,? FROM accounts a JOIN account_security s ON s.account_id=a.id WHERE a.id=? AND (? IS NULL OR s.security_version=?) AND (? IS NULL OR a.password_hash=?) AND (SELECT COUNT(*) FROM totp_challenges c WHERE c.account_id=a.id AND c.created_at>?)<10',
    )
        .bind(
            await digest(token),
            now(),
            expires,
            accountId,
            proof?.securityVersion ?? null,
            proof?.securityVersion ?? null,
            proof?.passwordHash ?? null,
            proof?.passwordHash ?? null,
            new Date(Date.now() - 15 * 60_000).toISOString(),
        )
        .run();
    if (!issued.meta.changes) return authError('Sign in again before continuing.', 401);
    return authJson({ requiresTwoFactor: true }, 200, {
        'Set-Cookie': cookieHeader(request, CHALLENGE_COOKIE, token, 300),
    });
}

export async function beginSecondFactor(
    request: Request,
    env: SettingsEnv,
    accountId: string,
    _deps?: SettingsDeps,
    proof?: { securityVersion: number; passwordHash?: string },
): Promise<Response | null> {
    return issueChallenge(request, env, accountId, proof);
}

async function verifyLoginChallenge(
    request: Request,
    env: SettingsEnv,
    deps: SettingsDeps,
): Promise<Response> {
    if (!encryptionReady(env))
        return authError(
            'Authenticator verification is unavailable because server encryption is not configured.',
            503,
        );
    const token = cookie(request, CHALLENGE_COOKIE);
    const input = await body(request);
    const code = text(input?.code);
    if (!token || !/^(?:\d{6}|[A-Za-z2-9\s-]{12,20})$/.test(code))
        return authError('Invalid or expired authenticator challenge.', 401);
    const tokenHash = await digest(token);
    const challenge = await env.DB.prepare(
        'SELECT c.*,a.password_hash,s.security_version AS current_version,s.totp_enabled FROM totp_challenges c JOIN accounts a ON a.id=c.account_id JOIN account_security s ON s.account_id=c.account_id WHERE c.token_hash=? AND c.expires_at>? AND c.consumed_at IS NULL AND c.attempts<5',
    )
        .bind(tokenHash, now())
        .first<any>();
    if (
        !challenge ||
        !challenge.totp_enabled ||
        challenge.current_version !== challenge.security_version ||
        challenge.password_hash !== challenge.password_hash_snapshot
    )
        return authError('Invalid or expired authenticator challenge.', 401);
    const reserved = await env.DB.prepare(
        'UPDATE totp_challenges SET attempts=attempts+1 WHERE token_hash=? AND consumed_at IS NULL AND attempts<5 AND expires_at>? AND security_version=?',
    )
        .bind(tokenHash, now(), challenge.security_version)
        .run();
    if (!reserved.meta.changes) return authError('Invalid or expired authenticator challenge.', 401);
    const valid = await verifyCode(env, challenge.account_id, code, challenge.security_version);
    if (!valid) {
        return authError('Invalid or expired authenticator challenge.', 401);
    }
    const consumed = await env.DB.prepare(
        'UPDATE totp_challenges SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND attempts<=5 AND expires_at>? AND EXISTS(SELECT 1 FROM account_security s JOIN accounts a ON a.id=s.account_id WHERE s.account_id=totp_challenges.account_id AND s.security_version=totp_challenges.security_version AND a.password_hash=totp_challenges.password_hash_snapshot AND s.totp_enabled=1)',
    )
        .bind(now(), tokenHash, now())
        .run();
    if (!consumed.meta.changes) return authError('Invalid or expired authenticator challenge.', 401);
    const row = await env.DB.prepare('SELECT id,username,display_name,role,group_id FROM accounts WHERE id=?')
        .bind(challenge.account_id)
        .first<any>();
    if (!row) return authError('Account not found.', 401);
    const headers = new Headers({ 'Set-Cookie': cookieHeader(request, CHALLENGE_COOKIE, '', 0) });
    headers.append(
        'Set-Cookie',
        await deps.createSession(request, env, challenge.account_id, {
            securityVersion: challenge.security_version,
            passwordHash: challenge.password_hash_snapshot,
            requireNoTotp: false,
        }),
    );
    return authJson(
        {
            account: {
                id: row.id,
                username: row.username,
                displayName: row.display_name,
                role: row.role,
                groupId: row.group_id,
            } satisfies Account,
        },
        200,
        headers,
    );
}

export async function handleAccountSettings(
    request: Request,
    env: SettingsEnv,
    deps: SettingsDeps,
): Promise<Response | null> {
    const url = new URL(request.url),
        path = url.pathname,
        method = request.method;
    if (path === '/api/auth/totp/verify' && method === 'POST')
        return verifyLoginChallenge(request, env, deps);
    if (!path.startsWith('/api/settings')) return null;
    const account = await deps.currentAccount(request, env);
    if (!account) return authError('Sign in required.', 401);
    if (path === '/api/settings/display-name' && method === 'PUT') {
        return changeDisplayName(env, account, await body(request));
    }
    if (path === '/api/settings/group-name' && method === 'PUT') {
        return changeGroupName(env, account, await body(request));
    }
    const security = await ensureSecurity(env, account.id);
    if (path === '/api/settings' && method === 'GET')
        return authJson({ settings: await loadSettings(request, env, account) });
    if (path === '/api/settings/username' && method === 'PUT') {
        return changeUsername(env, account, await body(request));
    }

    if (path === '/api/settings/emails' && method === 'POST') {
        const input = await body(request),
            email = text(input?.email).toLowerCase();
        if (!validEmail(email)) return authError('Enter a valid email address.');
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM account_emails WHERE account_id=?')
            .bind(account.id)
            .first<{ count: number }>();
        if ((count?.count ?? 0) >= 5) return authError('You can add up to 5 contact emails.');
        const emailId = id();
        try {
            const inserted = await env.DB.prepare(
                'INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at) SELECT ?,?,?,CASE WHEN COUNT(*)=0 THEN 1 ELSE 0 END,NULL,? FROM account_emails WHERE account_id=? HAVING COUNT(*)<5 OR COUNT(*)=0',
            )
                .bind(emailId, account.id, email, now(), account.id)
                .run();
            if (!inserted.meta.changes) return authError('You can add up to 5 contact emails.');
        } catch {
            return authError('That email is already in use.');
        }
        const contact = {
            id: emailId,
            email,
            verified: false,
            primary: (count?.count ?? 0) === 0,
        } satisfies SettingsEmail;
        const verification = await sendVerifyCode(env, request, deps, {
            id: emailId,
            accountId: account.id,
            address: email,
        });
        return authJson({ email: contact, verification }, 201);
    }
    const verifyEmailMatch = path.match(/^\/api\/settings\/emails\/([\w-]+)\/(verification|verify)$/);
    if (verifyEmailMatch && verifyEmailMatch[2] === 'verification' && method === 'POST') {
        const contact = await env.DB.prepare(
            'SELECT id,email,verified_at,is_primary FROM account_emails WHERE id=? AND account_id=?',
        )
            .bind(verifyEmailMatch[1], account.id)
            .first<any>();
        if (!contact) return authError('Email not found.', 404);
        if (contact.verified_at) return authError('This contact email is already verified.', 409);
        const verification = await sendVerifyCode(env, request, deps, {
            id: contact.id,
            accountId: account.id,
            address: contact.email,
        });
        if (
            verification.retryAfterSeconds &&
            !verification.sent &&
            verification.error === 'Please wait before requesting another verification email.'
        )
            return authJson(
                {
                    error: verification.error,
                    code: 'verification_rate_limited',
                    retryAfterSeconds: verification.retryAfterSeconds,
                },
                429,
            );
        return authJson({
            email: {
                id: contact.id,
                email: contact.email,
                verified: false,
                primary: !!contact.is_primary,
            } satisfies SettingsEmail,
            verification,
        });
    }
    if (verifyEmailMatch && verifyEmailMatch[2] === 'verify' && method === 'POST') {
        const contact = await env.DB.prepare(
            'SELECT id,email,is_primary,verified_at FROM account_emails WHERE id=? AND account_id=?',
        )
            .bind(verifyEmailMatch[1], account.id)
            .first<any>();
        if (!contact) return authError('Email not found.', 404);
        if (contact.verified_at)
            return authJson({
                email: {
                    id: contact.id,
                    email: contact.email,
                    verified: true,
                    primary: !!contact.is_primary,
                } satisfies SettingsEmail,
            });
        if (!canVerifyEmail(env))
            return authJson(
                {
                    error: 'Email verification is unavailable until server email and encryption settings are configured.',
                    code: 'verification_unavailable',
                },
                503,
            );
        const input = await body(request);
        const result = await verifyEmailCode(env, account.id, contact.id, text(input?.code));
        if (!result.ok) return authJson({ error: result.error, code: result.code }, result.status);
        const updated = await env.DB.prepare(
            'SELECT id,email,is_primary,verified_at FROM account_emails WHERE id=? AND account_id=?',
        )
            .bind(contact.id, account.id)
            .first<any>();
        if (!updated?.verified_at)
            return authError('Email verification could not be completed. Try again.', 409);
        return authJson({
            email: {
                id: updated.id,
                email: updated.email,
                verified: true,
                primary: !!updated.is_primary,
            } satisfies SettingsEmail,
        });
    }
    const emailMatch = path.match(/^\/api\/settings\/emails\/([\w-]+)(?:\/primary)?$/);
    if (emailMatch && method === 'PUT' && !path.endsWith('/primary')) {
        const input = await body(request),
            email = text(input?.email).toLowerCase();
        if (!validEmail(email)) return authError('Enter a valid email address.');
        try {
            const result = await env.DB.prepare(
                'UPDATE account_emails SET email=?,verified_at=NULL WHERE id=? AND account_id=?',
            )
                .bind(email, emailMatch[1], account.id)
                .run();
            if (!result.meta.changes) return authError('Email not found.', 404);
        } catch {
            return authError('That email is already in use.');
        }
        const contact = await env.DB.prepare(
            'SELECT id,email,is_primary FROM account_emails WHERE id=? AND account_id=?',
        )
            .bind(emailMatch[1], account.id)
            .first<{ id: string; email: string; is_primary: number }>();
        const verification = await sendVerifyCode(env, request, deps, {
            id: emailMatch[1],
            accountId: account.id,
            address: email,
        });
        return authJson({
            email: {
                id: emailMatch[1],
                email,
                verified: false,
                primary: !!contact?.is_primary,
            } satisfies SettingsEmail,
            verification,
        });
    }
    if (emailMatch && method === 'DELETE' && !path.endsWith('/primary')) {
        const result = await env.DB.prepare('DELETE FROM account_emails WHERE id=? AND account_id=?')
            .bind(emailMatch[1], account.id)
            .run();
        if (!result.meta.changes) return authError('Email not found.', 404);
        const remaining = await env.DB.prepare(
            'SELECT id FROM account_emails WHERE account_id=? ORDER BY created_at,id LIMIT 1',
        )
            .bind(account.id)
            .first<{ id: string }>();
        if (remaining)
            await env.DB.prepare(
                'UPDATE account_emails SET is_primary=1 WHERE id=? AND account_id=? AND NOT EXISTS(SELECT 1 FROM account_emails WHERE account_id=? AND is_primary=1)',
            )
                .bind(remaining.id, account.id, account.id)
                .run();
        return authJson({ ok: true });
    }
    if (emailMatch && method === 'PUT' && path.endsWith('/primary')) {
        const exists = await env.DB.prepare(
            'SELECT 1 AS found FROM account_emails WHERE id=? AND account_id=?',
        )
            .bind(emailMatch[1], account.id)
            .first<{ found: number }>();
        if (!exists) return authError('Email not found.', 404);
        const result = await env.DB.prepare(
            'UPDATE account_emails SET is_primary=CASE WHEN id=? THEN 1 ELSE 0 END WHERE account_id=?',
        )
            .bind(emailMatch[1], account.id)
            .run();
        if (!result.meta.changes) return authError('Email not found.', 404);
        return authJson({ ok: true });
    }
    if (path === '/api/settings/password' && method === 'POST') {
        const input = await body(request),
            newPassword = input?.newPassword;
        if (!validPassword(newPassword)) return authError(PASSWORD_ERROR);
        const proofFailure = await passwordProofFailure(
            request,
            env,
            account.id,
            security,
            input?.currentPassword,
            deps,
        );
        if (proofFailure)
            return authJson({ error: proofFailure.error, code: proofFailure.code }, proofFailure.status);
        const previous = await env.DB.prepare('SELECT password_hash FROM accounts WHERE id=?')
            .bind(account.id)
            .first<{ password_hash: string }>();
        if (!previous) return authError('Account not found.', 404);
        const priorVersion = security.security_version as number;
        const hashed = await deps.passwordHash(newPassword);
        const changes = await env.DB.batch([
            env.DB.prepare(
                'UPDATE accounts SET password_salt=?,password_hash=? WHERE id=? AND password_hash=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=?)',
            ).bind(hashed.salt, hashed.hash, account.id, previous.password_hash, account.id, priorVersion),
            env.DB.prepare(
                'UPDATE account_security SET password_set=1,security_version=security_version+1,updated_at=? WHERE account_id=? AND security_version=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND password_hash=?)',
            ).bind(now(), account.id, priorVersion, account.id, hashed.hash),
        ]);
        if (!changes[0].meta.changes || !changes[1].meta.changes)
            return authError('Account security changed. Sign in again and retry.', 409);
        await revokeOtherAuthState(request, env, account.id);
        const setCookie = await deps.createSession(request, env, account.id, {
            securityVersion: priorVersion + 1,
            passwordHash: hashed.hash,
            requireNoTotp: !!security.totp_enabled ? false : true,
        });
        const oldToken = cookie(request, 'manhunt_session');
        if (oldToken)
            await env.DB.prepare('DELETE FROM sessions WHERE token_hash=? AND account_id=?')
                .bind(await digest(oldToken), account.id)
                .run();
        return authJson({ ok: true }, 200, { 'Set-Cookie': setCookie });
    }
    if (path === '/api/settings/totp/setup' && method === 'POST') {
        if (!encryptionReady(env))
            return authError(
                'Authenticator setup is unavailable because server encryption is not configured.',
                503,
            );
        const input = await body(request);
        const proofError = await requireTotpSetupProof(
            request,
            env,
            account.id,
            security,
            input?.password,
            deps,
        );
        if (proofError) return authError(proofError, 403);
        if (security.totp_enabled) return authError('Authenticator app is already enabled.');
        const secret = randomTotpSecret();
        const encrypted = await encryptTotpSecret(secret, encryptionKey(env));
        const pendingUntil = new Date(Date.now() + 10 * 60_000).toISOString();
        const pending = await env.DB.prepare(
            'UPDATE account_security SET totp_pending_ciphertext=?,totp_pending_expires_at=?,totp_pending_attempts=0,totp_pending_security_version=?,updated_at=? WHERE account_id=? AND totp_enabled=0 AND security_version=?',
        )
            .bind(
                encrypted,
                pendingUntil,
                security.security_version,
                now(),
                account.id,
                security.security_version,
            )
            .run();
        if (!pending.meta.changes)
            return authError('Account security changed. Sign in again and retry.', 409);
        const label = encodeURIComponent(`Manhunt IX:${account.username}`);
        const issuer = encodeURIComponent('Manhunt IX');
        const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
        return authJson({ secret, otpauthUri });
    }
    if (path === '/api/settings/totp/activate' && method === 'POST') {
        if (!encryptionReady(env))
            return authError(
                'Authenticator setup is unavailable because server encryption is not configured.',
                503,
            );
        const input = await body(request);
        if (
            security.totp_enabled ||
            !security.totp_pending_ciphertext ||
            !security.totp_pending_expires_at ||
            security.totp_pending_expires_at <= now() ||
            security.totp_pending_attempts >= 5 ||
            security.totp_pending_security_version !== security.security_version
        )
            return authError('Start authenticator setup first.');
        const reserved = await env.DB.prepare(
            'UPDATE account_security SET totp_pending_attempts=totp_pending_attempts+1 WHERE account_id=? AND totp_enabled=0 AND totp_pending_ciphertext=? AND totp_pending_expires_at>? AND totp_pending_attempts<5',
        )
            .bind(account.id, security.totp_pending_ciphertext, now())
            .run();
        if (!reserved.meta.changes) return authError('Start authenticator setup first.');
        let secret: string;
        try {
            secret = await decryptTotpSecret(security.totp_pending_ciphertext, encryptionKey(env));
        } catch {
            return authError('Authenticator setup is unavailable because server encryption is invalid.', 503);
        }
        const step = await verifyTotp(secret, text(input?.code));
        if (step === null)
            return authError('Enter the current six-digit code from your authenticator app.', 401);
        const encrypted = security.totp_pending_ciphertext;
        const recoveryCodes = makeRecoveryCodes();
        const newVersion = Number(security.security_version) + 1;
        const activationClaim = id();
        const activateStmts: D1PreparedStatement[] = [
            env.DB.prepare(
                'UPDATE account_security SET totp_enabled=1,totp_secret_ciphertext=?,totp_pending_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_attempts=0,totp_pending_security_version=NULL,totp_last_step=?,security_version=?,security_claim=?,updated_at=? WHERE account_id=? AND totp_enabled=0 AND totp_pending_ciphertext=? AND totp_pending_expires_at>? AND security_version=?',
            ).bind(
                encrypted,
                step,
                newVersion,
                activationClaim,
                now(),
                account.id,
                encrypted,
                now(),
                security.security_version,
            ),
            env.DB.prepare(
                'DELETE FROM totp_recovery_codes WHERE account_id=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=? AND totp_enabled=1)',
            ).bind(account.id, account.id, newVersion, activationClaim),
        ];
        for (const code of recoveryCodes)
            activateStmts.push(
                env.DB.prepare(
                    'INSERT INTO totp_recovery_codes(account_id,code_hash,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=? AND totp_enabled=1)',
                ).bind(
                    account.id,
                    await digest(`${account.id}:${code.toUpperCase().replace(/[\s-]/g, '')}`),
                    now(),
                    account.id,
                    newVersion,
                    activationClaim,
                ),
            );
        const activated = await env.DB.batch(activateStmts);
        if (!activated[0]?.meta.changes) return authError('Authenticator setup expired. Start again.');
        await revokeOtherAuthState(request, env, account.id);
        const setCookie = await rotateCurrentSession(request, env, deps, account.id, newVersion, false);
        return authJson({ ok: true, recoveryCodes }, 200, { 'Set-Cookie': setCookie });
    }
    if (path === '/api/settings/totp/disable' && method === 'POST') {
        const input = await body(request);
        if (!security.totp_enabled) return authError('Authenticator app is not enabled.');
        if (!(await requirePasswordOrRecent(request, env, account.id, security, input?.password, deps)))
            return authError('Current password or a recent sign-in is required.', 403);
        if (!(await verifyCode(env, account.id, text(input?.code), security.security_version)))
            return authError('A valid authenticator or recovery code is required.', 403);
        const disableClaim = id(),
            disableVersion = Number(security.security_version) + 1;
        const disabled = await env.DB.batch([
            env.DB.prepare(
                'UPDATE account_security SET totp_enabled=0,totp_secret_ciphertext=NULL,totp_pending_ciphertext=NULL,totp_pending_expires_at=NULL,totp_pending_security_version=NULL,totp_last_step=NULL,security_version=?,security_claim=?,updated_at=? WHERE account_id=? AND security_version=? AND totp_enabled=1',
            ).bind(disableVersion, disableClaim, now(), account.id, security.security_version),
            env.DB.prepare(
                'DELETE FROM totp_recovery_codes WHERE account_id=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=? AND totp_enabled=0)',
            ).bind(account.id, account.id, disableVersion, disableClaim),
        ]);
        if (!disabled[0]?.meta.changes)
            return authError('Account security changed. Sign in again and retry.', 409);
        await revokeOtherAuthState(request, env, account.id);
        const setCookie = await rotateCurrentSession(request, env, deps, account.id, disableVersion, true);
        return authJson({ ok: true }, 200, { 'Set-Cookie': setCookie });
    }
    if (path === '/api/settings/totp/recovery-codes' && method === 'POST') {
        const input = await body(request);
        if (!(await requirePasswordOrRecent(request, env, account.id, security, input?.password, deps)))
            return authError('Current password or a recent sign-in is required.', 403);
        if (
            !security.totp_enabled ||
            !(await verifyCode(env, account.id, text(input?.code), security.security_version))
        )
            return authError('A valid authenticator or recovery code is required.', 403);
        const recoveryCodes = makeRecoveryCodes();
        if (!(await replaceRecoveryCodes(env, account.id, recoveryCodes, security.security_version)))
            return authError('Account security changed. Sign in again and retry.', 409);
        await revokeOtherAuthState(request, env, account.id);
        const setCookie = await rotateCurrentSession(
            request,
            env,
            deps,
            account.id,
            Number(security.security_version) + 1,
            false,
        );
        return authJson({ recoveryCodes }, 200, { 'Set-Cookie': setCookie });
    }
    return authError('Settings endpoint not found.', 404);
}
