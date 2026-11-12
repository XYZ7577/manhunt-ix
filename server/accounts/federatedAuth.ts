import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Account } from '../../shared/types';
import { normalizePhone, REGISTRATION_PHONE_ERROR } from '../../shared/accounts/registrationPhone';
import { authError, authJson } from './authResponse';

export interface FederatedAuthEnv {
    DB: D1Database;
    APP_ORIGIN?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    ADMIN_GOOGLE_EMAIL?: string;
}

export interface AuthDeps {
    currentAccount(request: Request, env: FederatedAuthEnv): Promise<Account | null>;
    createSession(request: Request, env: FederatedAuthEnv, accountId: string): Promise<string>;
    passwordHash(password: string): Promise<{ salt: string; hash: string }>;
    googleJwks?: JWTVerifyGetKey;
    providerFetch?: typeof fetch;
}

const enc = new TextEncoder();
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_FLOW_MS = 10 * 60 * 1000;
const PUBLIC_AUTH_ERRORS = [
    'cancelled',
    'invalid_request',
    'invalid_state',
    'provider_unavailable',
    'configuration_missing',
    'identity_not_linked',
    'identity_already_linked',
    'account_not_found',
    'account_setup_required',
    'verification_failed',
    'sign_in_required',
    'already_signed_in',
    'phone_required',
] as const;
export type PublicAuthError = (typeof PUBLIC_AUTH_ERRORS)[number];

type Mode = 'login' | 'register' | 'link';
type JsonBody = Record<string, unknown>;
type GoogleClaims = { sub: string; email: string; email_verified: true; name?: string };
type IdentityRow = { account_id: string; provider: 'google'; subject: string; identifier: string };
type InvitationRow = { id: string; group_id: string; email: string; group_name: string };
type GoogleFlow = {
    id: string;
    state_hash: string;
    nonce_hash: string;
    code_verifier: string;
    cookie_hash: string;
    mode: Mode;
    account_id: string | null;
    group_name: string | null;
    members_json: string | null;
    phone: string | null;
    expires_at: string;
};
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const b64url = (bytes: Uint8Array) =>
    btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
const equalText = (a: string, b: string) =>
    a.length === b.length && constantTimeEqual(enc.encode(a), enc.encode(b));
const wrote = (result: { meta: { changes: number } } | undefined) =>
    Boolean(result && result.meta.changes > 0);

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    let difference = a.length ^ b.length;
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++)
        difference |= (a[i % Math.max(1, a.length)] ?? 0) ^ (b[i % Math.max(1, b.length)] ?? 0);
    return difference === 0;
}

export async function hashAuthValue(value: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(value));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function validGroupRegistration(
    groupName: unknown,
    members: unknown,
): { groupName: string; members: string[] } | null {
    if (typeof groupName !== 'string' || !Array.isArray(members)) return null;
    const name = groupName.trim();
    const roster = members.map((member) => (typeof member === 'string' ? member.trim() : ''));
    if (
        !name ||
        name.length > 60 ||
        roster.length < 1 ||
        roster.length > 12 ||
        roster.some((member) => !member || member.length > 80)
    )
        return null;
    return { groupName: name, members: roster };
}

function modeFrom(value: unknown): Mode | null {
    return value === 'login' || value === 'register' || value === 'link' ? value : null;
}

function appOrigin(env: FederatedAuthEnv): string | null {
    if (!env.APP_ORIGIN) return null;
    try {
        const url = new URL(env.APP_ORIGIN);
        if (
            url.origin !== env.APP_ORIGIN.replace(/\/$/, '') ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
        )
            return null;
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
        return url.origin;
    } catch {
        return null;
    }
}

function secureCookie(request: Request) {
    return new URL(request.url).protocol === 'https:' ? '; Secure' : '';
}
function binderCookie(name: string, value: string, request: Request, maxAge: number) {
    return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie(request)}`;
}
function expiredCookie(name: string, request: Request) {
    return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie(request)}`;
}
function requestCookie(request: Request, name: string): string | null {
    const prefix = `${name}=`;
    return (
        request.headers
            .get('Cookie')
            ?.split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith(prefix))
            ?.slice(prefix.length) ?? null
    );
}
function appendGoogleCookieClears(headers: Headers, request: Request, oneState?: string) {
    const names = new Set<string>();
    if (oneState && /^[A-Za-z0-9_-]{16,128}$/.test(oneState)) names.add(googleCookieName(oneState));
    for (const pair of (request.headers.get('Cookie') ?? '').split(';')) {
        const name = pair.trim().split('=', 1)[0];
        if (/^manhunt_google_[A-Za-z0-9_-]{12,24}$/.test(name)) names.add(name);
    }
    for (const name of names) headers.append('Set-Cookie', expiredCookie(name, request));
}
function googleCookieName(state: string) {
    return `manhunt_google_${state.slice(0, 20)}`;
}
type AuthReturnPath = '/login' | '/register' | '/settings';

function authRedirect(
    origin: string,
    error: PublicAuthError,
    request: Request,
    state?: string,
    returnPath: AuthReturnPath = '/login',
) {
    const url = new URL(returnPath, origin);
    url.searchParams.set('auth_error', error);
    const headers = new Headers({ Location: url.toString() });
    appendGoogleCookieClears(headers, request, state);
    return new Response(null, { status: 303, headers });
}

