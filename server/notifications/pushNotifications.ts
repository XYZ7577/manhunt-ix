import type { Account } from '../../shared/types';
import { getTaskDefinition } from '../../shared/event/tasks';
import { GAME_RESULT_ANNOUNCEMENT_ID } from '../../shared/notifications/announcements';

export interface PushEnv {
    DB: D1Database;
    PUSH_VAPID_PUBLIC_KEY?: string;
    PUSH_VAPID_PRIVATE_KEY?: string;
    PUSH_VAPID_SUBJECT?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const reviewPayload = encoder.encode(
    JSON.stringify({
        title: 'Manhunt IX',
        body: 'There is a new review update. Open Manhunt IX to see it.',
        url: '/home',
        tag: 'review-update',
    }),
);
const testPayload = encoder.encode(
    JSON.stringify({
        title: 'Manhunt IX notifications',
        body: 'Notifications are enabled for this device.',
        url: '/home',
        tag: 'push-test',
    }),
);
const testMessages = new Set(['boop', 'beep', 'hi', 'hiii', 'stop pressing me :(', 'that tickles!']);
const MAX_REQUEST_BYTES = 8192;
const ALLOWED_PUSH_HOSTS = new Set(['fcm.googleapis.com']);
const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

function base64url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}
function unbase64url(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value.');
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
function concat(...arrays: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0));
    let offset = 0;
    for (const item of arrays) {
        result.set(item, offset);
        offset += item.length;
    }
    return result;
}
function bytes(value: string): Uint8Array {
    return encoder.encode(value);
}
export function isSafePushEndpoint(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
        const endpoint = new URL(value);
        return (
            endpoint.protocol === 'https:' &&
            endpoint.username === '' &&
            endpoint.password === '' &&
            endpoint.hash === '' &&
            isPushHost(endpoint.hostname.toLowerCase()) &&
            !endpoint.port
        );
    } catch {
        return false;
    }
}
function isPushHost(host: string) {
    return (
        ALLOWED_PUSH_HOSTS.has(host) ||
        host.endsWith('.push.services.mozilla.com') ||
        host.endsWith('.push.apple.com') ||
        host.endsWith('.notify.windows.com')
    );
}
export function isPushConfigured(env: PushEnv): boolean {
    try {
        return (
            !!env.PUSH_VAPID_PUBLIC_KEY &&
            unbase64url(env.PUSH_VAPID_PUBLIC_KEY).length === 65 &&
            !!env.PUSH_VAPID_PRIVATE_KEY &&
            unbase64url(env.PUSH_VAPID_PRIVATE_KEY).length === 32 &&
            !!env.PUSH_VAPID_SUBJECT &&
            /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S{1,190})$/.test(env.PUSH_VAPID_SUBJECT)
        );
    } catch {
        return false;
    }
}
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > MAX_REQUEST_BYTES) return null;
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_REQUEST_BYTES) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        const parsed = JSON.parse(decoder.decode(data));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    } finally {
        reader.releaseLock();
    }
}

async function allowPushTest(env: PushEnv, accountId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 60_000).toISOString();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(accountId) as BufferSource));
    const key = `push-test:${base64url(digest)}`;
    try {
        const row = await env.DB.prepare(
            `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET
        count=CASE WHEN auth_rate_buckets.expires_at<=? THEN 1 ELSE auth_rate_buckets.count+1 END,
        expires_at=CASE WHEN auth_rate_buckets.expires_at<=? THEN excluded.expires_at ELSE auth_rate_buckets.expires_at END
      RETURNING count`,
        )
            .bind(key, expires, now, now)
            .first<{ count: number }>();
        return !!row && Number(row.count) <= 30;
    } catch {
        return false;
    }
}

async function hmac(keyBytes: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw',
        keyBytes as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, value as BufferSource));
}
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
    let previous = new Uint8Array();
    const blocks: Uint8Array[] = [];
    for (let counter = 1; blocks.reduce((size, part) => size + part.length, 0) < length; counter++) {
        previous = new Uint8Array(await hmac(prk, concat(previous, info, new Uint8Array([counter]))));
        blocks.push(previous);
    }
    return concat(...blocks).slice(0, length);
}

export async function deriveWebPushContentKeys(
    shared: Uint8Array,
    authSecret: Uint8Array,
    userPublic: Uint8Array,
    serverPublic: Uint8Array,
    salt: Uint8Array,
) {
    const authenticationPrk = await hmac(authSecret, shared);
    const keyInfo = concat(bytes('WebPush: info\0'), userPublic, serverPublic);
    const inputKeyMaterial = await hkdfExpand(authenticationPrk, keyInfo, 32);
    const contentPrk = await hmac(salt, inputKeyMaterial);
    return {
        contentKey: await hkdfExpand(contentPrk, bytes('Content-Encoding: aes128gcm\0'), 16),
        nonce: await hkdfExpand(contentPrk, bytes('Content-Encoding: nonce\0'), 12),
    };
}

