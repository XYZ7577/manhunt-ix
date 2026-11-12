import type { Account } from '../../shared/types';
import type { GroupInvitationView, GroupMemberView, GroupMembersResponse } from '../../shared/groups/members';
import { verifyGroupDisbandCode, disbandEmailStatus, sendGroupDisbandCode } from './groupDisbandVerification';
import type { GroupDisbandVerificationEnv, GroupDisbandVerificationDeps } from './groupDisbandVerification';
import { getEmailConfiguration, sendEmail } from '../email/email';
import { groupInvitationEmail } from '../email/emailTemplates';
import {
    GROUP_MERGING_OPEN_SQL,
    GROUP_MERGING_PAUSED_MESSAGE,
    groupMergingEnabled,
} from './groupMergingSettings';

export type GroupMembershipEnv = GroupDisbandVerificationEnv;
export interface GroupMembershipDeps extends GroupDisbandVerificationDeps {
    currentAccount(request: Request, env: GroupMembershipEnv): Promise<Account | null>;
    sessionAccount?(request: Request, env: GroupMembershipEnv): Promise<Account | null>;
}

const MAX_MEMBERS = 12;
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_EMAIL_LEASE_MS = 2 * 60_000;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(data, {
        status,
        headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', ...headers },
    });
const fail = (error: string, status = 400) => json({ error }, status);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const validEmail = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.trim().length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const base64url = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
async function hashInviteToken(token: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type GroupRow = { id: string; name: string };
type LeaderRow = { account_id: string };
type MemberRow = {
    id: string;
    display_name: string;
    username?: string;
    email?: string | null;
    phone?: string | null;
};
type InvitationRow = {
    id: string;
    email: string;
    created_at: string;
    expires_at: string;
    token_hash?: string | null;
    email_delivery: GroupInvitationView['emailDelivery'];
};

async function allowInvitationEmail(
    env: GroupMembershipEnv,
    actorId: string,
    email: string,
): Promise<boolean> {
    if (!getEmailConfiguration(env)) return true;
    const timestamp = now(),
        expires = new Date(Date.now() + 15 * 60_000).toISOString();
    for (const [key, limit] of [
        [`actor:${actorId}`, 30],
        [`recipient:${email}`, 3],
    ] as const) {
        const row = await env.DB.prepare(
            `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET count=CASE WHEN auth_rate_buckets.expires_at<=? THEN 1 ELSE auth_rate_buckets.count+1 END,
      expires_at=CASE WHEN auth_rate_buckets.expires_at<=? THEN excluded.expires_at ELSE auth_rate_buckets.expires_at END
      RETURNING count`,
        )
            .bind(`group-invitation:${key}`, expires, timestamp, timestamp)
            .first<{ count: number }>();
        if (!row || row.count > limit) return false;
    }
    return true;
}

async function deliverInvitation(
    env: GroupMembershipEnv,
    deps: GroupMembershipDeps,
    invitationId: string,
    tokenHash: string,
    joinUrl: string,
) {
    const invitation = await env.DB.prepare(
        `SELECT gi.email,gi.expires_at,g.name,a.display_name AS inviter_name
    FROM group_invitations gi JOIN groups g ON g.id=gi.group_id JOIN accounts a ON a.id=gi.invited_by
    WHERE gi.id=? AND gi.token_hash=? AND gi.status='pending' AND gi.expires_at>?
      AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gi.group_id)`,
    )
        .bind(invitationId, tokenHash, now())
        .first<{ email: string; expires_at: string; name: string; inviter_name: string }>();
    if (!invitation) return 'failed' as const;
    const emailDelivery = !getEmailConfiguration(env)
        ? 'not_available'
        : (await sendEmail(
                env,
                groupInvitationEmail(
                    invitation.email,
                    invitation.inviter_name,
                    invitation.name,
                    joinUrl,
                    invitation.expires_at,
                ),
                deps.providerFetch,
            ))
          ? 'sent'
          : 'failed';
    await env.DB.prepare(
        `UPDATE group_invitations SET email_delivery=? WHERE id=? AND token_hash=? AND status='pending'`,
    )
        .bind(emailDelivery, invitationId, tokenHash)
        .run();
    return emailDelivery;
}

function isManager(account: Account, leaderAccountId: string | null) {
    return account.role === 'admin' || account.id === leaderAccountId;
}

async function groupState(env: GroupMembershipEnv, account: Account, groupId: string) {
    const group = await env.DB.prepare(
        `SELECT g.id,g.name,EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=g.id) AS disbanded
    FROM groups g WHERE g.id=?`,
    )
        .bind(groupId)
        .first<GroupRow & { disbanded: number }>();
    if (!group) return { error: fail('Group not found.', 404) } as const;
    if (account.role !== 'admin' && (account.role !== 'player' || account.groupId !== groupId)) {
        return { error: fail('You cannot view or manage this group.', 403) } as const;
    }
    const leader = await env.DB.prepare('SELECT account_id FROM group_leaders WHERE group_id=?')
        .bind(groupId)
        .first<LeaderRow>();
    const active = !group.disbanded;
    return {
        group,
        leaderAccountId: leader?.account_id ?? null,
        disbanded: !active,
        canManageMembers: active && isManager(account, leader?.account_id ?? null),
    } as const;
}

async function listMembers(
    request: Request,
    env: GroupMembershipEnv,
    account: Account,
    groupId: string,
): Promise<Response> {
    const state = await groupState(env, account, groupId);
    if (state.error) return state.error;
    if (state.canManageMembers) {
        await env.DB.prepare(
            "UPDATE group_invitations SET status='expired' WHERE group_id=? AND status='pending' AND expires_at<=?",
        )
            .bind(groupId, now())
            .run();
    }
    const rows = state.canManageMembers
        ? await env.DB.prepare(
              `SELECT a.id,a.display_name,a.username,
        COALESCE((SELECT e.email FROM account_emails e WHERE e.account_id=a.id AND e.verified_at IS NOT NULL ORDER BY e.is_primary DESC,e.created_at LIMIT 1),
          (SELECT fi.identifier FROM federated_identities fi WHERE fi.account_id=a.id AND fi.provider='google' ORDER BY fi.created_at LIMIT 1)) AS email
        ${account.role === 'admin' ? ',(SELECT c.phone FROM account_contacts c WHERE c.account_id=a.id) AS phone' : ''}
      FROM accounts a WHERE a.group_id=? AND a.role='player' ORDER BY a.created_at,a.username COLLATE NOCASE,a.id`,
          )
              .bind(groupId)
              .all<MemberRow>()
        : await env.DB.prepare(
              "SELECT a.id,a.display_name FROM accounts a WHERE a.group_id=? AND a.role='player' ORDER BY a.created_at,a.username COLLATE NOCASE,a.id",
          )
              .bind(groupId)
              .all<MemberRow>();
    const members: GroupMemberView[] = rows.results.map((row) => ({
        accountId: row.id,
        displayName: row.display_name,
        role: row.id === state.leaderAccountId ? 'leader' : 'member',
        ...(state.canManageMembers && row.username && !/^(google:|sms:)/.test(row.username)
            ? { username: row.username }
            : {}),
        ...(state.canManageMembers && row.email ? { email: row.email } : {}),
        ...(account.role === 'admin' ? { phone: row.phone ?? null } : {}),
    }));
    const inviteRows = state.canManageMembers
        ? await env.DB.prepare(
              "SELECT id,email,created_at,expires_at,token_hash,email_delivery FROM group_invitations WHERE group_id=? AND status='pending' AND expires_at>? ORDER BY created_at,id",
          )
              .bind(groupId, now())
              .all<InvitationRow>()
        : { results: [] as InvitationRow[] };
    const invitations: GroupInvitationView[] = inviteRows.results.map((row) => ({
        id: row.id,
        email: row.email,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        joinLinkAvailable: !!row.token_hash,
        emailDelivery: row.email_delivery,
    }));
    const response: GroupMembersResponse = {
        group: { id: state.group.id, name: state.group.name },
        currentAccountId: account.id,
        leaderAccountId: state.leaderAccountId,
        canManageMembers: state.canManageMembers,
        disbanded: state.disbanded,
        ...(account.role === 'player' && account.id === state.leaderAccountId && !state.disbanded
            ? await disbandEmailStatus(env, account.id)
            : {}),
        members,
        invitations,
        maxMembers: MAX_MEMBERS,
    };
    return json(response);
}

async function inviteMember(
    request: Request,
    env: GroupMembershipEnv,
    deps: GroupMembershipDeps,
    account: Account,
    groupId: string,
): Promise<Response> {
    const state = await groupState(env, account, groupId);
    if (state.error) return state.error;
    if (!state.canManageMembers) return fail('Only the group leader or an admin can invite members.', 403);
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return fail('Enter a valid email address.');
    }
    const emailValue =
        body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>).email
            : null;
    if (!validEmail(emailValue)) return fail('Enter a valid email address.');
    const email = emailValue.trim().toLowerCase();
    const timestamp = now();
    const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS).toISOString();

    await env.DB.prepare(
        "UPDATE group_invitations SET status='expired' WHERE status='pending' AND expires_at<=?",
    )
        .bind(timestamp)
        .run();

    const linkedGoogle = await env.DB.prepare(
        `SELECT a.id,a.group_id,a.role,
      (SELECT COUNT(*) FROM accounts member WHERE member.group_id=a.group_id AND member.role='player') AS player_count
    FROM federated_identities fi JOIN accounts a ON a.id=fi.account_id
    WHERE fi.provider='google' AND fi.identifier=? COLLATE NOCASE LIMIT 1`,
    )
        .bind(email)
        .first<{ id: string; group_id: string | null; role: string; player_count: number }>();
    if (linkedGoogle) {
        if (linkedGoogle.group_id === groupId)
            return fail('That Google account is already a member of this group.', 409);
        if (linkedGoogle.role !== 'player')
            return fail('Only player accounts can be invited to a group.', 409);
        if (linkedGoogle.player_count > 1)
            return fail(
                "That account's current group has more than one player. It cannot join another group.",
                409,
            );
    }
    const existingMember = await env.DB.prepare(
        `SELECT a.id FROM accounts a WHERE a.group_id=? AND a.role='player' AND (
      a.username=? COLLATE NOCASE OR EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=a.id AND e.email=? COLLATE NOCASE)
    ) LIMIT 1`,
    )
        .bind(groupId, email, email)
        .first<{ id: string }>();
    if (existingMember) return fail('That email already belongs to a member of this group.', 409);
    const oldInvite = await env.DB.prepare(
        "SELECT id,group_id FROM group_invitations WHERE email=? COLLATE NOCASE AND status='pending' AND expires_at>? LIMIT 1",
    )
        .bind(email, timestamp)
        .first<{ id: string; group_id: string }>();
    if (oldInvite)
        return fail(
            oldInvite.group_id === groupId
                ? 'That email already has a pending invitation.'
                : 'That email already has a pending invitation to another group.',
            409,
        );

    const invitationId = id();
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await hashInviteToken(token);
    if (!(await allowInvitationEmail(env, account.id, email)))
        return fail('Too many invitation emails. Wait 15 minutes before sending another.', 429);
    try {
        const inserted = await env.DB.prepare(
            `INSERT INTO group_invitations(id,group_id,email,invited_by,created_at,expires_at,status,token_hash,email_delivery,email_attempted_at)
      SELECT ?,g.id,?,?,?,?,'pending',?,'sending',? FROM groups g JOIN accounts actor ON actor.id=?
      WHERE g.id=?
        AND (actor.role='admin' OR EXISTS(SELECT 1 FROM group_leaders gl WHERE gl.group_id=g.id AND gl.account_id=actor.id))
        AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=g.id)
        AND (SELECT COUNT(*) FROM accounts a WHERE a.group_id=g.id AND a.role='player')
          +(SELECT COUNT(*) FROM group_invitations gi WHERE gi.group_id=g.id AND gi.status='pending' AND gi.expires_at>?) < ?
        AND NOT EXISTS(SELECT 1 FROM federated_identities fi JOIN accounts a ON a.id=fi.account_id WHERE fi.provider='google' AND fi.identifier=? COLLATE NOCASE
          AND (a.role<>'player' OR a.group_id=g.id
            OR (SELECT COUNT(*) FROM accounts member WHERE member.group_id=a.group_id AND member.role='player')>1))
        AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.group_id=g.id AND a.role='player' AND (a.username=? COLLATE NOCASE OR EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=a.id AND e.email=? COLLATE NOCASE)))`,
        )
            .bind(
                invitationId,
                email,
                account.id,
                timestamp,
                expiresAt,
                tokenHash,
                timestamp,
                account.id,
                groupId,
                timestamp,
                MAX_MEMBERS,
                email,
                email,
                email,
            )
            .run();
        if (!inserted.meta.changes)
            return fail('The group is full or its membership changed. Refresh and try again.', 409);
    } catch {
        return fail('That email already has a pending invitation.', 409);
    }
    const joinUrl = new URL('/join', request.url);
    joinUrl.searchParams.set('invite', invitationId);
    joinUrl.hash = `token=${token}`;
    const emailDelivery = await deliverInvitation(env, deps, invitationId, tokenHash, joinUrl.href);
    return json(
        {
            invitation: {
                id: invitationId,
                email,
                createdAt: timestamp,
                expiresAt,
                joinLinkAvailable: true,
                emailDelivery,
            },
            joinPath: `${joinUrl.pathname}${joinUrl.search}${joinUrl.hash}`,
            emailDelivery,
            message: `${emailDelivery === 'sent' ? 'Invitation email sent. You can also share the link or QR code.' : 'Invitation created, but its email could not be sent. Share the link or QR code, or resend the invitation.'} The player can sign in with any account to join.`,
        },
        201,
    );
}

