import { getEmailConfiguration, sendEmail, type EmailEnv } from '../email/email';
import { verificationCodeEmail } from '../email/emailTemplates';

export interface EmailVerificationEnv extends EmailEnv {
    DB: D1Database;
    TOTP_ENCRYPTION_KEY?: string;
}

export interface EmailVerificationDeps {
    providerFetch?: typeof fetch;
}

export interface VerificationDelivery {
    sent: boolean;
    error?: string;
    retryAfterSeconds?: number;
    expiresAt?: string;
}

const encoder = new TextEncoder();
const CODE_TTL_MS = 10 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const VERIFY_BUDGET_WINDOW_MS = 15 * 60_000;

function timestamp(ms = Date.now()): string {
    return new Date(ms).toISOString();
}

function secretBytes(env: EmailVerificationEnv): Uint8Array | null {
    try {
        const key = env.TOTP_ENCRYPTION_KEY || '';
        const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
        return bytes.length === 32 ? bytes : null;
    } catch {
        return null;
    }
}

export function canVerifyEmail(env: EmailVerificationEnv): boolean {
    return !!secretBytes(env) && !!getEmailConfiguration(env);
}

async function hmac(env: EmailVerificationEnv, value: string): Promise<string | null> {
    const bytes = secretBytes(env);
    if (!bytes) return null;
    try {
        const rawKey = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const input = encoder.encode(value).buffer as ArrayBuffer;
        const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, [
            'sign',
        ]);
        const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
        return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
}

function secureEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function bucketKey(env: EmailVerificationEnv, name: string): Promise<string> {
    const hash = await hmac(env, `email-verification-rate:${name}`);
    return `email-verify:${hash || crypto.randomUUID()}`;
}

async function reserveBucket(
    env: EmailVerificationEnv,
    name: string,
    limit: number,
    windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const at = Date.now(),
        current = timestamp(at),
        expiry = timestamp(at + windowMs);
    const key = await bucketKey(env, name);
    try {
        const row = await env.DB.prepare(
            `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET
        count=CASE WHEN auth_rate_buckets.expires_at<=? THEN 1 ELSE auth_rate_buckets.count+1 END,
        expires_at=CASE WHEN auth_rate_buckets.expires_at<=? THEN excluded.expires_at ELSE auth_rate_buckets.expires_at END
      RETURNING count,expires_at`,
        )
            .bind(key, expiry, current, current)
            .first<{ count: number; expires_at: string }>();
        const retrySecs = Math.max(1, Math.ceil((Date.parse(row?.expires_at || expiry) - at) / 1000));
        return { allowed: !!row && row.count <= limit, retryAfterSeconds: retrySecs };
    } catch {
        return { allowed: false, retryAfterSeconds: 60 };
    }
}

function requestIp(request: Request): string {
    const direct = request.headers.get('cf-connecting-ip')?.trim();
    if (direct) return direct;
    return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

async function reserveSend(
    env: EmailVerificationEnv,
    request: Request,
    accountId: string,
    email: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const dimensions: Array<[string, number, number]> = [
        [`cooldown:${accountId}:${email}`, 1, 60_000],
        [`account:${accountId}`, 5, RATE_WINDOW_MS],
        [`address:${email}`, 5, RATE_WINDOW_MS],
        [`ip:${requestIp(request)}`, 15, RATE_WINDOW_MS],
    ];
    let retrySecs = 1,
        allowed = true;
    for (const [name, limit, window] of dimensions) {
        const reserved = await reserveBucket(env, `send:${name}`, limit, window);
        if (!reserved.allowed) {
            allowed = false;
            retrySecs = Math.max(retrySecs, reserved.retryAfterSeconds);
        }
    }
    return { allowed, retryAfterSeconds: retrySecs };
}

function sixDigitCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    return String(value % 1_000_000).padStart(6, '0');
}

export async function sendVerifyCode(
    env: EmailVerificationEnv,
    request: Request,
    deps: EmailVerificationDeps,
    email: { id: string; accountId: string; address: string },
): Promise<VerificationDelivery> {
    const normalized = email.address.toLowerCase();
    if (!canVerifyEmail(env))
        return {
            sent: false,
            error: 'Email verification is unavailable until server email and encryption settings are configured.',
        };
    const allowed = await reserveSend(env, request, email.accountId, normalized);
    if (!allowed.allowed)
        return {
            sent: false,
            error: 'Please wait before requesting another verification email.',
            retryAfterSeconds: allowed.retryAfterSeconds,
        };

    const challengeId = crypto.randomUUID();
    const code = sixDigitCode();
    const expiresAt = timestamp(Date.now() + CODE_TTL_MS);
    const codeHash = await hmac(
        env,
        `email-verification-code:v1:${email.accountId}:${email.id}:${normalized}:${challengeId}:${code}`,
    );
    if (!codeHash)
        return {
            sent: false,
            error: 'Email verification is unavailable until server encryption is configured.',
        };
    const createdAt = timestamp();
    try {
        const saved = await env.DB.prepare(
            `INSERT INTO email_verification_challenges(email_id,account_id,email_snapshot,challenge_id,code_hash,attempts,created_at,expires_at,consumed_at)
      SELECT ?,?,?,?, ?,0,?,?,NULL FROM account_emails WHERE id=? AND account_id=? AND email=? COLLATE NOCASE AND verified_at IS NULL
      ON CONFLICT(email_id) DO UPDATE SET account_id=excluded.account_id,email_snapshot=excluded.email_snapshot,challenge_id=excluded.challenge_id,code_hash=excluded.code_hash,attempts=0,created_at=excluded.created_at,expires_at=excluded.expires_at,consumed_at=NULL`,
        )
            .bind(
                email.id,
                email.accountId,
                normalized,
                challengeId,
                codeHash,
                createdAt,
                expiresAt,
                email.id,
                email.accountId,
                normalized,
            )
            .run();
        if (!saved.meta.changes)
            return { sent: false, error: 'This contact email changed. Refresh the page and try again.' };
    } catch {
        return { sent: false, error: 'Could not start email verification. Try again shortly.' };
    }

    const delivered = await sendEmail(
        env,
        verificationCodeEmail(normalized, code, CODE_TTL_MS / 60_000),
        deps.providerFetch,
    );

    const current = await env.DB.prepare(
        `SELECT 1 AS active FROM email_verification_challenges c
    JOIN account_emails e ON e.id=c.email_id AND e.account_id=c.account_id
    WHERE c.email_id=? AND c.account_id=? AND c.challenge_id=? AND c.email_snapshot=? AND e.email=? COLLATE NOCASE AND e.verified_at IS NULL AND c.consumed_at IS NULL AND c.expires_at>?`,
    )
        .bind(email.id, email.accountId, challengeId, normalized, normalized, timestamp())
        .first<{ active: number }>();
    if (!current)
        return {
            sent: false,
            error: 'This contact email changed while the message was being sent. Request a new code.',
        };
    if (!delivered)
        return {
            sent: false,
            error: 'Email verification could not be sent. Try again shortly.',
            retryAfterSeconds: 60,
            expiresAt,
        };
    return { sent: true, expiresAt };
}

