import type { Account } from '../../shared/types';
import { PASSWORD_ERROR, validPassword } from '../../shared/accounts/credentials';
import { verifyAuthCode, type SettingsDeps, type SettingsEnv } from './accountSettings';
import { getEmailConfiguration, sendEmail, type EmailEnv } from '../email/email';
import { verificationCodeEmail } from '../email/emailTemplates';
import { authError, authJson } from './authResponse';

export interface AccountRecoveryEnv extends SettingsEnv, EmailEnv {}

export interface AccountRecoveryDeps extends Pick<
    SettingsDeps,
    'createSession' | 'passwordHash' | 'passwordMatches'
> {
    providerFetch?: typeof fetch;
}

const enc = new TextEncoder();
const RESET_COOKIE = 'manhunt_password_reset';
const EMAIL_CODE_TTL_MS = 10 * 60_000;
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) =>
    hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
const secure = (request: Request) => (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
function cookie(request: Request, name: string): string | null {
    return (
        request.headers
            .get('Cookie')
            ?.split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith(`${name}=`))
            ?.slice(name.length + 1) ?? null
    );
}
function setCookie(request: Request, token: string, age: number) {
    return `${RESET_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure(request)}`;
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
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const normalizeIdentifier = (value: unknown) => str(value).toLocaleLowerCase('en-US').slice(0, 254);
const resetCodeHash = (accountId: string, browserHash: string, code: string) =>
    digest(`password-reset-email:v1:${accountId}:${browserHash}:${code}`);

async function reserveRate(
    env: AccountRecoveryEnv,
    key: string,
    limit: number,
    windowMs: number,
): Promise<boolean> {
    const timestamp = Date.now(),
        current = new Date(timestamp).toISOString(),
        expiry = new Date(timestamp + windowMs).toISOString();
    const hashedKey = `recovery:${await digest(key)}`;
    try {
        const result = await env.DB.prepare(
            `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET
        count=CASE WHEN auth_rate_buckets.expires_at<=? THEN 1 ELSE auth_rate_buckets.count+1 END,
        expires_at=CASE WHEN auth_rate_buckets.expires_at<=? THEN excluded.expires_at ELSE auth_rate_buckets.expires_at END
      RETURNING count`,
        )
            .bind(hashedKey, expiry, current, current)
            .first<{ count: number }>();
        return !!result && result.count <= limit;
    } catch {
        return false;
    }
}

function requestIp(request: Request): string {
    return (
        request.headers.get('CF-Connecting-IP')?.trim().slice(0, 100) ||
        request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim().slice(0, 100) ||
        'unknown'
    );
}

async function accountByIdentifier(env: AccountRecoveryEnv, identifier: string): Promise<any | null> {
    if (!identifier || identifier.length > 254) return null;
    return env.DB.prepare(
        `SELECT a.*,s.security_version,s.totp_enabled,s.password_set
    FROM accounts a JOIN account_security s ON s.account_id=a.id
    WHERE a.username=? COLLATE NOCASE OR EXISTS(
      SELECT 1 FROM federated_identities f WHERE f.account_id=a.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE
    )
    ORDER BY CASE WHEN EXISTS(
      SELECT 1 FROM federated_identities f WHERE f.account_id=a.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE
    ) THEN 0 ELSE 1 END,a.id LIMIT 1`,
    )
        .bind(identifier, identifier, identifier)
        .first<any>();
}

function accountDto(row: any): Account {
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        groupId: row.group_id,
    };
}

function passwordResetOptions(env: AccountRecoveryEnv) {
    return { emailEnabled: getEmailConfiguration(env) !== null };
}

async function sendResetEmail(
    env: AccountRecoveryEnv,
    recipient: string,
    code: string,
    providerFetch?: typeof fetch,
): Promise<boolean> {
    return sendEmail(env, verificationCodeEmail(recipient, code, EMAIL_CODE_TTL_MS / 60_000), providerFetch);
}

async function authenticatorLogin(
    request: Request,
    env: AccountRecoveryEnv,
    input: Record<string, unknown>,
    deps: AccountRecoveryDeps,
): Promise<Response> {
    const identifier = normalizeIdentifier(input.identifier),
        code = str(input.code);
    if (!(await reserveRate(env, `login-ip:${requestIp(request)}`, 30, 15 * 60_000)))
        return authError('Too many sign-in attempts. Wait a while and try again.', 429);
    if (!identifier || !/^(?:\d{6}|[A-Z2-9\s-]{12,20})$/i.test(code))
        return authError('Username/email or authenticator code is incorrect.', 401);
    const row = await accountByIdentifier(env, identifier);
    if (!row || !row.totp_enabled)
        return authError('Username/email or authenticator code is incorrect.', 401);
    const valid = await verifyAuthCode(env, row.id, code, Number(row.security_version));
    if (!valid) return authError('Username/email or authenticator code is incorrect.', 401);
    try {
        const session = await deps.createSession(request, env, row.id, {
            securityVersion: Number(row.security_version),
            passwordHash: row.password_hash,
            requireNoTotp: false,
        });
        return authJson({ account: accountDto(row) }, 200, { 'Set-Cookie': session });
    } catch {
        return authError('Account security changed. Sign in again and retry.', 401);
    }
}