async function refreshInvitationLink(
    request: Request,
    env: GroupMembershipEnv,
    deps: GroupMembershipDeps,
    account: Account,
    groupId: string,
    invitationId: string,
): Promise<Response> {
    const state = await groupState(env, account, groupId);
    if (state.error) return state.error;
    if (!state.canManageMembers)
        return fail('Only the group leader or an admin can create invitation links.', 403);
    const pending = await env.DB.prepare(
        `SELECT email,email_delivery,email_attempted_at FROM group_invitations WHERE id=? AND group_id=? AND status='pending' AND expires_at>?`,
    )
        .bind(invitationId, groupId, now())
        .first<{ email: string; email_delivery: string; email_attempted_at: string | null }>();
    if (!pending) return fail('Pending invitation not found or expired.', 404);
    const leaseCutoff = new Date(Date.now() - INVITATION_EMAIL_LEASE_MS).toISOString();
    if (
        pending.email_delivery === 'sending' &&
        pending.email_attempted_at &&
        pending.email_attempted_at > leaseCutoff
    ) {
        return fail('This invitation email is still being sent. Wait a moment before resending.', 409);
    }
    if (!(await allowInvitationEmail(env, account.id, pending.email)))
        return fail('Too many invitation emails. Wait 15 minutes before sending another.', 429);
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await hashInviteToken(token);
    const updated = await env.DB.prepare(
        `UPDATE group_invitations SET token_hash=?,email_delivery='sending',email_attempted_at=?
    WHERE id=? AND group_id=? AND status='pending' AND expires_at>?
      AND (email_delivery<>'sending' OR email_attempted_at IS NULL OR email_attempted_at<=?)
      AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=group_invitations.group_id)
      AND EXISTS(SELECT 1 FROM accounts actor WHERE actor.id=? AND (actor.role='admin' OR EXISTS(SELECT 1 FROM group_leaders gl WHERE gl.group_id=? AND gl.account_id=actor.id)))`,
    )
        .bind(tokenHash, now(), invitationId, groupId, now(), leaseCutoff, account.id, groupId)
        .run();
    if (!updated.meta.changes)
        return fail('The invitation is being sent or changed. Refresh and try again.', 409);
    const joinUrl = new URL('/join', request.url);
    joinUrl.searchParams.set('invite', invitationId);
    joinUrl.hash = `token=${token}`;
    const emailDelivery = await deliverInvitation(env, deps, invitationId, tokenHash, joinUrl.href);
    return json({ joinPath: `${joinUrl.pathname}${joinUrl.search}${joinUrl.hash}`, emailDelivery });
}

