import type { Account } from '../../shared/types';
import type {
    Announcement,
    AnnouncementDeliveryStatusCounts,
    AnnouncementInbox,
    AnnouncementStatus,
} from '../../shared/notifications/announcements';
import { getEmailConfiguration, type EmailEnv } from '../email/email';
import { isPushConfigured } from '../notifications/pushNotifications';

export interface AnnouncementEnv extends EmailEnv {
    DB: D1Database;
    DEMO_MODE?: string;
    PUSH_VAPID_PUBLIC_KEY?: string;
    PUSH_VAPID_PRIVATE_KEY?: string;
    PUSH_VAPID_SUBJECT?: string;
}

interface AnnouncementRow {
    id: string;
    title: string;
    message: string;
    status: AnnouncementStatus;
    scheduled_for: string;
    created_at: string;
    published_at: string | null;
    cancelled_at: string | null;
    send_email: number;
    recipient_count: number;
    read_at?: string | null;
    email_pending?: number;
    email_sent?: number;
    email_failed?: number;
    email_cancelled?: number;
    push_pending?: number;
    push_sent?: number;
    push_failed?: number;
    push_cancelled?: number;
}

const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const now = () => new Date().toISOString();
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SCHEDULE_MS = 365 * 24 * 60 * 60 * 1000;

function shapeAnnouncement(row: AnnouncementRow): Announcement {
    return {
        id: row.id,
        title: row.title,
        message: row.message,
        status: row.status,
        scheduledFor: row.scheduled_for,
        createdAt: row.created_at,
        publishedAt: row.published_at,
        cancelledAt: row.cancelled_at,
        sendEmail: row.send_email === 1,
        recipientCount: Number(row.recipient_count),
    };
}

function deliveryCounts(row: AnnouncementRow) {
    const channelCounts = (prefix: 'email' | 'push'): AnnouncementDeliveryStatusCounts => ({
        pending: Number(row[`${prefix}_pending` as 'email_pending' | 'push_pending'] ?? 0),
        sent: Number(row[`${prefix}_sent` as 'email_sent' | 'push_sent'] ?? 0),
        failed: Number(row[`${prefix}_failed` as 'email_failed' | 'push_failed'] ?? 0),
        cancelled: Number(row[`${prefix}_cancelled` as 'email_cancelled' | 'push_cancelled'] ?? 0),
    });
    return { email: channelCounts('email'), push: channelCounts('push') };
}

const announcementSql = `SELECT a.id,a.title,a.message,a.status,a.scheduled_for,a.created_at,a.published_at,a.cancelled_at,a.send_email,a.recipient_count,
  (SELECT COUNT(*) FROM announcement_email_deliveries d WHERE d.announcement_id=a.id AND d.status='pending') AS email_pending,
  (SELECT COUNT(*) FROM announcement_email_deliveries d WHERE d.announcement_id=a.id AND d.status='sent') AS email_sent,
  (SELECT COUNT(*) FROM announcement_email_deliveries d WHERE d.announcement_id=a.id AND d.status='failed') AS email_failed,
  (SELECT COUNT(*) FROM announcement_email_deliveries d WHERE d.announcement_id=a.id AND d.status='cancelled') AS email_cancelled,
  (SELECT COUNT(*) FROM announcement_push_deliveries d WHERE d.announcement_id=a.id AND d.status='pending') AS push_pending,
  (SELECT COUNT(*) FROM announcement_push_deliveries d WHERE d.announcement_id=a.id AND d.status='sent') AS push_sent,
  (SELECT COUNT(*) FROM announcement_push_deliveries d WHERE d.announcement_id=a.id AND d.status='failed') AS push_failed,
  (SELECT COUNT(*) FROM announcement_push_deliveries d WHERE d.announcement_id=a.id AND d.status='cancelled') AS push_cancelled
  FROM announcements a`;

async function requestJson(request: Request): Promise<Record<string, unknown> | null> {
    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > MAX_BODY_BYTES || !request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    } finally {
        reader.releaseLock();
    }
}

