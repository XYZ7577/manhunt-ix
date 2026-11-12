import type { Account } from '../../shared/types';
import type {
    AccountApproval,
    AccountApprovalStatus,
    ApprovalEmailState,
    AdminApprovalAccount,
} from '../../shared/accounts/approval';
import { sendEmail, type EmailEnv } from '../email/email';
import { withEmailFooter } from '../email/emailTemplates';

interface ApprovalEnv extends EmailEnv {
    DB: D1Database;
}
interface ApprovalDeps {
    currentAccount(request: Request): Promise<Account | null>;
    sendApprovalEmail?: (to: string, displayName: string) => Promise<boolean>;
}

const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const stamp = () => new Date().toISOString();
const EMAIL_ATTEMPT_LEASE_MS = 2 * 60 * 1000;
const statusText: Record<AccountApprovalStatus, string> = {
    pending: 'Your account is waiting for an administrator to approve it.',
    approved: 'Your account is approved. You can sign in.',
    rejected: 'An administrator did not approve this account.',
    disabled: 'This account is disabled.',
};

export async function getAccountApproval(db: D1Database, accountId: string): Promise<AccountApproval | null> {
    const row = await db
        .prepare('SELECT * FROM account_approvals WHERE account_id=?')
        .bind(accountId)
        .first<any>();
    if (!row) return null;
    return {
        accountId: row.account_id,
        status: row.status,
        requestedAt: row.requested_at,
        reviewedAt: row.reviewed_at,
        reviewedBy: row.reviewed_by,
        reviewNote: row.review_note,
        notificationEmail: row.notification_email,
    };
}

export async function getAccountApprovalStatus(db: D1Database, accountId: string) {
    const approval = await getAccountApproval(db, accountId);
    if (!approval) return null;
    return {
        status: approval.status,
        canSignIn: approval.status === 'approved',
        requestedAt: approval.requestedAt,
        message: statusText[approval.status],
    };
}

async function adminAccount(db: D1Database, id: string): Promise<AdminApprovalAccount | null> {
    const row = await db
        .prepare(
            `SELECT a.id,a.username,a.display_name,a.created_at,aa.status,aa.reviewed_at,aa.notification_email,
      (SELECT email FROM account_emails e WHERE e.account_id=a.id ORDER BY e.is_primary DESC,e.created_at LIMIT 1) AS email,
      (SELECT phone FROM account_contacts c WHERE c.account_id=a.id) AS phone
    FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=?`,
        )
        .bind(id)
        .first<any>();
    return row
        ? {
              id: row.id,
              username: row.username,
              displayName: row.display_name,
              createdAt: row.created_at,
              email: row.email ?? null,
              phone: row.phone ?? null,
              status: row.status,
              reviewedAt: row.reviewed_at,
              notificationEmail: row.notification_email,
          }
        : null;
}

async function emailAttempts(db: D1Database, accountIds: string[]) {
    if (!accountIds.length) return new Map<string, NonNullable<AdminApprovalAccount['emailAttempts']>>();
    const placeholders = accountIds.map(() => '?').join(',');
    const rows = await db
        .prepare(
            `SELECT account_id,started_at,completed_at,status FROM account_approval_email_attempts WHERE account_id IN (${placeholders}) ORDER BY started_at`,
        )
        .bind(...accountIds)
        .all<any>();
    const byAccount = new Map<string, NonNullable<AdminApprovalAccount['emailAttempts']>>();
    for (const row of rows.results ?? []) {
        const attempts = byAccount.get(row.account_id) ?? [];
        attempts.push({ startedAt: row.started_at, completedAt: row.completed_at, status: row.status });
        byAccount.set(row.account_id, attempts);
    }
    return byAccount;
}

