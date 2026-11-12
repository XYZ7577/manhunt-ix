import type { Account } from '../../shared/types';
import type { AdminPerson } from '../../shared/accounts/settings';
import { PASSWORD_ERROR, USERNAME_ERROR, validPassword, validUsername } from '../../shared/accounts/credentials';

interface AdminAccountsEnv {
    DB: D1Database;
    ADMIN_GOOGLE_EMAIL?: string;
}
interface AdminAccountsDeps {
    currentAccount(request: Request): Promise<Account | null>;
    passwordHash(password: string): Promise<{ salt: string; hash: string }>;
}

const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const now = () => new Date().toISOString();
const digest = async (value: string) => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
};

function validOptionalEmail(value: string) {
    return (
        value.length <= 254 &&
        /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
            value,
        )
    );
}

async function rateAllowed(env: AdminAccountsEnv, actorId: string) {
    const current = now(),
        expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    const key = `admin-account-create:${await digest(actorId)}`;
    try {
        const result = await env.DB.prepare(
            `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET
        count=CASE WHEN auth_rate_buckets.expires_at<=? THEN 1 ELSE auth_rate_buckets.count+1 END,
        expires_at=CASE WHEN auth_rate_buckets.expires_at<=? THEN excluded.expires_at ELSE auth_rate_buckets.expires_at END
      RETURNING count`,
        )
            .bind(key, expiry, current, current)
            .first<{ count: number }>();
        return !!result && result.count <= 10;
    } catch {
        return false;
    }
}

async function approvedAdmin(env: AdminAccountsEnv, account: Account) {
    return !!(await env.DB.prepare(
        `SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
    WHERE a.id=? AND a.role='admin' AND aa.status='approved'`,
    )
        .bind(account.id)
        .first());
}

export async function handleAdminAccountCreation(
    request: Request,
    env: AdminAccountsEnv,
    deps: AdminAccountsDeps,
): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== '/api/admin/accounts/create') return null;
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const actor = await deps.currentAccount(request);
    if (!actor) return json({ error: 'Sign in required.' }, 401);
    if (!(await approvedAdmin(env, actor)))
        return json({ error: 'Approved administrator access required.' }, 403);
    if (!(await rateAllowed(env, actor.id)))
        return json({ error: 'Too many admin accounts created. Try again later.' }, 429);

    let body: any;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Invalid request body.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return json({ error: 'Invalid request body.' }, 400);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const email =
        body.email === undefined || body.email === null || body.email === ''
            ? null
            : typeof body.email === 'string'
              ? body.email.trim()
              : '';
    if (!validUsername(username)) return json({ error: USERNAME_ERROR }, 400);
    if (!displayName || displayName.length > 80)
        return json({ error: 'Display name must be 1 to 80 characters.' }, 400);
    if (!validPassword(password)) return json({ error: PASSWORD_ERROR }, 400);
    if (email !== null && !validOptionalEmail(email))
        return json({ error: 'Enter a valid email address or leave it blank.' }, 400);

    const id = crypto.randomUUID(),
        createdAt = now();
    const hash = await deps.passwordHash(password);
    const emailId = email ? crypto.randomUUID() : null;
    let results: D1Result[];
    try {
        results = await env.DB.batch([
            env.DB.prepare(
                `INSERT INTO accounts(id,username,display_name,role,group_id,password_salt,password_hash,created_at)
        SELECT ?,?,?, 'admin',NULL,?,?,? WHERE EXISTS(
          SELECT 1 FROM accounts actor JOIN account_approvals aa ON aa.account_id=actor.id
          WHERE actor.id=? AND actor.role='admin' AND aa.status='approved')`,
            ).bind(id, username, displayName, hash.salt, hash.hash, createdAt, actor.id),
            env.DB.prepare(
                `INSERT INTO account_approvals(account_id,status,requested_at,reviewed_at,reviewed_by)
        SELECT id,'approved',?,?,? FROM accounts WHERE id=? AND role='admin'`,
            ).bind(createdAt, createdAt, actor.id, id),
            env.DB.prepare(
                `INSERT INTO account_security(account_id,password_set,updated_at)
        SELECT id,1,created_at FROM accounts WHERE id=? AND role='admin'`,
            ).bind(id),
            ...(email
                ? [
                      env.DB.prepare(
                          `INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at)
        SELECT ?,id,?,1,NULL,created_at FROM accounts WHERE id=? AND role='admin'`,
                      ).bind(emailId, email, id),
                  ]
                : []),
        ]);
    } catch {
        const duplicate = await env.DB.prepare('SELECT 1 FROM accounts WHERE username=? COLLATE NOCASE')
            .bind(username)
            .first();
        return duplicate
            ? json({ error: 'That username is already in use.' }, 409)
            : json({ error: 'The admin account could not be created.' }, 500);
    }
    if (!results[0]?.meta.changes) {
        return (await approvedAdmin(env, actor))
            ? json({ error: 'That username is already in use.' }, 409)
            : json({ error: 'Approved administrator access required.' }, 403);
    }
    return json(
        {
            account: { id, username, displayName, role: 'admin' },
            message: 'Admin account created and approved. They can sign in now.',
        },
        201,
    );
}