async function requestPasswordReset(
    request: Request,
    env: AccountRecoveryEnv,
    deps: AccountRecoveryDeps,
): Promise<Response> {
    if (!passwordResetOptions(env).emailEnabled) {
        return authError(
            'Email password recovery is not configured. Use an authenticator or backup code, or ask an administrator for help.',
            503,
        );
    }
    const browserToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');
    const generic = () =>
        authJson({ ok: true }, 200, { 'Set-Cookie': setCookie(request, browserToken, 600) });
    if (!(await reserveRate(env, `reset-ip:${requestIp(request)}`, 10, 60 * 60_000))) return generic();
    const input = await body(request),
        identifier = normalizeIdentifier(input?.identifier);
    const row = identifier ? await accountByIdentifier(env, identifier) : null;
    if (!row) return generic();
    if (!(await reserveRate(env, `reset-account:${row.id}`, 5, 60 * 60_000))) return generic();

    const verifiedIdentity = await env.DB.prepare(
        `SELECT identifier FROM federated_identities
    WHERE account_id=? AND provider='google' AND identifier=? COLLATE NOCASE LIMIT 1`,
    )
        .bind(row.id, identifier)
        .first<{ identifier: string }>();
    if (!verifiedIdentity) return generic();

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    const browserHash = await digest(browserToken);
    const codeHash = await resetCodeHash(row.id, browserHash, code);
    const issuedAt = now(),
        expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString();
    try {
        const saved = await env.DB.prepare(
            `INSERT INTO password_reset_challenges(account_id,code_hash,browser_hash,security_version,attempts,created_at,expires_at,consumed_at)
      SELECT ?,?,?,s.security_version,0,?,?,NULL FROM account_security s WHERE s.account_id=? AND s.security_version=?
      ON CONFLICT(account_id) DO UPDATE SET
      code_hash=excluded.code_hash,browser_hash=excluded.browser_hash,security_version=excluded.security_version,attempts=0,created_at=excluded.created_at,expires_at=excluded.expires_at,consumed_at=NULL`,
        )
            .bind(row.id, codeHash, browserHash, issuedAt, expiresAt, row.id, Number(row.security_version))
            .run();
        if (!saved.meta.changes) return generic();
        const delivered = await sendResetEmail(env, verifiedIdentity.identifier, code, deps.providerFetch);
        if (!delivered) {
            await env.DB.prepare(
                'DELETE FROM password_reset_challenges WHERE account_id=? AND browser_hash=?',
            )
                .bind(row.id, browserHash)
                .run();
            return generic();
        }
    } catch {
        await env.DB.prepare('DELETE FROM password_reset_challenges WHERE account_id=? AND browser_hash=?')
            .bind(row.id, browserHash)
            .run()
            .catch(() => undefined);
        return generic();
    }
    return generic();
}

