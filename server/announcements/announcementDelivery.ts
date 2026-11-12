import { GAME_RESULT_ANNOUNCEMENT_ID } from '../../shared/notifications/announcements';
import type { EmailEnv } from '../email/email';
import { getEmailConfiguration, sendEmail } from '../email/email';
import { withEmailFooter } from '../email/emailTemplates';
import { isPushConfigured, sendAnnouncementPush, type PushEnv } from '../notifications/pushNotifications';

export interface AnnouncementDeliveryEnv extends PushEnv, EmailEnv {
    DB: D1Database;
}

export interface AnnouncementDeliveryDeps {
    providerFetch?: typeof fetch;
    pushFetch?: typeof fetch;
    now?: () => string;
    sendPush?: typeof sendAnnouncementPush;
}

type EmailDelivery = {
    announcement_id: string;
    account_id: string;
    email_id: string;
    email: string;
    title: string;
    message: string;
    attempts: number;
    current_email_id: string | null;
    current_email: string | null;
    verified_at: string | null;
    approval_status: string | null;
};

type PushDelivery = {
    announcement_id: string;
    subscription_id: string;
    attempts: number;
    title: string;
    message: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    account_id: string;
    subscription_account_id: string;
    subscription_group_id: string;
    account_group_id: string | null;
    approval_status: string | null;
};

const MAX_ATTEMPTS = 5;
const LEASE_MS = 30_000;
const EMAIL_BATCH_SIZE = 4;
const PUSH_BATCH_SIZE = 10;
const PUSH_BATCH_LIMIT = 20;
const PUSH_DEADLINE_MS = 20_000;
const WORKER_LIMIT = 100;
const stamp = () => new Date().toISOString();

function nextAttempt(attempts: number, now: string): string {
    const delay = Math.min(6 * 60 * 60_000, 60_000 * 2 ** attempts);
    return new Date(Date.parse(now) + delay).toISOString();
}

async function sendAnnouncementEmail(
    env: AnnouncementDeliveryEnv,
    item: EmailDelivery,
    providerFetch: typeof fetch,
): Promise<boolean> {
    const subject = `Manhunt announcement: ${item.title.slice(0, 100)}`;
    const text =
        item.announcement_id === GAME_RESULT_ANNOUNCEMENT_ID
            ? `${item.title}\n${item.message}`
            : withEmailFooter(
                  `${item.title}\n\n${item.message}\n\nSign in to Manhunt IX to see the announcement.`,
              );
    return sendEmail(env, { to: item.email, subject, text }, providerFetch);
}