async function readJoinInvitation(
    request: Request,
    env: GroupMembershipEnv,
    account: Account | null,
): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/api\/invitations\/([^/]+)$/);
    if (!match) return fail('Invitation not found or expired.', 404);
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return fail('Invitation not found or expired.', 404);
    }
    const token =
        body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>).token
            : '';
    if (typeof token !== 'string') return fail('Invitation not found or expired.', 404);
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return fail('Invitation not found or expired.', 404);
    let invitationId: string;
    try {
        invitationId = decodeURIComponent(match[1]);
    } catch {
        return fail('Invitation not found or expired.', 404);
    }
    const row = await env.DB.prepare(
        `SELECT g.id AS group_id,g.name AS group_name,a.display_name AS inviter_name,gi.expires_at,gi.status,gi.accepted_by FROM group_invitations gi
    JOIN groups g ON g.id=gi.group_id JOIN accounts a ON a.id=gi.invited_by WHERE gi.id=? AND gi.token_hash=?
      AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gi.group_id)
      AND (gi.status='accepted' OR (gi.status='pending' AND gi.expires_at>?))`,
    )
        .bind(invitationId, await hashInviteToken(token), now())
        .first<{
            group_id: string;
            group_name: string;
            inviter_name: string;
            expires_at: string;
            status: string;
            accepted_by: string | null;
        }>();
    if (!row) return fail('Invitation not found or expired.', 404);
    const joined = account?.role === 'player' && account.groupId === row.group_id;
    const accepted = row.status === 'accepted';
    return json(
        {
            groupName: row.group_name,
            inviterName: row.inviter_name,
            expiresAt: row.expires_at,
            joined,
            accepted,
            signedInToDifferentGroup: !!account?.groupId && !joined && account.groupId !== row.group_id,
            mergingPaused: !(await groupMergingEnabled(env)),
        },
        200,
        { 'Referrer-Policy': 'no-referrer' },
    );
}

