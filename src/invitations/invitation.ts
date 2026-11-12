export type PendingInvitation = { id: string; token: string; cachedAt: number };

export const PENDING_INVITATION_KEY = 'manhunt_confirmed_invitation_v2';
const LEGACY_PENDING_INVITATION_KEY = 'manhunt_pending_invitation';
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function validIdentity(value: unknown): value is { id: string; token: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        typeof value.id === 'string' &&
        UUID_PATTERN.test(value.id) &&
        'token' in value &&
        typeof value.token === 'string' &&
        TOKEN_PATTERN.test(value.token)
    );
}

function validPending(value: unknown, now = Date.now()): value is PendingInvitation {
    if (
        !validIdentity(value) ||
        !('cachedAt' in value) ||
        typeof value.cachedAt !== 'number' ||
        !Number.isFinite(value.cachedAt)
    )
        return false;
    return value.cachedAt <= now && now - value.cachedAt < INVITATION_TTL_MS;
}

export function parseInvitation(location: { search: string; hash: string }): PendingInvitation | null {
    try {
        const query = new URLSearchParams(location.search);
        const fragment = new URLSearchParams(
            location.hash.startsWith('#') ? location.hash.slice(1) : location.hash,
        );
        const ids = query.getAll('invite');
        const tokens = fragment.getAll('token');
        if (ids.length !== 1 || tokens.length !== 1) return null;
        const invitation = { id: ids[0], token: tokens[0] };
        if (!validIdentity(invitation)) return null;
        return { ...invitation, cachedAt: Date.now() };
    } catch {
        return null;
    }
}

export function rememberInvitation(invitation: PendingInvitation): boolean {
    if (!validPending(invitation)) return false;
    try {
        window.localStorage.removeItem(LEGACY_PENDING_INVITATION_KEY);
        window.localStorage.setItem(PENDING_INVITATION_KEY, JSON.stringify(invitation));
        return true;
    } catch {
        return false;
    }
}

export function getPendingInvite(): PendingInvitation | null {
    try {
        window.localStorage.removeItem(LEGACY_PENDING_INVITATION_KEY);
        const serialized = window.localStorage.getItem(PENDING_INVITATION_KEY);
        if (serialized === null) return null;
        let value: unknown;
        try {
            value = JSON.parse(serialized);
        } catch {
            value = null;
        }
        if (validPending(value)) return value;
        window.localStorage.removeItem(PENDING_INVITATION_KEY);
        return null;
    } catch {
        return null;
    }
}

export function clearPendingInvite(expected?: PendingInvitation): void {
    try {
        window.localStorage.removeItem(LEGACY_PENDING_INVITATION_KEY);
        if (expected) {
            const serialized = window.localStorage.getItem(PENDING_INVITATION_KEY);
            if (serialized === null) return;
            let current: unknown;
            try {
                current = JSON.parse(serialized);
            } catch {
                return;
            }
            if (
                !current ||
                typeof current !== 'object' ||
                !('id' in current) ||
                !('token' in current) ||
                !('cachedAt' in current)
            )
                return;
            if (
                current.id !== expected.id ||
                current.token !== expected.token ||
                current.cachedAt !== expected.cachedAt
            )
                return;
        }
        window.localStorage.removeItem(PENDING_INVITATION_KEY);
    } catch {}
}

export function shouldClearInviteOnError(status: number, code?: unknown): boolean {
    if (code === 'group_merging_paused') return false;
    return [400, 403, 404, 409, 410].includes(status);
}