function readObject(value: unknown): JsonBody | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonBody) : null;
}
async function requestJson(request: Request): Promise<JsonBody | null> {
    return readObject(await request.json().catch(() => null));
}

export async function validateGoogleIdToken(
    token: string,
    clientId: string,
    expectedNonceHash: string,
    jwks: JWTVerifyGetKey = GOOGLE_KEYS,
): Promise<GoogleClaims> {
    if (!clientId || !token || !expectedNonceHash) throw new Error('invalid_token');
    const { payload } = await jwtVerify(token, jwks, {
        algorithms: ['RS256'],
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
        requiredClaims: ['exp', 'iat', 'iss', 'aud', 'sub', 'nonce', 'email', 'email_verified'],
        clockTolerance: 5,
    });
    if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        typeof payload.email !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
        payload.email_verified !== true ||
        typeof payload.nonce !== 'string' ||
        !equalText(await hashAuthValue(payload.nonce), expectedNonceHash)
    )
        throw new Error('invalid_claims');
    if (payload.azp !== undefined && payload.azp !== clientId) throw new Error('invalid_authorized_party');
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
        throw new Error('invalid_authorized_party');
    return {
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        email_verified: true,
        ...(typeof payload.name === 'string' && payload.name.trim()
            ? { name: payload.name.trim().slice(0, 80) }
            : {}),
    };
}

function validGoogleConfig(
    env: FederatedAuthEnv,
): env is FederatedAuthEnv & { APP_ORIGIN: string; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string } {
    return Boolean(appOrigin(env) && env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}
async function options(_request: Request, env: FederatedAuthEnv) {
    return authJson({ googleEnabled: validGoogleConfig(env) });
}

async function methods(request: Request, env: FederatedAuthEnv, deps: AuthDeps) {
    const account = await deps.currentAccount(request, env);
    if (!account) return authError('Please sign in.', 401);
    const rows = await env.DB.prepare(
        "SELECT provider,identifier FROM federated_identities WHERE account_id=? AND provider='google' ORDER BY created_at",
    )
        .bind(account.id)
        .all<{ provider: 'google'; identifier: string }>();
    return authJson({
        methods: rows.results.map((row) => ({
            id: row.provider,
            provider: row.provider,
            identifier: row.identifier,
        })),
    });
}

async function googleStart(request: Request, env: FederatedAuthEnv, deps: AuthDeps) {
    if (!validGoogleConfig(env)) return authError('Google sign-in is not configured.', 503);
    const requestOrigin = request.headers.get('Origin');
    const pinnedOrigin = appOrigin(env)!;
    if (requestOrigin && requestOrigin !== pinnedOrigin)
        return authError('Cross-origin request rejected.', 403);
    const body = await requestJson(request);
    const mode = modeFrom(body?.mode);
    if (!mode) return authError('Choose login, register, or link.');
    const sessionAccount = await deps.currentAccount(request, env);
    if (mode === 'link' && !sessionAccount) return authError('Sign in before linking Google.', 401);
    if (mode === 'register' && sessionAccount)
        return authError('Sign out before creating another group account.', 409);
    let registration: { groupName: string; members: string[] } | null = null;
    let registrationPhone: string | null = null;
    if (mode === 'register') {
        registrationPhone = normalizePhone(body?.phone);
        if (!registrationPhone) return authError(REGISTRATION_PHONE_ERROR);
        const hasRegFields = body?.groupName !== undefined || body?.members !== undefined;
        if (hasRegFields) {
            registration = validGroupRegistration(body?.groupName, body?.members);
            if (!registration) return authError('Enter a group name and between 1 and 12 member names.');
        }
    }

    const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const cookieValue = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
    const timestamp = new Date();
    const expires = new Date(timestamp.getTime() + GOOGLE_FLOW_MS).toISOString();
    const flowId = id();
    try {
        await env.DB.prepare('DELETE FROM google_auth_flows WHERE expires_at<=? OR consumed_at IS NOT NULL')
            .bind(timestamp.toISOString())
            .run();
        await env.DB.prepare(
            'INSERT INTO google_auth_flows(id,state_hash,nonce_hash,code_verifier,cookie_hash,mode,account_id,group_name,members_json,phone,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
            .bind(
                flowId,
                await hashAuthValue(state),
                await hashAuthValue(nonce),
                verifier,
                await hashAuthValue(cookieValue),
                mode,
                sessionAccount?.id ?? null,
                registration?.groupName ?? null,
                registration ? JSON.stringify(registration.members) : null,
                registrationPhone,
                timestamp.toISOString(),
                expires,
            )
            .run();
    } catch {
        return authError('Could not start Google sign-in. Try again.', 503);
    }

    const callback = `${pinnedOrigin}/api/auth/google/callback`;
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: callback,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    }).toString();
    return authJson({ authorizationUrl: authorization.toString() }, 200, {
        'Set-Cookie': binderCookie(googleCookieName(state), cookieValue, request, GOOGLE_FLOW_MS / 1000),
    });
}