type AcceptInviteRow = {
    group_id: string;
    group_name: string;
    expires_at: string;
    status: string;
    accepted_by: string | null;
    token_hash: string | null;
};
type JoinAccountRow = {
    id: string;
    role: string;
    group_id: string | null;
    display_name: string;
    created_at: string;
    approval_status: string | null;
};

async function acceptJoinInvitation(
    request: Request,
    env: GroupMembershipEnv,
    account: Account | null,
): Promise<Response> {
    if (!account) return fail('Sign in required.', 401);
    if (account.role !== 'player') return fail('Only player accounts can accept an invitation.', 403);
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return fail('Invitation not found or expired.', 404);
    }
    const values =
        body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const token = values.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(token))
        return fail('Invitation not found or expired.', 404);
    const match = new URL(request.url).pathname.match(/^\/api\/invitations\/([^/]+)\/accept$/);
    let invitationId: string;
    try {
        invitationId = decodeURIComponent(match![1]);
    } catch {
        return fail('Invitation not found or expired.', 404);
    }
    const timestamp = now();
    const invite = await env.DB.prepare(
        `SELECT gi.group_id,g.name AS group_name,gi.expires_at,gi.status,gi.accepted_by,gi.token_hash
    FROM group_invitations gi JOIN groups g ON g.id=gi.group_id WHERE gi.id=? AND gi.token_hash=?
      AND (gi.status='accepted' OR (gi.status='pending' AND gi.expires_at>?))`,
    )
        .bind(invitationId, await hashInviteToken(token), timestamp)
        .first<AcceptInviteRow>();
    if (!invite) return fail('Invitation not found or expired.', 404);
    const joiner = await env.DB.prepare(
        `SELECT a.id,a.role,a.group_id,a.display_name,a.created_at,aa.status AS approval_status
    FROM accounts a LEFT JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=?`,
    )
        .bind(account.id)
        .first<JoinAccountRow>();
    if (
        !joiner ||
        joiner.role !== 'player' ||
        !['pending', 'approved'].includes(joiner.approval_status ?? '')
    ) {
        return fail('This account cannot accept invitations.', 403);
    }
    if (invite.status === 'accepted') {
        if (invite.accepted_by === account.id && joiner.group_id === invite.group_id) {
            return json({ joined: true, groupId: invite.group_id, groupName: invite.group_name }, 200, {
                'Referrer-Policy': 'no-referrer',
            });
        }
        return fail('This invitation has already been used.', 409);
    }
    if (joiner.group_id === invite.group_id)
        return fail('This account is already in the invited group.', 409);
    if (!(await groupMergingEnabled(env)))
        return json({ error: GROUP_MERGING_PAUSED_MESSAGE, code: 'group_merging_paused' }, 403);

    const source = joiner.group_id
        ? await env.DB.prepare(
              `SELECT g.id,g.name,g.members_json,g.created_at,
      (SELECT COUNT(*) FROM accounts a WHERE a.group_id=g.id) AS account_count,
      (SELECT COUNT(*) FROM accounts a WHERE a.group_id=g.id AND a.role='player') AS player_count,
      (SELECT COUNT(*) FROM submissions s WHERE s.group_id=g.id) AS submission_count,
      (SELECT COUNT(*) FROM group_invitations gi WHERE gi.group_id=g.id) AS invitation_count,
      (SELECT gl.account_id FROM group_leaders gl WHERE gl.group_id=g.id) AS leader_id
    FROM groups g WHERE g.id=?`,
          )
              .bind(joiner.group_id)
              .first<{
                  id: string;
                  name: string;
                  members_json: string;
                  created_at: string;
                  account_count: number;
                  player_count: number;
                  submission_count: number;
                  invitation_count: number;
                  leader_id: string | null;
              }>()
        : null;
    if (source && source.player_count > 1)
        return fail('Your current group has more than one player. You cannot join another group.', 409);
    let members: unknown;
    try {
        members = JSON.parse(source?.members_json ?? 'null');
    } catch {
        members = null;
    }
    const displayNames = JSON.stringify([joiner.display_name]);
    const unusedDefault =
        !!source &&
        source.account_count === 1 &&
        source.leader_id === joiner.id &&
        JSON.stringify(members) === displayNames &&
        source.submission_count === 0 &&
        source.invitation_count === 0 &&
        source.created_at === joiner.created_at &&
        (source.name === joiner.display_name.slice(0, 60) ||
            source.name === `${joiner.display_name}'s group`.slice(0, 60));

    const eligibleSource = `EXISTS(SELECT 1 FROM groups sg WHERE sg.id=a.group_id AND sg.id<>gi.group_id
    AND (SELECT COUNT(*) FROM accounts sa WHERE sa.group_id=sg.id AND sa.role='player')<=1)`;
    const capacity = `(SELECT COUNT(*) FROM accounts ta WHERE ta.group_id=gi.group_id AND ta.role='player')
    +(SELECT COUNT(*) FROM group_invitations ti WHERE ti.group_id=gi.group_id AND ti.status='pending' AND ti.expires_at>? AND ti.id<>gi.id) < ${MAX_MEMBERS}`;
    const guard = env.DB.prepare(
        `INSERT INTO group_leaders(group_id,account_id,created_at)
    SELECT 'invalid-invitation-claim',NULL,? WHERE NOT EXISTS(
      SELECT 1 FROM group_invitations gi JOIN accounts a ON a.id=? JOIN account_approvals aa ON aa.account_id=a.id
      WHERE gi.id=? AND gi.group_id=? AND gi.token_hash=? AND gi.status='pending' AND gi.expires_at>?
        AND ${GROUP_MERGING_OPEN_SQL}
        AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gi.group_id)
        AND a.role='player' AND aa.status IN ('pending','approved') AND (a.group_id IS NULL OR (a.group_id<>gi.group_id AND ${eligibleSource}))
        AND ${capacity})`,
    ).bind(timestamp, account.id, invitationId, invite.group_id, invite.token_hash, timestamp, timestamp);
    const delSrcLeader = env.DB.prepare(
        `DELETE FROM group_leaders WHERE group_id=? AND account_id=?
    AND EXISTS(SELECT 1 FROM accounts a JOIN groups sg ON sg.id=a.group_id WHERE a.id=? AND a.group_id=?
      AND sg.id<>? AND (SELECT COUNT(*) FROM accounts sa WHERE sa.group_id=sg.id AND sa.role='player')<=1)`,
    ).bind(joiner.group_id, account.id, account.id, joiner.group_id, invite.group_id);
    const moveAccount = env.DB.prepare(
        `UPDATE accounts SET group_id=? WHERE id=? AND role='player'
    AND ${GROUP_MERGING_OPEN_SQL}
    AND (accounts.group_id IS NULL OR (accounts.group_id=?
    AND EXISTS(SELECT 1 FROM account_approvals aa WHERE aa.account_id=accounts.id AND aa.status IN ('pending','approved'))
    AND NOT EXISTS(SELECT 1 FROM group_leaders gl WHERE gl.group_id=accounts.group_id AND gl.account_id=accounts.id)
    AND EXISTS(SELECT 1 FROM group_invitations gi JOIN accounts a ON a.id=accounts.id
      WHERE gi.id=? AND gi.group_id=? AND gi.token_hash=? AND gi.status='pending' AND gi.expires_at>?
        AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gi.group_id) AND ${eligibleSource})))
    AND EXISTS(SELECT 1 FROM account_approvals aa WHERE aa.account_id=accounts.id AND aa.status IN ('pending','approved'))
    AND EXISTS(SELECT 1 FROM group_invitations gi WHERE gi.id=? AND gi.group_id=? AND gi.token_hash=? AND gi.status='pending' AND gi.expires_at>?
      AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gi.group_id)
      AND (SELECT COUNT(*) FROM accounts ta WHERE ta.group_id=gi.group_id AND ta.role='player')
        +(SELECT COUNT(*) FROM group_invitations ti WHERE ti.group_id=gi.group_id AND ti.status='pending' AND ti.expires_at>? AND ti.id<>gi.id) < ${MAX_MEMBERS})`,
    ).bind(
        invite.group_id,
        account.id,
        joiner.group_id,
        invitationId,
        invite.group_id,
        invite.token_hash,
        timestamp,
        invitationId,
        invite.group_id,
        invite.token_hash,
        timestamp,
        timestamp,
    );
    const consumeInvite = env.DB.prepare(
        `UPDATE group_invitations AS gi SET status='accepted',accepted_at=?,accepted_by=?
    WHERE gi.id=? AND gi.group_id=? AND gi.token_hash=? AND gi.status='pending' AND gi.expires_at>?
      AND ${GROUP_MERGING_OPEN_SQL}
      AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gi.group_id)
      AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=? AND a.group_id=gi.group_id AND a.role='player')
      AND EXISTS(SELECT 1 FROM account_approvals aa WHERE aa.account_id=? AND aa.status IN ('pending','approved'))
      AND (SELECT COUNT(*) FROM accounts ta WHERE ta.group_id=gi.group_id AND ta.role='player')
        +(SELECT COUNT(*) FROM group_invitations ti WHERE ti.group_id=gi.group_id AND ti.status='pending' AND ti.expires_at>? AND ti.id<>gi.id) <= ${MAX_MEMBERS}`,
    ).bind(
        timestamp,
        account.id,
        invitationId,
        invite.group_id,
        invite.token_hash,
        timestamp,
        account.id,
        account.id,
        timestamp,
    );
    const ensureDstLeader = env.DB.prepare(
        `INSERT INTO group_leaders(group_id,account_id,created_at)
    SELECT gi.group_id,(SELECT a.id FROM accounts a WHERE a.group_id=gi.group_id AND a.role='player'
      ORDER BY a.created_at,a.username COLLATE NOCASE,a.id LIMIT 1),?
    FROM group_invitations gi JOIN accounts joiner ON joiner.id=gi.accepted_by
    WHERE gi.id=? AND gi.status='accepted' AND gi.accepted_by=? AND joiner.group_id=gi.group_id
      AND NOT EXISTS(SELECT 1 FROM group_leaders gl WHERE gl.group_id=gi.group_id)`,
    ).bind(timestamp, invitationId, account.id);
    const delEmptySrc = env.DB.prepare(
        `DELETE FROM groups WHERE id=? AND NOT EXISTS(SELECT 1 FROM accounts WHERE group_id=groups.id)
    AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=? AND groups.created_at=a.created_at
      AND groups.name IN (substr(a.display_name,1,60),substr(a.display_name||'''s group',1,60))
      AND groups.members_json=json_array(a.display_name))
    AND NOT EXISTS(SELECT 1 FROM submissions WHERE group_id=groups.id)
    AND NOT EXISTS(SELECT 1 FROM group_invitations WHERE group_id=groups.id)
    AND NOT EXISTS(SELECT 1 FROM group_disbands WHERE group_id=groups.id)
    AND NOT EXISTS(SELECT 1 FROM group_deletions WHERE group_id=groups.id)`,
    ).bind(unusedDefault ? joiner.group_id : null, account.id);
    const clearSelfReq = env.DB.prepare(
        `DELETE FROM account_group_requests WHERE account_id=?
    AND EXISTS(SELECT 1 FROM group_invitations gi JOIN accounts a ON a.id=gi.accepted_by
      WHERE gi.id=? AND gi.group_id=? AND gi.status='accepted' AND gi.accepted_by=? AND a.group_id=gi.group_id
        AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gi.group_id))`,
    ).bind(account.id, invitationId, invite.group_id, account.id);
    const completeGuard = env.DB.prepare(
        `INSERT INTO group_leaders(group_id,account_id,created_at)
    SELECT 'invalid-invitation-claim',NULL,? WHERE NOT EXISTS(SELECT 1 FROM group_invitations gi JOIN accounts a ON a.id=gi.accepted_by
      WHERE gi.id=? AND gi.status='accepted' AND gi.accepted_by=? AND a.group_id=gi.group_id
        AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=gi.group_id))`,
    ).bind(timestamp, invitationId, account.id);
    try {
        await env.DB.batch([
            guard,
            delSrcLeader,
            moveAccount,
            consumeInvite,
            ensureDstLeader,
            delEmptySrc,
            clearSelfReq,
            completeGuard,
        ]);
    } catch {
        if (!(await groupMergingEnabled(env)))
            return json({ error: GROUP_MERGING_PAUSED_MESSAGE, code: 'group_merging_paused' }, 403);
        return fail('The invitation or group membership changed. Refresh and try again.', 409);
    }
    return json({ joined: true, groupId: invite.group_id, groupName: invite.group_name }, 200, {
        'Referrer-Policy': 'no-referrer',
    });
}