export async function verifyEmailCode(
    env: EmailVerificationEnv,
    accountId: string,
    emailId: string,
    rawCode: string,
): Promise<{ ok: true } | { ok: false; error: string; code: string; status: number }> {
    const code = rawCode.trim();
    const at = Date.now();
    const budget = await reserveBucket(
        env,
        `attempt-budget:${accountId}:${emailId}`,
        20,
        VERIFY_BUDGET_WINDOW_MS,
    );
    if (!budget.allowed)
        return {
            ok: false,
            error: 'Too many code attempts. Wait before trying again.',
            code: 'verification_attempts_limited',
            status: 429,
        };

    const attempt = await env.DB.prepare(
        `UPDATE email_verification_challenges SET attempts=attempts+1
    WHERE email_id=? AND account_id=? AND consumed_at IS NULL AND expires_at>? AND attempts<5
      AND EXISTS(SELECT 1 FROM account_emails e WHERE e.id=email_verification_challenges.email_id AND e.account_id=? AND e.email=email_verification_challenges.email_snapshot COLLATE NOCASE AND e.verified_at IS NULL)
    RETURNING challenge_id,email_snapshot,code_hash,attempts,expires_at`,
    )
        .bind(emailId, accountId, timestamp(at), accountId)
        .first<{
            challenge_id: string;
            email_snapshot: string;
            code_hash: string;
            attempts: number;
            expires_at: string;
        }>();
    if (!attempt) {
        const exhausted = await env.DB.prepare(
            'SELECT attempts,expires_at,consumed_at FROM email_verification_challenges WHERE email_id=? AND account_id=?',
        )
            .bind(emailId, accountId)
            .first<{ attempts: number; expires_at: string; consumed_at: string | null }>();
        if (
            exhausted &&
            !exhausted.consumed_at &&
            exhausted.expires_at > timestamp(at) &&
            exhausted.attempts >= 5
        )
            return {
                ok: false,
                error: 'Too many incorrect codes. Request a new verification email.',
                code: 'verification_attempts_limited',
                status: 429,
            };
        return {
            ok: false,
            error: 'This verification code has expired or was already used. Request a new code.',
            code: 'verification_code_expired',
            status: 400,
        };
    }
    const validFormat = /^\d{6}$/.test(code);
    const candidate = validFormat
        ? await hmac(
              env,
              `email-verification-code:v1:${accountId}:${emailId}:${attempt.email_snapshot}:${attempt.challenge_id}:${code}`,
          )
        : null;
    if (!candidate || !secureEqual(candidate, attempt.code_hash)) {
        return {
            ok: false,
            error:
                attempt.attempts >= 5
                    ? 'Too many incorrect codes. Request a new verification email.'
                    : 'That verification code is incorrect.',
            code: attempt.attempts >= 5 ? 'verification_attempts_limited' : 'verification_code_invalid',
            status: attempt.attempts >= 5 ? 429 : 401,
        };
    }

    const consumedAt = timestamp();
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                `UPDATE email_verification_challenges SET consumed_at=? WHERE email_id=? AND account_id=? AND challenge_id=? AND consumed_at IS NULL AND attempts<=5 AND expires_at>?`,
            ).bind(consumedAt, emailId, accountId, attempt.challenge_id, consumedAt),
            env.DB.prepare(
                `UPDATE account_emails SET verified_at=? WHERE id=? AND account_id=? AND email=? COLLATE NOCASE AND verified_at IS NULL
        AND EXISTS(SELECT 1 FROM email_verification_challenges c WHERE c.email_id=? AND c.account_id=? AND c.challenge_id=? AND c.consumed_at=? AND c.email_snapshot=? COLLATE NOCASE)`,
            ).bind(
                consumedAt,
                emailId,
                accountId,
                attempt.email_snapshot,
                emailId,
                accountId,
                attempt.challenge_id,
                consumedAt,
                attempt.email_snapshot,
            ),
        ]);
        if (!results[0]?.meta.changes || !results[1]?.meta.changes)
            return {
                ok: false,
                error: 'This verification code is no longer valid. Request a new code.',
                code: 'verification_code_expired',
                status: 400,
            };
        return { ok: true };
    } catch {
        return {
            ok: false,
            error: 'Email verification could not be completed. Try again.',
            code: 'verification_unavailable',
            status: 503,
        };
    }
}
