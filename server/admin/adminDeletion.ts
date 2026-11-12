import type { Account } from '../../shared/types';

interface AdminDeletionEnv {
    DB: D1Database;
    ADMIN_GOOGLE_EMAIL?: string;
}
interface AdminDeletionDeps {
    currentAccount(request: Request): Promise<Account | null>;
}
const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const fail = (message: string, status = 400) => json({ error: message }, status);
const stamp = () => new Date().toISOString();

function configuredEmail(env: AdminDeletionEnv) {
    return env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase() ?? '';
}
const approvedAdminSql = `EXISTS(SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
  WHERE a.id=? AND a.role='admin' AND aa.status='approved')`;
const mainAdminSql = `EXISTS(SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
  JOIN federated_identities f ON f.account_id=a.id AND f.provider='google'
  WHERE a.id=? AND a.role='admin' AND aa.status='approved' AND f.identifier=? COLLATE NOCASE)`;

async function mainAdmin(env: AdminDeletionEnv, accountId: string) {
    const email = configuredEmail(env);
    return (
        !!email && !!(await env.DB.prepare(`SELECT 1 WHERE ${mainAdminSql}`).bind(accountId, email).first())
    );
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
    const body = await request.json().catch(() => null);
    return body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
}

export async function handleAdminDeletion(
    request: Request,
    env: AdminDeletionEnv,
    deps: AdminDeletionDeps,
): Promise<Response | null> {
    const url = new URL(request.url),
        path = url.pathname;
    const options = path === '/api/admin/deletion-options';
    const accountMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)$/);
    const groupMatch = path.match(/^\/api\/admin\/groups\/([^/]+)$/);
    if (!options && !accountMatch && !groupMatch) return null;
    const actor = await deps.currentAccount(request);
    if (!actor) return fail('Sign in required.', 401);
    if (
        !(
            await env.DB.prepare(`SELECT ${approvedAdminSql} AS allowed`)
                .bind(actor.id)
                .first<{ allowed: number }>()
        )?.allowed
    )
        return fail('Approved administrator access required.', 403);

    if (options) {
        if (request.method !== 'GET') return fail('Method not allowed.', 405);
        const canDelete = await mainAdmin(env, actor.id);
        if (!canDelete) return json({ canDelete: false, players: [], groups: [] });
        const [playerRows, groupRows] = await Promise.all([
            env.DB.prepare(
                `SELECT a.id,a.username,a.display_name,a.group_id,aa.status
        FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
        WHERE a.role='player' AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=a.id)
        ORDER BY a.display_name COLLATE NOCASE,a.username COLLATE NOCASE,a.id LIMIT 1000`,
            ).all<any>(),
            env.DB.prepare(
                `SELECT g.id,g.name,
        (SELECT COUNT(*) FROM accounts a WHERE a.group_id=g.id AND a.role='player') AS player_count,
        EXISTS(SELECT 1 FROM group_disbands gd WHERE gd.group_id=g.id) AS disbanded
        FROM groups g WHERE NOT EXISTS(SELECT 1 FROM group_deletions d WHERE d.group_id=g.id)
        ORDER BY g.name COLLATE NOCASE,g.id LIMIT 1000`,
            ).all<any>(),
        ]);
        return json({
            canDelete,
            players: playerRows.results.map((row) => ({
                id: row.id,
                username: row.username,
                displayName: row.display_name,
                groupId: row.group_id,
                status: row.status,
            })),
            groups: groupRows.results.map((row) => ({
                id: row.id,
                name: row.name,
                playerCount: Number(row.player_count),
                disbanded: !!row.disbanded,
            })),
        });
    }
    if (request.method !== 'DELETE') return fail('Method not allowed.', 405);
    if (!configuredEmail(env) || !(await mainAdmin(env, actor.id)))
        return fail('Only the main administrator can delete players or groups.', 403);
    const body = await readJson(request);
    if (!body || typeof body.confirmation !== 'string' || !body.confirmation)
        return fail('Enter the name shown to confirm deletion.');
    const deletedAt = stamp();
    const deletionToken = crypto.randomUUID();

    if (accountMatch) {
        let targetId: string;
        try {
            targetId = decodeURIComponent(accountMatch[1]);
        } catch {
            return fail('Account not found.', 404);
        }
        if (targetId === actor.id) return fail('You cannot delete your own account.', 400);
        const target = await env.DB.prepare(
            `SELECT a.id,a.username,a.display_name,a.role,a.group_id,aa.status,
      EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=a.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE) AS main_account
      FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=?
        AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=a.id)`,
        )
            .bind(configuredEmail(env), targetId)
            .first<any>();
        if (!target || target.role !== 'player') return fail('Player account not found.', 404);
        if (target.main_account) return fail('The main administrator account cannot be deleted.', 403);
        if (body.confirmation !== target.username)
            return fail('The username changed or did not match. Refresh and try again.', 409);
        const random = crypto.getRandomValues(new Uint8Array(64));
        const replacementUsername = `deleted-player-${deletionToken}`;
        const salt = [...random.slice(0, 16)].map((v) => v.toString(16).padStart(2, '0')).join('');
        const passwordHash = [...random.slice(16)].map((v) => v.toString(16).padStart(2, '0')).join('');
        const emailRows = await env.DB.prepare(
            `SELECT email FROM account_emails WHERE account_id=?
      UNION SELECT identifier AS email FROM federated_identities WHERE account_id=?`,
        )
            .bind(targetId, targetId)
            .all<any>();
        const emails = [
            ...new Set(
                [
                    ...emailRows.results.map((row) => String(row.email).toLowerCase()),
                    ...(target.username.includes('@') ? [target.username.toLowerCase()] : []),
                ].filter(Boolean),
            ),
        ];
        const inEmails = emails.length ? ` OR lower(email) IN (${emails.map(() => '?').join(',')})` : '';
        const actorId = actor.id,
            groupId = target.group_id;
        try {
            const results = await env.DB.batch([
                env.DB.prepare(
                    `INSERT INTO account_deletions(account_id,deleted_by,deleted_at,deletion_token)
          SELECT ?,?,?,? WHERE ${mainAdminSql} AND EXISTS(SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
            WHERE a.id=? AND a.role='player' AND a.username=? AND a.group_id IS ?
              AND aa.status=?
              AND NOT EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=a.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE)
            AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=a.id))`,
                ).bind(
                    targetId,
                    actorId,
                    deletedAt,
                    deletionToken,
                    actorId,
                    configuredEmail(env),
                    targetId,
                    target.username,
                    groupId,
                    target.status,
                    configuredEmail(env),
                ),
                env.DB.prepare(
                    `DELETE FROM group_leaders WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `UPDATE accounts SET username=?,display_name='Deleted player',password_salt=?,password_hash=?,group_id=NULL
          ,registration_username=NULL WHERE id=? AND role='player' AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(replacementUsername, salt, passwordHash, targetId, targetId, deletionToken),
                env.DB.prepare(
                    `UPDATE account_approvals SET status='disabled',reviewed_at=?,reviewed_by=?
          WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(deletedAt, actorId, targetId, targetId, deletionToken),
                env.DB.prepare(
                    `UPDATE group_invitations SET status='revoked',email='deleted-'||lower(hex(randomblob(12)))||'@deleted.invalid'
          WHERE status='pending' AND (invited_by=? OR accepted_by=?${inEmails})
            AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, ...emails, targetId, deletionToken),
                env.DB.prepare(
                    `UPDATE group_invitations SET email='deleted-'||lower(hex(randomblob(12)))||'@deleted.invalid'
          WHERE status!='pending' AND email IN (SELECT email FROM account_emails WHERE account_id=? UNION SELECT identifier FROM federated_identities WHERE account_id=? UNION SELECT ?)
            AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, target.username, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM account_group_requests WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM sessions WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM account_emails WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM account_contacts WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM federated_identities WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM account_security WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM password_reset_challenges WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM totp_recovery_codes WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM totp_challenges WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM email_signin_challenges WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM sms_auth_challenges WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM google_auth_flows WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM push_subscriptions WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM notification_reads WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM announcement_recipients WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `UPDATE review_email_deliveries SET email='deleted-'||lower(hex(randomblob(12)))||'@deleted.invalid',email_id='deleted-'||lower(hex(randomblob(12))),status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
          WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `UPDATE announcement_email_deliveries SET email='deleted-'||lower(hex(randomblob(12)))||'@deleted.invalid',email_id='deleted-'||lower(hex(randomblob(12))),status='cancelled',next_attempt_at=NULL,locked_until=NULL,lock_token=NULL
          WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `DELETE FROM account_approval_email_attempts WHERE account_id=? AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)`,
                ).bind(targetId, targetId, deletionToken),
                env.DB.prepare(
                    `INSERT OR IGNORE INTO group_leaders(group_id,account_id,created_at)
          SELECT ?,a.id,? FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id AND aa.status='approved'
          WHERE a.group_id=? AND a.role='player' AND NOT EXISTS(SELECT 1 FROM group_leaders WHERE group_id=?)
            AND EXISTS(SELECT 1 FROM account_deletions WHERE account_id=? AND deletion_token=?)
          ORDER BY a.created_at,a.username COLLATE NOCASE,a.id LIMIT 1`,
                ).bind(groupId, deletedAt, groupId, groupId, targetId, deletionToken),
            ]);
            if (!results[0]?.meta.changes)
                return fail('The player changed or was already deleted. Refresh and try again.', 409);
        } catch {
            return fail('The player could not be deleted. Refresh and try again.', 409);
        }
        return json({ deleted: true, accountId: targetId });
    }

    let groupId: string;
    try {
        groupId = decodeURIComponent(groupMatch![1]);
    } catch {
        return fail('Group not found.', 404);
    }
    const group = await env.DB.prepare(
        `SELECT id,name FROM groups WHERE id=?
    AND NOT EXISTS(SELECT 1 FROM group_deletions d WHERE d.group_id=groups.id)`,
    )
        .bind(groupId)
        .first<any>();
    if (!group) return fail('Group not found.', 404);
    if (body.confirmation !== group.name)
        return fail('The group name changed or did not match. Refresh and try again.', 409);
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                `INSERT INTO group_deletions(group_id,deleted_by,deleted_at,deletion_token)
        SELECT g.id,?,?,? FROM groups g WHERE g.id=? AND g.name=? AND ${mainAdminSql}
          AND NOT EXISTS(SELECT 1 FROM group_deletions d WHERE d.group_id=g.id)`,
            ).bind(actor.id, deletedAt, deletionToken, groupId, group.name, actor.id, configuredEmail(env)),
            env.DB.prepare(
                `INSERT OR IGNORE INTO group_disbands(group_id,disbanded_by,disbanded_at)
        SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM group_deletions WHERE group_id=? AND deletion_token=?)`,
            ).bind(groupId, actor.id, deletedAt, groupId, deletionToken),
            env.DB.prepare(
                `DELETE FROM group_disband_challenges WHERE group_id=? AND EXISTS(SELECT 1 FROM group_deletions WHERE group_id=? AND deletion_token=?)`,
            ).bind(groupId, groupId, deletionToken),
            env.DB.prepare(
                `DELETE FROM group_leaders WHERE group_id=? AND EXISTS(SELECT 1 FROM group_deletions WHERE group_id=? AND deletion_token=?)`,
            ).bind(groupId, groupId, deletionToken),
            env.DB.prepare(
                `UPDATE accounts SET group_id=NULL WHERE group_id=? AND EXISTS(SELECT 1 FROM group_deletions WHERE group_id=? AND deletion_token=?)`,
            ).bind(groupId, groupId, deletionToken),
            env.DB.prepare(
                `UPDATE group_invitations SET status='revoked' WHERE group_id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM group_deletions WHERE group_id=? AND deletion_token=?)`,
            ).bind(groupId, groupId, deletionToken),
            env.DB.prepare(
                `UPDATE upload_sessions SET state='aborted',lock_token=NULL,lock_expires_at=NULL
        WHERE state IN ('creating','uploading','completing') AND submission_id IN (SELECT id FROM submissions WHERE group_id=?)
          AND EXISTS(SELECT 1 FROM group_deletions WHERE group_id=? AND deletion_token=?)`,
            ).bind(groupId, groupId, deletionToken),
            env.DB.prepare(
                `DELETE FROM push_subscriptions WHERE group_id=? AND EXISTS(SELECT 1 FROM group_deletions WHERE group_id=? AND deletion_token=?)`,
            ).bind(groupId, groupId, deletionToken),
            env.DB.prepare(
                `UPDATE groups SET members_json='[]' WHERE id=? AND EXISTS(SELECT 1 FROM group_deletions WHERE group_id=? AND deletion_token=?)`,
            ).bind(groupId, groupId, deletionToken),
        ]);
        if (!results[0]?.meta.changes)
            return fail('The group changed or was already deleted. Refresh and try again.', 409);
    } catch {
        return fail('The group could not be deleted. Refresh and try again.', 409);
    }
    return json({ deleted: true, groupId });
}