async function revokeInvitation(
    env: GroupMembershipEnv,
    account: Account,
    groupId: string,
    invitationId: string,
): Promise<Response> {
    const state = await groupState(env, account, groupId);
    if (state.error) return state.error;
    if (!state.canManageMembers)
        return fail('Only the group leader or an admin can revoke invitations.', 403);
    const result = await env.DB.prepare(
        `UPDATE group_invitations SET status='revoked'
    WHERE id=? AND group_id=? AND status='pending' AND expires_at>?
      AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=group_invitations.group_id)
      AND EXISTS(SELECT 1 FROM accounts actor WHERE actor.id=? AND (actor.role='admin' OR EXISTS(SELECT 1 FROM group_leaders gl WHERE gl.group_id=? AND gl.account_id=actor.id)))`,
    )
        .bind(invitationId, groupId, now(), account.id, groupId)
        .run();
    if (!result.meta.changes) return fail('Pending invitation not found.', 404);
    return json({ ok: true });
}

async function transferLeader(
    request: Request,
    env: GroupMembershipEnv,
    account: Account,
    groupId: string,
): Promise<Response> {
    const state = await groupState(env, account, groupId);
    if (state.error) return state.error;
    if (!state.canManageMembers)
        return fail('Only the group leader or an admin can transfer leadership.', 403);
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return fail('Choose a current leader and a new leader.');
    }
    const values =
        body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (typeof values.accountId !== 'string' || typeof values.previousLeaderAccountId !== 'string')
        return fail('Choose a current leader and a new leader.');
    const result = await env.DB.prepare(
        `UPDATE group_leaders SET account_id=?,created_at=?
    WHERE group_id=? AND account_id=?
      AND EXISTS(SELECT 1 FROM accounts target WHERE target.id=? AND target.group_id=? AND target.role='player')
      AND EXISTS(SELECT 1 FROM accounts actor WHERE actor.id=? AND (actor.role='admin' OR EXISTS(SELECT 1 FROM group_leaders current WHERE current.group_id=? AND current.account_id=actor.id)))`,
    )
        .bind(
            values.accountId,
            now(),
            groupId,
            values.previousLeaderAccountId,
            values.accountId,
            groupId,
            account.id,
            groupId,
        )
        .run();
    if (!result.meta.changes)
        return fail('The current leader or selected member changed. Refresh and try again.', 409);
    return json({ leaderAccountId: values.accountId });
}