async function finishEmailAttempt(
    db: D1Database,
    accountId: string,
    attemptId: string,
    state: 'sent' | 'failed' | 'not_available',
) {
    const completedAt = stamp();
    const attemptStatus = state === 'sent' ? 'sent' : 'failed';
    await db.batch([
        db
            .prepare(
                "UPDATE account_approvals SET notification_email=?,notification_attempted_at=? WHERE account_id=? AND status='approved' AND notification_email='sending' AND notification_attempt_id=?",
            )
            .bind(state, completedAt, accountId, attemptId),
        db
            .prepare(
                "UPDATE account_approval_email_attempts SET status=?,completed_at=? WHERE id=? AND status='sending'",
            )
            .bind(attemptStatus, completedAt, attemptId),
    ]);
}

async function approvedAdmin(db: D1Database, account: Account) {
    if (account.role !== 'admin') return false;
    const row = await db
        .prepare("SELECT 1 AS ok FROM account_approvals WHERE account_id=? AND status='approved'")
        .bind(account.id)
        .first();
    return Boolean(row);
}

async function sendApprovalNotice(
    env: ApprovalEnv,
    deps: ApprovalDeps,
    email: string,
    displayName: string,
): Promise<boolean> {
    if (deps.sendApprovalEmail) return deps.sendApprovalEmail(email, displayName);
    return sendEmail(env, {
        to: email,
        subject: 'Your Manhunt IX account is approved',
        text: withEmailFooter(
            `Hi ${displayName},\n\nYour Manhunt account has been approved. You can now sign in!\n`,
        ),
    });
}