async function exchangeGoogleCode(
    code: string,
    verifier: string,
    callback: string,
    env: FederatedAuthEnv,
    deps: AuthDeps,
): Promise<string | null> {
    const fetcher = deps.providerFetch ?? fetch;
    try {
        const response = await fetcher('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                code,
                client_id: env.GOOGLE_CLIENT_ID!,
                client_secret: env.GOOGLE_CLIENT_SECRET!,
                redirect_uri: callback,
                grant_type: 'authorization_code',
                code_verifier: verifier,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return null;
        const body = readObject(await response.json().catch(() => null));
        return typeof body?.id_token === 'string' ? body.id_token : null;
    } catch {
        return null;
    }
}

async function getGoogleFlow(env: FederatedAuthEnv, state: string): Promise<GoogleFlow | null> {
    const hash = await hashAuthValue(state);
    return env.DB.prepare(
        'SELECT * FROM google_auth_flows WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?',
    )
        .bind(hash, now())
        .first<GoogleFlow>();
}

async function consumeGoogleFlow(env: FederatedAuthEnv, flow: GoogleFlow): Promise<boolean> {
    const result = await env.DB.prepare(
        'UPDATE google_auth_flows SET consumed_at=?,phone=NULL WHERE id=? AND state_hash=? AND consumed_at IS NULL AND expires_at>?',
    )
        .bind(now(), flow.id, flow.state_hash, now())
        .run();
    return result.meta.changes === 1;
}

async function googleCallback(request: Request, env: FederatedAuthEnv, deps: AuthDeps): Promise<Response> {
    const origin = appOrigin(env);
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    let flow: GoogleFlow | null = null;
    try {
        if (state) flow = await getGoogleFlow(env, state);
    } catch {}
    const returnPath: AuthReturnPath = flow?.mode === 'link' ? '/settings' : '/login';
    if (!origin || !validGoogleConfig(env))
        return authRedirect(origin ?? url.origin, 'configuration_missing', request, state, returnPath);
    const providerError = url.searchParams.get('error');
    const binderName = /^[A-Za-z0-9_-]{16,128}$/.test(state) ? googleCookieName(state) : '';
    const cookie = binderName ? requestCookie(request, binderName) : null;
    if (providerError) {
        const boundFlow = Boolean(
            binderName && cookie && flow && (await equalText(await hashAuthValue(cookie), flow.cookie_hash)),
        );
        if (boundFlow && flow) await consumeGoogleFlow(env, flow);
        return authRedirect(
            origin,
            providerError === 'access_denied' ? 'cancelled' : 'invalid_request',
            request,
            state,
            returnPath,
        );
    }
    if (!binderName || !cookie) return authRedirect(origin, 'invalid_state', request, state, returnPath);
    if (!flow || !equalText(await hashAuthValue(cookie), flow.cookie_hash))
        return authRedirect(origin, 'invalid_state', request, state, returnPath);
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || !flow.code_verifier || !flow.nonce_hash) {
        await consumeGoogleFlow(env, flow);
        return authRedirect(origin, 'invalid_request', request, state, returnPath);
    }
    const idToken = await exchangeGoogleCode(
        code,
        flow.code_verifier,
        `${origin}/api/auth/google/callback`,
        env,
        deps,
    );
    if (!idToken) {
        await consumeGoogleFlow(env, flow);
        return authRedirect(origin, 'provider_unavailable', request, state, returnPath);
    }

    let claims: GoogleClaims;
    try {
        claims = await validateGoogleIdToken(
            idToken,
            env.GOOGLE_CLIENT_ID,
            flow.nonce_hash,
            deps.googleJwks ?? GOOGLE_KEYS,
        );
    } catch {
        await consumeGoogleFlow(env, flow);
        return authRedirect(origin, 'verification_failed', request, state, returnPath);
    }

    const existing = await env.DB.prepare(
        "SELECT id,account_id,provider,subject,identifier FROM federated_identities WHERE provider='google' AND subject=?",
    )
        .bind(claims.sub)
        .first<IdentityRow>();
    const defaultAdminEmail = env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase();
    const isDefaultAdmin = Boolean(defaultAdminEmail && claims.email === defaultAdminEmail);
    if (!existing && !isDefaultAdmin && flow.mode === 'login') {
        await consumeGoogleFlow(env, flow);
        return authRedirect(origin, 'phone_required', request, state, '/register');
    }
    if (!isDefaultAdmin && flow.mode === 'register' && !normalizePhone(flow.phone)) {
        await consumeGoogleFlow(env, flow);
        return authRedirect(origin, 'phone_required', request, state, '/register');
    }
    const sessionAccount = await deps.currentAccount(request, env);
    if (flow.mode === 'link' && (!sessionAccount || sessionAccount.id !== flow.account_id)) {
        await consumeGoogleFlow(env, flow);
        return authRedirect(origin, 'sign_in_required', request, state, returnPath);
    }
    if (existing && flow.mode === 'link' && existing.account_id !== flow.account_id) {
        await consumeGoogleFlow(env, flow);
        return authRedirect(origin, 'identity_already_linked', request, state, returnPath);
    }
    if (flow.mode === 'register' && existing) {
        await consumeGoogleFlow(env, flow);
        return authRedirect(origin, 'identity_already_linked', request, state, returnPath);
    }
    let accountId: string;
    let linked = flow.mode === 'link';
    if (isDefaultAdmin && flow.mode !== 'link') {
        if (existing) {
            const adminStatus = await defaultAdminIdentityStatus(env, existing);
            if (adminStatus === 'blocked') {
                await consumeGoogleFlow(env, flow);
                return authRedirect(origin, 'account_setup_required', request, state, returnPath);
            }
            if (adminStatus === 'promote') {
                if (!(await promotePendingGoogleAdmin(env, deps, flow, existing, defaultAdminEmail!))) {
                    return authRedirect(origin, 'identity_not_linked', request, state, returnPath);
                }
            } else if (!(await syncGoogleIdentity(env, flow, existing, claims.email))) {
                return authRedirect(origin, 'identity_already_linked', request, state, returnPath);
            }
            accountId = existing.account_id;
        } else {
            const created = await createDefaultGoogleAdmin(
                env,
                deps,
                flow,
                claims.sub,
                claims.email,
                googleDisplayName(claims),
            );
            if (!created) return authRedirect(origin, 'identity_not_linked', request, state, returnPath);
            accountId = created;
        }
    } else {
        const invitation = !existing && flow.mode !== 'link' ? await findInvitation(env, claims.email) : null;
        if (flow.mode === 'link') {
            accountId = flow.account_id!;
            if (existing) {
                if (
                    existing.account_id !== accountId ||
                    !(await syncGoogleIdentity(env, flow, existing, claims.email))
                )
                    return authRedirect(origin, 'identity_already_linked', request, state, returnPath);
            } else if (!(await linkIdentity(env, flow, 'google', claims.sub, claims.email))) {
                return authRedirect(origin, 'identity_already_linked', request, state, returnPath);
            }
        } else if (existing) {
            accountId = existing.account_id;
            if (!(await syncGoogleIdentity(env, flow, existing, claims.email)))
                return authRedirect(origin, 'identity_already_linked', request, state, returnPath);
        } else if (invitation) {
            const created = await createInvitedPlayer(env, deps, flow, invitation, claims.sub, claims.email);
            if (!created) return authRedirect(origin, 'identity_not_linked', request, state, returnPath);
            accountId = created;
        } else {
            const requestedMembers = flow.members_json ? safeMembers(flow.members_json) : null;
            if (flow.members_json && !requestedMembers) {
                await consumeGoogleFlow(env, flow);
                return authRedirect(origin, 'invalid_request', request, state, returnPath);
            }
            const displayName = googleDisplayName(claims);
            const groupName = flow.group_name ?? `${displayName}'s group`.slice(0, 60);
            const members = requestedMembers ?? [displayName];
            const created = await createFederatedPlayer(
                env,
                deps,
                flow,
                claims.sub,
                claims.email,
                displayName,
                groupName,
                members,
            );
            if (!created) return authRedirect(origin, 'identity_already_linked', request, state, returnPath);
            accountId = created;
        }
    }

    if (flow.mode !== 'link') linked = false;
    let sessionCookie: string | undefined;
    if (!linked) {
        try {
            sessionCookie = await deps.createSession(request, env, accountId);
        } catch {
            return authRedirect(origin, 'provider_unavailable', request, state, returnPath);
        }
    }
    const destination = new URL(linked ? '/settings' : '/tasks', origin);
    destination.searchParams.set('auth', linked ? 'linked' : 'signed-in');
    const headers = new Headers({ Location: destination.toString() });
    if (sessionCookie) headers.append('Set-Cookie', sessionCookie);
    appendGoogleCookieClears(headers, request, state);
    return new Response(null, { status: 303, headers });
}

