import type { EmailEnv } from '../email/email';
import { getEmailConfiguration, sendEmail } from '../email/email';
import { withEmailFooter } from '../email/emailTemplates';
import { isPushConfigured, isSafePushEndpoint, sendCaughtPush, type PushEnv } from './pushNotifications';

export interface CaughtNotificationEnv extends PushEnv, EmailEnv {
    DB: D1Database;
}
export interface CaughtNotificationDeps {
    now?: () => string;
    providerFetch?: typeof fetch;
    pushFetch?: typeof fetch;
    sendPush?: typeof sendCaughtPush;
}

const MAX_ATTEMPTS = 5;
const LEASE_MS = 30_000;
const BATCH_SIZE = 10;
const stamp = () => new Date().toISOString();

export function caughtNotificationStatements(
    env: CaughtNotificationEnv,
    caught: { eventId: string; accountId: string; message: string; createdAt: string },
): D1PreparedStatement[] {
    const { eventId, accountId, message, createdAt } = caught;
    const event = env.DB.prepare(
        `INSERT OR IGNORE INTO caught_notification_events(event_id,account_id,message,created_at)
    SELECT ?,s.account_id,?,? FROM game_player_states s
    JOIN accounts a ON a.id=s.account_id AND a.role='player'
    JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved'
    WHERE s.account_id=? AND s.dead=1 AND s.caught_at=? AND s.catch_event_id=?`,
    ).bind(eventId, message, createdAt, accountId, createdAt, eventId);
    const email = env.DB.prepare(
        `INSERT OR IGNORE INTO caught_email_deliveries(event_id,account_id,email_id,email)
    SELECT e.event_id,e.account_id,preferred.id,preferred.email FROM caught_notification_events e
    JOIN accounts a ON a.id=e.account_id AND a.role='player'
    JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved'
    JOIN account_emails preferred ON preferred.account_id=a.id AND preferred.verified_at IS NOT NULL
      AND preferred.id=(SELECT e2.id FROM account_emails e2 WHERE e2.account_id=a.id AND e2.verified_at IS NOT NULL
        ORDER BY e2.is_primary DESC,e2.created_at,e2.id LIMIT 1)
    WHERE e.event_id=?`,
    ).bind(eventId);
    const push = env.DB.prepare(
        `INSERT OR IGNORE INTO caught_push_deliveries(event_id,subscription_id)
    SELECT e.event_id,p.id FROM caught_notification_events e
    JOIN accounts a ON a.id=e.account_id AND a.role='player'
    JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved'
    JOIN push_subscriptions p ON p.account_id=a.id AND p.group_id=a.group_id
    WHERE e.event_id=?`,
    ).bind(eventId);
    return [event, email, push];
}

type EmailRow = {
    event_id: string;
    account_id: string;
    email_id: string;
    email: string;
    message: string;
    attempts: number;
    current_email_id: string | null;
    current_email: string | null;
    verified_at: string | null;
    approval_status: string | null;
};
type PushRow = {
    event_id: string;
    account_id: string;
    subscription_id: string;
    message: string;
    attempts: number;
    endpoint: string;
    p256dh: string;
    auth: string;
    owner_id: string | null;
    subscription_account_id: string | null;
    subscription_group_id: string | null;
    account_group_id: string | null;
    approval_status: string | null;
};