export async function handleAccountApprovalRoutes(
    request: Request,
    env: ApprovalEnv,
    deps: ApprovalDeps,
): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === '/api/account-status' && request.method === 'GET') {
        const account = await deps.currentAccount(request);
        if (!account) return json({ error: 'Sign in to check account status.' }, 401);
        const status = await getAccountApprovalStatus(env.DB, account.id);
        return status ? json(status) : json({ error: 'Account approval status is unavailable.' }, 503);
    }

    if (url.pathname === '/api/admin/accounts' && request.method === 'GET') {
        const admin = await deps.currentAccount(request);
        if (!admin) return json({ error: 'Sign in required.' }, 401);
        if (!(await approvedAdmin(env.DB, admin)))
            return json({ error: 'Approved administrator access required.' }, 403);
        const status = url.searchParams.get('status') || 'pending';
        if (!['pending', 'approved', 'rejected', 'disabled'].includes(status))
            return json({ error: 'Invalid status.' }, 400);
        const rows = await env.DB.prepare(
            `SELECT a.id,a.username,a.display_name,a.created_at,aa.status,aa.reviewed_at,aa.notification_email,
        (SELECT email FROM account_emails e WHERE e.account_id=a.id ORDER BY e.is_primary DESC,e.created_at LIMIT 1) AS email,
        (SELECT phone FROM account_contacts c WHERE c.account_id=a.id) AS phone
      FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id WHERE aa.status=?
        AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=a.id)
      ORDER BY ${status === 'pending' ? 'aa.requested_at ASC' : 'COALESCE(aa.reviewed_at,aa.requested_at) DESC'} LIMIT 100`,
        )
            .bind(status)
            .all<any>();
        const records = rows.results ?? [];
        const attempts = await emailAttempts(
            env.DB,
            records.map((row: any) => row.id),
        );
        const accounts = records.map((row: any) => ({
            id: row.id,
            username: row.username,
            displayName: row.display_name,
            createdAt: row.created_at,
            email: row.email ?? null,
            phone: row.phone ?? null,
            status: row.status,
            reviewedAt: row.reviewed_at,
            notificationEmail: row.notification_email,
            emailAttempts: attempts.get(row.id) ?? [],
        }));
        return json({ accounts });
    }

    const match = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/(approve|reject)$/);
    const retry = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/approval-email\/retry$/);
    if ((!match && !retry) || request.method !== 'POST') return null;
    const admin = await deps.currentAccount(request);
    if (!admin) return json({ error: 'Sign in required.' }, 401);
    if (!(await approvedAdmin(env.DB, admin)))
        return json({ error: 'Approved administrator access required.' }, 403);
    const targetId = decodeURIComponent((match ?? retry)![1]);
    if (targetId === admin.id) return json({ error: 'You cannot review your own account.' }, 400);
    if (retry) {
        const target = await adminAccount(env.DB, targetId);
        if (!target || target.status !== 'approved')
            return json({ error: 'Approved account not found.' }, 404);
        const attemptedAt = stamp();
        const attemptId = crypto.randomUUID();
        const staleBefore = new Date(Date.now() - EMAIL_ATTEMPT_LEASE_MS).toISOString();
        const claim = await env.DB.batch([
            env.DB.prepare(
                `UPDATE account_approvals SET notification_email='sending',notification_attempted_at=?,notification_attempt_id=?
      WHERE account_id=? AND status='approved' AND (notification_email='failed' OR
        (notification_email='sending' AND notification_attempted_at<?))`,
            ).bind(attemptedAt, attemptId, targetId, staleBefore),
            env.DB.prepare(
                `INSERT INTO account_approval_email_attempts(id,account_id,started_at,status)
      SELECT ?,account_id,?,'sending' FROM account_approvals WHERE account_id=? AND status='approved' AND notification_email='sending' AND notification_attempt_id=?`,
            ).bind(attemptId, attemptedAt, targetId, attemptId),
        ]);
        if (!claim[0]?.meta.changes) {
            const existing = await getAccountApproval(env.DB, targetId);
            return existing
                ? json({
                      approval: {
                          accountId: targetId,
                          status: existing.status,
                          reviewedAt: existing.reviewedAt,
                          notificationEmail: existing.notificationEmail,
                      },
                  })
                : json({ error: 'Account not found.' }, 404);
        }
        let state: ApprovalEmailState = 'not_available';
        if (target.email) {
            try {
                state = (await sendApprovalNotice(env, deps, target.email, target.displayName))
                    ? 'sent'
                    : 'failed';
            } catch {
                state = 'failed';
            }
        }
        await finishEmailAttempt(
            env.DB,
            targetId,
            attemptId,
            state === 'sent' ? 'sent' : state === 'failed' ? 'failed' : 'not_available',
        );
        return json({
            approval: {
                accountId: targetId,
                status: 'approved',
                reviewedAt: (await getAccountApproval(env.DB, targetId))?.reviewedAt ?? null,
                notificationEmail: state,
            },
        });
    }
    const decision = match![2] === 'approve' ? 'approved' : 'rejected';
    let reviewNote: string | null = null;
    if (decision === 'rejected') {
        const raw = await request.text();
        if (raw) {
            let body: any;
            try {
                body = JSON.parse(raw);
            } catch {
                return json({ error: 'Invalid request body.' }, 400);
            }
            if (
                body.reviewNote !== undefined &&
                (typeof body.reviewNote !== 'string' || body.reviewNote.length > 500)
            )
                return json({ error: 'Review note must be 500 characters or fewer.' }, 400);
            reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote.trim() || null : null;
        }
    }
    const reviewedAt = stamp();
    const attemptId = decision === 'approved' ? crypto.randomUUID() : null;
    const transition = await env.DB.batch([
        env.DB.prepare(
            `UPDATE account_approvals SET status=?,reviewed_at=?,reviewed_by=?,
      review_note=?,notification_attempted_at=CASE WHEN ?='approved' AND EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=account_approvals.account_id) THEN ? ELSE NULL END,
      notification_attempt_id=CASE WHEN ?='approved' AND EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=account_approvals.account_id) THEN ? ELSE NULL END,
      notification_email=CASE WHEN ?='approved' AND EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=account_approvals.account_id) THEN 'sending'
        WHEN ?='approved' THEN 'not_available' ELSE 'not_sent' END
    WHERE account_id=? AND status='pending'`,
        ).bind(
            decision,
            reviewedAt,
            admin.id,
            reviewNote,
            decision,
            reviewedAt,
            decision,
            attemptId,
            decision,
            decision,
            targetId,
        ),
        env.DB.prepare(
            `INSERT INTO account_approval_email_attempts(id,account_id,started_at,status)
    SELECT ?,account_id,?,'sending' FROM account_approvals WHERE account_id=? AND status='approved' AND notification_email='sending' AND notification_attempt_id=?`,
        ).bind(attemptId, reviewedAt, targetId, attemptId),
        ...(decision === 'approved'
            ? [
                  env.DB.prepare(
                      `INSERT INTO groups(id,name,members_json,created_at)
      SELECT r.group_id,r.name,r.members_json,r.created_at
      FROM account_group_requests r
      JOIN accounts a ON a.id=r.account_id AND a.role='player' AND a.group_id IS NULL
      JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved'
      WHERE r.account_id=? AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id=r.group_id)`,
                  ).bind(targetId),
                  env.DB.prepare(
                      `UPDATE accounts SET group_id=(SELECT r.group_id FROM account_group_requests r
        JOIN groups g ON g.id=r.group_id AND g.name=r.name AND g.members_json=r.members_json AND g.created_at=r.created_at
        WHERE r.account_id=accounts.id)
      WHERE id=? AND role='player' AND group_id IS NULL
        AND EXISTS (SELECT 1 FROM account_approvals aa WHERE aa.account_id=accounts.id AND aa.status='approved')
        AND EXISTS (SELECT 1 FROM account_group_requests r JOIN groups g ON g.id=r.group_id
          AND g.name=r.name AND g.members_json=r.members_json AND g.created_at=r.created_at WHERE r.account_id=accounts.id)`,
                  ).bind(targetId),
                  env.DB.prepare(
                      `INSERT OR IGNORE INTO group_leaders(group_id,account_id,created_at)
      SELECT a.group_id,a.id,r.created_at FROM accounts a JOIN account_group_requests r ON r.account_id=a.id AND r.group_id=a.group_id
      JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved' WHERE a.id=? AND a.role='player'`,
                  ).bind(targetId),
                  env.DB.prepare(
                      'DELETE FROM account_group_requests WHERE account_id=? AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=? AND a.group_id IS NOT NULL)',
                  ).bind(targetId, targetId),
              ]
            : [
                  env.DB.prepare(
                      "DELETE FROM account_group_requests WHERE account_id=? AND EXISTS (SELECT 1 FROM account_approvals WHERE account_id=? AND status='rejected')",
                  ).bind(targetId, targetId),
              ]),
    ]);
    if (!transition[0]?.meta.changes) {
        const existing = await getAccountApproval(env.DB, targetId);
        return existing
            ? json({ approval: { ...existing, notificationEmail: existing.notificationEmail } })
            : json({ error: 'Account not found.' }, 404);
    }

    let emailNotification: ApprovalEmailState = 'not_sent';
    if (decision === 'approved') {
        const target = await adminAccount(env.DB, targetId);
        if (target?.email) {
            let sent = false;
            try {
                sent = await sendApprovalNotice(env, deps, target.email, target.displayName);
            } catch {
                sent = false;
            }
            emailNotification = sent ? 'sent' : 'failed';
            await finishEmailAttempt(
                env.DB,
                targetId,
                attemptId!,
                emailNotification === 'sent' ? 'sent' : 'failed',
            );
        } else {
            emailNotification = 'not_available';
            if (attemptId) await finishEmailAttempt(env.DB, targetId, attemptId, 'not_available');
        }
    }
    if (decision === 'rejected')
        await env.DB.prepare('DELETE FROM sessions WHERE account_id=?').bind(targetId).run();
    return json({
        approval: { accountId: targetId, status: decision, reviewedAt, notificationEmail: emailNotification },
    });
}