async function resetPassword(
    request: Request,
    env: AccountRecoveryEnv,
    input: Record<string, unknown>,
    deps: AccountRecoveryDeps,
): Promise<Response> {
    const identifier = normalizeIdentifier(input.identifier);
    const method = input.method;
    const code = str(input.code);
    const newPassword = input.newPassword;
    if (!validPassword(newPassword)) return authError(PASSWORD_ERROR);
    if (!identifier || !['authenticator', 'backup', 'email'].includes(String(method)))
        return authError('Choose a valid recovery method and enter its code.');
    const row = await accountByIdentifier(env, identifier);
    if (!row) return authError('The recovery code is invalid or expired.', 401);
    const expectedVersion = Number(row.security_version);

    let emailChallenge: any = null;
    if (method === 'email') {
        const token = cookie(request, RESET_COOKIE);
        if (!token || !/^\d{6}$/.test(code))
            return authError('The recovery code is invalid or expired.', 401);
        const browserHash = await digest(token);
        emailChallenge = await env.DB.prepare(
            `UPDATE password_reset_challenges SET attempts=attempts+1
      WHERE account_id=? AND browser_hash=? AND security_version=? AND expires_at>? AND consumed_at IS NULL AND attempts<5
      RETURNING code_hash,security_version,attempts,created_at,expires_at`,
        )
            .bind(row.id, browserHash, expectedVersion, now())
            .first<any>();
        const receivedHash = await resetCodeHash(row.id, browserHash, code);
        if (
            !emailChallenge ||
            Number(emailChallenge.security_version) !== expectedVersion ||
            emailChallenge.code_hash !== receivedHash
        )
            return authError('The recovery code is invalid or expired.', 401);
        emailChallenge.browserHash = browserHash;
    } else {
        if (!/^(?:\d{6}|[A-Z2-9\s-]{12,20})$/i.test(code) || !row.totp_enabled)
            return authError('The recovery code is invalid or expired.', 401);
        if (!(await verifyAuthCode(env, row.id, code, expectedVersion)))
            return authError('The recovery code is invalid or expired.', 401);
    }

    const hashed = await deps.passwordHash(newPassword);
    const nextVersion = expectedVersion + 1,
        claim = newId(),
        changedAt = now();
    const statements: D1PreparedStatement[] = [
        env.DB.prepare(
            `UPDATE account_security SET password_set=1,security_version=?,security_claim=?,totp_pending_ciphertext=NULL,
      totp_pending_expires_at=NULL,totp_pending_attempts=0,totp_pending_security_version=NULL,updated_at=?
      WHERE account_id=? AND security_version=? AND (? IS NULL OR EXISTS(
        SELECT 1 FROM password_reset_challenges c WHERE c.account_id=account_security.account_id AND c.browser_hash=?
        AND c.code_hash=? AND c.security_version=? AND c.attempts<=5 AND c.expires_at>? AND c.consumed_at IS NULL
      ))`,
        ).bind(
            nextVersion,
            claim,
            changedAt,
            row.id,
            expectedVersion,
            emailChallenge ? 1 : null,
            emailChallenge?.browserHash ?? null,
            emailChallenge?.code_hash ?? null,
            expectedVersion,
            now(),
        ),
        env.DB.prepare(
            `UPDATE accounts SET password_salt=?,password_hash=? WHERE id=? AND EXISTS(
      SELECT 1 FROM account_security s WHERE s.account_id=accounts.id AND s.security_version=? AND s.security_claim=?
    )`,
        ).bind(hashed.salt, hashed.hash, row.id, nextVersion, claim),
        env.DB.prepare(
            'DELETE FROM sessions WHERE account_id=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=?)',
        ).bind(row.id, row.id, nextVersion, claim),
        env.DB.prepare(
            'DELETE FROM totp_challenges WHERE account_id=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=?)',
        ).bind(row.id, row.id, nextVersion, claim),
        env.DB.prepare(
            'DELETE FROM google_auth_flows WHERE account_id=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=?)',
        ).bind(row.id, row.id, nextVersion, claim),
        env.DB.prepare(
            "DELETE FROM sms_auth_challenges WHERE account_id=? AND state IN ('sending','pending','verified') AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=?)",
        ).bind(row.id, row.id, nextVersion, claim),
        env.DB.prepare(
            'DELETE FROM password_reset_challenges WHERE account_id=? AND EXISTS(SELECT 1 FROM account_security WHERE account_id=? AND security_version=? AND security_claim=?)',
        ).bind(row.id, row.id, nextVersion, claim),
    ];
    const results = await env.DB.batch(statements);
    if (!results[0]?.meta.changes || !results[1]?.meta.changes)
        return authError('Account security changed. Request a new code and retry.', 409);
    const headers = new Headers({ 'Set-Cookie': setCookie(request, '', 0) });
    return authJson({ ok: true }, 200, headers);
}

export async function handleAccountRecovery(
    request: Request,
    env: AccountRecoveryEnv,
    deps: AccountRecoveryDeps,
): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/auth/recovery-options' && request.method === 'GET')
        return authJson(passwordResetOptions(env));
    if (pathname === '/api/auth/authenticator' && request.method === 'POST') {
        const input = await body(request);
        return input
            ? authenticatorLogin(request, env, input, deps)
            : authError('Enter your username/email and authenticator code.');
    }
    if (pathname === '/api/auth/password-reset/request' && request.method === 'POST')
        return requestPasswordReset(request, env, deps);
    if (pathname === '/api/auth/password-reset/confirm' && request.method === 'POST') {
        const input = await body(request);
        return input
            ? resetPassword(request, env, input, deps)
            : authError('Enter your recovery code and new password.');
    }
    return null;
}