function scheduledTime(value: unknown, current: string): string | null {
    if (value === undefined || value === null || value === '') return current;
    if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
    const milliseconds = Date.parse(value);
    const nowMs = Date.parse(current);
    if (!Number.isFinite(milliseconds) || milliseconds <= nowMs || milliseconds > nowMs + MAX_SCHEDULE_MS)
        return null;
    return new Date(milliseconds).toISOString();
}

async function approvedAccount(db: D1Database, account: Account) {
    const row = await db
        .prepare(
            `SELECT a.role,aa.status FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=?`,
        )
        .bind(account.id)
        .first<{ role: string; status: string }>();
    return row?.status === 'approved' ? row.role : null;
}

async function approvedAdmin(db: D1Database, account: Account): Promise<boolean> {
    return (await approvedAccount(db, account)) === 'admin';
}

export async function loadAnnounceInbox(env: AnnouncementEnv, account: Account): Promise<AnnouncementInbox> {
    const [rows, count] = await Promise.all([
        env.DB.prepare(
            `SELECT a.*,r.read_at FROM announcement_recipients r JOIN announcements a ON a.id=r.announcement_id
      WHERE r.account_id=? AND a.status='published' ORDER BY a.published_at DESC,a.id DESC LIMIT 50`,
        )
            .bind(account.id)
            .all<AnnouncementRow>(),
        env.DB.prepare(
            `SELECT COUNT(*) AS n FROM announcement_recipients r JOIN announcements a ON a.id=r.announcement_id
      WHERE r.account_id=? AND r.read_at IS NULL AND a.status='published'`,
        )
            .bind(account.id)
            .first<{ n: number }>(),
    ]);
    return {
        announcements: (rows.results ?? []).map((row) => ({
            ...shapeAnnouncement(row),
            read: row.read_at !== null,
        })),
        unreadCount: Number(count?.n ?? 0),
    };
}

async function publishAnnouncement(
    env: AnnouncementEnv,
    announcementId: string,
    publishedAt = now(),
): Promise<boolean> {
    const token = crypto.randomUUID();
    const result = await env.DB.batch([
        env.DB.prepare(
            `UPDATE announcements SET status='published',published_at=?,publication_token=? WHERE id=?
        AND status='scheduled' AND scheduled_for<=? AND EXISTS (
          SELECT 1 FROM accounts owner JOIN account_approvals approval ON approval.account_id=owner.id
          WHERE owner.id=announcements.created_by AND owner.role='admin' AND approval.status='approved')`,
        ).bind(publishedAt, token, announcementId, publishedAt),
        ...announcementRecipientStatements(env, announcementId, token),
    ]);
    return Boolean(result[0]?.meta.changes);
}

export function announcementRecipientStatements(
    env: Pick<AnnouncementEnv, 'DB' | 'DEMO_MODE'>,
    announcementId: string,
    token: string,
): D1PreparedStatement[] {
    const eligibleAudience = `a.role IN ('admin','player') AND aa.status='approved'${env.DEMO_MODE === 'true' ? '' : " AND a.id NOT LIKE 'demo-account-%'"}`;
    return [
        env.DB.prepare(
            `INSERT OR IGNORE INTO announcement_recipients(announcement_id,account_id)
        SELECT ?,a.id FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
        JOIN announcements n ON n.id=? AND n.status='published' AND n.publication_token=?
        WHERE ${eligibleAudience}`,
        ).bind(announcementId, announcementId, token),
        env.DB.prepare(
            `UPDATE announcements SET recipient_count=(SELECT COUNT(*) FROM announcement_recipients WHERE announcement_id=?),publication_token=NULL
        WHERE id=? AND status='published' AND publication_token=?`,
        ).bind(announcementId, announcementId, token),
    ];
}

