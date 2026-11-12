import type { Account } from '../../shared/types';
import { getEmailConfiguration, sendEmail, type EmailEnv } from '../email/email';
import { verificationCodeEmail } from '../email/emailTemplates';

export interface GroupDisbandVerificationEnv extends EmailEnv {
    DB: D1Database;
    TOTP_ENCRYPTION_KEY?: string;
}
export interface GroupDisbandVerificationDeps {
    providerFetch?: typeof fetch;
}

const TTL_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;
const WINDOW_MS = 15 * 60_000;
const encoder = new TextEncoder();
const time = (at = Date.now()) => new Date(at).toISOString();
const hex = (value: Uint8Array) => [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function keyBytes(env: GroupDisbandVerificationEnv): Uint8Array | null {
    try {
        const bytes = Uint8Array.from(atob(env.TOTP_ENCRYPTION_KEY || ''), (char) => char.charCodeAt(0));
        return bytes.length === 32 ? bytes : null;
    } catch {
        return null;
    }
}

async function hmac(env: GroupDisbandVerificationEnv, value: string): Promise<string | null> {
    const bytes = keyBytes(env);
    if (!bytes) return null;
    try {
        const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const input = encoder.encode(value).buffer as ArrayBuffer;
        const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
            'sign',
        ]);
        return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, input)));
    } catch {
        return null;
    }
}

function secureEqual(a: string, b: string) {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
}

function emailConfigured(env: GroupDisbandVerificationEnv) {
    return !!keyBytes(env) && !!getEmailConfiguration(env);
}

async function verifiedLeaderEmail(
    env: GroupDisbandVerificationEnv,
    accountId: string,
): Promise<string | null> {
    const contact = await env.DB.prepare(
        `SELECT email FROM account_emails WHERE account_id=? AND verified_at IS NOT NULL
    ORDER BY is_primary DESC,created_at,id LIMIT 1`,
    )
        .bind(accountId)
        .first<{ email: string }>();
    if (contact) return contact.email.toLowerCase();
    const google = await env.DB.prepare(
        `SELECT identifier AS email FROM federated_identities WHERE account_id=? AND provider='google'
    ORDER BY created_at,id LIMIT 1`,
    )
        .bind(accountId)
        .first<{ email: string }>();
    return google?.email.toLowerCase() ?? null;
}

function codeForEmail(email: string) {
    const [local, domain] = email.split('@');
    return `${local.slice(0, 1)}•••@${domain}`;
}

export async function disbandEmailStatus(env: GroupDisbandVerificationEnv, accountId: string) {
    const email = await verifiedLeaderEmail(env, accountId);
    return {
        emailVerificationAvailable: emailConfigured(env) && !!email,
        disbandVerificationEmail: email ? codeForEmail(email) : null,
    };
}

async function rateBucket(env: GroupDisbandVerificationEnv, name: string, limit: number): Promise<boolean> {
    const identity = await hmac(env, `group-disband-rate:v1:${name}`);
    if (!identity) return false;
    const at = Date.now(),
        current = time(at),
        expiry = time(at + WINDOW_MS);
    try {
        const row = await env.DB.prepare(
            `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET count=CASE WHEN auth_rate_buckets.expires_at<=? THEN 1 ELSE auth_rate_buckets.count+1 END,
      expires_at=CASE WHEN auth_rate_buckets.expires_at<=? THEN excluded.expires_at ELSE auth_rate_buckets.expires_at END
      RETURNING count`,
        )
            .bind(`group-disband:${identity}`, expiry, current, current)
            .first<{ count: number }>();
        return !!row && row.count <= limit;
    } catch {
        return false;
    }
}

