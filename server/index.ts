import { fileTypeFromBuffer } from 'file-type';
import exifr from 'exifr';
import { ARCHIVED_TASKS, getTaskDefinition, TASKS } from '../shared/event/tasks';
import {
    DIRECT_UPLOAD_MAX_BYTES,
    EVIDENCE_COMMENT_MAX_LENGTH,
    MAX_FILE_BYTES,
    MAX_FILES_PER_SUBMISSION,
    UPLOAD_PART_BYTES,
    type UploadSession,
} from '../shared/evidence/uploads';
import type {
    Account,
    Dashboard,
    DemoAccount,
    Evidence,
    Group,
    MetadataResult,
    Submission,
} from '../shared/types';
import { evaluatePhotoMetadata } from './evidence/metadata';
import { handleEvidenceFile } from './evidence/fileRoute';
import { parseCameraCapture, withCameraCapture } from './evidence/cameraCapture';
import { handleFederatedAuth, type FederatedAuthEnv } from './accounts/federatedAuth';
import { handleAccountSettings, type SettingsEnv } from './accounts/accountSettings';
import { handleAccountRecovery, type AccountRecoveryEnv } from './accounts/accountRecovery';
import { emailOtpAvailable, handleEmailSignIn } from './accounts/emailSignIn';
import { ensureGroupLeaders, handleGroupMembers } from './groups/groupMembership';
import { handleEvidencePreview } from './evidence/evidencePreviews';
import { handleImageMetadata } from './evidence/imageMetadata';
import { handleDraftNote } from './groups/draftNotes';
import { handleReviewNotifications, loadReviewInbox } from './notifications/reviewNotifications';
import {
    handlePushNotifications,
    processPushDeliveries,
    type PushEnv,
} from './notifications/pushNotifications';
import { processReviewEmails, type ReviewEmailEnv } from './notifications/reviewEmails';
import { handleAnnouncements, processDueAnnouncements } from './announcements/announcements';
import { processAnnouncementDeliveries } from './announcements/announcementDelivery';
import { publishDueGameResult } from './game/resultAnnouncement';
import { getAccountApproval, handleAccountApprovalRoutes } from './accounts/accountApproval';
import { handleAdminAccountCreation, handleAdminRoleRoutes } from './admin/adminAccounts';
import { handleAdminDeletion } from './admin/adminDeletion';
import { loadAdminDashboardSummary } from './admin/adminDashboard';
import { handleAdminSubQueries, handleSubReviews } from './admin/submissionRoutes';
import { privateError as fail, privateJson as json } from './http/responses';
import { PASSWORD_ERROR, USERNAME_ERROR, validPassword, validUsername } from '../shared/accounts/credentials';
import { normalizePhone, REGISTRATION_PHONE_ERROR } from '../shared/accounts/registrationPhone';
import {
    handleSubmissionSettings,
    isSubmissionWrite,
    loadSubmissionSettings,
    submissionsEnabled,
    SUBMISSIONS_OPEN_SQL,
    SUBMISSIONS_PAUSED_MESSAGE,
} from './evidence/submissionSettings';
import { handleGroupMergingSettings, loadGroupMergingSettings } from './groups/groupMergingSettings';
import { gameRoute, loadGameDash, isPlayerDead, DEAD_MESSAGE, GAME_WRITE_BLOCK_SQL } from './game/game';
import { processCaughtNotifications } from './notifications/caughtNotifications';
import { isLunchBreak, LUNCH_MESSAGE, LUNCH_START, LUNCH_END } from '../shared/event/taskAvailability';

interface Env extends FederatedAuthEnv, SettingsEnv, AccountRecoveryEnv, PushEnv, ReviewEmailEnv {
    EVIDENCE: R2Bucket;
    ASSETS: Fetcher;
    DEMO_MODE?: string;
}
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const ITERATIONS = 100_000;
const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
const COMPLETION_LOCK_MS = 10 * 60 * 1000;
const SAFE_IMAGE_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/gif',
    'image/avif',
]);
const SAFE_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const encoder = new TextEncoder();
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const hex = (bytes: Uint8Array) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');

async function digest(value: string) {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
async function passwordHash(password: string, salt?: Uint8Array) {
    const s: Uint8Array<ArrayBuffer> = new Uint8Array(salt ?? crypto.getRandomValues(new Uint8Array(16)));
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
        'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: s, iterations: ITERATIONS },
        key,
        256,
    );
    return { salt: b64(s), hash: b64(new Uint8Array(bits)) };
}
async function passwordMatches(password: string, salt: string, expected: string) {
    const actual = (await passwordHash(password, unb64(salt))).hash;
    const a = unb64(actual),
        b = unb64(expected);
    return a.length === b.length && a.reduce((acc, value, i) => acc | (value ^ b[i]), 0) === 0;
}