async function sendCaughtEmails(env: CaughtNotificationEnv, limit: number, deps: CaughtNotificationDeps) {
    if (!getEmailConfiguration(env)) return;
    const currentTime = deps.now ?? stamp;
    const now = currentTime();
    const due = await env.DB.prepare(
        `SELECT d.event_id,d.account_id,d.email_id,d.email,d.attempts,e.message,
      current.id AS current_email_id,current.email AS current_email,current.verified_at,aa.status AS approval_status
    FROM caught_email_deliveries d JOIN caught_notification_events e ON e.event_id=d.event_id
    LEFT JOIN accounts a ON a.id=d.account_id AND a.role='player'
    LEFT JOIN account_approvals aa ON aa.account_id=a.id
    LEFT JOIN account_emails current ON current.id=d.email_id AND current.account_id=d.account_id
      AND current.email=d.email COLLATE NOCASE AND current.verified_at IS NOT NULL
    WHERE d.status IN ('pending','sending') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
      AND (d.locked_until IS NULL OR d.locked_until<=?) ORDER BY e.created_at,d.event_id LIMIT ?`,
    )
        .bind(now, now, limit)
        .all<EmailRow>();
    const providerFetch = deps.providerFetch ?? fetch;
    await Promise.all(
        due.results.map(async (item) => {
            if (
                item.approval_status !== 'approved' ||
                !item.current_email_id ||
                item.current_email_id !== item.email_id ||
                item.current_email?.toLowerCase() !== item.email.toLowerCase() ||
                item.verified_at === null
            ) {
                await env.DB.prepare(
                    `UPDATE caught_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE event_id=? AND account_id=? AND status IN ('pending','sending') AND (locked_until IS NULL OR locked_until<=?)`,
                )
                    .bind(item.event_id, item.account_id, now)
                    .run();
                return;
            }
            if (Number(item.attempts) >= MAX_ATTEMPTS) {
                await env.DB.prepare(
                    `UPDATE caught_email_deliveries SET status='failed',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE event_id=? AND account_id=? AND status IN ('pending','sending') AND attempts>=?
          AND (locked_until IS NULL OR locked_until<=?)`,
                )
                    .bind(item.event_id, item.account_id, MAX_ATTEMPTS, now)
                    .run();
                return;
            }
            const token = crypto.randomUUID();
            const claimTime = currentTime();
            const claim = await env.DB.prepare(
                `UPDATE caught_email_deliveries SET status='sending',attempts=attempts+1,
        locked_until=?,lock_token=?,next_attempt_at=NULL
      WHERE event_id=? AND account_id=? AND status IN ('pending','sending')
        AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (locked_until IS NULL OR locked_until<=?)
        AND EXISTS(SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
          JOIN account_emails e ON e.account_id=a.id WHERE a.id=caught_email_deliveries.account_id
          AND a.role='player' AND aa.status='approved' AND e.id=caught_email_deliveries.email_id
          AND e.email=caught_email_deliveries.email COLLATE NOCASE AND e.verified_at IS NOT NULL)`,
            )
                .bind(
                    new Date(Date.parse(claimTime) + LEASE_MS).toISOString(),
                    token,
                    item.event_id,
                    item.account_id,
                    claimTime,
                    claimTime,
                )
                .run();
            if (!claim.meta.changes) return;
            let delivered = false;
            try {
                delivered = await sendEmail(
                    env,
                    {
                        to: item.email,
                        subject: 'Manhunt IX: you have been caught',
                        text: withEmailFooter(
                            `${item.message}\n\nSign in to Manhunt IX to check your game status and revive options.`,
                        ),
                    },
                    providerFetch,
                );
            } catch {}
            const attempt = Number(item.attempts) + 1;
            const guard = "WHERE event_id=? AND account_id=? AND status='sending' AND lock_token=?";
            if (delivered) {
                await env.DB.prepare(
                    `UPDATE caught_email_deliveries SET status='sent',sent_at=?,locked_until=NULL,lock_token=NULL ${guard}`,
                )
                    .bind(currentTime(), item.event_id, item.account_id, token)
                    .run();
            } else if (attempt >= MAX_ATTEMPTS) {
                await env.DB.prepare(
                    `UPDATE caught_email_deliveries SET status='failed',locked_until=NULL,lock_token=NULL ${guard}`,
                )
                    .bind(item.event_id, item.account_id, token)
                    .run();
            } else {
                await env.DB.prepare(
                    `UPDATE caught_email_deliveries SET status='pending',next_attempt_at=?,locked_until=NULL,lock_token=NULL ${guard}`,
                )
                    .bind(
                        new Date(
                            Date.parse(currentTime()) + Math.min(6 * 60 * 60_000, 60_000 * 2 ** attempt),
                        ).toISOString(),
                        item.event_id,
                        item.account_id,
                        token,
                    )
                    .run();
            }
        }),
    );
}

