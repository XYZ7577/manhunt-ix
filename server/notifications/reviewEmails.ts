import { getTaskDefinition } from '../../shared/event/tasks';
import { getEmailConfiguration, sendEmail, type EmailEnv, type OutboundEmail } from '../email/email';
import { withEmailFooter } from '../email/emailTemplates';

export interface ReviewEmailEnv extends EmailEnv {
    DB: D1Database;
    APP_ORIGIN?: string;
}

export interface ReviewEmailDeps {
    providerFetch?: typeof fetch;
}
interface ReviewEmailDelivery {
    notification_id: number;
    account_id: string;
    group_id: string;
    email_id: string;
    email: string;
    status: string;
    attempts: number;
    task_id: string;
    review_status: 'approved' | 'changes_requested';
    feedback: string | null;
    kind: 'decision' | 'feedback';
    display_name: string | null;
    current_group_id: string | null;
    approval_status: string | null;
    current_email_id: string | null;
    current_email: string | null;
    verified_at: string | null;
}

const EMAIL_MAX_ATTEMPTS = 5;
const EMAIL_BATCH_SIZE = 4;

function safeOrigin(value?: string): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
        if (
            url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        )
            return url.origin;
    } catch {}
    return null;
}

function reviewMessage(env: ReviewEmailEnv, delivery: ReviewEmailDelivery): OutboundEmail {
    const task = getTaskDefinition(delivery.task_id);
    const title = task?.title ?? 'a task';
    const person = delivery.display_name?.trim() || 'there';
    const subject =
        delivery.kind === 'feedback'
            ? `Manhunt IX feedback updated: ${title}`
            : delivery.review_status === 'approved'
              ? `Manhunt IX task approved: ${title}`
              : `Manhunt IX changes requested: ${title}`;
    const update =
        delivery.kind === 'feedback'
            ? `The organiser updated the feedback for ${title}.\nCurrent review status: ${delivery.review_status === 'approved' ? 'Approved' : 'Changes requested'}.`
            : delivery.review_status === 'approved'
              ? `${title} has been approved for your group.`
              : `The organiser requested changes to ${title}.`;
    const details = delivery.feedback?.trim() ? `\n\nOrganiser feedback:\n${delivery.feedback.trim()}` : '';
    const origin = safeOrigin(env.APP_ORIGIN);
    const action = origin
        ? `\n\nSign in to Manhunt IX to view the update and continue with your group:\n${origin}/home\n`
        : '\n\nSign in to Manhunt IX and open Review updates to see the details.\n';
    return {
        to: delivery.email,
        subject,
        text: withEmailFooter(`Hi ${person},\n\n${update}${details}${action}`),
    };
}