function account(row: any): Account {
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        groupId: row.group_id,
    };
}
function parseJson<T>(v: string): T {
    return JSON.parse(v) as T;
}
function parseEvidenceComment(value: unknown): string | null {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > EVIDENCE_COMMENT_MAX_LENGTH) return null;
    return value.trim();
}
function cookieName() {
    return 'manhunt_session';
}
function secure(request: Request) {
    return new URL(request.url).protocol === 'https:' ? '; Secure' : '';
}
function getCookie(request: Request, name: string) {
    return (
        request.headers
            .get('Cookie')
            ?.split(';')
            .map((p) => p.trim())
            .find((p) => p.startsWith(`${name}=`))
            ?.slice(name.length + 1) ?? null
    );
}
async function sessionAccount(request: Request, env: Env): Promise<Account | null> {
    const token = getCookie(request, cookieName());
    if (!token) return null;
    const row = await env.DB.prepare(
        'SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?',
    )
        .bind(await digest(token), now())
        .first<any>();
    if (!row || (env.DEMO_MODE !== 'true' && String(row.id).startsWith('demo-account-'))) return null;
    return account(row);
}
async function currentAccount(request: Request, env: Env): Promise<Account | null> {
    const me = await sessionAccount(request, env);
    if (!me) return null;
    const approval = await getAccountApproval(env.DB, me.id);
    return approval?.status === 'approved' ? me : null;
}
function assertSameOrigin(request: Request) {
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    if (fetchSite === 'cross-site') return false;
    const origin = request.headers.get('Origin');
    if (!origin || new URL(origin).origin === new URL(request.url).origin) return true;
    return (
        request.url.startsWith('http://') &&
        request.headers.get('Host')?.endsWith(':8787') &&
        ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(new URL(origin).origin)
    );
}
type SessionGuard = {
    securityVersion: number;
    passwordHash?: string;
    requireNoTotp?: boolean;
    emailSignIn?: {
        kind: 'google' | 'native';
        id: string;
        email: string;
        identifier: string;
        subject?: string;
    };
};
async function createSession(request: Request, env: Env, accountId: string, guard?: SessionGuard) {
    if (env.DEMO_MODE !== 'true' && accountId.startsWith('demo-account-'))
        throw new Error('Sample accounts are unavailable in normal mode.');
    const approval = await getAccountApproval(env.DB, accountId);
    if (!approval || (approval.status !== 'approved' && approval.status !== 'pending'))
        throw new Error('This account has not been approved.');
    const security =
        guard ??
        (await env.DB.prepare(
            'SELECT COALESCE(s.security_version,0) AS securityVersion FROM accounts a LEFT JOIN account_security s ON s.account_id=a.id WHERE a.id=?',
        )
            .bind(accountId)
            .first<{ securityVersion: number }>());
    if (!security) throw new Error('Account security changed. Sign in again.');
    const token = b64(crypto.getRandomValues(new Uint8Array(32)))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    const expires = new Date(Date.now() + SESSION_MS).toISOString();
    const identity = guard?.emailSignIn;
    const inserted = await env.DB.prepare(
        `INSERT INTO sessions(token_hash,account_id,expires_at,created_at)
    SELECT ?,a.id,?,? FROM accounts a LEFT JOIN account_security s ON s.account_id=a.id
    WHERE a.id=? AND COALESCE(s.security_version,0)=?
    AND (? IS NULL OR a.password_hash=?) AND (?=0 OR COALESCE(s.totp_enabled,0)=0)
    AND (? IS NULL OR
      (?='google' AND EXISTS(SELECT 1 FROM federated_identities f WHERE f.id=? AND f.account_id=a.id AND f.provider='google' AND f.subject IS ? AND f.identifier=? COLLATE NOCASE)) OR
      (?='native' AND EXISTS(SELECT 1 FROM account_emails e WHERE e.id=? AND e.account_id=a.id AND e.email=? COLLATE NOCASE AND e.verified_at IS NOT NULL AND a.registration_username=? COLLATE NOCASE)
        AND NOT EXISTS(SELECT 1 FROM federated_identities f WHERE f.provider='google' AND f.identifier=? COLLATE NOCASE AND f.account_id<>a.id)))`,
    )
        .bind(
            await digest(token),
            expires,
            now(),
            accountId,
            security.securityVersion,
            guard?.passwordHash ?? null,
            guard?.passwordHash ?? null,
            guard?.requireNoTotp === true ? 1 : 0,
            identity?.kind ?? null,
            identity?.kind ?? null,
            identity?.id ?? null,
            identity?.subject ?? null,
            identity?.identifier ?? null,
            identity?.kind ?? null,
            identity?.id ?? null,
            identity?.email ?? null,
            identity?.email ?? null,
            identity?.email ?? null,
        )
        .run();
    if (!inserted.meta.changes) throw new Error('Account security changed. Sign in again.');
    return `${cookieName()}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure(request)}`;
}
async function ensureDemo(env: Env) {
    if (env.DEMO_MODE !== 'true') return;
    const existing = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM accounts WHERE username IN ('player1','player2','player3','player4','player5','team1-1','team1-2','team2-1','team2-2','admin1','admin2')",
    ).first<{ n: number }>();
    if (existing?.n === 11) {
        await env.DB.prepare(
            "INSERT INTO account_approvals(account_id,status,requested_at) SELECT id,'approved',created_at FROM accounts WHERE id LIKE 'demo-account-%' ON CONFLICT(account_id) DO UPDATE SET status='approved'",
        ).run();
        await ensureGroupLeaders(env.DB);
        return;
    }
    const pass = await passwordHash('manhunt123');
    const team1 = 'demo-group-team1',
        team2 = 'demo-group-team2';
    const groupRows: Array<[string, string, string[]]> = [
        ...[1, 2, 3, 4, 5].map(
            (i) => [`demo-group-player${i}`, `Player ${i}`, [`Player ${i}`]] as [string, string, string[]],
        ),
        [team1, 'Team 1', ['Player 1', 'Player 2']],
        [team2, 'Team 2', ['Player 3', 'Player 4']],
    ];
    const statements: D1PreparedStatement[] = groupRows.map(([gid, name, members]) =>
        env.DB.prepare('INSERT OR IGNORE INTO groups(id,name,members_json,created_at) VALUES(?,?,?,?)').bind(
            gid,
            name,
            JSON.stringify(members),
            now(),
        ),
    );
    const records: Array<[string, string, string, string | null]> = [
        ...[1, 2, 3, 4, 5].map(
            (i) =>
                [`player${i}`, `Player ${i}`, 'player', `demo-group-player${i}`] as [
                    string,
                    string,
                    string,
                    string,
                ],
        ),
        ['team1-1', 'Team 1', 'player', team1],
        ['team1-2', 'Team 1', 'player', team1],
        ['team2-1', 'Team 2', 'player', team2],
        ['team2-2', 'Team 2', 'player', team2],
        ['admin1', 'Admin 1', 'admin', null],
        ['admin2', 'Admin 2', 'admin', null],
    ];
    for (const [username, display, role, gid] of records) {
        statements.push(
            env.DB.prepare(
                'INSERT OR IGNORE INTO accounts(id,username,display_name,role,group_id,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',
            ).bind(`demo-account-${username}`, username, display, role, gid, pass.salt, pass.hash, now()),
        );
    }
    await env.DB.batch(statements);
    await env.DB.prepare(
        "INSERT INTO account_approvals(account_id,status,requested_at) SELECT id,'approved',created_at FROM accounts WHERE id LIKE 'demo-account-%' ON CONFLICT(account_id) DO UPDATE SET status='approved'",
    ).run();
    await ensureGroupLeaders(env.DB);
}
async function loadDashboard(me: Account, env: Env): Promise<Dashboard> {
    const [submissionSettings, groupMergingSettings, game] = await Promise.all([
        loadSubmissionSettings(env, me),
        loadGroupMergingSettings(env, me),
        loadGameDash(env, me),
    ]);
    if (me.role === 'admin') {
        const summary = await loadAdminDashboardSummary(env);
        const submissions: Submission[] = summary.progress.map((item) => ({
            id: `${item.groupId}:${item.taskId}`,
            groupId: item.groupId,
            taskId: item.taskId,
            status: item.status,
            attempt: 0,
            note: '',
            reviewNote: null,
            createdAt: '',
            submittedAt: null,
            reviewedAt: null,
            evidence: [],
        }));
        return {
            account: me,
            group: null,
            tasks: TASKS,
            archivedTasks: ARCHIVED_TASKS,
            submissions,
            groups: summary.groups,
            demoMode: env.DEMO_MODE === 'true',
            uploads: [],
            adminPendingCount: summary.pendingCount,
            game,
            serverNow: now(),
            ...submissionSettings,
            ...groupMergingSettings,
        } as Dashboard;
    }
    if (me.groupId) {
        const timestamp = now();
        const expired = await env.DB.prepare(
            `SELECT u.*,s.task_id FROM upload_sessions u
      JOIN submissions s ON s.id=u.submission_id WHERE s.group_id=? AND s.status='draft'
      AND u.state IN ('creating','uploading','completing') AND u.expires_at<=?`,
        )
            .bind(me.groupId, timestamp)
            .all<any>();
        await recoverExpiredUploads(env, expired.results, timestamp);
    }
    const snapshotTime = now();
    const evidenceSql =
        'SELECT e.*,p.object_key AS preview_object_key FROM evidence e LEFT JOIN evidence_previews p ON p.evidence_id=e.id';
    const [groupRows, rows, evidenceRows, active, reviewInbox] = await Promise.all([
        env.DB.prepare('SELECT * FROM groups WHERE id=?').bind(me.groupId).all<any>(),
        env.DB.prepare('SELECT * FROM submissions WHERE group_id=? ORDER BY created_at DESC')
            .bind(me.groupId)
            .all<any>(),
        env.DB.prepare(
            `${evidenceSql} JOIN submissions s ON s.id=e.submission_id WHERE s.group_id=? ORDER BY e.uploaded_at,e.id`,
        )
            .bind(me.groupId)
            .all<any>(),
        env.DB.prepare(
            "SELECT u.* FROM upload_sessions u JOIN submissions s ON s.id=u.submission_id WHERE s.group_id=? AND s.status='draft' AND u.state IN ('creating','uploading','completing') AND u.expires_at>? ORDER BY u.created_at",
        )
            .bind(me.groupId, snapshotTime)
            .all<any>(),
        loadReviewInbox(env, me),
    ]);
    const groups: Group[] = groupRows.results.map((row) => ({
        id: row.id,
        name: row.name,
        members: parseJson(row.members_json),
    }));
    const evidenceBySub = new Map<string, Evidence[]>();
    for (const evidence of evidenceRows.results) {
        const list = evidenceBySub.get(evidence.submission_id) ?? [];
        list.push(shapeEvidence(evidence));
        evidenceBySub.set(evidence.submission_id, list);
    }
    const submissions: Submission[] = [];
    for (const row of rows.results) {
        submissions.push({
            id: row.id,
            groupId: row.group_id,
            taskId: row.task_id,
            status: row.status,
            attempt: row.attempt,
            note: row.note,
            reviewNote: row.review_note,
            createdAt: row.created_at,
            submittedAt: row.submitted_at,
            reviewedAt: row.reviewed_at,
            evidence: evidenceBySub.get(row.id) ?? [],
        });
    }
    const partsByUpload = new Map<string, any[]>();
    if (active.results.length) {
        const partQueries: Promise<D1Result<any>>[] = [];
        for (let offset = 0; offset < active.results.length; offset += 100) {
            const uploadIds = active.results.slice(offset, offset + 100).map((row) => row.id);
            partQueries.push(
                env.DB.prepare(
                    `SELECT p.upload_id,p.part_number,p.etag,p.size,p.sha256 FROM upload_parts p
        WHERE p.upload_id IN (${uploadIds.map(() => '?').join(',')}) AND p.state='uploaded'
        ORDER BY p.upload_id,p.part_number`,
                )
                    .bind(...uploadIds)
                    .all<any>(),
            );
        }
        for (const parts of await Promise.all(partQueries)) {
            for (const part of parts.results) {
                const list = partsByUpload.get(part.upload_id) ?? [];
                list.push(part);
                partsByUpload.set(part.upload_id, list);
            }
        }
    }
    const uploads = active.results.map((row) => shapeUploadSession(row, partsByUpload.get(row.id) ?? []));
    const archivedTasks = ARCHIVED_TASKS.filter((task) =>
        submissions.some((submission) => submission.taskId === task.id),
    );
    return {
        account: me,
        group: groups.find((g) => g.id === me.groupId) ?? null,
        tasks: TASKS,
        archivedTasks,
        submissions,
        groups: [],
        demoMode: env.DEMO_MODE === 'true',
        uploads,
        reviewInbox,
        game,
        serverNow: now(),
        ...submissionSettings,
        ...groupMergingSettings,
    };
}
function tooMany(request: Request) {
    return request.headers.get('CF-Connecting-IP') ?? 'local';
}
async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
    return request.body ? readBoundedStream(request.body, limit) : null;
}
async function readBoundedStream(
    stream: ReadableStream<Uint8Array>,
    limit: number,
): Promise<Uint8Array | null> {
    const reader = stream.getReader(),
        chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}