export async function ensureGroupLeaders(db: D1Database): Promise<void> {
    await db
        .prepare(
            `INSERT INTO group_leaders(group_id,account_id,created_at)
    SELECT g.id, (SELECT a.id FROM accounts a WHERE a.group_id=g.id AND a.role='player'
      ORDER BY a.created_at,a.username COLLATE NOCASE,a.id LIMIT 1), g.created_at
    FROM groups g WHERE NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=g.id)
      AND EXISTS(SELECT 1 FROM accounts a WHERE a.group_id=g.id AND a.role='player')
    ON CONFLICT(group_id) DO NOTHING`,
        )
        .run();
}

async function disbandGroup(
    request: Request,
    env: GroupMembershipEnv,
    account: Account,
    groupId: string,
): Promise<Response> {
    if (account.role !== 'player') return fail('Only the current group leader can disband this group.', 403);
    const state = await groupState(env, account, groupId);
    if (state.error) return state.error;
    if (state.disbanded || state.leaderAccountId !== account.id)
        return fail('Only the current group leader can disband this group.', 403);
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return fail('Enter the 6-digit email verification code.');
    }
    const code =
        body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>).code
            : null;
    if (typeof code !== 'string') return fail('Enter the 6-digit email verification code.');
    const verified = await verifyGroupDisbandCode(env, account.id, groupId, code);
    if (!verified.ok) return fail(verified.error, verified.status);

    const timestamp = now();
    const ticket = env.DB.prepare(
        `INSERT INTO group_disbands(group_id,disbanded_by,disbanded_at)
    SELECT g.id,?,? FROM groups g JOIN accounts actor ON actor.id=?
    JOIN group_leaders gl ON gl.group_id=g.id AND gl.account_id=actor.id
    JOIN account_approvals aa ON aa.account_id=actor.id AND aa.status='approved'
    WHERE g.id=? AND actor.role='player' AND actor.group_id=g.id
      AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=g.id)
      AND EXISTS(SELECT 1 FROM group_disband_challenges c WHERE c.group_id=g.id AND c.account_id=actor.id AND c.challenge_id=?
        AND c.email_snapshot=? COLLATE NOCASE AND c.consumed_at=? AND c.expires_at>?)
      AND (EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=actor.id AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=actor.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE))`,
    ).bind(
        account.id,
        timestamp,
        account.id,
        groupId,
        verified.challengeId,
        verified.email,
        timestamp,
        timestamp,
        verified.email,
        verified.email,
    );
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                `UPDATE group_disband_challenges SET consumed_at=? WHERE group_id=? AND account_id=? AND challenge_id=?
        AND email_snapshot=? COLLATE NOCASE AND consumed_at IS NULL AND expires_at>? AND attempts<=5
        AND EXISTS(SELECT 1 FROM accounts actor JOIN account_approvals aa ON aa.account_id=actor.id AND aa.status='approved'
          JOIN group_leaders gl ON gl.group_id=group_disband_challenges.group_id AND gl.account_id=actor.id
          WHERE actor.id=group_disband_challenges.account_id AND actor.role='player' AND actor.group_id=group_disband_challenges.group_id
            AND NOT EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=group_disband_challenges.group_id)
            AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.account_id=actor.id)
            AND (EXISTS(SELECT 1 FROM account_emails e WHERE e.account_id=actor.id AND e.email=group_disband_challenges.email_snapshot COLLATE NOCASE AND e.verified_at IS NOT NULL)
              OR EXISTS(SELECT 1 FROM federated_identities f WHERE f.account_id=actor.id AND f.provider='google' AND f.identifier=group_disband_challenges.email_snapshot COLLATE NOCASE)))`,
            ).bind(timestamp, groupId, account.id, verified.challengeId, verified.email, timestamp),
            ticket,
            env.DB.prepare(
                `DELETE FROM group_leaders WHERE group_id=? AND EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=? AND d.disbanded_by=? AND d.disbanded_at=?)`,
            ).bind(groupId, groupId, account.id, timestamp),
            env.DB.prepare(
                `UPDATE accounts SET group_id=NULL WHERE group_id=? AND role='player'
        AND EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=? AND d.disbanded_by=? AND d.disbanded_at=?)`,
            ).bind(groupId, groupId, account.id, timestamp),
            env.DB.prepare(
                `UPDATE group_invitations SET status='revoked' WHERE group_id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=? AND d.disbanded_by=? AND d.disbanded_at=?)`,
            ).bind(groupId, groupId, account.id, timestamp),
            env.DB.prepare(
                `UPDATE upload_sessions SET state='aborted',lock_token=NULL,lock_expires_at=NULL
        WHERE state IN ('creating','uploading','completing') AND submission_id IN (SELECT id FROM submissions WHERE group_id=?)
          AND EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=? AND d.disbanded_by=? AND d.disbanded_at=?)`,
            ).bind(groupId, groupId, account.id, timestamp),
            env.DB.prepare(
                `UPDATE groups SET members_json='[]' WHERE id=?
        AND EXISTS(SELECT 1 FROM group_disbands d WHERE d.group_id=? AND d.disbanded_by=? AND d.disbanded_at=?)`,
            ).bind(groupId, groupId, account.id, timestamp),
        ]);
        if (!results[0]?.meta.changes || !results[1]?.meta.changes)
            return fail(
                'Group leadership or verified email changed, or the code expired. Request a new code.',
                409,
            );
    } catch {
        return fail(
            'Group leadership or verified email changed, or the code expired. Request a new code.',
            409,
        );
    }
    return json({ disbanded: true, groupId });
}

