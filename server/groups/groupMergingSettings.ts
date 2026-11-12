import type { Account } from '../../shared/types';

interface GroupMergingSettingsEnv {
    DB: D1Database;
    ADMIN_GOOGLE_EMAIL?: string;
}
export const GROUP_MERGING_OPEN_SQL =
    'EXISTS (SELECT 1 FROM group_merging_settings WHERE id=1 AND enabled=1)';
export const GROUP_MERGING_PAUSED_MESSAGE =
    'Group merging is currently paused by the main administrator. Invitation links can still be created, but players cannot join a team through an invitation right now.';
const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

const mainAdminSql = `SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
  JOIN federated_identities f ON f.account_id=a.id AND f.provider='google'
  WHERE a.id=? AND a.role='admin' AND aa.status='approved' AND f.identifier=? COLLATE NOCASE`;

export async function groupMergingEnabled(env: GroupMergingSettingsEnv): Promise<boolean> {
    const row = await env.DB.prepare('SELECT enabled FROM group_merging_settings WHERE id=1').first<{
        enabled: number;
    }>();
    return row?.enabled === 1;
}

export async function loadGroupMergingSettings(env: GroupMergingSettingsEnv, actor: Account) {
    const email = env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase();
    const [enabled, mainAdmin] = await Promise.all([
        groupMergingEnabled(env),
        actor.role === 'admin' && email
            ? env.DB.prepare(mainAdminSql).bind(actor.id, email).first()
            : Promise.resolve(null),
    ]);
    return { groupMergingEnabled: enabled, canManageGroupMerging: !!mainAdmin };
}

export async function handleGroupMergingSettings(
    request: Request,
    env: GroupMergingSettingsEnv,
    actor: Account,
): Promise<Response | null> {
    if (new URL(request.url).pathname !== '/api/admin/group-merging-settings') return null;
    if (request.method !== 'GET' && request.method !== 'PATCH')
        return json({ error: 'Method not allowed.' }, 405);
    const email = env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase();
    if (!email || !(await env.DB.prepare(mainAdminSql).bind(actor.id, email).first())) {
        return json({ error: 'Only the main administrator can control group merging.' }, 403);
    }
    if (request.method === 'GET') return json(await loadGroupMergingSettings(env, actor));
    const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!body || typeof body.enabled !== 'boolean')
        return json({ error: 'Choose whether group merging is enabled.' }, 400);
    const result = await env.DB.prepare(
        `INSERT INTO group_merging_settings(id,enabled,updated_at,updated_by)
    SELECT 1,?,?,? WHERE EXISTS (${mainAdminSql})
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    )
        .bind(body.enabled ? 1 : 0, new Date().toISOString(), actor.id, actor.id, email)
        .run();
    if (!result.meta.changes)
        return json({ error: 'Main administrator access changed. Refresh and try again.' }, 403);
    return json({ groupMergingEnabled: body.enabled, canManageGroupMerging: true });
}