async function loginRateLimited(env: Env, key: string) {
    const current = await env.DB.prepare('SELECT count,window_started_at FROM login_attempts WHERE key=?')
        .bind(key)
        .first<any>();
    if (!current || Date.now() - Date.parse(current.window_started_at) > 15 * 60_000) {
        await env.DB.prepare(
            'INSERT OR REPLACE INTO login_attempts(key,count,window_started_at) VALUES(?,0,?)',
        )
            .bind(key, now())
            .run();
        return false;
    }
    return current.count >= 10;
}
async function recordLoginFailure(env: Env, key: string) {
    await env.DB.prepare('UPDATE login_attempts SET count=count+1 WHERE key=?').bind(key).run();
}
function looksLikeEmail(value: string) {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
async function registerNativeAccount(request: Request, env: Env, body: any): Promise<Response> {
    const identifier =
        typeof body?.identifier === 'string'
            ? body.identifier.trim()
            : typeof body?.username === 'string'
              ? body.username.trim()
              : '';
    const password = body?.password;
    const displayName =
        typeof body?.displayName === 'string' && body.displayName.trim()
            ? body.displayName.trim()
            : typeof body?.groupName === 'string' && body.groupName.trim()
              ? body.groupName.trim()
              : (identifier.split('@')[0] || identifier).slice(0, 80);
    const groupName =
        typeof body?.groupName === 'string' && body.groupName.trim()
            ? body.groupName.trim()
            : displayName.slice(0, 60);
    const members = Array.isArray(body?.members) && body.members.length ? body.members : [displayName];
    const email =
        typeof body?.email === 'string' && body.email.trim()
            ? body.email.trim().toLowerCase()
            : looksLikeEmail(identifier)
              ? identifier.toLowerCase()
              : null;
    const phone = normalizePhone(body?.phone);
    if (!phone) return fail(REGISTRATION_PHONE_ERROR);
    if (
        !validUsername(identifier) ||
        !validPassword(password) ||
        !displayName ||
        displayName.length > 80 ||
        !groupName ||
        groupName.length > 60 ||
        (body?.members !== undefined && !Array.isArray(body.members)) ||
        members.length > 12 ||
        members.some(
            (member: unknown) => typeof member !== 'string' || !member.trim() || member.length > 80,
        ) ||
        (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    ) {
        return fail(`${USERNAME_ERROR} ${PASSWORD_ERROR} Any email address must be valid.`);
    }
    const key = `signup:${tooMany(request)}`;
    if (await loginRateLimited(env, key))
        return fail('Too many sign-up attempts. Try again in 15 minutes.', 429);
    await recordLoginFailure(env, key);
    const encoded = await passwordHash(password),
        groupId = id(),
        accountId = id(),
        timestamp = now();
    try {
        await env.DB.batch([
            env.DB.prepare(
                "INSERT INTO accounts(id,username,display_name,role,group_id,password_salt,password_hash,created_at) VALUES(?,?,?,'player',NULL,?,?,?)",
            ).bind(accountId, identifier, displayName, encoded.salt, encoded.hash, timestamp),
            env.DB.prepare(
                'INSERT INTO account_group_requests(account_id,group_id,name,members_json,created_at) VALUES(?,?,?,?,?)',
            ).bind(
                accountId,
                groupId,
                groupName,
                JSON.stringify(members.map((member: string) => member.trim())),
                timestamp,
            ),
            env.DB.prepare(
                'INSERT INTO account_security(account_id,password_set,updated_at) VALUES(?,1,?)',
            ).bind(accountId, timestamp),
            env.DB.prepare(
                'INSERT INTO account_contacts(account_id,phone,phone_verified_at) VALUES(?,?,NULL)',
            ).bind(accountId, phone),
            ...(email
                ? [
                      env.DB.prepare(
                          'INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at) VALUES(?,?,?,1,NULL,?)',
                      ).bind(id(), accountId, email, timestamp),
                  ]
                : []),
        ]);
    } catch {
        return fail('That username is already registered. Sign in or choose another username.', 409);
    }
    return json(
        {
            account: {
                id: accountId,
                username: identifier,
                displayName,
                role: 'player',
                groupId: null,
            } satisfies Account,
            session: true,
            approval: 'pending',
            message: 'Your account has been created and is waiting for administrator approval.',
        },
        201,
        { 'Set-Cookie': await createSession(request, env, accountId) },
    );
}
async function getSubmission(env: Env, submissionId: string) {
    return env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(submissionId).first<any>();
}
async function getUpload(env: Env, uploadId: string) {
    return env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?').bind(uploadId).first<any>();
}
async function uploadSessionView(env: Env, row: any): Promise<UploadSession> {
    const parts = await env.DB.prepare(
        "SELECT part_number,etag,size,sha256 FROM upload_parts WHERE upload_id=? AND state='uploaded' ORDER BY part_number",
    )
        .bind(row.id)
        .all<any>();
    return shapeUploadSession(row, parts.results);
}
function shapeUploadSession(row: any, parts: any[]): UploadSession {
    return {
        id: row.id,
        submissionId: row.submission_id,
        filename: row.filename,
        comment: row.comment ?? '',
        size: row.size,
        slot: row.slot,
        partSize: row.part_size,
        partCount: row.part_count,
        state: row.state,
        evidenceId: row.evidence_id,
        expiresAt: row.expires_at,
        parts: parts.map((p: any) => ({
            partNumber: p.part_number,
            etag: p.etag,
            size: p.size,
            sha256: p.sha256,
        })),
    };
}
async function stopExpiredUpload(env: Env, row: any, state: 'expired' | 'aborted') {
    const result = await env.DB.prepare(
        "UPDATE upload_sessions SET state=?,lock_token=NULL,lock_expires_at=NULL WHERE id=? AND state IN ('creating','uploading')",
    )
        .bind(state, row.id)
        .run();
    if (!result.meta.changes) return;
    if (row.multipart_upload_id) {
        try {
            await env.EVIDENCE.resumeMultipartUpload(row.object_key, row.multipart_upload_id).abort();
        } catch {}
    }
}
async function expireSubmissionUploads(env: Env, submissionId: string) {
    const timestamp = now();
    const rows = await env.DB.prepare(
        "SELECT u.*,s.task_id FROM upload_sessions u JOIN submissions s ON s.id=u.submission_id WHERE u.submission_id=? AND u.state IN ('creating','uploading','completing') AND u.expires_at<=?",
    )
        .bind(submissionId, timestamp)
        .all<any>();
    await recoverExpiredUploads(env, rows.results, timestamp);
}
async function recoverExpiredUploads(env: Env, rows: any[], timestamp: string) {
    const acceptingEvidence =
        rows.some((row) => row.state === 'completing') && (await submissionsEnabled(env));
    for (const row of rows) {
        if (row.state !== 'completing') {
            await stopExpiredUpload(env, row, 'expired');
            continue;
        }
        if (!acceptingEvidence) continue;
        if (row.lock_expires_at && row.lock_expires_at > timestamp) continue;
        const token = id();
        const claimed = await env.DB.prepare(
            "UPDATE upload_sessions SET lock_token=?,lock_expires_at=? WHERE id=? AND state='completing' AND expires_at<=? AND (lock_expires_at IS NULL OR lock_expires_at<=?)",
        )
            .bind(
                token,
                new Date(Date.now() + COMPLETION_LOCK_MS).toISOString(),
                row.id,
                timestamp,
                timestamp,
            )
            .run();
        if (!claimed.meta.changes) continue;
        row.lock_token = token;
        const head = await env.EVIDENCE.head(row.object_key);
        if (head?.size === row.size) {
            try {
                await finalizeMultipartEvidence(env, row, row.size, token);
            } catch {}
            continue;
        }
        const expired = await env.DB.prepare(
            "UPDATE upload_sessions SET state='expired',lock_token=NULL,lock_expires_at=NULL WHERE id=? AND state='completing' AND lock_token=? AND expires_at<=?",
        )
            .bind(row.id, token, timestamp)
            .run();
        if (expired.meta.changes && row.multipart_upload_id) {
            try {
                await env.EVIDENCE.resumeMultipartUpload(row.object_key, row.multipart_upload_id).abort();
            } catch {}
        }
    }
}
async function ownedUpload(requestAccount: Account, env: Env, uploadId: string) {
    if (requestAccount.role !== 'player') return null;
    return env.DB.prepare(
        'SELECT u.*,s.group_id,s.task_id,s.status AS submission_status FROM upload_sessions u JOIN submissions s ON s.id=u.submission_id WHERE u.id=? AND s.group_id=?',
    )
        .bind(uploadId, requestAccount.groupId)
        .first<any>();
}
async function authorizedSubmission(me: Account, env: Env, submissionId: string) {
    const row = await getSubmission(env, submissionId);
    if (!row) return null;
    if (me.role !== 'admin' && row.group_id !== me.groupId) return null;
    return row;
}
async function evidenceById(env: Env, evidenceId: string) {
    const row = await env.DB.prepare('SELECT * FROM evidence WHERE id=?').bind(evidenceId).first<any>();
    if (!row) return null;
    return shapeEvidence(row);
}
async function finalizeMultipartEvidence(
    env: Env,
    row: any,
    expectedSize: number,
    lockToken: string | null,
): Promise<Evidence | null> {
    const head = await env.EVIDENCE.head(row.object_key);
    if (!head || head.size !== expectedSize) return null;
    const prefixLen = Math.min(expectedSize, UPLOAD_PART_BYTES);
    const prefixObject = await env.EVIDENCE.get(row.object_key, {
        range: { offset: 0, length: prefixLen },
    });
    if (!prefixObject) return null;
    const prefix = await readBoundedStream(prefixObject.body, UPLOAD_PART_BYTES);
    if (!prefix || prefix.byteLength !== prefixLen) return null;
    let sniffed: Awaited<ReturnType<typeof fileTypeFromBuffer>> = undefined;
    try {
        sniffed = await fileTypeFromBuffer(prefix);
    } catch {}
    const sniffedType = sniffed?.mime;
    const mediaType =
        sniffedType && (SAFE_IMAGE_TYPES.has(sniffedType) || SAFE_VIDEO_TYPES.has(sniffedType))
            ? sniffedType
            : 'application/octet-stream';
    let metadata: MetadataResult = {
        capturedAt: null,
        rawDate: null,
        timezone: null,
        status: 'unavailable',
        flags: ['Capture date is unavailable for this file type.'],
        source: null,
    };
    if (SAFE_IMAGE_TYPES.has(mediaType)) {
        try {
            const tags = await exifr.parse(prefix, {
                tiff: true,
                exif: true,
                gps: false,
                xmp: false,
                iptc: false,
                icc: false,
                reviveValues: false,
            });
            metadata = evaluatePhotoMetadata(tags ?? {}, row.task_id);
            if (expectedSize > prefixLen) {
                if (metadata.status === 'consistent') metadata.status = 'uncertain';
                metadata.flags.push('Image metadata was checked from the first 8 MiB only.');
            }
        } catch {
            metadata = {
                capturedAt: null,
                rawDate: null,
                timezone: null,
                status: 'unavailable',
                flags: ['Image capture metadata could not be read from the first 8 MiB.'],
                source: null,
            };
        }
        metadata = withCameraCapture(metadata, parseCameraCapture(row.camera_capture_json));
    }
    const fullSmallFile = expectedSize <= prefixLen ? new Uint8Array(prefix) : null;
    const sha = fullSmallFile
        ? hex(new Uint8Array(await crypto.subtle.digest('SHA-256', fullSmallFile.buffer)))
        : '';
    if (sha) {
        const duplicate = await env.DB.prepare(
            "SELECT id FROM evidence WHERE sha256=? AND sha256<>'' LIMIT 1",
        )
            .bind(sha)
            .first();
        if (duplicate)
            metadata.flags.push(
                'This exact file was uploaded previously; admins can compare the earlier evidence.',
            );
    }
    const receivedAt = now();
    try {
        await env.DB.batch([
            env.DB.prepare(
                `UPDATE upload_sessions SET state='completed',completed_at=?,lock_token=NULL,lock_expires_at=NULL WHERE id=? AND state='completing' AND lock_token=? AND ${SUBMISSIONS_OPEN_SQL} AND EXISTS (SELECT 1 FROM submissions s WHERE s.id=upload_sessions.submission_id AND s.status='draft' AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=s.group_id))`,
            ).bind(receivedAt, row.id, lockToken),
            env.DB.prepare(
                `INSERT INTO evidence(id,submission_id,object_key,filename,media_type,size,sha256,uploaded_at,slot,metadata_json,comment) SELECT evidence_id,submission_id,object_key,filename,?,?,?, ?,slot,?,comment FROM upload_sessions WHERE id=? AND state='completed' AND evidence_id=? AND ${SUBMISSIONS_OPEN_SQL} AND EXISTS (SELECT 1 FROM submissions WHERE id=upload_sessions.submission_id AND status='draft' AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=submissions.group_id)) AND NOT EXISTS (SELECT 1 FROM evidence WHERE id=upload_sessions.evidence_id)`,
            ).bind(
                mediaType,
                expectedSize,
                sha,
                receivedAt,
                JSON.stringify(metadata),
                row.id,
                row.evidence_id,
            ),
        ]);
    } catch (error) {
        const existing = await evidenceById(env, row.evidence_id);
        if (existing) return existing;
        throw error;
    }
    return evidenceById(env, row.evidence_id);
}
async function cleanupExpiredUploads(env: Env) {
    const rows = await env.DB.prepare(
        "SELECT DISTINCT submission_id FROM upload_sessions WHERE expires_at<=? AND state IN ('creating','uploading','completing') ORDER BY submission_id LIMIT 100",
    )
        .bind(now())
        .all<{ submission_id: string }>();
    for (const row of rows.results) await expireSubmissionUploads(env, row.submission_id);
}
async function handleApi(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    await ensureDemo(env);
    const url = new URL(request.url),
        path = url.pathname;
    const method = request.method.toUpperCase();
    if (method !== 'GET' && !assertSameOrigin(request)) return fail('Cross-origin request rejected.', 403);
    if (path === '/api/admin-setup') return fail('Not found.', 404);
    const createAdminRes = await handleAdminAccountCreation(request, env, {
        currentAccount: (adminRequest) => sessionAccount(adminRequest, env),
        passwordHash,
    });
    if (createAdminRes) return createAdminRes;
    const adminRoleRes = await handleAdminRoleRoutes(request, env, {
        currentAccount: (adminRequest) => sessionAccount(adminRequest, env),
        passwordHash,
    });
    if (adminRoleRes) return adminRoleRes;
    const deleteAdminRes = await handleAdminDeletion(request, env, {
        currentAccount: (adminRequest) => sessionAccount(adminRequest, env),
    });
    if (deleteAdminRes) return deleteAdminRes;
    const approvalRes = await handleAccountApprovalRoutes(request, env, {
        currentAccount: (approvalRequest) => sessionAccount(approvalRequest, env),
    });
    if (approvalRes) return approvalRes;
    const recoveryRes = await handleAccountRecovery(request, env, {
        createSession: (authRequest, _authEnv, accountId, guard) =>
            createSession(authRequest, env, accountId, guard),
        passwordHash,
        passwordMatches,
    });
    if (recoveryRes) return recoveryRes;
    const membersRes = await handleGroupMembers(request, env, {
        currentAccount: (membershipRequest) => currentAccount(membershipRequest, env),
        sessionAccount: (membershipRequest) => sessionAccount(membershipRequest, env),
    });
    if (membersRes) return membersRes;
    const settingsRes = await handleAccountSettings(request, env, {
        currentAccount: (settingsRequest) => currentAccount(settingsRequest, env),
        createSession: (settingsRequest, _settingsEnv, accountId, guard) =>
            createSession(settingsRequest, env, accountId, guard),
        passwordHash,
        passwordMatches,
    });
    if (settingsRes) return settingsRes;
    const emailSignInRes = await handleEmailSignIn(request, env, {
        createSession: (authRequest, _authEnv, accountId, guard) =>
            createSession(authRequest, env, accountId, guard),
        waitUntil: context ? (task) => context.waitUntil(task) : undefined,
    });
    if (emailSignInRes) return emailSignInRes;
    const authRes = await handleFederatedAuth(request, env, {
        currentAccount: (authRequest) => sessionAccount(authRequest, env),
        createSession: (authRequest, _authEnv, accountId) => createSession(authRequest, env, accountId),
        passwordHash,
    });
    if (authRes) {
        if (path === '/api/auth/options' && method === 'GET') {
            const body = (await authRes
                .clone()
                .json()
                .catch(() => ({}))) as Record<string, unknown>;
            body.emailOtpEnabled = emailOtpAvailable(env);
            return json(body, authRes.status, authRes.headers);
        }
        return authRes;
    }
    if (path === '/api/demo-accounts' && method === 'GET') {
        if (env.DEMO_MODE !== 'true') return fail('Not found.', 404);
        const accounts: DemoAccount[] = [
            ...['player1', 'player2', 'player3', 'player4', 'player5'].map((username, i) => ({
                username,
                role: 'player' as const,
                group: `Player ${i + 1}`,
            })),
            { username: 'team1-1', role: 'player', group: 'Team 1' },
            { username: 'team1-2', role: 'player', group: 'Team 1' },
            { username: 'team2-1', role: 'player', group: 'Team 2' },
            { username: 'team2-2', role: 'player', group: 'Team 2' },
            { username: 'admin1', role: 'admin', group: 'Admin' },
            { username: 'admin2', role: 'admin', group: 'Admin' },
        ];
        return json({ accounts, password: 'manhunt123' });
    }
    if (path === '/api/login' && method === 'POST') {
        const body = await request.json<any>().catch(() => null);
        if (!body || typeof body.username !== 'string' || typeof body.password !== 'string')
            return fail('Enter a username and password.');
        const identifier = body.username.trim();
        if (!identifier || identifier.length > 254) return fail('Username or password is incorrect.', 401);
        const key = `${tooMany(request)}:${identifier.toLowerCase()}`;
        if (await loginRateLimited(env, key))
            return fail('Too many login attempts. Try again in 15 minutes.', 429);
        const candidates = await env.DB.prepare(
            `SELECT a.*,COALESCE(s.security_version,0) AS security_version
      FROM accounts a LEFT JOIN account_security s ON s.account_id=a.id
      WHERE a.username=? COLLATE NOCASE OR (s.password_set=1 AND EXISTS (
        SELECT 1 FROM federated_identities f WHERE f.account_id=a.id AND f.provider='google' AND f.identifier=? COLLATE NOCASE))
      ORDER BY CASE WHEN a.username=? COLLATE NOCASE THEN 0 ELSE 1 END LIMIT 3`,
        )
            .bind(identifier, identifier, identifier)
            .all<any>();
        let row: any = null;
        if (body.password.length <= 128)
            for (const candidate of candidates.results) {
                if (await passwordMatches(body.password, candidate.password_salt, candidate.password_hash)) {
                    row = candidate;
                    break;
                }
            }
        if (!row) {
            await recordLoginFailure(env, key);
            if (!candidates.results.length && validUsername(identifier) && validPassword(body.password)) {
                const knownIdentity = await env.DB.prepare(
                    `SELECT 1 FROM federated_identities WHERE provider='google' AND identifier=? COLLATE NOCASE
          UNION ALL SELECT 1 FROM account_emails WHERE email=? COLLATE NOCASE LIMIT 1`,
                )
                    .bind(identifier, identifier)
                    .first();
                if (!knownIdentity) {
                    if (body.phone === undefined || body.phone === null || body.phone === '') {
                        return fail('Choose Sign Up and enter your phone number for account verification.');
                    }
                    return registerNativeAccount(request, env, {
                        username: identifier,
                        password: body.password,
                        phone: body.phone,
                    });
                }
            }
            return fail('Username or password is incorrect.', 401);
        }
        if (env.DEMO_MODE !== 'true' && String(row.id).startsWith('demo-account-'))
            return fail('Sample accounts are no longer available. Sign up for a personal account.', 403);
        const approval = await getAccountApproval(env.DB, row.id);
        if (!approval || approval.status === 'disabled' || approval.status === 'rejected')
            return fail('This account is not approved. Contact an administrator.', 403);
        await env.DB.prepare('DELETE FROM login_attempts WHERE key=?').bind(key).run();
        const proof = { securityVersion: row.security_version, passwordHash: row.password_hash };
        let sessionCookie: string;
        try {
            sessionCookie = await createSession(request, env, row.id, { ...proof, requireNoTotp: false });
        } catch {
            return fail('Account security changed. Sign in again.', 401);
        }
        const headers = new Headers({ 'Set-Cookie': sessionCookie });
        return json({ account: account(row) }, 200, headers);
    }
    if (path === '/api/logout' && method === 'POST') {
        const token = getCookie(request, cookieName());
        if (token)
            await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?')
                .bind(await digest(token))
                .run();
        return json({ ok: true }, 200, {
            'Set-Cookie': `${cookieName()}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure(request)}`,
        });
    }
    if (path === '/api/register' && method === 'POST') {
        const body = await request.json<any>().catch(() => null);
        return registerNativeAccount(request, env, body);
    }
    const me = await sessionAccount(request, env);
    if (!me) return fail('Please sign in.', 401);
    const approval = await getAccountApproval(env.DB, me.id);
    if (approval?.status !== 'approved')
        return json(
            {
                error: 'Administrator approval is required before you can access the portal.',
                code: 'approval_required',
                approval: approval?.status ?? 'pending',
                canSignIn: false,
            },
            403,
        );
    const subSettingsRes = await handleSubmissionSettings(request, env, me);
    if (subSettingsRes) return subSettingsRes;
    const mergeSettingsRes = await handleGroupMergingSettings(request, env, me);
    if (mergeSettingsRes) return mergeSettingsRes;
    const gameRes = await gameRoute(request, env, me, () => dispatchAnnouncementAlerts(env, context));
    if (gameRes) {
        if (gameRes.ok && method === 'PATCH' && path.startsWith('/api/admin/game-players/')) {
            const deliveries = processCaughtNotifications(env).catch(() => {
                console.error('Caught notification delivery failed.');
            });
            if (context) context.waitUntil(deliveries);
            else await deliveries;
        }
        return gameRes;
    }
    const taskMutation =
        isSubmissionWrite(path, method) ||
        (method === 'PATCH' && /^\/api\/submissions\/[^/]+\/note$/.test(path)) ||
        ((method === 'PATCH' || method === 'DELETE') && /^\/api\/evidence\/[^/]+$/.test(path));
    if (me.role === 'player' && taskMutation && (await isPlayerDead(env, me.id))) {
        return json({ error: DEAD_MESSAGE, code: 'player_dead' }, 403);
    }
    if (
        me.role === 'player' &&
        method === 'POST' &&
        /^\/api\/submissions\/[^/]+\/submit$/.test(path) &&
        isLunchBreak()
    ) {
        return json({ error: LUNCH_MESSAGE, code: 'lunch_break' }, 403);
    }
    if (isSubmissionWrite(path, method) && me.role === 'player' && !(await submissionsEnabled(env))) {
        return json({ error: SUBMISSIONS_PAUSED_MESSAGE, code: 'submissions_paused' }, 403);
    }
    const announcementRes = await handleAnnouncements(request, env, me);
    if (announcementRes) {
        if (announcementRes.ok && path === '/api/admin/announcements' && method === 'POST')
            await dispatchAnnouncementAlerts(env, context);
        return announcementRes;
    }
    const reviewNotifRes = await handleReviewNotifications(request, env, me);
    if (reviewNotifRes) return reviewNotifRes;
    const pushRes = await handlePushNotifications(request, env, me);
    if (pushRes) return pushRes;
    const draftNoteRes = await handleDraftNote(request, env, me);
    if (draftNoteRes) return draftNoteRes;
    const previewRes = await handleEvidencePreview(request, env, { currentAccount: async () => me });
    if (previewRes) return previewRes;
    const metaRes = await handleImageMetadata(request, env, { currentAccount: async () => me });
    if (metaRes) return metaRes;
    if (path === '/api/dashboard' && method === 'GET') return json(await loadDashboard(me, env));

    const adminQueueRes = await handleAdminSubQueries(request, env, me, (row, includeMetadata) =>
        shapeSubmission(row, env, includeMetadata),
    );
    if (adminQueueRes) return adminQueueRes;

    if (path === '/api/submissions' && method === 'POST') {
        if (me.role !== 'player' || !me.groupId) return fail('Only players can submit evidence.', 403);
        const body = await request.json<any>().catch(() => null);
        const task = getTaskDefinition(body?.taskId);
        if (!task) return fail('Unknown task.');
        const prior = await env.DB.prepare(
            'SELECT * FROM submissions WHERE group_id=? AND task_id=? ORDER BY attempt DESC LIMIT 1',
        )
            .bind(me.groupId, task.id)
            .first<any>();
        if (prior?.status === 'draft') return json({ submission: await shapeSubmission(prior, env) });
        if (!TASKS.includes(task)) return fail('Unknown task.');
        if (prior?.status === 'pending' || prior?.status === 'approved')
            return fail('This task already has an active submission.', 409);
        const nextAttempt = (prior?.attempt ?? 0) + 1,
            submissionId = id();
        try {
            await env.DB.prepare(
                `INSERT INTO submissions(id,group_id,task_id,status,attempt,created_at) SELECT ?,?,?,'draft',?,? WHERE ${SUBMISSIONS_OPEN_SQL} AND ${GAME_WRITE_BLOCK_SQL} AND NOT EXISTS (SELECT 1 FROM group_disbands WHERE group_id=?) AND NOT EXISTS (SELECT 1 FROM submissions WHERE group_id=? AND task_id=? AND status IN ('draft','pending','approved'))`,
            )
                .bind(
                    submissionId,
                    me.groupId,
                    task.id,
                    nextAttempt,
                    now(),
                    me.id,
                    me.groupId,
                    me.groupId,
                    task.id,
                )
                .run();
        } catch {
            return fail('A submission is already being prepared for this task.', 409);
        }
        const created = await getSubmission(env, submissionId);
        if (!created) {
            if (await isPlayerDead(env, me.id))
                return json({ error: DEAD_MESSAGE, code: 'player_dead' }, 403);
            return fail('A submission is already being prepared for this task.', 409);
        }
        return json({ submission: await shapeSubmission(created, env) }, 201);
    }

    let match = path.match(/^\/api\/submissions\/([^/]+)\/evidence$/);
    if (match && method === 'POST') {
        if (me.role !== 'player') return fail('Only players can upload evidence.', 403);
        const sub = await authorizedSubmission(me, env, match[1]);
        if (!sub || sub.status !== 'draft') return fail('Draft submission not found.', 404);
        const length = Number(request.headers.get('Content-Length') ?? 0);
        if (length > DIRECT_UPLOAD_MAX_BYTES + 64 * 1024)
            return fail('Files over 8 MiB must use chunked upload.', 413);
        await expireSubmissionUploads(env, sub.id);
        const count = await env.DB.prepare(
            "SELECT (SELECT COUNT(*) FROM evidence WHERE submission_id=?) + (SELECT COUNT(*) FROM upload_sessions WHERE submission_id=? AND state IN ('creating','uploading','completing')) AS n",
        )
            .bind(sub.id, sub.id)
            .first<{ n: number }>();
        if ((count?.n ?? 0) >= MAX_FILES_PER_SUBMISSION)
            return fail(`A submission can contain at most ${MAX_FILES_PER_SUBMISSION} files.`, 409);
        let form: FormData;
        try {
            const boundedBody = await readBoundedBody(request, DIRECT_UPLOAD_MAX_BYTES + 64 * 1024);
            if (!boundedBody) return fail('Files over 8 MiB must use chunked upload.', 413);
            const formBytes = new Uint8Array(boundedBody.byteLength);
            formBytes.set(boundedBody);
            form = await new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: formBytes.buffer,
            }).formData();
        } catch {
            return fail('Upload a multipart file.');
        }
        const file = form.get('file'),
            slotRaw = form.get('slot');
        if (!(file instanceof File)) return fail('Choose a file to upload.');
        if (file.size > DIRECT_UPLOAD_MAX_BYTES)
            return fail('Files over 8 MiB must use chunked upload.', 413);
        if (file.size === 0) return fail('Choose a non-empty file.');
        const slot = typeof slotRaw === 'string' && slotRaw.trim() ? slotRaw.trim() : null;
        const comment = parseEvidenceComment(form.get('comment'));
        if (comment === null)
            return fail(`Each file comment must be ${EVIDENCE_COMMENT_MAX_LENGTH} characters or fewer.`);
        const buf = new Uint8Array(await file.arrayBuffer());
        let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>> = undefined;
        try {
            detected = await fileTypeFromBuffer(buf);
        } catch {}
        const sniffedType = detected?.mime;
        const type =
            sniffedType && (SAFE_IMAGE_TYPES.has(sniffedType) || SAFE_VIDEO_TYPES.has(sniffedType))
                ? sniffedType
                : 'application/octet-stream';
        const evidenceId = id(),
            objectKey = `evidence/${sub.id}/${evidenceId}`;
        let metadata: MetadataResult = {
            capturedAt: null,
            rawDate: null,
            timezone: null,
            status: 'unavailable',
            flags: ['Capture date is unavailable for this file type.'],
            source: null,
        };
        if (SAFE_IMAGE_TYPES.has(type)) {
            try {
                const tags = await exifr.parse(buf, {
                    tiff: true,
                    exif: true,
                    gps: false,
                    xmp: false,
                    iptc: false,
                    icc: false,
                    reviveValues: false,
                });
                metadata = evaluatePhotoMetadata(tags ?? {}, sub.task_id);
            } catch {
                metadata = {
                    capturedAt: null,
                    rawDate: null,
                    timezone: null,
                    status: 'unavailable',
                    flags: ['Image capture metadata could not be read.'],
                    source: null,
                };
            }
            metadata = withCameraCapture(metadata, parseCameraCapture(form.get('cameraCapture')));
        }
        const sha = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
        const duplicate = await env.DB.prepare('SELECT id FROM evidence WHERE sha256=? LIMIT 1')
            .bind(sha)
            .first<{ id: string }>();
        if (duplicate)
            metadata.flags.push(
                'This exact file was uploaded previously; admins can compare the earlier evidence.',
            );
        const timestamp = now();
        await env.EVIDENCE.put(objectKey, buf, { httpMetadata: { contentType: type } });
        try {
            const inserted = await env.DB.prepare(
                `INSERT INTO evidence(id,submission_id,object_key,filename,media_type,size,sha256,uploaded_at,slot,metadata_json,comment) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${SUBMISSIONS_OPEN_SQL} AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND status='draft' AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=submissions.group_id))`,
            )
                .bind(
                    evidenceId,
                    sub.id,
                    objectKey,
                    file.name.slice(0, 255) || 'upload',
                    type,
                    file.size,
                    sha,
                    timestamp,
                    slot,
                    JSON.stringify(metadata),
                    comment,
                    sub.id,
                )
                .run();
            if (!inserted.meta.changes) {
                await env.EVIDENCE.delete(objectKey);
                return fail('Submission was changed while uploading. Please retry.', 409);
            }
        } catch (e) {
            await env.EVIDENCE.delete(objectKey);
            if (
                String(e).includes('UNIQUE constraint failed') ||
                String(e).includes('submission evidence limit exceeded') ||
                String(e).includes('submission slot is reserved')
            )
                return fail('This upload conflicts with another change or the 10-file limit.', 409);
            throw e;
        }
        return json(
            {
                evidence: {
                    id: evidenceId,
                    submissionId: sub.id,
                    filename: file.name,
                    comment,
                    mediaType: type,
                    size: file.size,
                    url: `/api/evidence/${evidenceId}/file`,
                    uploadedAt: timestamp,
                    slot,
                } satisfies Evidence,
            },
            201,
        );
    }

    match = path.match(/^\/api\/submissions\/([^/]+)\/uploads$/);
    if (match && method === 'POST') {
        if (me.role !== 'player' || !me.groupId) return fail('Only players can upload evidence.', 403);
        const sub = await authorizedSubmission(me, env, match[1]);
        if (!sub || sub.status !== 'draft') return fail('Draft submission not found.', 404);
        const body = await request.json<any>().catch(() => null);
        const size = body?.size;
        const filename = typeof body?.filename === 'string' ? body.filename.trim().slice(0, 255) : '';
        if (!filename || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES)
            return fail('Enter a filename and a file size between 1 byte and 2 GiB.');
        const slot = typeof body.slot === 'string' && body.slot.trim() ? body.slot.trim() : null;
        const comment = parseEvidenceComment(body.comment);
        if (comment === null)
            return fail(`Each file comment must be ${EVIDENCE_COMMENT_MAX_LENGTH} characters or fewer.`);
        await expireSubmissionUploads(env, sub.id);
        const count = await env.DB.prepare(
            "SELECT (SELECT COUNT(*) FROM evidence WHERE submission_id=?) + (SELECT COUNT(*) FROM upload_sessions WHERE submission_id=? AND state IN ('creating','uploading','completing')) AS n",
        )
            .bind(sub.id, sub.id)
            .first<{ n: number }>();
        if ((count?.n ?? 0) >= MAX_FILES_PER_SUBMISSION)
            return fail(`A submission can contain at most ${MAX_FILES_PER_SUBMISSION} files.`, 409);
        const uploadId = id(),
            evidenceId = id(),
            objectKey = `evidence/${sub.id}/${evidenceId}`;
        const partCount = Math.ceil(size / UPLOAD_PART_BYTES),
            createdAt = now(),
            expiresAt = new Date(Date.now() + UPLOAD_LIFETIME_MS).toISOString();
        const cameraCapture = parseCameraCapture(body.cameraCapture);
        try {
            const reserved = await env.DB.prepare(
                `INSERT INTO upload_sessions(id,submission_id,object_key,filename,size,slot,part_size,part_count,state,evidence_id,created_at,expires_at,camera_capture_json,comment) SELECT ?,?,?,?,?,?,?,?,'creating',?,?,?,?,? WHERE ${SUBMISSIONS_OPEN_SQL} AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND status='draft' AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=submissions.group_id)) AND (SELECT COUNT(*) FROM evidence WHERE submission_id=?) + (SELECT COUNT(*) FROM upload_sessions WHERE submission_id=? AND state IN ('creating','uploading','completing')) < ?`,
            )
                .bind(
                    uploadId,
                    sub.id,
                    objectKey,
                    filename,
                    size,
                    slot,
                    UPLOAD_PART_BYTES,
                    partCount,
                    evidenceId,
                    createdAt,
                    expiresAt,
                    cameraCapture ? JSON.stringify(cameraCapture) : null,
                    comment,
                    sub.id,
                    sub.id,
                    sub.id,
                    MAX_FILES_PER_SUBMISSION,
                )
                .run();
            if (!reserved.meta.changes)
                return fail('Submission changed or its evidence limit has been reached.', 409);
        } catch (error) {
            if (String(error).includes('submission evidence limit exceeded'))
                return fail(`A submission can contain at most ${MAX_FILES_PER_SUBMISSION} files.`, 409);
            if (String(error).includes('submission evidence limit exceeded'))
                return fail(`A submission can contain at most ${MAX_FILES_PER_SUBMISSION} files.`, 409);
            throw error;
        }
        let multipart: R2MultipartUpload;
        try {
            multipart = await env.EVIDENCE.createMultipartUpload(objectKey, {
                httpMetadata: { contentType: 'application/octet-stream' },
            });
        } catch (error) {
            await env.DB.prepare("UPDATE upload_sessions SET state='aborted' WHERE id=? AND state='creating'")
                .bind(uploadId)
                .run();
            throw error;
        }
        const activated = await env.DB.prepare(
            "UPDATE upload_sessions SET multipart_upload_id=?,state='uploading' WHERE id=? AND state='creating'",
        )
            .bind(multipart.uploadId, uploadId)
            .run();
        if (!activated.meta.changes) {
            try {
                await multipart.abort();
            } catch {}
            return fail('Upload was cancelled while it was being prepared.', 409);
        }
        return json(
            {
                upload: await uploadSessionView(
                    env,
                    (await getUpload(env, uploadId))! satisfies UploadSession,
                ),
            },
            201,
        );
    }

    match = path.match(/^\/api\/uploads\/([^/]+)$/);
    if (match && method === 'GET') {
        if (me.role !== 'player') return fail('Only players can access their uploads.', 403);
        const upload = await ownedUpload(me, env, match[1]);
        if (!upload) return fail('Upload not found.', 404);
        if (['creating', 'uploading'].includes(upload.state) && upload.expires_at <= now()) {
            await stopExpiredUpload(env, upload, 'expired');
            return fail('This upload expired. Select the file again to retry.', 410);
        }
        return json({ upload: await uploadSessionView(env, upload) });
    }

    match = path.match(/^\/api\/uploads\/([^/]+)\/parts\/(\d+)$/);
    if (match && method === 'PUT') {
        if (me.role !== 'player') return fail('Only players can upload evidence.', 403);
        const upload = await ownedUpload(me, env, match[1]);
        if (!upload) return fail('Upload not found.', 404);
        if (upload.state !== 'uploading') return fail('This upload is no longer accepting parts.', 409);
        if (upload.expires_at <= now()) {
            await stopExpiredUpload(env, upload, 'expired');
            return fail('This upload expired. Select the file again to retry.', 410);
        }
        const partNumber = Number(match[2]);
        if (
            !Number.isInteger(partNumber) ||
            partNumber < 1 ||
            partNumber > upload.part_count ||
            partNumber > 256
        )
            return fail('Invalid part number.');
        const expectedSize =
            partNumber < upload.part_count
                ? upload.part_size
                : upload.size - (upload.part_count - 1) * upload.part_size;
        const declaredLen = request.headers.get('Content-Length');
        if (declaredLen && Number(declaredLen) !== expectedSize) return fail('This part has the wrong size.');
        const data = await readBoundedBody(request, UPLOAD_PART_BYTES);
        if (!data) return fail('Each upload part must be no larger than 8 MiB.', 413);
        if (data.byteLength !== expectedSize)
            return fail(`Part ${partNumber} must contain exactly ${expectedSize} bytes.`);
        const partBytes = new Uint8Array(data.byteLength);
        partBytes.set(data);
        const sha = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', partBytes.buffer)));
        const previous = await env.DB.prepare(
            'SELECT * FROM upload_parts WHERE upload_id=? AND part_number=?',
        )
            .bind(upload.id, partNumber)
            .first<any>();
        if (previous && (previous.size !== data.byteLength || previous.sha256 !== sha))
            return fail(
                'This part number already has different content. Cancel the upload and start again.',
                409,
            );
        if (previous?.state === 'uploaded')
            return json({ part: { partNumber, etag: previous.etag, size: previous.size } });
        const partLease = now();
        const retryReady = '1970-01-01T00:00:00.000Z';
        if (!previous) {
            try {
                const reservation = await env.DB.prepare(
                    "INSERT INTO upload_parts(upload_id,part_number,size,sha256,state,updated_at) SELECT ?,?,?,?,'uploading',? WHERE EXISTS (SELECT 1 FROM upload_sessions WHERE id=? AND state='uploading' AND expires_at>?)",
                )
                    .bind(upload.id, partNumber, data.byteLength, sha, partLease, upload.id, partLease)
                    .run();
                if (!reservation.meta.changes)
                    return fail('Upload is being completed, was cancelled, or has expired.', 409);
            } catch (error) {
                if (String(error).includes('UNIQUE constraint failed'))
                    return fail('This part is already being stored. Retry shortly.', 503);
                throw error;
            }
        } else {
            if (previous.updated_at !== retryReady) {
                if (Date.parse(previous.updated_at) <= Date.now() - 2 * 60_000) {
                    await stopExpiredUpload(env, upload, 'aborted');
                    return fail(
                        'An upload part was interrupted. Select the file again to restart safely.',
                        409,
                    );
                }
                return fail('This part is already being stored. Retry shortly.', 503);
            }
            const reclaimed = await env.DB.prepare(
                "UPDATE upload_parts SET updated_at=? WHERE upload_id=? AND part_number=? AND state='uploading' AND updated_at=? AND EXISTS (SELECT 1 FROM upload_sessions WHERE id=? AND state='uploading' AND expires_at>?)",
            )
                .bind(partLease, upload.id, partNumber, retryReady, upload.id, partLease)
                .run();
            if (!reclaimed.meta.changes)
                return fail('This part is already being stored. Retry shortly.', 503);
        }
        let uploadedPart: R2UploadedPart;
        try {
            uploadedPart = await env.EVIDENCE.resumeMultipartUpload(
                upload.object_key,
                upload.multipart_upload_id,
            ).uploadPart(partNumber, data);
        } catch {
            await env.DB.prepare(
                "UPDATE upload_parts SET updated_at=? WHERE upload_id=? AND part_number=? AND state='uploading' AND updated_at=?",
            )
                .bind(retryReady, upload.id, partNumber, partLease)
                .run();
            return fail('The part could not be stored. Retry this same part.', 502);
        }
        const saved = await env.DB.prepare(
            "UPDATE upload_parts SET etag=?,state='uploaded',updated_at=? WHERE upload_id=? AND part_number=? AND state='uploading' AND sha256=? AND updated_at=? AND EXISTS (SELECT 1 FROM upload_sessions WHERE id=? AND state='uploading')",
        )
            .bind(uploadedPart.etag, now(), upload.id, partNumber, sha, partLease, upload.id)
            .run();
        if (!saved.meta.changes) {
            const current = await env.DB.prepare(
                'SELECT etag,size,state FROM upload_parts WHERE upload_id=? AND part_number=?',
            )
                .bind(upload.id, partNumber)
                .first<any>();
            if (current?.state === 'uploaded' && current.size === expectedSize)
                return json({ part: { partNumber, etag: current.etag, size: current.size } });
            return fail('Upload changed while storing this part. Retry or start the upload again.', 409);
        }
        return json({ part: { partNumber, etag: uploadedPart.etag, size: data.byteLength } });
    }

    match = path.match(/^\/api\/uploads\/([^/]+)\/complete$/);
    if (match && method === 'POST') {
        if (me.role !== 'player') return fail('Only players can complete uploads.', 403);
        let upload = await ownedUpload(me, env, match[1]);
        if (!upload) return fail('Upload not found.', 404);
        if (upload.state === 'completed') {
            const evidence = await evidenceById(env, upload.evidence_id);
            return evidence ? json({ evidence }) : fail('Completed evidence is unavailable.', 500);
        }
        if (upload.submission_status !== 'draft') return fail('This submission is no longer editable.', 409);
        if (upload.state === 'aborted' || upload.state === 'expired')
            return fail('This upload expired or was cancelled. Select the file again to retry.', 410);
        if (upload.state === 'creating') return fail('Upload is still being prepared.', 409);
        const existingObject =
            upload.state === 'completing' ? await env.EVIDENCE.head(upload.object_key) : null;
        if (existingObject) {
            if (existingObject.size !== upload.size)
                return fail('Stored upload size did not match the selected file.', 409);
            const evidence = await finalizeMultipartEvidence(env, upload, upload.size, upload.lock_token);
            return evidence ? json({ evidence }) : fail('Upload finalization is still in progress.', 409);
        }
        let lockToken: string;
        if (upload.state === 'uploading') {
            if (upload.expires_at <= now()) {
                await stopExpiredUpload(env, upload, 'expired');
                return fail('This upload expired. Select the file again to retry.', 410);
            }
            const parts = await env.DB.prepare(
                'SELECT part_number,size,etag,state FROM upload_parts WHERE upload_id=? ORDER BY part_number',
            )
                .bind(upload.id)
                .all<any>();
            if (
                parts.results.length !== upload.part_count ||
                parts.results.some(
                    (part: any, i: number) =>
                        part.part_number !== i + 1 ||
                        part.state !== 'uploaded' ||
                        part.size !==
                            (i + 1 < upload.part_count
                                ? upload.part_size
                                : upload.size - (upload.part_count - 1) * upload.part_size) ||
                        !part.etag,
                )
            )
                return fail('Upload every part before completing the file.', 400);
            lockToken = id();
            const acquired = await env.DB.prepare(
                "UPDATE upload_sessions SET state='completing',lock_token=?,lock_expires_at=? WHERE id=? AND state='uploading' AND expires_at>? AND NOT EXISTS (SELECT 1 FROM upload_parts WHERE upload_id=? AND state<>'uploaded')",
            )
                .bind(
                    lockToken,
                    new Date(Date.now() + COMPLETION_LOCK_MS).toISOString(),
                    upload.id,
                    now(),
                    upload.id,
                )
                .run();
            if (!acquired.meta.changes)
                return fail('Upload is changing. Refresh its status and try again.', 409);
            upload = await ownedUpload(me, env, upload.id);
        } else {
            if (upload.lock_expires_at && upload.lock_expires_at > now())
                return fail('Upload completion is already in progress.', 409);
            lockToken = id();
            const acquired = await env.DB.prepare(
                "UPDATE upload_sessions SET lock_token=?,lock_expires_at=? WHERE id=? AND state='completing' AND (lock_expires_at IS NULL OR lock_expires_at<=?)",
            )
                .bind(lockToken, new Date(Date.now() + COMPLETION_LOCK_MS).toISOString(), upload.id, now())
                .run();
            if (!acquired.meta.changes) return fail('Upload completion is already in progress.', 409);
            upload = await ownedUpload(me, env, upload.id);
        }
        if (!upload?.multipart_upload_id) return fail('Stored upload session is incomplete.', 500);
        const parts = await env.DB.prepare(
            "SELECT part_number,etag FROM upload_parts WHERE upload_id=? AND state='uploaded' ORDER BY part_number",
        )
            .bind(upload.id)
            .all<any>();
        try {
            const completed = await env.EVIDENCE.resumeMultipartUpload(
                upload.object_key,
                upload.multipart_upload_id,
            ).complete(parts.results.map((part: any) => ({ partNumber: part.part_number, etag: part.etag })));
            if (completed.size !== upload.size)
                return fail('Stored upload size did not match the selected file.', 409);
        } catch {
            const head = await env.EVIDENCE.head(upload.object_key);
            if (!head || head.size !== upload.size) {
                await env.DB.prepare(
                    "UPDATE upload_sessions SET lock_expires_at=NULL WHERE id=? AND state='completing' AND lock_token=?",
                )
                    .bind(upload.id, lockToken)
                    .run();
                return fail('The file could not be finalized. Retry completing this upload.', 502);
            }
        }
        const evidence = await finalizeMultipartEvidence(env, upload, upload.size, lockToken);
        return evidence ? json({ evidence }) : fail('Upload finalization is still in progress.', 409);
    }

    match = path.match(/^\/api\/uploads\/([^/]+)$/);
    if (match && method === 'DELETE') {
        if (me.role !== 'player') return fail('Only players can cancel uploads.', 403);
        const upload = await ownedUpload(me, env, match[1]);
        if (!upload) return fail('Upload not found.', 404);
        if (upload.state === 'completed') return fail('Completed evidence cannot be cancelled.', 409);
        if (upload.state === 'completing') return fail('Upload completion is already in progress.', 409);
        if (upload.state === 'aborted' || upload.state === 'expired') return json({ ok: true });
        const result = await env.DB.prepare(
            "UPDATE upload_sessions SET state='aborted',lock_token=NULL,lock_expires_at=NULL WHERE id=? AND state IN ('creating','uploading')",
        )
            .bind(upload.id)
            .run();
        if (!result.meta.changes) return fail('Upload changed while cancelling.', 409);
        if (upload.multipart_upload_id) {
            try {
                await env.EVIDENCE.resumeMultipartUpload(
                    upload.object_key,
                    upload.multipart_upload_id,
                ).abort();
            } catch {}
        }
        return json({ ok: true });
    }

    match = path.match(/^\/api\/evidence\/([^/]+)$/);
    if (match && method === 'PATCH') {
        if (me.role !== 'player') return fail('Only players can update comments on draft evidence.', 403);
        const bytes = await readBoundedBody(request, 16_000);
        if (!bytes) return fail('Enter a comment for this file.', request.body ? 413 : 400);
        let body: { comment?: unknown } | null;
        try {
            body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return fail('Enter a comment for this file.');
        }
        if (typeof body?.comment !== 'string') return fail('Enter a comment for this file.');
        const comment = parseEvidenceComment(body.comment);
        if (comment === null)
            return fail(`Each file comment must be ${EVIDENCE_COMMENT_MAX_LENGTH} characters or fewer.`);
        const updated = await env.DB.prepare(
            `UPDATE evidence SET comment=? WHERE id=? AND ${GAME_WRITE_BLOCK_SQL} AND EXISTS (
      SELECT 1 FROM submissions WHERE submissions.id=evidence.submission_id AND submissions.group_id=? AND submissions.status='draft'
      AND NOT EXISTS (SELECT 1 FROM group_disbands WHERE group_id=submissions.group_id))`,
        )
            .bind(comment, match[1], me.id, me.groupId)
            .run();
        if (!updated.meta.changes) {
            if (await isPlayerDead(env, me.id))
                return json({ error: DEAD_MESSAGE, code: 'player_dead' }, 403);
            return fail('Draft evidence not found.', 404);
        }
        const evidence = await evidenceById(env, match[1]);
        return evidence ? json({ evidence }) : fail('Draft evidence not found.', 404);
    }
    if (match && method === 'DELETE') {
        if (me.role !== 'player') return fail('Only players can remove draft evidence.', 403);
        const evidenceRecord = await env.DB.prepare(
            'SELECT e.*,s.group_id,s.status,p.object_key AS preview_object_key FROM evidence e JOIN submissions s ON s.id=e.submission_id LEFT JOIN evidence_previews p ON p.evidence_id=e.id WHERE e.id=?',
        )
            .bind(match[1])
            .first<any>();
        if (!evidenceRecord || evidenceRecord.group_id !== me.groupId || evidenceRecord.status !== 'draft')
            return fail('Draft evidence not found.', 404);
        const removed = await env.DB.prepare(
            `DELETE FROM evidence WHERE id=? AND EXISTS(SELECT 1 FROM submissions WHERE id=? AND status='draft'
      AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=submissions.group_id))`,
        )
            .bind(evidenceRecord.id, evidenceRecord.submission_id)
            .run();
        if (!removed.meta.changes) return fail('Submission changed while removing evidence.', 409);
        if (evidenceRecord.preview_object_key) await env.EVIDENCE.delete(evidenceRecord.preview_object_key);
        await env.EVIDENCE.delete(evidenceRecord.object_key);
        return json({ ok: true });
    }
    match = path.match(/^\/api\/submissions\/([^/]+)\/submit$/);
    if (match && method === 'POST') {
        if (me.role !== 'player') return fail('Only players can submit evidence.', 403);
        const sub = await authorizedSubmission(me, env, match[1]);
        if (!sub || sub.status !== 'draft') return fail('Draft submission not found.', 404);
        await expireSubmissionUploads(env, sub.id);
        const body = await request.json<any>().catch(() => ({}));
        const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : null;
        const task = getTaskDefinition(sub.task_id);
        if (!task) return fail('Unknown task.');
        const result = await env.DB.prepare(
            `UPDATE submissions SET status='pending',note=COALESCE(?,note),submitted_at=? WHERE id=? AND group_id=? AND status='draft' AND ${SUBMISSIONS_OPEN_SQL} AND ${GAME_WRITE_BLOCK_SQL} AND NOT (julianday('now')>=julianday(?) AND julianday('now')<julianday(?)) AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=submissions.group_id) AND (SELECT COUNT(*) FROM evidence WHERE submission_id=submissions.id)>=? AND NOT EXISTS (SELECT 1 FROM upload_sessions WHERE submission_id=submissions.id AND state IN ('creating','uploading','completing'))`,
        )
            .bind(note, now(), sub.id, me.groupId, me.id, LUNCH_START, LUNCH_END, task.minFiles)
            .run();
        if (!result.meta.changes) {
            if (await isPlayerDead(env, me.id))
                return json({ error: DEAD_MESSAGE, code: 'player_dead' }, 403);
            if (isLunchBreak()) return json({ error: LUNCH_MESSAGE, code: 'lunch_break' }, 403);
            if (!(await submissionsEnabled(env)))
                return json({ error: SUBMISSIONS_PAUSED_MESSAGE, code: 'submissions_paused' }, 403);
            const latest = await getSubmission(env, sub.id);
            if (!latest || latest.status !== 'draft')
                return fail('Submission changed while you were editing it.', 409);
            const active = await env.DB.prepare(
                "SELECT COUNT(*) AS n FROM upload_sessions WHERE submission_id=? AND state IN ('creating','uploading','completing')",
            )
                .bind(sub.id)
                .first<{ n: number }>();
            if ((active?.n ?? 0) > 0)
                return fail('Wait for or cancel active file uploads before submitting.', 409);
            const evidence = await env.DB.prepare('SELECT COUNT(*) AS n FROM evidence WHERE submission_id=?')
                .bind(sub.id)
                .first<{ n: number }>();
            if ((evidence?.n ?? 0) < task.minFiles)
                return fail(
                    `Upload at least ${task.minFiles} file${task.minFiles === 1 ? '' : 's'} before submitting.`,
                );
            return fail('Submission changed while you were editing it.', 409);
        }
        return json({ submission: await shapeSubmission(await getSubmission(env, sub.id), env) });
    }
    const reviewRes = await handleSubReviews(
        request,
        env,
        me,
        (row, includeMetadata) => shapeSubmission(row, env, includeMetadata),
        () => dispatchReviewAlerts(env, context),
    );
    if (reviewRes) return reviewRes;
    const fileRes = await handleEvidenceFile(request, env, me);
    if (fileRes) return fileRes;
    return fail('Not found.', 404);
}