export async function processDueAnnouncements(env: AnnouncementEnv, limit = 25): Promise<void> {
    const current = now();
    const due = await env.DB.prepare(
        `SELECT id FROM announcements WHERE status='scheduled' AND scheduled_for<=?
    ORDER BY scheduled_for,id LIMIT ?`,
    )
        .bind(current, Math.min(100, Math.max(1, Math.floor(limit))))
        .all<{ id: string }>();
    for (const item of due.results ?? []) {
        const publishedAt = now();
        const published = await publishAnnouncement(env, item.id, publishedAt);
        if (!published) {
            await env.DB.prepare(
                `UPDATE announcements SET status='cancelled',cancelled_at=? WHERE id=?
        AND status='scheduled' AND scheduled_for<=? AND NOT EXISTS (
          SELECT 1 FROM accounts owner JOIN account_approvals approval ON approval.account_id=owner.id
          WHERE owner.id=announcements.created_by AND owner.role='admin' AND approval.status='approved')`,
            )
                .bind(publishedAt, item.id, publishedAt)
                .run();
        }
    }
}

export async function handleAnnouncements(
    request: Request,
    env: AnnouncementEnv,
    account: Account,
): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (pathname === '/api/admin/announcements') {
        if (method !== 'GET' && method !== 'POST') return json({ error: 'Not found.' }, 404);
        if (!(await approvedAdmin(env.DB, account)))
            return json({ error: 'Approved administrator access required.' }, 403);
        if (method === 'GET') {
            const rows = await env.DB.prepare(
                `${announcementSql} ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
        CASE WHEN status='scheduled' THEN scheduled_for END ASC,
        CASE WHEN status!='scheduled' THEN created_at END DESC,a.id DESC LIMIT 100`,
            ).all<AnnouncementRow>();
            return json({
                announcements: (rows.results ?? []).map((row) => ({
                    ...shapeAnnouncement(row),
                    delivery: deliveryCounts(row),
                })),
                emailEnabled: Boolean(getEmailConfiguration(env)),
                pushEnabled: isPushConfigured(env),
            });
        }

        const body = await requestJson(request);
        if (!body) return json({ error: 'Enter a title and announcement message.' }, 400);
        if (
            typeof body.title !== 'string' ||
            !body.title.trim() ||
            body.title.trim().length > MAX_TITLE_LENGTH
        ) {
            return json({ error: 'Enter a title of 1 to 120 characters.' }, 400);
        }
        if (
            typeof body.message !== 'string' ||
            !body.message.trim() ||
            body.message.trim().length > MAX_MESSAGE_LENGTH
        ) {
            return json({ error: 'Enter a message of 1 to 4,000 characters.' }, 400);
        }
        if (body.sendEmail !== undefined && typeof body.sendEmail !== 'boolean')
            return json({ error: 'Choose whether to email this announcement.' }, 400);
        const timestamp = now();
        const scheduledFor = scheduledTime(body.scheduledFor, timestamp);
        if (!scheduledFor)
            return json(
                {
                    error: 'Choose a future time within the next year, including its time zone, or send the announcement now.',
                },
                400,
            );
        const row: AnnouncementRow = {
            id: crypto.randomUUID(),
            title: body.title.trim(),
            message: body.message.trim(),
            status: 'scheduled',
            scheduled_for: scheduledFor,
            created_at: timestamp,
            published_at: null,
            cancelled_at: null,
            send_email: body.sendEmail === false ? 0 : 1,
            recipient_count: 0,
        };
        await env.DB.prepare(
            `INSERT INTO announcements(id,title,message,created_by,created_at,scheduled_for,status,send_email)
      VALUES(?,?,?,?,?,?,'scheduled',?)`,
        )
            .bind(row.id, row.title, row.message, account.id, timestamp, scheduledFor, row.send_email)
            .run();
        if (scheduledFor <= now()) await publishAnnouncement(env, row.id);
        const saved = await env.DB.prepare(`${announcementSql} WHERE a.id=?`)
            .bind(row.id)
            .first<AnnouncementRow>();
        return json(
            {
                announcement: saved
                    ? { ...shapeAnnouncement(saved), delivery: deliveryCounts(saved) }
                    : shapeAnnouncement(row),
            },
            201,
        );
    }

    if (pathname === '/api/admin/announcements/' || pathname.startsWith('/api/admin/announcements/')) {
        const match = pathname.match(/^\/api\/admin\/announcements\/([^/]+)\/cancel$/);
        if (!match) return json({ error: 'Not found.' }, 404);
        if (method !== 'POST') return json({ error: 'Not found.' }, 404);
        if (!(await approvedAdmin(env.DB, account)))
            return json({ error: 'Approved administrator access required.' }, 403);
        const id = decodeURIComponent(match[1]);
        const cancelledAt = now();
        const result = await env.DB.prepare(
            `UPDATE announcements SET status='cancelled',cancelled_at=?
      WHERE id=? AND status='scheduled'`,
        )
            .bind(cancelledAt, id)
            .run();
        if (!result.meta.changes) {
            const exists = await env.DB.prepare('SELECT status FROM announcements WHERE id=?')
                .bind(id)
                .first<{ status: string }>();
            return exists
                ? json({ error: 'This announcement can no longer be cancelled.' }, 409)
                : json({ error: 'Announcement not found.' }, 404);
        }
        const row = await env.DB.prepare(`${announcementSql} WHERE a.id=?`).bind(id).first<AnnouncementRow>();
        return row
            ? json({ announcement: { ...shapeAnnouncement(row), delivery: deliveryCounts(row) } })
            : json({ error: 'Announcement not found.' }, 404);
    }

    if (pathname === '/api/announcements') {
        if (method !== 'GET') return json({ error: 'Not found.' }, 404);
        if ((await approvedAccount(env.DB, account)) === null)
            return json({ error: 'Approved account access required.' }, 403);
        return json(await loadAnnounceInbox(env, account));
    }
    if (pathname === '/api/announcements/read') {
        if (method !== 'POST') return json({ error: 'Not found.' }, 404);
        if ((await approvedAccount(env.DB, account)) === null)
            return json({ error: 'Approved account access required.' }, 403);
        const body = await requestJson(request);
        if (typeof body?.through !== 'string' || !body.through.trim() || body.through.length > 80) {
            return json({ error: 'Choose an announcement through which to mark updates as read.' }, 400);
        }
        const boundary = body.through.trim();
        const owned = await env.DB.prepare(
            `SELECT a.published_at,a.id FROM announcements a
      JOIN announcement_recipients r ON r.announcement_id=a.id AND r.account_id=?
      WHERE a.id=? AND a.status='published'`,
        )
            .bind(account.id, boundary)
            .first<{ published_at: string; id: string }>();
        if (!owned) return json({ error: 'Announcement not found.' }, 404);
        const readAt = now();
        await env.DB.prepare(
            `UPDATE announcement_recipients AS r SET read_at=?
      WHERE r.account_id=? AND r.read_at IS NULL AND EXISTS(
        SELECT 1 FROM announcements a JOIN announcements target ON target.id=? AND target.status='published'
        WHERE a.id=r.announcement_id AND a.status='published'
          AND (a.published_at<target.published_at OR (a.published_at=target.published_at AND a.id<=target.id)))`,
        )
            .bind(readAt, account.id, boundary)
            .run();
        return json({ ok: true });
    }
    const readMatch = pathname.match(/^\/api\/announcements\/([^/]+)\/read$/);
    if (readMatch) {
        if (method !== 'POST') return json({ error: 'Not found.' }, 404);
        if ((await approvedAccount(env.DB, account)) === null)
            return json({ error: 'Approved account access required.' }, 403);
        const id = decodeURIComponent(readMatch[1]);
        const result = await env.DB.prepare(
            `UPDATE announcement_recipients SET read_at=?
      WHERE announcement_id=? AND account_id=? AND read_at IS NULL
      AND EXISTS(SELECT 1 FROM announcements WHERE id=? AND status='published')`,
        )
            .bind(now(), id, account.id, id)
            .run();
        if (!result.meta.changes) {
            const owned = await env.DB.prepare(
                `SELECT 1 FROM announcement_recipients r JOIN announcements a ON a.id=r.announcement_id
        WHERE r.announcement_id=? AND r.account_id=? AND a.status='published'`,
            )
                .bind(id, account.id)
                .first();
            return owned ? json({ ok: true }) : json({ error: 'Announcement not found.' }, 404);
        }
        return json({ ok: true });
    }
    return null;
}
