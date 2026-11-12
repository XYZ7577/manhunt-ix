import type { Account } from '../../shared/types';
import type { ReviewInbox, ReviewNotification } from '../../shared/notifications/review';

interface NotificationEnv {
    DB: D1Database;
}
const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function loadReviewInbox(env: NotificationEnv, account: Account): Promise<ReviewInbox> {
    if (account.role !== 'player' || !account.groupId) return { notifications: [], unreadCount: 0 };
    const [rows, count] = await Promise.all([
        env.DB.prepare(
            `SELECT n.*,r.notification_id AS read_id FROM review_notifications n
      LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.account_id=?
      WHERE n.group_id=? ORDER BY n.id DESC LIMIT 50`,
        )
            .bind(account.id, account.groupId)
            .all<any>(),
        env.DB.prepare(
            `SELECT COUNT(*) AS n FROM review_notifications n WHERE n.group_id=?
      AND NOT EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.account_id=?)`,
        )
            .bind(account.groupId, account.id)
            .first<{ n: number }>(),
    ]);
    const notifications: ReviewNotification[] = rows.results.map((row) => ({
        id: row.id,
        submissionId: row.submission_id,
        taskId: row.task_id,
        status: row.status,
        feedback: row.feedback,
        kind: row.kind,
        createdAt: row.created_at,
        read: row.read_id != null,
    }));
    return { notifications, unreadCount: count?.n ?? 0 };
}

export async function handleReviewNotifications(
    request: Request,
    env: NotificationEnv,
    account: Account,
): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (path !== '/api/notifications' && path !== '/api/notifications/read') return null;
    if (account.role !== 'player' || !account.groupId)
        return json({ notifications: [], unreadCount: 0 } satisfies ReviewInbox);
    if (path === '/api/notifications' && request.method === 'GET') {
        return json(await loadReviewInbox(env, account));
    }
    if (path === '/api/notifications/read' && request.method === 'POST') {
        const body = await request.json<{ through?: unknown; id?: unknown }>().catch(() => null);
        const boundary = body?.through ?? body?.id;
        if (!Number.isSafeInteger(boundary) || Number(boundary) < 1)
            return json({ error: 'Choose an update to mark as read.' }, 400);
        const owned = await env.DB.prepare('SELECT id FROM review_notifications WHERE id=? AND group_id=?')
            .bind(boundary, account.groupId)
            .first();
        if (!owned) return json({ error: 'Update not found.' }, 404);
        const comparison = body?.through !== undefined ? '<=' : '=';
        await env.DB.prepare(
            `INSERT OR IGNORE INTO notification_reads(account_id,notification_id,read_at)
      SELECT ?,n.id,? FROM review_notifications n WHERE n.group_id=? AND n.id${comparison}?`,
        )
            .bind(account.id, new Date().toISOString(), account.groupId, boundary)
            .run();
        return json({ ok: true });
    }
    return json({ error: 'Not found.' }, 404);
}