function headAdminEmail(env: AdminAccountsEnv) {
    return env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase() ?? '';
}

const personColumns = `a.id,a.username,a.display_name,a.role,
  (SELECT e.email FROM account_emails e WHERE e.account_id=a.id ORDER BY e.is_primary DESC,e.created_at,e.id LIMIT 1) AS email,
  CASE WHEN ?='' THEN 0 ELSE (
    EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=a.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE)
    OR EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=a.id AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL)
  ) END AS head_admin`;

function person(row: any): AdminPerson {
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        email: row.email ?? null,
        role: row.role === 'admin' ? 'admin' : 'player',
        headAdmin: !!row.head_admin,
    };
}

async function loadPerson(env: AdminAccountsEnv, id: string): Promise<AdminPerson | null> {
    const email = headAdminEmail(env);
    const row = await env.DB.prepare(
        `SELECT ${personColumns}
    FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
    WHERE a.id=? AND aa.status='approved'`,
    )
        .bind(email, email, email, id)
        .first<any>();
    return row ? person(row) : null;
}

async function isHeadAdmin(env: AdminAccountsEnv, id: string) {
    const email = headAdminEmail(env);
    if (!email) return false;
    return !!(await env.DB.prepare(
        `SELECT 1 FROM accounts a WHERE a.id=? AND (
    EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=a.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE)
    OR EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=a.id AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL)
  )`,
    )
        .bind(id, email, email)
        .first());
}

async function promotePerson(env: AdminAccountsEnv, id: string) {
    const timestamp = now();
    const results = await env.DB.batch([
        env.DB.prepare(
            `DELETE FROM group_leaders WHERE account_id=?
      AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND role='player')`,
        ).bind(id, id),
        env.DB.prepare(
            `UPDATE accounts SET role='admin' WHERE id=? AND role='player'
      AND EXISTS(SELECT 1 FROM account_approvals WHERE account_id=? AND status='approved')
      AND NOT EXISTS(SELECT 1 FROM group_leaders WHERE account_id=?)`,
        ).bind(id, id, id),
        env.DB.prepare(
            `INSERT OR IGNORE INTO group_leaders(group_id,account_id,created_at)
      SELECT a.group_id,(SELECT p.id FROM accounts p WHERE p.group_id=a.group_id AND p.role='player'
        ORDER BY p.created_at,p.username COLLATE NOCASE,p.id LIMIT 1),?
      FROM accounts a WHERE a.id=? AND a.role='admin' AND a.group_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM group_leaders gl WHERE gl.group_id=a.group_id)
        AND EXISTS(SELECT 1 FROM accounts p WHERE p.group_id=a.group_id AND p.role='player')`,
        ).bind(timestamp, id),
    ]);
    return !!results[1]?.meta.changes;
}

