import type { Account } from '../../shared/types';
import { getEmailConfiguration, sendEmail, type EmailEnv } from '../email/email';
import { verificationCodeEmail } from '../email/emailTemplates';
import { authJson } from './authResponse';

export interface EmailSignInEnv extends EmailEnv {
    DB: D1Database;
    TOTP_ENCRYPTION_KEY?: string;
}

export interface EmailSignInDeps {
    createSession(
        request: Request,
        env: EmailSignInEnv,
        accountId: string,
        guard?: {
            securityVersion: number;
            passwordHash?: string;
            emailSignIn?: {
                kind: 'google' | 'native';
                id: string;
                email: string;
                subject?: string;
                identifier: string;
            };
        },
    ): Promise<string>;
    providerFetch?: typeof fetch;
    waitUntil?: (task: Promise<unknown>) => void;
}

const encoder = new TextEncoder();
const COOKIE = 'manhunt_email_signin';
const TTL_MS = 10 * 60_000;
const WINDOW_MS = 15 * 60_000;
const now = (ms = Date.now()) => new Date(ms).toISOString();
const uuid = () => crypto.randomUUID();
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) =>
    hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));

function secret(env: EmailSignInEnv): Uint8Array | null {
    try {
        const value = Uint8Array.from(atob(env.TOTP_ENCRYPTION_KEY || ''), (c) => c.charCodeAt(0));
        return value.length === 32 ? value : null;
    } catch {
        return null;
    }
}

export function emailOtpAvailable(env: EmailSignInEnv): boolean {
    return !!secret(env) && !!getEmailConfiguration(env);
}

async function hmac(env: EmailSignInEnv, value: string): Promise<string | null> {
    const bytes = secret(env);
    if (!bytes) return null;
    try {
        const rawKey = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, [
            'sign',
        ]);
        return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
    } catch {
        return null;
    }
}