export async function processReviewEmails(
    env: ReviewEmailEnv,
    limit = 20,
    deps: ReviewEmailDeps = {},
): Promise<void> {
    if (!getEmailConfiguration(env)) return;
    const max = Math.max(1, Math.min(limit, EMAIL_BATCH_SIZE));
    {
        const now = new Date().toISOString();
        const due = await env.DB.prepare(
            `SELECT d.notification_id,d.account_id,d.group_id,d.email_id,d.email,d.status,d.attempts,
        n.task_id,n.status AS review_status,n.feedback,n.kind,
        a.display_name,a.group_id AS current_group_id,aa.status AS approval_status,
        e.id AS current_email_id,e.email AS current_email,e.verified_at
      FROM review_email_deliveries d
      JOIN review_notifications n ON n.id=d.notification_id
      LEFT JOIN accounts a ON a.id=d.account_id
      LEFT JOIN account_approvals aa ON aa.account_id=a.id
      LEFT JOIN account_emails e ON e.id=d.email_id AND e.account_id=d.account_id AND e.email=d.email COLLATE NOCASE
        AND e.verified_at IS NOT NULL
      WHERE d.status IN ('pending','sending')
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)
        AND (d.locked_until IS NULL OR d.locked_until<=?)
      ORDER BY d.notification_id,d.account_id LIMIT ?`,
        )
            .bind(now, now, max)
            .all<ReviewEmailDelivery>();

        if (!due.results.length) return;
        await Promise.all(
            due.results.map(async (item) => {
                const valid =
                    item.display_name !== null &&
                    item.current_group_id === item.group_id &&
                    item.approval_status === 'approved' &&
                    item.current_email_id === item.email_id &&
                    item.current_email?.toLowerCase() === item.email.toLowerCase() &&
                    item.verified_at !== null;
                if (!valid) {
                    await env.DB.prepare(
                        `UPDATE review_email_deliveries SET status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
          WHERE notification_id=? AND account_id=? AND status IN ('pending','sending')
            AND (locked_until IS NULL OR locked_until<=?)`,
                    )
                        .bind(item.notification_id, item.account_id, now)
                        .run();
                    return;
                }

                if (Number(item.attempts) >= EMAIL_MAX_ATTEMPTS) {
                    await env.DB.prepare(
                        `UPDATE review_email_deliveries SET status='failed',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
          WHERE notification_id=? AND account_id=? AND status IN ('pending','sending')
            AND attempts>=? AND (locked_until IS NULL OR locked_until<=?)`,
                    )
                        .bind(item.notification_id, item.account_id, EMAIL_MAX_ATTEMPTS, now)
                        .run();
                    return;
                }

                const lockToken = crypto.randomUUID();
                const claim = await env.DB.prepare(
                    `UPDATE review_email_deliveries SET status='sending',attempts=attempts+1,
          locked_until=?,lock_token=?,next_attempt_at=NULL
        WHERE notification_id=? AND account_id=? AND status IN ('pending','sending')
          AND (next_attempt_at IS NULL OR next_attempt_at<=?)
          AND (locked_until IS NULL OR locked_until<=?)
          AND EXISTS(SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
            JOIN account_emails e ON e.account_id=a.id WHERE a.id=review_email_deliveries.account_id
            AND a.role='player' AND a.group_id=review_email_deliveries.group_id AND aa.status='approved'
            AND e.id=review_email_deliveries.email_id AND e.email=review_email_deliveries.email COLLATE NOCASE
            AND e.verified_at IS NOT NULL)`,
                )
                    .bind(
                        new Date(Date.now() + 30_000).toISOString(),
                        lockToken,
                        item.notification_id,
                        item.account_id,
                        now,
                        now,
                    )
                    .run();
                if (!claim.meta.changes) return;

                let delivered = false;
                try {
                    delivered = await sendEmail(env, reviewMessage(env, item), deps.providerFetch);
                } catch {
                    delivered = false;
                }
                const afterAttempt = Number(item.attempts) + 1;
                const tokenGuard =
                    "WHERE notification_id=? AND account_id=? AND status='sending' AND lock_token=?";
                if (delivered) {
                    await env.DB.prepare(
                        `UPDATE review_email_deliveries SET status='sent',sent_at=?,locked_until=NULL,lock_token=NULL ${tokenGuard}`,
                    )
                        .bind(new Date().toISOString(), item.notification_id, item.account_id, lockToken)
                        .run();
                } else if (afterAttempt >= EMAIL_MAX_ATTEMPTS) {
                    await env.DB.prepare(
                        `UPDATE review_email_deliveries SET status='failed',locked_until=NULL,lock_token=NULL ${tokenGuard}`,
                    )
                        .bind(item.notification_id, item.account_id, lockToken)
                        .run();
                } else {
                    const retryAt = new Date(
                        Date.now() + Math.min(6 * 60 * 60_000, 60_000 * 2 ** afterAttempt),
                    ).toISOString();
                    await env.DB.prepare(
                        `UPDATE review_email_deliveries SET status='pending',next_attempt_at=?,locked_until=NULL,lock_token=NULL ${tokenGuard}`,
                    )
                        .bind(retryAt, item.notification_id, item.account_id, lockToken)
                        .run();
                }
            }),
        );
    }
}