export async function sendGroupDisbandCode(
    request: Request,
    env: GroupDisbandVerificationEnv,
    deps: GroupDisbandVerificationDeps,
    account: Account,
    groupId: string,
): Promise<Response> {
    const email = await verifiedLeaderEmail(env, account.id);
    if (!email)
        return Response.json(
            { error: 'Add and verify an email address in Settings before disbanding your team.' },
            { status: 403 },
        );
    if (!emailConfigured(env))
        return Response.json(
            { error: 'Email verification is temporarily unavailable. Try again later.' },
            { status: 503 },
        );
    const current = await env.DB.prepare(
        `SELECT g.id FROM groups g JOIN accounts actor ON actor.id=? AND actor.role='player' AND actor.group_id=g.id
    JOIN account_approvals aa ON aa.account_id=actor.id AND aa.status='approved'
    JOIN group_leaders gl ON gl.group_id=g.id AND gl.account_id=actor.id
    WHERE g.id=? AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=g.id)
      AND NOT EXISTS(SELECT 1 FROM group_deletions d WHERE d.group_id=g.id)
      AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=actor.id)
      AND (EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=actor.id AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=actor.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE))`,
    )
        .bind(account.id, groupId, email, email)
        .first();
    if (!current)
        return Response.json(
            { error: 'Only the current group leader can request a disband code.' },
            { status: 403 },
        );

    const previous = await env.DB.prepare(
        'SELECT created_at,expires_at,consumed_at FROM group_disband_challenges WHERE group_id=? AND account_id=?',
    )
        .bind(groupId, account.id)
        .first<{ created_at: string; expires_at: string; consumed_at: string | null }>();
    if (
        previous &&
        !previous.consumed_at &&
        Date.parse(previous.created_at) > Date.now() - COOLDOWN_MS &&
        Date.parse(previous.expires_at) > Date.now()
    ) {
        return Response.json(
            {
                error: 'Please wait before requesting another code.',
                retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((Date.parse(previous.created_at) + COOLDOWN_MS - Date.now()) / 1000),
                ),
            },
            { status: 429 },
        );
    }
    const ip =
        request.headers.get('CF-Connecting-IP')?.trim() ||
        request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
        'unknown';
    if (!(await rateBucket(env, `account:${account.id}`, 5)) || !(await rateBucket(env, `ip:${ip}`, 15))) {
        return Response.json({ error: 'Too many code requests. Wait before trying again.' }, { status: 429 });
    }

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    const challengeId = crypto.randomUUID(),
        createdAt = time(),
        expiresAt = time(Date.now() + TTL_MS);
    const codeHash = await hmac(
        env,
        `group-disband-code:v1:${account.id}:${groupId}:${email}:${challengeId}:${code}`,
    );
    if (!codeHash)
        return Response.json(
            { error: 'Email verification is temporarily unavailable. Try again later.' },
            { status: 503 },
        );
    const cooldownBoundary = time(Date.now() - COOLDOWN_MS);
    try {
        const saved = await env.DB.prepare(
            `INSERT INTO group_disband_challenges(group_id,account_id,email_snapshot,challenge_id,code_hash,attempts,created_at,expires_at,consumed_at)
      SELECT ?,?,?,?, ?,0,?,?,NULL WHERE EXISTS(SELECT 1 FROM accounts actor JOIN account_approvals aa ON aa.account_id=actor.id AND aa.status='approved'
        JOIN group_leaders gl ON gl.group_id=? AND gl.account_id=actor.id
        WHERE actor.id=? AND actor.role='player' AND actor.group_id=? AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=?)
          AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=actor.id)
          AND (EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=actor.id AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL)
            OR EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=actor.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE)))
      ON CONFLICT(group_id) DO UPDATE SET account_id=excluded.account_id,email_snapshot=excluded.email_snapshot,challenge_id=excluded.challenge_id,
        code_hash=excluded.code_hash,attempts=0,created_at=excluded.created_at,expires_at=excluded.expires_at,consumed_at=NULL
      WHERE group_disband_challenges.consumed_at IS NOT NULL OR group_disband_challenges.expires_at<=? OR group_disband_challenges.created_at<=?`,
        )
            .bind(
                groupId,
                account.id,
                email,
                challengeId,
                codeHash,
                createdAt,
                expiresAt,
                groupId,
                account.id,
                groupId,
                groupId,
                email,
                email,
                createdAt,
                cooldownBoundary,
            )
            .run();
        if (!saved.meta.changes) {
            await env.DB.prepare(
                'DELETE FROM group_disband_challenges WHERE group_id=? AND account_id=? AND challenge_id=?',
            )
                .bind(groupId, account.id, challengeId)
                .run()
                .catch(() => undefined);
            return Response.json(
                {
                    error: 'Please wait before requesting another code.',
                    retryAfterSeconds: Math.max(
                        1,
                        Math.ceil(
                            (Date.parse(previous?.created_at ?? createdAt) + COOLDOWN_MS - Date.now()) / 1000,
                        ),
                    ),
                },
                { status: 429 },
            );
        }
    } catch {
        return Response.json(
            { error: 'Could not start email verification. Try again shortly.' },
            { status: 503 },
        );
    }

    const delivered = await sendEmail(
        env,
        verificationCodeEmail(email, code, TTL_MS / 60_000),
        deps.providerFetch,
    );
    const active = await env.DB.prepare(
        `SELECT 1 FROM group_disband_challenges c JOIN accounts actor ON actor.id=c.account_id
    JOIN account_approvals aa ON aa.account_id=actor.id AND aa.status='approved' JOIN group_leaders gl ON gl.group_id=c.group_id AND gl.account_id=actor.id
    WHERE c.group_id=? AND c.account_id=? AND c.challenge_id=? AND c.email_snapshot=? COLLATE NOCASE AND c.consumed_at IS NULL AND c.expires_at>?
      AND actor.group_id=c.group_id AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=c.group_id)
      AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=actor.id)
      AND (EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=actor.id AND e.email=c.email_snapshot COLLATE NOCASE AND e.verified_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=actor.id AND f.provider='google' AND f.identifier=c.email_snapshot COLLATE NOCASE))`,
    )
        .bind(groupId, account.id, challengeId, email, time())
        .first();
    if (!active || !delivered) {
        await env.DB.prepare(
            'DELETE FROM group_disband_challenges WHERE group_id=? AND account_id=? AND challenge_id=?',
        )
            .bind(groupId, account.id, challengeId)
            .run()
            .catch(() => undefined);
        return Response.json(
            {
                error: !active
                    ? 'The group or verified email changed while the code was sent. Request a new code.'
                    : 'Email verification could not be sent. Try again shortly.',
            },
            { status: !active ? 409 : 503 },
        );
    }
    return Response.json(
        { sent: true, expiresAt, email: codeForEmail(email) },
        { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    );
}