function secure(request: Request) {
    return new URL(request.url).protocol === 'https:' ? '; Secure' : '';
}
function cookieHeader(request: Request, binder: string) {
    return `${COOKIE}=${binder}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.ceil(TTL_MS / 1000)}${secure(request)}`;
}
function binderFrom(request: Request): string | null {
    const value = request.headers
        .get('Cookie')
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1);
    return value && /^[A-Za-z0-9_-]{40,50}$/.test(value) ? value : null;
}
function newBinder() {
    return btoa(
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => String.fromCharCode(b)).join(''),
    )
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}
function randomCode(): string {
    const range = 0x1_0000_0000;
    const ceiling = Math.floor(range / 1_000_000) * 1_000_000;
    let randomNumber: number;
    do {
        const bytes = crypto.getRandomValues(new Uint8Array(4));
        randomNumber = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    } while (randomNumber >= ceiling);
    return String(randomNumber % 1_000_000).padStart(6, '0');
}
function equal(a: string, b: string) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
function normalizeEmail(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
function requestIp(request: Request) {
    return (
        request.headers.get('cf-connecting-ip')?.trim() ||
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown'
    );
}
async function countRateLimitAttempt(
    env: EmailSignInEnv,
    name: string,
    limit: number,
    windowMs: number,
): Promise<boolean> {
    const keyHash = await hmac(env, `email-signin-rate:v1:${name}`);
    if (!keyHash) return false;
    const timestamp = Date.now();
    const current = now(timestamp);
    const expiresAt = now(timestamp + windowMs);
    try {
        const row = await env.DB.prepare(
            `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET
      count=CASE WHEN auth_rate_buckets.expires_at<=? THEN 1 ELSE auth_rate_buckets.count+1 END,
      expires_at=CASE WHEN auth_rate_buckets.expires_at<=? THEN excluded.expires_at ELSE auth_rate_buckets.expires_at END
      RETURNING count`,
        )
            .bind(`email-signin:${keyHash}`, expiresAt, current, current)
            .first<{ count: number }>();
        return !!row && row.count <= limit;
    } catch {
        return false;
    }
}

type Identity = {
    account_id: string;
    username: string;
    display_name: string;
    role: Account['role'];
    group_id: string | null;
    security_version: number;
    password_hash: string | null;
    identity_kind: 'google' | 'native';
    identity_id: string;
    identity_subject: string | null;
    identity_identifier: string;
};

async function trustedIdentity(env: EmailSignInEnv, email: string): Promise<Identity | null> {
    const google = await env.DB.prepare(
        `SELECT a.id AS account_id,a.username,a.display_name,a.role,a.group_id,
      COALESCE(s.security_version,0) AS security_version,a.password_hash,
      'google' AS identity_kind,f.id AS identity_id,f.subject AS identity_subject,f.identifier AS identity_identifier
    FROM federated_identities f JOIN accounts a ON a.id=f.account_id
    LEFT JOIN account_security s ON s.account_id=a.id
    WHERE f.provider='google' AND f.identifier=? COLLATE NOCASE ORDER BY f.created_at LIMIT 2`,
    )
        .bind(email)
        .all<Identity>();
    if (google.results.length === 1) return google.results[0];
    if (google.results.length > 1) return null;
    const native = await env.DB.prepare(
        `SELECT DISTINCT a.id AS account_id,a.username,a.display_name,a.role,a.group_id,
      COALESCE(s.security_version,0) AS security_version,a.password_hash,
      'native' AS identity_kind,e.id AS identity_id,NULL AS identity_subject,e.email AS identity_identifier
    FROM accounts a JOIN account_emails e ON e.account_id=a.id
    LEFT JOIN account_security s ON s.account_id=a.id
    WHERE a.registration_username=? COLLATE NOCASE AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL
    LIMIT 2`,
    )
        .bind(email, email)
        .all<Identity>();
    return native.results.length === 1 ? native.results[0] : null;
}

function response(request: Request, binder: string) {
    return authJson({ ok: true, retryAfterSeconds: 60 }, 200, {
        'Set-Cookie': cookieHeader(request, binder),
    });
}

async function start(request: Request, env: EmailSignInEnv, deps: EmailSignInDeps): Promise<Response> {
    if (!emailOtpAvailable(env)) return authJson({ error: 'Email sign-in is unavailable.' }, 503);
    const binder = binderFrom(request) || newBinder();
    const binderHash = await digest(binder);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const email = normalizeEmail(body?.email);
    const ipAllowed = await countRateLimitAttempt(env, `send:ip:${requestIp(request)}`, 15, WINDOW_MS);
    if (!email) return response(request, binder);
    const addressAllowed = await countRateLimitAttempt(env, `send:address:${email}`, 5, WINDOW_MS);
    const identity = await trustedIdentity(env, email).catch(() => null);
    if (!identity || !ipAllowed || !addressAllowed) return response(request, binder);
    const accountAllowed = await countRateLimitAttempt(
        env,
        `send:account:${identity.account_id}`,
        5,
        WINDOW_MS,
    );
    const cooldownAllowed = await countRateLimitAttempt(
        env,
        `send:cooldown:${identity.account_id}:${email}`,
        1,
        60_000,
    );
    if (!accountAllowed || !cooldownAllowed) return response(request, binder);

    const code = randomCode(),
        challengeId = uuid(),
        createdAt = now(),
        expiresAt = now(Date.now() + TTL_MS);
    const codeHash = await hmac(
        env,
        `email-signin-code:v1:${identity.account_id}:${email}:${binderHash}:${challengeId}:${code}`,
    );
    if (!codeHash) return response(request, binder);
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                'DELETE FROM email_signin_challenges WHERE binder_hash=? AND consumed_at IS NULL',
            ).bind(binderHash),
            env.DB.prepare(
                `INSERT INTO email_signin_challenges(id,binder_hash,account_id,email_snapshot,identity_kind,identity_id,identity_subject,identity_identifier,security_version,password_hash_snapshot,code_hash,attempts,created_at,expires_at,consumed_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,0,?,?,NULL
        WHERE EXISTS(SELECT 1 FROM accounts a WHERE a.id=? AND a.username=? COLLATE NOCASE AND a.password_hash IS ?)
          AND COALESCE((SELECT security_version FROM account_security WHERE account_id=?),0)=?
          AND ((?='google' AND EXISTS(SELECT 1 FROM federated_identities f WHERE f.id=? AND f.account_id=? AND f.provider='google' AND f.subject=? AND f.identifier=? COLLATE NOCASE))
            OR (?='native' AND EXISTS(SELECT 1 FROM account_emails e JOIN accounts a ON a.id=e.account_id WHERE e.id=? AND e.account_id=? AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL AND a.registration_username=? COLLATE NOCASE)
              AND NOT EXISTS(SELECT 1 FROM federated_identities f WHERE f.provider='google' AND f.identifier=? COLLATE NOCASE AND f.account_id<>?)))`,
            ).bind(
                challengeId,
                binderHash,
                identity.account_id,
                email,
                identity.identity_kind,
                identity.identity_id,
                identity.identity_subject,
                identity.identity_identifier,
                identity.security_version,
                identity.password_hash,
                codeHash,
                createdAt,
                expiresAt,
                identity.account_id,
                identity.username,
                identity.password_hash,
                identity.account_id,
                identity.security_version,
                identity.identity_kind,
                identity.identity_id,
                identity.account_id,
                identity.identity_subject,
                identity.identity_identifier,
                identity.identity_kind,
                identity.identity_id,
                identity.account_id,
                email,
                email,
                email,
                identity.account_id,
            ),
        ]);
        if (!results[1]?.meta.changes) return response(request, binder);
    } catch {
        return response(request, binder);
    }

    const deliverAndRecheck = async () => {
        const sent = await sendEmail(
            env,
            verificationCodeEmail(email, code, TTL_MS / 60_000),
            deps.providerFetch,
        );
        const stillValid = await env.DB.prepare(
            `SELECT 1 AS active FROM email_signin_challenges c
      JOIN accounts a ON a.id=c.account_id
      WHERE c.id=? AND c.binder_hash=? AND c.consumed_at IS NULL AND c.expires_at>? AND a.password_hash IS c.password_hash_snapshot
        AND COALESCE((SELECT security_version FROM account_security WHERE account_id=c.account_id),0)=c.security_version
        AND ((c.identity_kind='google' AND EXISTS(SELECT 1 FROM federated_identities f WHERE f.id=c.identity_id AND f.account_id=c.account_id AND f.provider='google' AND f.subject=c.identity_subject AND f.identifier=c.identity_identifier COLLATE NOCASE))
          OR (c.identity_kind='native' AND EXISTS(SELECT 1 FROM account_emails e WHERE e.id=c.identity_id AND e.account_id=c.account_id AND e.email=c.email_snapshot COLLATE NOCASE AND e.verified_at IS NOT NULL AND a.registration_username=c.email_snapshot COLLATE NOCASE)
            AND NOT EXISTS(SELECT 1 FROM federated_identities f WHERE f.provider='google' AND f.identifier=c.email_snapshot COLLATE NOCASE AND f.account_id<>c.account_id)))`,
        )
            .bind(challengeId, binderHash, now())
            .first<{ active: number }>()
            .catch(() => null);
        if (!sent || !stillValid) {
            await env.DB.prepare('DELETE FROM email_signin_challenges WHERE id=? AND binder_hash=?')
                .bind(challengeId, binderHash)
                .run()
                .catch(() => undefined);
        }
    };
    if (deps.waitUntil) deps.waitUntil(deliverAndRecheck());
    else await deliverAndRecheck();
    return response(request, binder);
}