async function encryptPayload(
    subscription: { p256dh: string; auth: string },
    content: Uint8Array,
): Promise<Uint8Array> {
    const userPublicBytes = unbase64url(subscription.p256dh);
    const authBytes = unbase64url(subscription.auth);
    if (userPublicBytes.length !== 65 || authBytes.length !== 16 || userPublicBytes[0] !== 4)
        throw new Error('Invalid subscription keys.');
    const userPublic = await crypto.subtle.importKey(
        'raw',
        userPublicBytes as BufferSource,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
    );
    const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
    ]);
    const shared = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'ECDH', public: userPublic }, serverKeys.privateKey, 256),
    );
    const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const { contentKey, nonce } = await deriveWebPushContentKeys(
        shared,
        authBytes,
        userPublicBytes,
        serverPublic,
        salt,
    );
    const cleartext = concat(content, new Uint8Array([2]));
    const key = await crypto.subtle.importKey('raw', contentKey as BufferSource, 'AES-GCM', false, [
        'encrypt',
    ]);
    const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce as BufferSource },
            key,
            cleartext as BufferSource,
        ),
    );
    const rs = new Uint8Array([0, 0, 16, 0]);
    return concat(salt, rs, new Uint8Array([serverPublic.length]), serverPublic, encrypted);
}

async function vapidAuthorization(env: PushEnv, endpoint: string): Promise<string> {
    if (!isPushConfigured(env)) throw new Error('Web Push is not configured.');
    const rawPublic = unbase64url(env.PUSH_VAPID_PUBLIC_KEY!);
    const rawPrivate = unbase64url(env.PUSH_VAPID_PRIVATE_KEY!);
    const jwk: JsonWebKey = {
        kty: 'EC',
        crv: 'P-256',
        x: base64url(rawPublic.slice(1, 33)),
        y: base64url(rawPublic.slice(33)),
        d: base64url(rawPrivate),
        ext: true,
        key_ops: ['sign'],
    };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
    ]);
    const audience = new URL(endpoint).origin;
    const head = base64url(bytes(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = base64url(
        bytes(
            JSON.stringify({
                aud: audience,
                exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
                sub: env.PUSH_VAPID_SUBJECT,
            }),
        ),
    );
    const input = `${head}.${claims}`;
    const signature = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(input) as BufferSource),
    );
    return `vapid t=${input}.${base64url(signature)}, k=${env.PUSH_VAPID_PUBLIC_KEY}`;
}

async function sendPush(
    env: PushEnv,
    device: { endpoint: string; p256dh: string; auth: string },
    content = reviewPayload,
    providerFetch: typeof fetch = fetch,
): Promise<'sent' | 'stale' | 'retry'> {
    try {
        const body = await encryptPayload(device, content);
        const pushHost = new URL(device.endpoint).hostname.toLowerCase();
        const response = await providerFetch(device.endpoint, {
            method: 'POST',
            redirect: 'manual',
            signal: AbortSignal.timeout(8000),
            body: body as unknown as BodyInit,
            headers: {
                Authorization: await vapidAuthorization(env, device.endpoint),
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                'TTL': '86400',
                'Urgency': 'normal',
                ...(pushHost.endsWith('.notify.windows.com') ? { 'X-WNS-Type': 'wns/raw' } : {}),
            },
        });
        if (response.status === 200 || response.status === 201 || response.status === 202) return 'sent';
        if (response.status === 404 || response.status === 410) return 'stale';
    } catch {}
    return 'retry';
}

export async function sendAnnouncementPush(
    env: PushEnv,
    device: { endpoint: string; p256dh: string; auth: string },
    announcementId: string,
    providerFetch: typeof fetch = fetch,
    gameResult?: { title: string; message: string } | null,
): Promise<'sent' | 'stale' | 'retry'> {
    if (!isPushConfigured(env) || !isSafePushEndpoint(device.endpoint)) return 'retry';
    const result = announcementId === GAME_RESULT_ANNOUNCEMENT_ID ? gameResult : null;
    const content = encoder.encode(
        JSON.stringify({
            type: 'announcement',
            title: result?.title ?? 'Manhunt IX announcement',
            body: result?.message ?? 'Open Manhunt IX to read the latest announcement.',
            url: '/home',
            tag: result ? announcementId : `announcement-${announcementId.slice(0, 32)}`,
        }),
    );
    return sendPush(env, device, content, providerFetch);
}