async function processEmailDeliveries(
    env: AnnouncementDeliveryEnv,
    limit: number,
    deps: AnnouncementDeliveryDeps,
): Promise<void> {
    if (!getEmailConfiguration(env)) return;
    const providerFetch = deps.providerFetch ?? fetch;
    const currentTime = deps.now ?? stamp;
    const now = currentTime();
    const due = await env.DB.prepare(
        `SELECT d.announcement_id,d.account_id,d.email_id,d.email,d.attempts,
      n.title,n.message,e.id AS current_email_id,e.email AS current_email,e.verified_at,aa.status AS approval_status
    FROM announcement_email_deliveries d
    JOIN announcements n ON n.id=d.announcement_id AND n.status='published' AND n.send_email=1
    JOIN announcement_recipients r ON r.announcement_id=d.announcement_id AND r.account_id=d.account_id
    LEFT JOIN accounts a ON a.id=d.account_id
    LEFT JOIN account_approvals aa ON aa.account_id=a.id
    LEFT JOIN account_emails e ON e.id=d.email_id AND e.account_id=d.account_id AND e.email=d.email COLLATE NOCASE
    WHERE d.status IN ('pending','sending') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
      AND (d.locked_until IS NULL OR d.locked_until<=?)
    ORDER BY (n.id=?) DESC,n.published_at,d.announcement_id,d.account_id LIMIT ?`,
    )
        .bind(now, now, GAME_RESULT_ANNOUNCEMENT_ID, Math.min(EMAIL_BATCH_SIZE, limit))
        .all<EmailDelivery>();

    await Promise.all(
        due.results.map(async (item) => {
            const valid =
                item.approval_status === 'approved' &&
                item.current_email_id === item.email_id &&
                item.current_email?.toLowerCase() === item.email.toLowerCase() &&
                item.verified_at !== null;
            if (!valid) {
                await env.DB.prepare(
                    `UPDATE announcement_email_deliveries SET status='cancelled',next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND account_id=?
            AND status IN ('pending','sending') AND (locked_until IS NULL OR locked_until<=?)`,
                )
                    .bind(item.announcement_id, item.account_id, now)
                    .run();
                return;
            }
            if (Number(item.attempts) >= MAX_ATTEMPTS) {
                await env.DB.prepare(
                    `UPDATE announcement_email_deliveries SET status='failed',next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND account_id=?
            AND status IN ('pending','sending') AND attempts>=? AND (locked_until IS NULL OR locked_until<=?)`,
                )
                    .bind(item.announcement_id, item.account_id, MAX_ATTEMPTS, now)
                    .run();
                return;
            }
            const claimTime = currentTime();
            const token = crypto.randomUUID();
            const claimed = await env.DB.prepare(
                `UPDATE announcement_email_deliveries
          SET status='sending',attempts=attempts+1,locked_until=?,lock_token=?,next_attempt_at=NULL
        WHERE announcement_id=? AND account_id=? AND status IN ('pending','sending')
          AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (locked_until IS NULL OR locked_until<=?)
          AND EXISTS(SELECT 1 FROM announcements WHERE id=? AND status='published' AND send_email=1)
          AND EXISTS(SELECT 1 FROM announcement_recipients WHERE announcement_id=? AND account_id=?)
          AND EXISTS(SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
            JOIN account_emails e ON e.account_id=a.id WHERE a.id=? AND aa.status='approved'
            AND e.id=? AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL)`,
            )
                .bind(
                    new Date(Date.parse(claimTime) + LEASE_MS).toISOString(),
                    token,
                    item.announcement_id,
                    item.account_id,
                    claimTime,
                    claimTime,
                    item.announcement_id,
                    item.announcement_id,
                    item.account_id,
                    item.account_id,
                    item.email_id,
                    item.email,
                )
                .run();
            if (!claimed.meta.changes) return;

            const attempt = Number(item.attempts) + 1;
            let delivered = false;
            try {
                delivered = await sendAnnouncementEmail(env, item, providerFetch);
            } catch {}
            const finishedAt = currentTime();
            if (delivered) {
                await env.DB.prepare(
                    `UPDATE announcement_email_deliveries SET status='sent',sent_at=?,next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND account_id=? AND status='sending' AND lock_token=?`,
                )
                    .bind(finishedAt, item.announcement_id, item.account_id, token)
                    .run();
            } else if (attempt >= MAX_ATTEMPTS) {
                await env.DB.prepare(
                    `UPDATE announcement_email_deliveries SET status='failed',next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND account_id=? AND status='sending' AND lock_token=?`,
                )
                    .bind(item.announcement_id, item.account_id, token)
                    .run();
            } else {
                await env.DB.prepare(
                    `UPDATE announcement_email_deliveries SET status='pending',next_attempt_at=?,locked_until=NULL,
            lock_token=NULL WHERE announcement_id=? AND account_id=? AND status='sending' AND lock_token=?`,
                )
                    .bind(nextAttempt(attempt, finishedAt), item.announcement_id, item.account_id, token)
                    .run();
            }
        }),
    );
}