async function demotePerson(env: AdminAccountsEnv, id: string) {
    const timestamp = now();
    const results = await env.DB.batch([
        env.DB.prepare(
            `DELETE FROM group_leaders WHERE account_id=?
      AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND role='admin')`,
        ).bind(id, id),
        env.DB.prepare(
            `UPDATE accounts SET role='player' WHERE id=? AND role='admin'
      AND EXISTS(SELECT 1 FROM account_approvals WHERE account_id=? AND status='approved')
      AND NOT EXISTS(SELECT 1 FROM group_leaders WHERE account_id=?)`,
        ).bind(id, id, id),
        env.DB.prepare(
            `INSERT OR IGNORE INTO group_leaders(group_id,account_id,created_at)
      SELECT a.group_id,a.id,? FROM accounts a
      WHERE a.id=? AND a.role='player' AND a.group_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM group_leaders gl WHERE gl.group_id=a.group_id)
        AND NOT EXISTS(SELECT 1 FROM group_leaders own WHERE own.account_id=a.id)`,
        ).bind(timestamp, id),
    ]);
    return !!results[1]?.meta.changes;
}

export async function handleAdminRoleRoutes(
    request: Request,
    env: AdminAccountsEnv,
    deps: AdminAccountsDeps,
): Promise<Response | null> {
    const url = new URL(request.url);
    const listing = url.pathname === '/api/admin/people';
    const match = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/role$/);
    if (!listing && !match) return null;
    const actor = await deps.currentAccount(request);
    if (!actor) return json({ error: 'Sign in required.' }, 401);
    if (!(await approvedAdmin(env, actor)))
        return json({ error: 'Approved administrator access required.' }, 403);

    if (listing) {
        if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
        const email = headAdminEmail(env);
        const rows = await env.DB.prepare(
            `SELECT ${personColumns}
      FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
      WHERE aa.status='approved'
      ORDER BY head_admin DESC,CASE WHEN a.role='admin' THEN 0 ELSE 1 END,a.display_name COLLATE NOCASE,a.username COLLATE NOCASE
      LIMIT 500`,
        )
            .bind(email, email, email)
            .all<any>();
        return json({ people: rows.results.map(person) });
    }

    if (request.method !== 'PUT') return json({ error: 'Method not allowed.' }, 405);
    let body: any;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Invalid request body.' }, 400);
    }
    if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        (body.role !== 'admin' && body.role !== 'player')
    ) {
        return json({ error: 'Choose whether the account should be an administrator or a player.' }, 400);
    }
    const targetId = decodeURIComponent(match![1]);
    if (targetId === actor.id) return json({ error: 'You cannot change your own administrator role.' }, 400);
    const target = await env.DB.prepare(
        `SELECT a.role,aa.status FROM accounts a
    JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=?`,
    )
        .bind(targetId)
        .first<any>();
    if (!target || target.status !== 'approved') return json({ error: 'Approved account not found.' }, 404);
    if (await isHeadAdmin(env, targetId))
        return json({ error: 'The Manhunt head administrator account cannot be modified.' }, 403);
    if (target.role === body.role) {
        const current = await loadPerson(env, targetId);
        return current ? json({ person: current }) : json({ error: 'Approved account not found.' }, 404);
    }

    let changed: boolean;
    try {
        changed =
            body.role === 'admin' ? await promotePerson(env, targetId) : await demotePerson(env, targetId);
    } catch {
        return json({ error: 'The administrator role could not be changed.' }, 500);
    }
    const updated = await loadPerson(env, targetId);
    if (!updated) return json({ error: 'Approved account not found.' }, 404);
    if (!changed && updated.role !== body.role)
        return json({ error: 'The account changed. Refresh and try again.' }, 409);
    return json({ person: updated });
}