export async function verifyGroupDisbandCode(
    env: GroupDisbandVerificationEnv,
    accountId: string,
    groupId: string,
    code: string,
): Promise<{ ok: true; challengeId: string; email: string } | { ok: false; status: number; error: string }> {
    if (!/^\d{6}$/.test(code))
        return { ok: false, status: 400, error: 'Enter the 6-digit email verification code.' };
    if (!(await rateBucket(env, `verify:${accountId}:${groupId}`, 20)))
        return { ok: false, status: 429, error: 'Too many code attempts. Wait before trying again.' };
    const current = await env.DB.prepare(
        `UPDATE group_disband_challenges SET attempts=attempts+1
    WHERE group_id=? AND account_id=? AND consumed_at IS NULL AND expires_at>? AND attempts<5
      AND EXISTS(SELECT 1 FROM accounts actor JOIN account_approvals aa ON aa.account_id=actor.id AND aa.status='approved'
        JOIN group_leaders gl ON gl.group_id=group_disband_challenges.group_id AND gl.account_id=actor.id
        WHERE actor.id=group_disband_challenges.account_id AND actor.role='player' AND actor.group_id=group_disband_challenges.group_id
          AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=group_disband_challenges.group_id)
          AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=actor.id)
          AND (EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=actor.id AND e.email=group_disband_challenges.email_snapshot COLLATE NOCASE AND e.verified_at IS NOT NULL)
            OR EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=actor.id AND f.provider='google' AND f.identifier=group_disband_challenges.email_snapshot COLLATE NOCASE)))
    RETURNING challenge_id,email_snapshot,code_hash,attempts`,
    )
        .bind(groupId, accountId, time())
        .first<{ challenge_id: string; email_snapshot: string; code_hash: string; attempts: number }>();
    if (!current)
        return {
            ok: false,
            status: 400,
            error: 'This email code has expired or was already used. Request a new code.',
        };
    const candidate = await hmac(
        env,
        `group-disband-code:v1:${accountId}:${groupId}:${current.email_snapshot}:${current.challenge_id}:${code}`,
    );
    if (!candidate || !secureEqual(candidate, current.code_hash))
        return {
            ok: false,
            status: current.attempts >= 5 ? 429 : 401,
            error:
                current.attempts >= 5
                    ? 'Too many incorrect codes. Request a new code.'
                    : 'That email verification code is incorrect.',
        };
    return { ok: true, challengeId: current.challenge_id, email: current.email_snapshot };
}

export { secureEqual };