function googleDisplayName(claims: GoogleClaims): string {
    const fromName = claims.name?.trim();
    if (fromName) return fromName.slice(0, 80);
    const localPart = claims.email
        .split('@', 1)[0]
        .replace(/[._+-]+/g, ' ')
        .trim();
    return (localPart || 'Google player').slice(0, 80).replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

type BootstrapIdentityState = 'approved_admin' | 'promote' | 'blocked';

async function defaultAdminIdentityStatus(
    env: FederatedAuthEnv,
    identity: IdentityRow,
): Promise<BootstrapIdentityState> {
    const row = await env.DB.prepare(
        `SELECT a.role, a.group_id, aa.status AS approval_status,
      s.password_set, s.totp_enabled, s.totp_secret_ciphertext, s.totp_pending_ciphertext,
      (SELECT COUNT(*) FROM federated_identities fi WHERE fi.account_id=a.id) AS identity_count,
      (SELECT COUNT(*) FROM totp_recovery_codes rc WHERE rc.account_id=a.id) AS recovery_code_count
    FROM accounts a LEFT JOIN account_approvals aa ON aa.account_id=a.id
    LEFT JOIN account_security s ON s.account_id=a.id WHERE a.id=?`,
    )
        .bind(identity.account_id)
        .first<{
            role: string;
            group_id: string | null;
            approval_status: string | null;
            password_set: number | null;
            totp_enabled: number | null;
            totp_secret_ciphertext: string | null;
            totp_pending_ciphertext: string | null;
            identity_count: number;
            recovery_code_count: number;
        }>();
    if (row?.role === 'admin' && row.approval_status === 'approved') return 'approved_admin';
    if (
        row?.role === 'player' &&
        row.approval_status === 'pending' &&
        row.group_id === null &&
        row.password_set === 0 &&
        row.totp_enabled === 0 &&
        !row.totp_secret_ciphertext &&
        !row.totp_pending_ciphertext &&
        row.identity_count === 1 &&
        row.recovery_code_count === 0 &&
        identity.identifier.trim().toLowerCase() === env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase()
    )
        return 'promote';
    return 'blocked';
}

async function promotePendingGoogleAdmin(
    env: FederatedAuthEnv,
    deps: AuthDeps,
    flow: GoogleFlow,
    identity: IdentityRow,
    email: string,
): Promise<boolean> {
    const claim = id(),
        timestamp = now();
    const randomPassword = `${b64url(crypto.getRandomValues(new Uint8Array(64)))}-${id()}`;
    const hash = await deps.passwordHash(randomPassword);
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                'UPDATE google_auth_flows SET consumed_at=?,consumption_token=?,phone=NULL WHERE id=? AND state_hash=? AND consumed_at IS NULL AND expires_at>?',
            ).bind(timestamp, claim, flow.id, flow.state_hash, timestamp),
            env.DB.prepare(
                `UPDATE accounts SET role='admin',password_salt=?,password_hash=? WHERE id=? AND role='player' AND group_id IS NULL
        AND EXISTS (SELECT 1 FROM account_approvals aa WHERE aa.account_id=accounts.id AND aa.status='pending')
        AND EXISTS (SELECT 1 FROM account_security s WHERE s.account_id=accounts.id AND s.password_set=0 AND s.totp_enabled=0 AND s.totp_secret_ciphertext IS NULL AND s.totp_pending_ciphertext IS NULL)
        AND (SELECT COUNT(*) FROM federated_identities fi WHERE fi.account_id=accounts.id)=1
        AND NOT EXISTS (SELECT 1 FROM totp_recovery_codes rc WHERE rc.account_id=accounts.id)
        AND EXISTS (SELECT 1 FROM federated_identities fi WHERE fi.account_id=accounts.id AND fi.provider='google' AND fi.subject=? AND fi.identifier=? COLLATE NOCASE)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(hash.salt, hash.hash, identity.account_id, identity.subject, email, flow.id, claim),
            env.DB.prepare(
                `UPDATE account_approvals SET status='approved',reviewed_at=?,reviewed_by=NULL,review_note='Configured Google administrator bootstrap'
        WHERE account_id=? AND status='pending' AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND role='admin' AND password_salt=? AND password_hash=?)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(timestamp, identity.account_id, identity.account_id, hash.salt, hash.hash, flow.id, claim),
            env.DB.prepare(
                "UPDATE account_security SET password_set=0,security_version=security_version+1,security_claim=NULL,updated_at=? WHERE account_id=? AND password_set=0 AND totp_enabled=0 AND totp_secret_ciphertext IS NULL AND totp_pending_ciphertext IS NULL AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND role='admin' AND password_salt=? AND password_hash=?) AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)",
            ).bind(timestamp, identity.account_id, identity.account_id, hash.salt, hash.hash, flow.id, claim),
            env.DB.prepare(
                "DELETE FROM account_group_requests WHERE account_id=? AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND role='admin' AND password_salt=? AND password_hash=?) AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)",
            ).bind(identity.account_id, identity.account_id, hash.salt, hash.hash, flow.id, claim),
            env.DB.prepare(
                "DELETE FROM sessions WHERE account_id=? AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND role='admin' AND password_salt=? AND password_hash=?) AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)",
            ).bind(identity.account_id, identity.account_id, hash.salt, hash.hash, flow.id, claim),
            env.DB.prepare(
                "DELETE FROM password_reset_challenges WHERE account_id=? AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND role='admin' AND password_salt=? AND password_hash=?) AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)",
            ).bind(identity.account_id, identity.account_id, hash.salt, hash.hash, flow.id, claim),
            env.DB.prepare(
                "DELETE FROM totp_challenges WHERE account_id=? AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND role='admin' AND password_salt=? AND password_hash=?) AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)",
            ).bind(identity.account_id, identity.account_id, hash.salt, hash.hash, flow.id, claim),
            env.DB.prepare(
                `UPDATE federated_identities SET identifier=? WHERE account_id=? AND provider='google' AND subject=?
        AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND role='admin' AND password_salt=? AND password_hash=?) AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(
                email,
                identity.account_id,
                identity.subject,
                identity.account_id,
                hash.salt,
                hash.hash,
                flow.id,
                claim,
            ),
            env.DB.prepare(
                `INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at)
        SELECT ?,?,?,1,?,? WHERE EXISTS (SELECT 1 FROM accounts WHERE id=? AND role='admin' AND password_salt=? AND password_hash=?)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)
        ON CONFLICT(account_id,email) DO UPDATE SET is_primary=1,verified_at=excluded.verified_at`,
            ).bind(
                id(),
                identity.account_id,
                email,
                timestamp,
                timestamp,
                identity.account_id,
                hash.salt,
                hash.hash,
                flow.id,
                claim,
            ),
        ]);
        return (
            wrote(results[0]) &&
            wrote(results[1]) &&
            wrote(results[2]) &&
            wrote(results[3]) &&
            wrote(results[8]) &&
            wrote(results[9])
        );
    } catch {
        await consumeGoogleFlow(env, flow);
        return false;
    }
}

async function createDefaultGoogleAdmin(
    env: FederatedAuthEnv,
    deps: AuthDeps,
    flow: GoogleFlow,
    subject: string,
    email: string,
    displayName: string,
): Promise<string | null> {
    const claim = id(),
        accountId = id(),
        username = `google:${id()}`;
    const randomPassword = `${b64url(crypto.getRandomValues(new Uint8Array(64)))}-${id()}`;
    const hash = await deps.passwordHash(randomPassword);
    const timestamp = now();
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                'UPDATE google_auth_flows SET consumed_at=?,consumption_token=?,phone=NULL WHERE id=? AND state_hash=? AND consumed_at IS NULL AND expires_at>?',
            ).bind(timestamp, claim, flow.id, flow.state_hash, timestamp),
            env.DB.prepare(
                `INSERT INTO accounts(id,username,display_name,role,group_id,password_salt,password_hash,created_at)
        SELECT ?,?,?,'admin',NULL,?,?,? WHERE EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)
        AND NOT EXISTS (SELECT 1 FROM federated_identities WHERE provider='google' AND subject=?)`,
            ).bind(
                accountId,
                username,
                displayName,
                hash.salt,
                hash.hash,
                timestamp,
                flow.id,
                claim,
                subject,
            ),
            env.DB.prepare(
                `INSERT INTO account_approvals(account_id,status,requested_at,reviewed_at,reviewed_by,review_note)
        SELECT id,'approved',?,?,NULL,'Configured Google administrator bootstrap' FROM accounts WHERE id=? AND role='admin'
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(timestamp, timestamp, accountId, flow.id, claim),
            env.DB.prepare(
                `INSERT INTO federated_identities(id,account_id,provider,subject,identifier,created_at)
        SELECT ?,?,'google',?,?,? FROM accounts WHERE id=? AND role='admin'
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(id(), accountId, subject, email, timestamp, accountId, flow.id, claim),
            env.DB.prepare(
                "INSERT INTO account_security(account_id,password_set,updated_at) SELECT id,0,? FROM accounts WHERE id=? AND role='admin' AND EXISTS (SELECT 1 FROM federated_identities WHERE account_id=? AND provider='google' AND subject=?)",
            ).bind(timestamp, accountId, accountId, subject),
            env.DB.prepare(
                `INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at)
        SELECT ?,id,?,1,?,? FROM accounts WHERE id=? AND role='admin' AND EXISTS (SELECT 1 FROM federated_identities WHERE account_id=? AND provider='google' AND subject=?)`,
            ).bind(id(), email, timestamp, timestamp, accountId, accountId, subject),
        ]);
        return results.every(wrote) ? accountId : null;
    } catch {
        await consumeGoogleFlow(env, flow);
        return null;
    }
}

function safeMembers(value: string): string[] | null {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed) || parsed.some((member) => typeof member !== 'string')) return null;
        const checked = validGroupRegistration('registration', parsed);
        return checked?.members ?? null;
    } catch {
        return null;
    }
}

async function linkIdentity(
    env: FederatedAuthEnv,
    flow: GoogleFlow,
    provider: 'google',
    subject: string,
    identifier: string,
): Promise<boolean> {
    const claim = id();
    const timestamp = now();
    const accountId = flow.account_id!;
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                'UPDATE google_auth_flows SET consumed_at=?,consumption_token=?,phone=NULL WHERE id=? AND state_hash=? AND consumed_at IS NULL AND expires_at>?',
            ).bind(timestamp, claim, flow.id, flow.state_hash, timestamp),
            env.DB.prepare(
                'INSERT INTO federated_identities(id,account_id,provider,subject,identifier,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)',
            ).bind(id(), accountId, provider, subject, identifier.toLowerCase(), timestamp, flow.id, claim),
            env.DB.prepare(
                'UPDATE account_emails SET is_primary=0 WHERE account_id=? AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)',
            ).bind(accountId, flow.id, claim),
            env.DB.prepare(
                `INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at)
        SELECT ?,?, ?,1,?,? WHERE EXISTS (SELECT 1 FROM federated_identities WHERE account_id=? AND provider='google' AND subject=?)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)
        ON CONFLICT(account_id,email) DO UPDATE SET is_primary=1,verified_at=excluded.verified_at`,
            ).bind(
                id(),
                accountId,
                identifier.toLowerCase(),
                timestamp,
                timestamp,
                accountId,
                subject,
                flow.id,
                claim,
            ),
        ]);
        return wrote(results[0]) && wrote(results[1]) && wrote(results[3]);
    } catch {
        await consumeGoogleFlow(env, flow);
        return false;
    }
}

async function syncGoogleIdentity(
    env: FederatedAuthEnv,
    flow: GoogleFlow,
    identity: IdentityRow,
    email: string,
): Promise<boolean> {
    const claim = id(),
        timestamp = now(),
        normalized = email.trim().toLowerCase();
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                'UPDATE google_auth_flows SET consumed_at=?,consumption_token=?,phone=NULL WHERE id=? AND state_hash=? AND consumed_at IS NULL AND expires_at>?',
            ).bind(timestamp, claim, flow.id, flow.state_hash, timestamp),
            env.DB.prepare(
                `UPDATE federated_identities SET identifier=? WHERE provider='google' AND subject=? AND account_id=?
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(normalized, identity.subject, identity.account_id, flow.id, claim),
            env.DB.prepare(
                'UPDATE account_emails SET is_primary=0 WHERE account_id=? AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)',
            ).bind(identity.account_id, flow.id, claim),
            env.DB.prepare(
                `INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at)
        SELECT ?,?,?,1,?,? WHERE EXISTS (SELECT 1 FROM federated_identities WHERE provider='google' AND subject=? AND account_id=? AND identifier=?)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)
        ON CONFLICT(account_id,email) DO UPDATE SET is_primary=1,verified_at=excluded.verified_at`,
            ).bind(
                id(),
                identity.account_id,
                normalized,
                timestamp,
                timestamp,
                identity.subject,
                identity.account_id,
                normalized,
                flow.id,
                claim,
            ),
        ]);
        return wrote(results[0]) && wrote(results[1]) && wrote(results[3]);
    } catch {
        await consumeGoogleFlow(env, flow);
        return false;
    }
}