type Challenge = Identity & {
    id: string;
    binder_hash: string;
    email_snapshot: string;
    code_hash: string;
    attempts: number;
    expires_at: string;
};

async function verify(request: Request, env: EmailSignInEnv, deps: EmailSignInDeps): Promise<Response> {
    if (!emailOtpAvailable(env)) return authJson({ error: 'Invalid email or code.' }, 401);
    const binder = binderFrom(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const email = normalizeEmail(body?.email),
        code = typeof body?.code === 'string' ? body.code.trim() : '';
    const binderHash = binder ? await digest(binder) : '';
    const addressKey = email || 'invalid';
    const ipAllowed = await countRateLimitAttempt(env, `verify:ip:${requestIp(request)}`, 30, WINDOW_MS);
    const addressAllowed = await countRateLimitAttempt(env, `verify:address:${addressKey}`, 20, WINDOW_MS);
    if (!binder || !email || !ipAllowed || !addressAllowed || !/^\d{6}$/.test(code))
        return authJson({ error: 'Invalid email or code.' }, 401);
    const challenge = await env.DB.prepare(
        `SELECT c.*,a.username,a.display_name,a.role,a.group_id,a.password_hash,
      c.security_version AS security_version,c.identity_kind AS identity_kind,c.identity_id AS identity_id,
      c.identity_subject AS identity_subject,c.identity_identifier AS identity_identifier
    FROM email_signin_challenges c JOIN accounts a ON a.id=c.account_id
    WHERE c.binder_hash=? AND c.email_snapshot=? COLLATE NOCASE AND c.consumed_at IS NULL AND c.expires_at>? AND c.attempts<5
    ORDER BY c.created_at DESC LIMIT 1`,
    )
        .bind(binderHash, email, now())
        .first<Challenge>();
    if (!challenge) return authJson({ error: 'Invalid email or code.' }, 401);
    if (!(await countRateLimitAttempt(env, `verify:account:${challenge.account_id}`, 20, WINDOW_MS)))
        return authJson({ error: 'Invalid email or code.' }, 401);
    const attempt = await env.DB.prepare(
        `UPDATE email_signin_challenges SET attempts=attempts+1
    WHERE id=? AND binder_hash=? AND email_snapshot=? COLLATE NOCASE AND consumed_at IS NULL AND expires_at>? AND attempts<5
    RETURNING attempts,code_hash`,
    )
        .bind(challenge.id, binderHash, email, now())
        .first<{ attempts: number; code_hash: string }>();
    if (!attempt) return authJson({ error: 'Invalid email or code.' }, 401);
    const candidate = await hmac(
        env,
        `email-signin-code:v1:${challenge.account_id}:${email}:${binderHash}:${challenge.id}:${code}`,
    );
    if (!candidate || !equal(candidate, attempt.code_hash))
        return authJson({ error: 'Invalid email or code.' }, 401);

    const consumeAt = now();
    const consumed = await env.DB.prepare(
        `UPDATE email_signin_challenges SET consumed_at=?
    WHERE id=? AND binder_hash=? AND account_id=? AND email_snapshot=? COLLATE NOCASE AND code_hash=? AND attempts<=5 AND consumed_at IS NULL AND expires_at>?
      AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=email_signin_challenges.account_id AND a.password_hash IS email_signin_challenges.password_hash_snapshot)
      AND COALESCE((SELECT security_version FROM account_security WHERE account_id=email_signin_challenges.account_id),0)=email_signin_challenges.security_version
      AND ((identity_kind='google' AND EXISTS(SELECT 1 FROM federated_identities f WHERE f.id=email_signin_challenges.identity_id AND f.account_id=email_signin_challenges.account_id AND f.provider='google' AND f.subject=email_signin_challenges.identity_subject AND f.identifier=email_signin_challenges.identity_identifier COLLATE NOCASE))
        OR (identity_kind='native' AND EXISTS(SELECT 1 FROM account_emails e JOIN accounts a ON a.id=e.account_id WHERE e.id=email_signin_challenges.identity_id AND e.account_id=email_signin_challenges.account_id AND e.email=email_signin_challenges.email_snapshot COLLATE NOCASE AND e.verified_at IS NOT NULL AND a.registration_username=email_signin_challenges.email_snapshot COLLATE NOCASE)
          AND NOT EXISTS(SELECT 1 FROM federated_identities f WHERE f.provider='google' AND f.identifier=email_signin_challenges.email_snapshot COLLATE NOCASE AND f.account_id<>email_signin_challenges.account_id)))`,
    )
        .bind(consumeAt, challenge.id, binderHash, challenge.account_id, email, attempt.code_hash, consumeAt)
        .run()
        .catch(() => null);
    if (!consumed?.meta.changes) return authJson({ error: 'Invalid email or code.' }, 401);
    try {
        const cookie = await deps.createSession(request, env, challenge.account_id, {
            securityVersion: challenge.security_version,
            ...(challenge.password_hash ? { passwordHash: challenge.password_hash } : {}),
            emailSignIn: {
                kind: challenge.identity_kind,
                id: challenge.identity_id,
                email,
                identifier: challenge.identity_identifier,
                ...(challenge.identity_subject ? { subject: challenge.identity_subject } : {}),
            },
        });
        const account: Account = {
            id: challenge.account_id,
            username: challenge.username,
            displayName: challenge.display_name,
            role: challenge.role,
            groupId: challenge.group_id,
        };
        return authJson({ account }, 200, { 'Set-Cookie': cookie });
    } catch {
        return authJson({ error: 'Invalid email or code.' }, 401);
    }
}

export async function handleEmailSignIn(
    request: Request,
    env: EmailSignInEnv,
    deps: EmailSignInDeps,
): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/auth/email/start' && request.method.toUpperCase() === 'POST')
        return start(request, env, deps);
    if (pathname === '/api/auth/email/verify' && request.method.toUpperCase() === 'POST')
        return verify(request, env, deps);
    return null;
}