export async function handleGroupMembers(
    request: Request,
    env: GroupMembershipEnv,
    deps: GroupMembershipDeps,
): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const base = path.match(/^\/api\/groups\/([^/]+)\/members$/);
    const inviteMatch = path.match(/^\/api\/groups\/([^/]+)\/members\/invitations$/);
    const invitationItem = path.match(/^\/api\/groups\/([^/]+)\/members\/invitations\/([^/]+)$/);
    const invitationLink = path.match(/^\/api\/groups\/([^/]+)\/members\/invitations\/([^/]+)\/link$/);
    const leaderRoute = path.match(/^\/api\/groups\/([^/]+)\/members\/leader$/);
    const disbandCodeRoute = path.match(/^\/api\/groups\/([^/]+)\/members\/disband\/code$/);
    const disbandRoute = path.match(/^\/api\/groups\/([^/]+)\/members\/disband$/);
    if (/^\/api\/invitations\/[^/]+\/accept$/.test(path) && request.method === 'POST') {
        const sessionAccount = deps.sessionAccount
            ? await deps.sessionAccount(request, env)
            : await deps.currentAccount(request, env);
        return acceptJoinInvitation(request, env, sessionAccount);
    }
    if (/^\/api\/invitations\/[^/]+$/.test(path) && request.method === 'POST') {
        const sessionAccount = deps.sessionAccount
            ? await deps.sessionAccount(request, env)
            : await deps.currentAccount(request, env);
        return readJoinInvitation(request, env, sessionAccount);
    }
    if (
        !base &&
        !inviteMatch &&
        !invitationItem &&
        !invitationLink &&
        !leaderRoute &&
        !disbandRoute &&
        !disbandCodeRoute
    )
        return path.startsWith('/api/groups/') ? fail('Group endpoint not found.', 404) : null;
    const match =
        base ??
        inviteMatch ??
        invitationItem ??
        invitationLink ??
        leaderRoute ??
        disbandCodeRoute ??
        disbandRoute!;
    const groupId = decodeURIComponent(match[1]);
    const account = await deps.currentAccount(request, env);
    if (!account) return fail('Sign in required.', 401);
    if (base && request.method === 'GET') return listMembers(request, env, account, groupId);
    if (inviteMatch && request.method === 'POST') return inviteMember(request, env, deps, account, groupId);
    if (invitationLink && request.method === 'POST')
        return refreshInvitationLink(
            request,
            env,
            deps,
            account,
            groupId,
            decodeURIComponent(invitationLink[2]),
        );
    if (invitationItem && request.method === 'DELETE')
        return revokeInvitation(env, account, groupId, decodeURIComponent(invitationItem[2]));
    if (leaderRoute && request.method === 'POST') return transferLeader(request, env, account, groupId);
    if (disbandCodeRoute && request.method === 'POST') {
        if (account.role !== 'player')
            return fail('Only the current group leader can request a disband code.', 403);
        return sendGroupDisbandCode(request, env, deps, account, groupId);
    }
    if (disbandRoute && request.method === 'POST') return disbandGroup(request, env, account, groupId);
    return fail('Method not allowed.', 405);
}