async function findInvitation(env: FederatedAuthEnv, email: string): Promise<InvitationRow | null> {
    return env.DB.prepare(
        `SELECT i.id,i.group_id,i.email,g.name AS group_name FROM group_invitations i
    JOIN groups g ON g.id=i.group_id WHERE i.email=? COLLATE NOCASE AND i.status='pending' AND i.expires_at>? LIMIT 1`,
    )
        .bind(email.trim().toLowerCase(), now())
        .first<InvitationRow>();
}

async function createInvitedPlayer(
    env: FederatedAuthEnv,
    deps: AuthDeps,
    flow: GoogleFlow,
    invitation: InvitationRow,
    subject: string,
    email: string,
): Promise<string | null> {
    const phone = flow.mode === 'register' ? normalizePhone(flow.phone) : null;
    if (!phone) return null;
    const claim = id(),
        accountId = id();
    const username = `google:${id()}`;
    const displayName = email.split('@')[0].slice(0, 80) || invitation.group_name;
    const randomPassword = `${b64url(crypto.getRandomValues(new Uint8Array(64)))}-${id()}`;
    const hash = await deps.passwordHash(randomPassword);
    const timestamp = now();
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                'UPDATE google_auth_flows SET consumed_at=?,consumption_token=?,phone=NULL WHERE id=? AND state_hash=? AND consumed_at IS NULL AND expires_at>?',
            ).bind(timestamp, claim, flow.id, flow.state_hash, timestamp),
            env.DB.prepare(
                `INSERT INTO accounts(id,username,display_name,role,group_id,password_salt,password_hash,created_at)
        SELECT ?,?,?,'player',?,?,?,? WHERE EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND group_id=? AND email=? COLLATE NOCASE AND status='pending' AND expires_at>?)
        AND (SELECT COUNT(*) FROM accounts WHERE group_id=? AND role='player')<12
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(
                accountId,
                username,
                displayName,
                invitation.group_id,
                hash.salt,
                hash.hash,
                timestamp,
                invitation.id,
                invitation.group_id,
                email.trim().toLowerCase(),
                timestamp,
                invitation.group_id,
                flow.id,
                claim,
            ),
            env.DB.prepare(
                `UPDATE group_invitations SET status='accepted',accepted_at=?,accepted_by=? WHERE id=? AND group_id=? AND email=? COLLATE NOCASE
        AND status='pending' AND expires_at>? AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND group_id=? AND role='player')
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(
                timestamp,
                accountId,
                invitation.id,
                invitation.group_id,
                email.trim().toLowerCase(),
                timestamp,
                accountId,
                invitation.group_id,
                flow.id,
                claim,
            ),
            env.DB.prepare(
                `DELETE FROM accounts WHERE id=? AND NOT EXISTS (
        SELECT 1 FROM group_invitations WHERE id=? AND status='accepted' AND accepted_by=?
      )`,
            ).bind(accountId, invitation.id, accountId),
            env.DB.prepare(
                `INSERT INTO federated_identities(id,account_id,provider,subject,identifier,created_at)
        SELECT ?,?,'google',?,?,? WHERE EXISTS (SELECT 1 FROM accounts WHERE id=? AND group_id=?)
        AND EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND status='accepted' AND accepted_by=?)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(
                id(),
                accountId,
                subject,
                email.trim().toLowerCase(),
                timestamp,
                accountId,
                invitation.group_id,
                invitation.id,
                accountId,
                flow.id,
                claim,
            ),
            env.DB.prepare(
                `INSERT INTO account_security(account_id,password_set,updated_at) SELECT id,0,? FROM accounts WHERE id=?
        AND EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND status='accepted' AND accepted_by=?)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(timestamp, accountId, invitation.id, accountId, flow.id, claim),
            env.DB.prepare(
                `INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at) SELECT ?,id,?,1,?,? FROM accounts WHERE id=?
        AND EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND status='accepted' AND accepted_by=?)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(
                id(),
                email.trim().toLowerCase(),
                timestamp,
                timestamp,
                accountId,
                invitation.id,
                accountId,
                flow.id,
                claim,
            ),
            env.DB.prepare(
                `INSERT INTO account_contacts(account_id,phone,phone_verified_at) SELECT id,?,NULL FROM accounts WHERE id=?
        AND EXISTS (SELECT 1 FROM group_invitations WHERE id=? AND status='accepted' AND accepted_by=?)
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(phone, accountId, invitation.id, accountId, flow.id, claim),
        ]);
        return wrote(results[0]) &&
            wrote(results[1]) &&
            wrote(results[2]) &&
            results[3].meta.changes === 0 &&
            wrote(results[4]) &&
            wrote(results[5]) &&
            wrote(results[6]) &&
            wrote(results[7])
            ? accountId
            : null;
    } catch {
        await consumeGoogleFlow(env, flow);
        return null;
    }
}