async function dispatchReviewAlerts(env: Env, context?: ExecutionContext) {
    const deliveries = Promise.all([
        processPushDeliveries(env).catch(() => {
            console.error('Push review delivery failed.');
        }),
        processReviewEmails(env).catch(() => {
            console.error('Email review delivery failed.');
        }),
    ]);
    if (context) context.waitUntil(deliveries);
    else await deliveries;
}

async function dispatchAnnouncementAlerts(env: Env, context?: ExecutionContext) {
    const deliveries = processAnnouncementDeliveries(env).catch(() => {
        console.error('Announcement delivery failed.');
    });
    if (context) context.waitUntil(deliveries);
    else await deliveries;
}

function shapeEvidence(e: any, includeMetadata = false): Evidence {
    return {
        id: e.id,
        submissionId: e.submission_id,
        filename: e.filename,
        comment: e.comment ?? '',
        mediaType: e.media_type,
        size: e.size,
        url: `/api/evidence/${e.id}/file`,
        ...(e.preview_object_key ? { previewUrl: `/api/evidence/${e.id}/preview` } : {}),
        uploadedAt: e.uploaded_at,
        slot: e.slot,
        ...(includeMetadata ? { metadata: parseJson<MetadataResult>(e.metadata_json) } : {}),
    };
}
async function shapeSubmission(row: any, env: Env, includeMetadata = false): Promise<Submission> {
    const evs = await env.DB.prepare(
        'SELECT e.*,p.object_key AS preview_object_key FROM evidence e LEFT JOIN evidence_previews p ON p.evidence_id=e.id WHERE e.submission_id=? ORDER BY e.uploaded_at,e.id',
    )
        .bind(row.id)
        .all<any>();
    return {
        id: row.id,
        groupId: row.group_id,
        taskId: row.task_id,
        status: row.status,
        attempt: row.attempt,
        note: row.note,
        reviewNote: row.review_note,
        createdAt: row.created_at,
        submittedAt: row.submitted_at,
        reviewedAt: row.reviewed_at,
        evidence: evs.results.map((e) => shapeEvidence(e, includeMetadata)),
    };
}

export default {
    async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
        if (new URL(request.url).pathname.startsWith('/api/')) {
            try {
                return await handleApi(request, env, context);
            } catch (error) {
                console.error('API error', error);
                return fail('The request could not be completed.', 500);
            }
        }
        return env.ASSETS.fetch(request);
    },
    async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
        if (controller.cron === '0 * * * *') {
            try {
                await cleanupExpiredUploads(env);
            } catch (error) {
                console.error('Upload cleanup failed', error);
            }
        }
        await Promise.all([
            processCaughtNotifications(env, 20).catch(() => {
                console.error('Caught notification retry failed.');
            }),
            processPushDeliveries(env, 100).catch(() => {
                console.error('Push delivery cleanup failed.');
            }),
            processReviewEmails(env, 20).catch(() => {
                console.error('Email delivery retry failed.');
            }),
            (async () => {
                await publishDueGameResult(env).catch(() => {
                    console.error('Geoguessr result publication failed.');
                });
                await processDueAnnouncements(env);
                await processAnnouncementDeliveries(env);
            })().catch(() => {
                console.error('Scheduled announcement delivery failed.');
            }),
        ]);
    },
};

export { passwordHash, passwordMatches };