async function processPushDeliveries(
    env: AnnouncementDeliveryEnv,
    limit: number,
    deps: AnnouncementDeliveryDeps,
): Promise<void> {
    if (!isPushConfigured(env)) return;
    const currentTime = deps.now ?? stamp;
    const now = currentTime();
    const due = await env.DB.prepare(
        `SELECT d.announcement_id,d.subscription_id,d.attempts,n.title,n.message,
      p.endpoint,p.p256dh,p.auth,p.account_id AS subscription_account_id,p.group_id AS subscription_group_id,
      a.id AS account_id,a.group_id AS account_group_id,aa.status AS approval_status
    FROM announcement_push_deliveries d
    JOIN announcements n ON n.id=d.announcement_id AND n.status='published'
    JOIN announcement_recipients r ON r.announcement_id=d.announcement_id
      AND r.account_id=(SELECT account_id FROM push_subscriptions WHERE id=d.subscription_id)
    LEFT JOIN push_subscriptions p ON p.id=d.subscription_id
    LEFT JOIN accounts a ON a.id=p.account_id AND a.role='player' AND a.group_id=p.group_id
    LEFT JOIN account_approvals aa ON aa.account_id=a.id
    WHERE d.status IN ('pending','sending') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
      AND (d.locked_until IS NULL OR d.locked_until<=?)
    ORDER BY (n.id=?) DESC,n.published_at,d.announcement_id,d.subscription_id LIMIT ?`,
    )
        .bind(now, now, GAME_RESULT_ANNOUNCEMENT_ID, Math.min(PUSH_BATCH_LIMIT, limit))
        .all<PushDelivery>();

    const push = deps.sendPush ?? sendAnnouncementPush;
    const pushFetch = deps.pushFetch ?? deps.providerFetch ?? fetch;
    const deadline = Date.now() + PUSH_DEADLINE_MS;
    for (let offset = 0; offset < due.results.length && Date.now() < deadline; offset += PUSH_BATCH_SIZE) {
        await Promise.all(
            due.results.slice(offset, offset + PUSH_BATCH_SIZE).map(async (item) => {
                const valid =
                    item.account_id !== null &&
                    item.approval_status === 'approved' &&
                    item.subscription_account_id === item.account_id &&
                    item.account_group_id === item.subscription_group_id;
                if (!valid) {
                    await env.DB.prepare(
                        `UPDATE announcement_push_deliveries SET status='cancelled',next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND subscription_id=?
            AND status IN ('pending','sending') AND (locked_until IS NULL OR locked_until<=?)`,
                    )
                        .bind(item.announcement_id, item.subscription_id, now)
                        .run();
                    return;
                }
                if (Number(item.attempts) >= MAX_ATTEMPTS) {
                    await env.DB.prepare(
                        `UPDATE announcement_push_deliveries SET status='failed',next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND subscription_id=?
            AND status IN ('pending','sending') AND attempts>=? AND (locked_until IS NULL OR locked_until<=?)`,
                    )
                        .bind(item.announcement_id, item.subscription_id, MAX_ATTEMPTS, now)
                        .run();
                    return;
                }
                const claimTime = currentTime();
                if (Date.now() >= deadline) return;
                const token = crypto.randomUUID();
                const claimed = await env.DB.prepare(
                    `UPDATE announcement_push_deliveries
          SET status='sending',attempts=attempts+1,locked_until=?,lock_token=?,next_attempt_at=NULL
        WHERE announcement_id=? AND subscription_id=? AND status IN ('pending','sending')
          AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (locked_until IS NULL OR locked_until<=?)
          AND EXISTS(SELECT 1 FROM announcements WHERE id=? AND status='published')
          AND EXISTS(SELECT 1 FROM announcement_recipients r JOIN push_subscriptions p ON p.account_id=r.account_id
            WHERE r.announcement_id=? AND p.id=?)
          AND EXISTS(SELECT 1 FROM push_subscriptions p JOIN accounts a ON a.id=p.account_id
            JOIN account_approvals aa ON aa.account_id=a.id WHERE p.id=? AND a.role='player'
            AND a.group_id=p.group_id AND aa.status='approved')`,
                )
                    .bind(
                        new Date(Date.parse(claimTime) + LEASE_MS).toISOString(),
                        token,
                        item.announcement_id,
                        item.subscription_id,
                        claimTime,
                        claimTime,
                        item.announcement_id,
                        item.announcement_id,
                        item.subscription_id,
                        item.subscription_id,
                    )
                    .run();
                if (!claimed.meta.changes) return;

                const attempt = Number(item.attempts) + 1;
                let result: 'sent' | 'stale' | 'retry' = 'retry';
                const gameResult =
                    item.announcement_id === GAME_RESULT_ANNOUNCEMENT_ID
                        ? { title: item.title, message: item.message }
                        : null;
                try {
                    result = await push(
                        env,
                        { endpoint: item.endpoint, p256dh: item.p256dh, auth: item.auth },
                        item.announcement_id,
                        pushFetch,
                        gameResult,
                    );
                } catch {}
                const finishedAt = currentTime();
                if (result === 'stale') {
                    await env.DB.prepare(
                        `UPDATE announcement_push_deliveries SET status='cancelled',next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND subscription_id=? AND status='sending' AND lock_token=?`,
                    )
                        .bind(item.announcement_id, item.subscription_id, token)
                        .run();
                    await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?')
                        .bind(item.subscription_id)
                        .run();
                } else if (result === 'sent') {
                    await env.DB.prepare(
                        `UPDATE announcement_push_deliveries SET status='sent',sent_at=?,next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND subscription_id=? AND status='sending' AND lock_token=?`,
                    )
                        .bind(finishedAt, item.announcement_id, item.subscription_id, token)
                        .run();
                } else if (attempt >= MAX_ATTEMPTS) {
                    await env.DB.prepare(
                        `UPDATE announcement_push_deliveries SET status='failed',next_attempt_at=NULL,
            locked_until=NULL,lock_token=NULL WHERE announcement_id=? AND subscription_id=? AND status='sending' AND lock_token=?`,
                    )
                        .bind(item.announcement_id, item.subscription_id, token)
                        .run();
                } else {
                    await env.DB.prepare(
                        `UPDATE announcement_push_deliveries SET status='pending',next_attempt_at=?,locked_until=NULL,
            lock_token=NULL WHERE announcement_id=? AND subscription_id=? AND status='sending' AND lock_token=?`,
                    )
                        .bind(
                            nextAttempt(attempt, finishedAt),
                            item.announcement_id,
                            item.subscription_id,
                            token,
                        )
                        .run();
                }
            }),
        );
    }
}

export async function processAnnouncementDeliveries(
    env: AnnouncementDeliveryEnv,
    limit = 20,
    deps: AnnouncementDeliveryDeps = {},
): Promise<void> {
    const boundedLimit = Math.min(WORKER_LIMIT, Math.max(1, Math.trunc(limit) || 1));
    await Promise.all([
        processEmailDeliveries(env, boundedLimit, deps),
        processPushDeliveries(env, boundedLimit, deps),
    ]);
}