export async function sendCaughtPush(
    env: PushEnv,
    device: { endpoint: string; p256dh: string; auth: string },
    eventId: string,
    message: string,
    providerFetch: typeof fetch = fetch,
): Promise<'sent' | 'stale' | 'retry'> {
    if (!isPushConfigured(env) || !isSafePushEndpoint(device.endpoint)) return 'retry';
    const content = encoder.encode(
        JSON.stringify({
            type: 'caught',
            title: 'Manhunt IX',
            body: message.slice(0, 240),
            url: '/home',
            tag: `caught-${eventId.slice(0, 32)}`,
        }),
    );
    return sendPush(env, device, content, providerFetch);
}

export async function processPushDeliveries(env: PushEnv, limit = 20): Promise<void> {
    if (!isPushConfigured(env)) return;
    const now = new Date().toISOString();
    const due = await env.DB.prepare(
        `SELECT d.notification_id,d.subscription_id,d.attempts,p.endpoint,p.p256dh,p.auth
    FROM push_deliveries d JOIN push_subscriptions p ON p.id=d.subscription_id
    JOIN accounts a ON a.id=p.account_id AND a.role='player' AND a.group_id=p.group_id
    JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved'
    WHERE d.delivery_status='pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
      AND (d.locked_until IS NULL OR d.locked_until<=?)
    ORDER BY d.created_at,d.notification_id LIMIT ?`,
    )
        .bind(now, now, Math.min(100, Math.max(1, limit)))
        .all<any>();
    const deadline = Date.now() + 20_000;
    for (let offset = 0; offset < due.results.length && Date.now() < deadline; offset += 10) {
        await Promise.all(
            due.results.slice(offset, offset + 10).map(async (item) => {
                const now = new Date();
                const claim = await env.DB.prepare(
                    `UPDATE push_deliveries SET locked_until=?,attempts=attempts+1
      WHERE notification_id=? AND subscription_id=? AND delivery_status='pending'
      AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (locked_until IS NULL OR locked_until<=?)`,
                )
                    .bind(
                        new Date(now.getTime() + 30_000).toISOString(),
                        item.notification_id,
                        item.subscription_id,
                        now.toISOString(),
                        now.toISOString(),
                    )
                    .run();
                if (!claim.meta.changes) return;
                const attempts = Number(item.attempts) + 1;
                const outcome = await sendPush(env, item);
                if (outcome === 'sent') {
                    await env.DB.prepare(
                        "UPDATE push_deliveries SET delivery_status='sent',delivered_at=?,failed_at=NULL,next_attempt_at=NULL,locked_until=NULL WHERE notification_id=? AND subscription_id=? AND delivery_status='pending'",
                    )
                        .bind(new Date().toISOString(), item.notification_id, item.subscription_id)
                        .run();
                } else if (outcome === 'stale') {
                    await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?')
                        .bind(item.subscription_id)
                        .run();
                } else {
                    if (attempts >= 5) {
                        await env.DB.prepare(
                            "UPDATE push_deliveries SET delivery_status='failed',failed_at=?,next_attempt_at=NULL,locked_until=NULL WHERE notification_id=? AND subscription_id=? AND delivery_status='pending'",
                        )
                            .bind(new Date().toISOString(), item.notification_id, item.subscription_id)
                            .run();
                    } else {
                        const next = new Date(
                            Date.now() + Math.min(6 * 60 * 60_000, 60_000 * 2 ** attempts),
                        ).toISOString();
                        await env.DB.prepare(
                            "UPDATE push_deliveries SET next_attempt_at=?,locked_until=NULL WHERE notification_id=? AND subscription_id=? AND delivery_status='pending'",
                        )
                            .bind(next, item.notification_id, item.subscription_id)
                            .run();
                    }
                }
            }),
        );
    }
}