async function sendCaughtPushes(env: CaughtNotificationEnv, limit: number, deps: CaughtNotificationDeps) {
    if (!isPushConfigured(env)) return;
    const currentTime = deps.now ?? stamp;
    const now = currentTime();
    const due = await env.DB.prepare(
        `SELECT d.event_id,d.subscription_id,d.attempts,e.account_id,e.message,
      p.endpoint,p.p256dh,p.auth,p.account_id AS subscription_account_id,p.group_id AS subscription_group_id,
      a.id AS owner_id,a.group_id AS account_group_id,aa.status AS approval_status
    FROM caught_push_deliveries d JOIN caught_notification_events e ON e.event_id=d.event_id
    LEFT JOIN push_subscriptions p ON p.id=d.subscription_id
    LEFT JOIN accounts a ON a.id=e.account_id AND a.role='player'
    LEFT JOIN account_approvals aa ON aa.account_id=a.id
    WHERE d.status IN ('pending','sending') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
      AND (d.locked_until IS NULL OR d.locked_until<=?) ORDER BY e.created_at,d.event_id LIMIT ?`,
    )
        .bind(now, now, limit)
        .all<PushRow>();
    const send = deps.sendPush ?? sendCaughtPush;
    const providerFetch = deps.pushFetch ?? fetch;
    await Promise.all(
        due.results.map(async (item) => {
            const valid =
                item.approval_status === 'approved' &&
                item.owner_id === item.account_id &&
                item.subscription_account_id === item.account_id &&
                item.subscription_group_id === item.account_group_id &&
                isSafePushEndpoint(item.endpoint);
            if (!valid) {
                await env.DB.prepare(
                    `UPDATE caught_push_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE event_id=? AND subscription_id=? AND status IN ('pending','sending') AND (locked_until IS NULL OR locked_until<=?)`,
                )
                    .bind(item.event_id, item.subscription_id, now)
                    .run();
                return;
            }
            if (Number(item.attempts) >= MAX_ATTEMPTS) {
                await env.DB.prepare(
                    `UPDATE caught_push_deliveries SET status='failed',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
        WHERE event_id=? AND subscription_id=? AND status IN ('pending','sending') AND attempts>=?
          AND (locked_until IS NULL OR locked_until<=?)`,
                )
                    .bind(item.event_id, item.subscription_id, MAX_ATTEMPTS, now)
                    .run();
                return;
            }
            const token = crypto.randomUUID();
            const claimTime = currentTime();
            const claim = await env.DB.prepare(
                `UPDATE caught_push_deliveries SET status='sending',attempts=attempts+1,
        locked_until=?,lock_token=?,next_attempt_at=NULL
      WHERE event_id=? AND subscription_id=? AND status IN ('pending','sending')
        AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (locked_until IS NULL OR locked_until<=?)
        AND EXISTS(SELECT 1 FROM push_subscriptions p JOIN accounts a ON a.id=p.account_id
          JOIN account_approvals aa ON aa.account_id=a.id WHERE p.id=caught_push_deliveries.subscription_id
          AND a.id=? AND a.role='player' AND p.group_id=a.group_id AND aa.status='approved')`,
            )
                .bind(
                    new Date(Date.parse(claimTime) + LEASE_MS).toISOString(),
                    token,
                    item.event_id,
                    item.subscription_id,
                    claimTime,
                    claimTime,
                    item.account_id,
                )
                .run();
            if (!claim.meta.changes) return;
            let outcome: 'sent' | 'stale' | 'retry' = 'retry';
            try {
                outcome = await send(env, item, item.event_id, item.message, providerFetch);
            } catch {}
            const attempt = Number(item.attempts) + 1;
            const guard = "WHERE event_id=? AND subscription_id=? AND status='sending' AND lock_token=?";
            if (outcome === 'stale') {
                await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?')
                    .bind(item.subscription_id)
                    .run();
            } else if (outcome === 'sent') {
                await env.DB.prepare(
                    `UPDATE caught_push_deliveries SET status='sent',sent_at=?,locked_until=NULL,lock_token=NULL ${guard}`,
                )
                    .bind(currentTime(), item.event_id, item.subscription_id, token)
                    .run();
            } else if (attempt >= MAX_ATTEMPTS) {
                await env.DB.prepare(
                    `UPDATE caught_push_deliveries SET status='failed',locked_until=NULL,lock_token=NULL ${guard}`,
                )
                    .bind(item.event_id, item.subscription_id, token)
                    .run();
            } else {
                await env.DB.prepare(
                    `UPDATE caught_push_deliveries SET status='pending',next_attempt_at=?,locked_until=NULL,lock_token=NULL ${guard}`,
                )
                    .bind(
                        new Date(
                            Date.parse(currentTime()) + Math.min(6 * 60 * 60_000, 60_000 * 2 ** attempt),
                        ).toISOString(),
                        item.event_id,
                        item.subscription_id,
                        token,
                    )
                    .run();
            }
        }),
    );
}

export async function processCaughtNotifications(
    env: CaughtNotificationEnv,
    limit = 20,
    deps: CaughtNotificationDeps = {},
): Promise<void> {
    const max = Math.max(1, Math.min(100, limit));
    await Promise.all([
        sendCaughtEmails(env, Math.min(BATCH_SIZE, max), deps),
        sendCaughtPushes(env, max, deps),
    ]);
}
