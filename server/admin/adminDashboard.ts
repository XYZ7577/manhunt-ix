import { TASK_DEFINITIONS } from '../../shared/event/tasks';
import type { AdminDashboardSummary, AdminSubmissionPage } from '../../shared/admin/dashboard';
import type { Account, Submission } from '../../shared/types';

export interface AdminSubmissionEnv {
    DB: D1Database;
    DEMO_MODE?: string;
}
interface AdminDashboardEnv extends AdminSubmissionEnv {}
const taskTitle = new Map(TASK_DEFINITIONS.map((task) => [task.id, task.title]));

export async function loadAdminDashboardSummary(env: AdminDashboardEnv): Promise<AdminDashboardSummary> {
    const groupConditions = env.DEMO_MODE === 'true' ? [] : ["id NOT LIKE 'demo-group-%'"];
    groupConditions.push('NOT EXISTS(SELECT 1 FROM group_deletions gd WHERE gd.group_id=groups.id)');
    const realGroups = `WHERE ${groupConditions.join(' AND ')}`;
    const groupsRows = await env.DB.prepare(
        `SELECT id,name,members_json FROM groups ${realGroups} ORDER BY name,id`,
    ).all<any>();
    const groupIds = new Set(groupsRows.results.map((group: any) => String(group.id)));
    const groups = groupsRows.results.map((row: any) => ({
        id: row.id,
        name: row.name,
        members: parseMembers(row.members_json),
    }));
    if (!groups.length) return { groups, progress: [], pendingCount: 0 };

    const progressConditions = env.DEMO_MODE === 'true' ? [] : ["s.group_id NOT LIKE 'demo-group-%'"];
    progressConditions.push(`NOT EXISTS (SELECT 1 FROM submissions newer WHERE newer.group_id=s.group_id AND newer.task_id=s.task_id
    AND (newer.attempt>s.attempt OR (newer.attempt=s.attempt AND newer.created_at>s.created_at)
    OR (newer.attempt=s.attempt AND newer.created_at=s.created_at AND newer.id>s.id)))`);
    const progressRows = await env.DB.prepare(
        `SELECT s.group_id,s.task_id,s.status FROM submissions s
    WHERE ${progressConditions.join(' AND ')}`,
    ).all<any>();
    const progress = progressRows.results
        .filter((row: any) => groupIds.has(String(row.group_id)))
        .map((row: any) => ({ groupId: row.group_id, taskId: row.task_id, status: row.status }));
    const pendingFilter =
        env.DEMO_MODE === 'true'
            ? "status='pending'"
            : "status='pending' AND group_id NOT LIKE 'demo-group-%'";
    const pending = await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM submissions WHERE ${pendingFilter}`,
    ).first<any>();
    return { groups, progress, pendingCount: Number(pending?.total ?? 0) };
}

function parseMembers(value: string): string[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function integerParam(
    params: URLSearchParams,
    key: string,
    fallback: number,
    min: number,
    max: number,
): number | null {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export async function loadAdminSubmissionPage(
    request: Request,
    env: AdminDashboardEnv,
): Promise<AdminSubmissionPage | null> {
    const params = new URL(request.url).searchParams;
    const status = params.get('status') ?? 'pending';
    const groupId = params.get('groupId') ?? 'all';
    const taskId = params.get('taskId') ?? 'all';
    const sort = params.get('sort') ?? 'oldest';
    const search = (params.get('search') ?? '').trim().slice(0, 100);
    const page = integerParam(params, 'page', 1, 1, 1_000_000);
    const pageSize = integerParam(params, 'pageSize', 20, 1, 50);
    const cursor = params.get('cursor');
    const cursorDirection = params.get('cursorDirection') ?? 'next';
    if (
        !['pending', 'all'].includes(status) ||
        !['oldest', 'newest'].includes(sort) ||
        page === null ||
        pageSize === null ||
        (cursor !== null && (cursor.length > 2048 || !['next', 'previous'].includes(cursorDirection))) ||
        (cursor === null && params.has('cursorDirection')) ||
        (groupId !== 'all' && !/^[\w-]{1,128}$/.test(groupId)) ||
        (taskId !== 'all' && !taskTitle.has(taskId))
    )
        return null;

    const conditions: string[] = [];
    const bindings: unknown[] = [];
    const taskCase = `CASE s.task_id ${TASK_DEFINITIONS.map(() => 'WHEN ? THEN ?').join(' ')} ELSE s.task_id END`;
    if (env.DEMO_MODE !== 'true') conditions.push("s.group_id NOT LIKE 'demo-group-%'");
    if (status === 'pending') conditions.push("s.status='pending'");
    if (groupId !== 'all') {
        conditions.push('s.group_id=?');
        bindings.push(groupId);
    }
    if (taskId !== 'all') {
        conditions.push('s.task_id=?');
        bindings.push(taskId);
    }
    if (search) {
        conditions.push(`(g.name LIKE ? COLLATE NOCASE OR (${taskCase}) LIKE ? COLLATE NOCASE)`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const taskBindings = TASK_DEFINITIONS.flatMap((task) => [task.id, task.title]);
    const searchBinding = search ? `%${search}%` : undefined;
    const count = await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM submissions s JOIN groups g ON g.id=s.group_id ${where}`,
    )
        .bind(
            ...bindings.slice(0, bindings.length),
            ...(search ? [searchBinding, ...taskBindings, searchBinding] : []),
        )
        .first<any>();
    const sortedAt = 'COALESCE(s.submitted_at,s.created_at)';
    const direction = sort === 'oldest' ? 'ASC' : 'DESC';
    let cursorValues: { at: string; id: string } | null = null;
    if (cursor !== null) {
        try {
            const normalized =
                cursor.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (cursor.length % 4)) % 4);
            const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
            const decoded = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
            if (
                decoded.v !== 1 ||
                decoded.status !== status ||
                decoded.groupId !== groupId ||
                decoded.taskId !== taskId ||
                decoded.sort !== sort ||
                decoded.search !== search ||
                typeof decoded.at !== 'string' ||
                !decoded.at ||
                decoded.at.length > 80 ||
                typeof decoded.id !== 'string' ||
                !/^[\w-]{1,128}$/.test(decoded.id) ||
                cursor !== encodeCursor(decoded)
            )
                return null;
            cursorValues = { at: decoded.at, id: decoded.id };
        } catch {
            return null;
        }
    }
    const isPrevious = cursor !== null && cursorDirection === 'previous';
    const comparison = (sort === 'oldest') !== isPrevious ? '>' : '<';
    const queryConditions = [...conditions];
    if (cursorValues) queryConditions.push(`(${sortedAt},s.id) ${comparison} (?,?)`);
    const queryWhere = queryConditions.length ? `WHERE ${queryConditions.join(' AND ')}` : '';
    const searchBindings = search ? [searchBinding, ...taskBindings, searchBinding] : [];
    const queryBindings = [
        ...bindings,
        ...searchBindings,
        ...(cursorValues ? [cursorValues.at, cursorValues.id] : []),
    ];
    const queryDirection = isPrevious ? (direction === 'ASC' ? 'DESC' : 'ASC') : direction;
    const offset = cursorValues ? 0 : (page - 1) * pageSize;
    const orderIndex =
        status === 'pending' ? 'submissions_pending_review_order' : 'submissions_all_review_order';
    const orderIndexHint =
        groupId === 'all' && taskId === 'all' && !search ? ` INDEXED BY ${orderIndex}` : '';
    const query = `SELECT s.id,s.group_id,s.task_id,s.status,s.attempt,s.created_at,s.submitted_at,s.reviewed_at,
      g.name AS group_name, ${taskCase} AS task_title,
      NOT EXISTS(SELECT 1 FROM submissions newer WHERE newer.group_id=s.group_id AND newer.task_id=s.task_id
        AND (newer.attempt>s.attempt OR (newer.attempt=s.attempt AND newer.created_at>s.created_at)
        OR (newer.attempt=s.attempt AND newer.created_at=s.created_at AND newer.id>s.id))) AS latest
    FROM submissions s${orderIndexHint}
      JOIN groups g ON g.id=s.group_id ${queryWhere}
    ORDER BY ${sortedAt} ${queryDirection},s.id ${queryDirection} LIMIT ? OFFSET ?`;
    const rows = await env.DB.prepare(query)
        .bind(...taskBindings, ...queryBindings, pageSize + 1, offset)
        .all<any>();
    const hasExtra = rows.results.length > pageSize;
    const pageRows = rows.results.slice(0, pageSize);
    const orderedRows = isPrevious ? pageRows.reverse() : pageRows;
    const items = orderedRows.map((row: any) => ({
        id: row.id,
        groupId: row.group_id,
        groupName: row.group_name,
        taskId: row.task_id,
        taskTitle: row.task_title,
        status: row.status,
        attempt: Number(row.attempt),
        createdAt: row.created_at,
        submittedAt: row.submitted_at,
        reviewedAt: row.reviewed_at,
        latest: Boolean(row.latest),
    }));
    const cursorFor = (row: any) =>
        encodeCursor({
            v: 1,
            status,
            groupId,
            taskId,
            sort,
            search,
            at: row.submitted_at ?? row.created_at,
            id: row.id,
        });
    const total = Number(count?.total ?? 0);
    const hasPrevious = isPrevious ? hasExtra : cursorValues !== null || page > 1;
    return {
        total,
        page,
        pageSize,
        items,
        nextCursor:
            items.length && (isPrevious || hasExtra) ? cursorFor(orderedRows[orderedRows.length - 1]) : null,
        previousCursor: items.length && hasPrevious ? cursorFor(orderedRows[0]) : null,
    };
}

function encodeCursor(value: Record<string, unknown>): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

export async function loadAdminSubmission(
    requestedId: string,
    env: AdminDashboardEnv,
    shape: (row: any, includeMetadata?: boolean) => Promise<Submission>,
): Promise<Submission | null> {
    const row = await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(requestedId).first<any>();
    if (!row || (env.DEMO_MODE !== 'true' && String(row.group_id).startsWith('demo-group-'))) return null;
    return shape(row, true);
}