export async function handlePushNotifications(
    request: Request,
    env: PushEnv,
    account: Account,
): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();
    if (pathname === '/api/push/config' && method === 'GET') {
        return json({
            enabled: isPushConfigured(env),
            publicKey: isPushConfigured(env) ? env.PUSH_VAPID_PUBLIC_KEY : null,
        });
    }
    if (pathname === '/api/push/delivery-status' && method === 'GET') {
        if (account.role !== 'admin') return json({ error: 'Admin access required.' }, 403);
        const counts = await env.DB.prepare(
            `SELECT
      SUM(CASE WHEN delivery_status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN delivery_status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN delivery_status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN delivery_status='unknown' THEN 1 ELSE 0 END) AS unknown
      FROM push_deliveries`,
        ).first<any>();
        const failures = await env.DB.prepare(
            `SELECT d.notification_id,d.attempts,d.failed_at,n.group_id,n.task_id,g.name AS group_name
      FROM push_deliveries d JOIN review_notifications n ON n.id=d.notification_id
      JOIN groups g ON g.id=n.group_id WHERE d.delivery_status='failed'
      ORDER BY d.failed_at DESC,d.notification_id DESC LIMIT 10`,
        ).all<any>();
        return json({
            counts: {
                pending: Number(counts?.pending ?? 0),
                sent: Number(counts?.sent ?? 0),
                failed: Number(counts?.failed ?? 0),
                unknown: Number(counts?.unknown ?? 0),
            },
            recentFailures: failures.results.map((row: any) => ({
                notificationId: Number(row.notification_id),
                groupId: row.group_id,
                groupName: row.group_name,
                taskId: row.task_id,
                taskTitle: getTaskDefinition(row.task_id)?.title ?? 'Task',
                attempts: Number(row.attempts),
                failedAt: row.failed_at,
            })),
        });
    }
    if (pathname !== '/api/push/subscriptions' && pathname !== '/api/push/test') return null;
    if (account.role !== 'player' || !account.groupId)
        return json({ error: 'Push updates are available to players.' }, 403);
    const body = await readBody(request);
    if (!body) return json({ error: 'Invalid push request.' }, 400);
    if (pathname === '/api/push/subscriptions' && method === 'DELETE') {
        const endpoint = body.endpoint;
        if (!isSafePushEndpoint(endpoint)) return json({ error: 'Invalid push endpoint.' }, 400);
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE account_id=? AND endpoint=?')
            .bind(account.id, endpoint)
            .run();
        return json({ ok: true });
    }
    if (!isPushConfigured(env)) return json({ error: 'Push notifications are not configured yet.' }, 503);
    if (pathname === '/api/push/subscriptions' && method === 'POST') {
        const subscription = body.subscription as any;
        const endpoint = subscription?.endpoint;
        const p256dh = subscription?.keys?.p256dh;
        const auth = subscription?.keys?.auth;
        if (!isSafePushEndpoint(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string')
            return json({ error: 'Invalid push subscription.' }, 400);
        try {
            const publicKey = unbase64url(p256dh),
                authKey = unbase64url(auth);
            if (publicKey.length !== 65 || publicKey[0] !== 4 || authKey.length !== 16)
                return json({ error: 'Invalid push subscription keys.' }, 400);
        } catch {
            return json({ error: 'Invalid push subscription keys.' }, 400);
        }
        const cursor = await env.DB.prepare(
            'SELECT COALESCE(MAX(id),0) AS id FROM review_notifications',
        ).first<any>();
        const timestamp = new Date().toISOString();
        await env.DB.prepare(
            `INSERT INTO push_subscriptions(id,account_id,group_id,endpoint,p256dh,auth,last_notification_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET account_id=excluded.account_id,group_id=excluded.group_id,
      p256dh=excluded.p256dh,auth=excluded.auth,last_notification_id=excluded.last_notification_id,updated_at=excluded.updated_at`,
        )
            .bind(
                crypto.randomUUID(),
                account.id,
                account.groupId,
                endpoint,
                p256dh,
                auth,
                cursor?.id ?? 0,
                timestamp,
                timestamp,
            )
            .run();
        return json({ ok: true });
    }
    if (pathname === '/api/push/test' && method === 'POST') {
        const endpoint = body.endpoint;
        if (!isSafePushEndpoint(endpoint)) return json({ error: 'Invalid push endpoint.' }, 400);
        if (
            body.message !== undefined &&
            (typeof body.message !== 'string' || !testMessages.has(body.message))
        )
            return json({ error: 'Choose a valid test message.' }, 400);
        const device = await env.DB.prepare(
            `SELECT p.endpoint,p.p256dh,p.auth FROM push_subscriptions p
      JOIN accounts a ON a.id=p.account_id AND a.role='player' AND a.group_id=p.group_id
      JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved'
      WHERE p.account_id=? AND p.group_id=? AND p.endpoint=?`,
        )
            .bind(account.id, account.groupId, endpoint)
            .first<any>();
        if (!device) return json({ error: 'Push subscription not found.' }, 404);
        if (!(await allowPushTest(env, account.id)))
            return json({ error: 'Too many test notifications. Try again in a minute.' }, 429);
        const payload =
            body.message === undefined
                ? testPayload
                : encoder.encode(
                      JSON.stringify({
                          type: 'push-test',
                          title: 'Manhunt IX notifications',
                          body: body.message,
                          url: '/home',
                          tag: `push-test-${crypto.randomUUID()}`,
                      }),
                  );
        const outcome = await sendPush(env, device, payload);
        if (outcome === 'stale') {
            await env.DB.prepare('DELETE FROM push_subscriptions WHERE account_id=? AND endpoint=?')
                .bind(account.id, endpoint)
                .run();
            return json({ error: 'This device subscription has expired. Enable notifications again.' }, 410);
        }
        if (outcome !== 'sent')
            return json({ error: 'Could not send a test notification. Try again later.' }, 502);
        return json({ ok: true });
    }
    return json({ error: 'Not found.' }, 404);
}