async function createFederatedPlayer(
    env: FederatedAuthEnv,
    deps: AuthDeps,
    flow: GoogleFlow,
    subject: string,
    identifier: string,
    displayName: string,
    groupName: string,
    members: string[],
): Promise<string | null> {
    const phone = flow.mode === 'register' ? normalizePhone(flow.phone) : null;
    if (!phone) return null;
    const claim = id();
    const accountId = id(),
        groupId = id();
    const username = `google:${id()}`;
    const randomPassword = `${b64url(crypto.getRandomValues(new Uint8Array(64)))}-${id()}`;
    const hash = await deps.passwordHash(randomPassword);
    const timestamp = now();
    try {
        const results = await env.DB.batch([
            env.DB.prepare(
                'UPDATE google_auth_flows SET consumed_at=?,consumption_token=?,phone=NULL WHERE id=? AND state_hash=? AND consumed_at IS NULL AND expires_at>?',
            ).bind(timestamp, claim, flow.id, flow.state_hash, timestamp),
            env.DB.prepare(
                "INSERT INTO accounts(id,username,display_name,role,group_id,password_salt,password_hash,created_at) SELECT ?,?,?,'player',NULL,?,?,? WHERE EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)",
            ).bind(accountId, username, displayName, hash.salt, hash.hash, timestamp, flow.id, claim),
            env.DB.prepare(
                `INSERT INTO account_group_requests(account_id,group_id,name,members_json,created_at)
        SELECT id,?,?,?,? FROM accounts WHERE id=? AND group_id IS NULL
        AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)`,
            ).bind(groupId, groupName, JSON.stringify(members), timestamp, accountId, flow.id, claim),
            env.DB.prepare(
                "INSERT INTO federated_identities(id,account_id,provider,subject,identifier,created_at) SELECT ?,?,'google',?,?,? WHERE EXISTS (SELECT 1 FROM accounts WHERE id=? AND group_id IS NULL) AND EXISTS (SELECT 1 FROM account_group_requests WHERE account_id=? AND group_id=?) AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)",
            ).bind(
                id(),
                accountId,
                subject,
                identifier,
                timestamp,
                accountId,
                accountId,
                groupId,
                flow.id,
                claim,
            ),
            env.DB.prepare(
                'INSERT INTO account_security(account_id,password_set,updated_at) SELECT id,0,? FROM accounts WHERE id=?',
            ).bind(timestamp, accountId),
            env.DB.prepare(
                'INSERT INTO account_emails(id,account_id,email,is_primary,verified_at,created_at) SELECT ?,id,?,1,?,? FROM accounts WHERE id=?',
            ).bind(id(), identifier.toLowerCase(), timestamp, timestamp, accountId),
            env.DB.prepare(
                'INSERT INTO account_contacts(account_id,phone,phone_verified_at) SELECT id,?,NULL FROM accounts WHERE id=? AND EXISTS (SELECT 1 FROM google_auth_flows WHERE id=? AND consumption_token=?)',
            ).bind(phone, accountId, flow.id, claim),
        ]);
        return results.every(wrote) ? accountId : null;
    } catch {
        await consumeGoogleFlow(env, flow);
        return null;
    }
}

export async function handleFederatedAuth(
    request: Request,
    env: FederatedAuthEnv,
    deps: AuthDeps,
): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase();
    if (path === '/api/auth/options' && method === 'GET') return options(request, env);
    if (path === '/api/auth/methods' && method === 'GET') return methods(request, env, deps);
    if (path === '/api/auth/google/start' && method === 'POST') return googleStart(request, env, deps);
    if (path === '/api/auth/google/callback' && method === 'GET') {
        try {
            return await googleCallback(request, env, deps);
        } catch {
            const callback = new URL(request.url);
            const state = callback.searchParams.get('state') ?? '';
            let returnPath: AuthReturnPath = '/login';
            try {
                if ((await getGoogleFlow(env, state))?.mode === 'link') returnPath = '/settings';
            } catch {}
            return authRedirect(
                appOrigin(env) ?? callback.origin,
                'provider_unavailable',
                request,
                state,
                returnPath,
            );
        }
    }
    if (path === '/api/auth/sms' || path.startsWith('/api/auth/sms/'))
        return authError('SMS sign-in is no longer supported. Sign in with Google.', 410);
    return null;
}
