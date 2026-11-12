import type { Account } from '../../shared/types';
import {
    GAME_EVENT_PASSWORD_MAX_LENGTH,
    GAME_EVENT_PASSWORD_MIN_LENGTH,
    type GameDashboard,
    type GameEventSetup,
} from '../../shared/event/game';
import { passwordHash, passwordMatches } from '../accounts/passwords';
import { privateJson as json } from '../http/responses';
import type { CaughtNotificationEnv } from '../notifications/caughtNotifications';
import { caughtNotificationStatements } from '../notifications/caughtNotifications';
import { gameResultStatements } from './resultAnnouncement';

export interface GameEnv extends CaughtNotificationEnv {
    ADMIN_GOOGLE_EMAIL?: string;
    DEMO_MODE?: string;
}
export const DEAD_MESSAGE = 'you are currently dead!';
export const GAME_WRITE_BLOCK_SQL = `NOT EXISTS(SELECT 1 FROM game_player_states gs WHERE gs.account_id=? AND gs.dead=1)`;
const MAIN_ADMIN_SQL = `SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
  JOIN federated_identities f ON f.account_id=a.id AND f.provider='google'
  WHERE a.id=? AND a.role='admin' AND aa.status='approved' AND f.identifier=? COLLATE NOCASE`;
const DEFAULT_START = '2026-11-13T05:30:00.000Z';
const DEFAULT_END = '2026-11-13T06:00:00.000Z';
const EVENT_PASSWORD_ATTEMPTS = 10;
const EVENT_PASSWORD_WINDOW_MS = 10 * 60_000;
const MAPS_PIN_PARAMS = new Set(['api', 'cid', 'ftid', 'q', 'query', 'query_place_id']);
const isoNow = () => new Date().toISOString();
const validCoord = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;

type ConfigRow = {
    starts_at: string;
    ends_at: string;
    target_latitude: number | null;
    target_longitude: number | null;
    picture_url: string | null;
    winner_account_id: string | null;
    winner_reward: 'revive' | 'immunity' | null;
    winner_immunity_until: string | null;
};
type DashboardConfigRow = Omit<ConfigRow, 'target_latitude' | 'target_longitude'> & {
    configured: number;
    password_set: number;
};
type EventPasswordRow = { password_salt: string | null; password_hash: string | null };
type PlayerRow = { status: 'survivor' | 'hunter'; dead: number; immunity_until: string | null };
async function playerState(db: D1Database, accountId: string, updatedAt = isoNow()): Promise<PlayerRow> {
    await db
        .prepare(
            `INSERT OR IGNORE INTO game_player_states(account_id,status,dead,updated_at)
    SELECT a.id,'survivor',0,? FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
    WHERE a.id=? AND a.role='player' AND aa.status='approved'`,
        )
        .bind(updatedAt, accountId)
        .run();
    return (
        (await db
            .prepare('SELECT status,dead,immunity_until FROM game_player_states WHERE account_id=?')
            .bind(accountId)
            .first<PlayerRow>()) ?? { status: 'survivor', dead: 0, immunity_until: null }
    );
}
export async function isPlayerDead(env: GameEnv, accountId: string): Promise<boolean> {
    return (await playerState(env.DB, accountId)).dead === 1;
}
async function isMainAdmin(env: GameEnv, account: Account): Promise<boolean> {
    const email = env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase();
    if (account.role !== 'admin' || !email) return false;
    return !!(await env.DB.prepare(MAIN_ADMIN_SQL).bind(account.id, email).first());
}
export async function loadGameDash(env: GameEnv, actor: Account): Promise<GameDashboard> {
    const canManage = await isMainAdmin(env, actor);
    const [pl, eventcfg, grpGuess] = await Promise.all([
        playerState(env.DB, actor.id),
        env.DB.prepare(
            `SELECT starts_at,ends_at,picture_url,winner_account_id,winner_reward,winner_immunity_until,
              target_latitude IS NOT NULL AND target_longitude IS NOT NULL AS configured,
              password_salt IS NOT NULL AND password_hash IS NOT NULL AS password_set
             FROM game_event_config WHERE id=1`,
        ).first<DashboardConfigRow>(),
        actor.groupId
            ? env.DB.prepare('SELECT COUNT(*) AS n FROM game_guesses WHERE group_id=?')
                  .bind(actor.groupId)
                  .first<{ n: number }>()
            : Promise.resolve(null),
    ]);
    const startsAt = eventcfg?.starts_at ?? DEFAULT_START;
    const endsAt = eventcfg?.ends_at ?? DEFAULT_END;
    const configured = !!eventcfg?.configured;
    const serverNow = isoNow();
    const submissions = Number(grpGuess?.n ?? 0);
    const winner = eventcfg?.winner_account_id === actor.id;
    const result: GameDashboard = {
        serverNow,
        hasTeam: !!actor.groupId,
        player: { status: pl.status, dead: pl.dead === 1, immunityUntil: pl.immunity_until },
        event: {
            configured,
            claimed: !!eventcfg?.winner_account_id,
            startsAt,
            endsAt,
            pictureUrl: serverNow >= startsAt ? (eventcfg?.picture_url ?? null) : null,
            submissions,
            attemptsRemaining: Math.max(0, 2 - submissions),
            canGuess:
                !!actor.groupId &&
                configured &&
                serverNow >= startsAt &&
                serverNow < endsAt &&
                !eventcfg?.winner_account_id &&
                submissions < 2,
            winner,
            reward: winner ? (eventcfg?.winner_reward ?? null) : null,
            immunityUntil: winner ? (eventcfg?.winner_immunity_until ?? null) : null,
        },
    };
    if (actor.role === 'admin') {
        result.canManage = canManage;
        if (canManage) result.eventPasswordSet = !!eventcfg?.password_set;
        result.canManagePlayers = true;
        const players = await env.DB.prepare(
            `SELECT a.id,a.display_name,a.username,g.name AS group_name,COALESCE(s.status,'survivor') AS status,
      COALESCE(s.dead,0) AS dead,s.immunity_until FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
      JOIN groups g ON g.id=a.group_id LEFT JOIN game_player_states s ON s.account_id=a.id
      WHERE a.role='player' AND aa.status='approved' ORDER BY g.name COLLATE NOCASE,a.display_name COLLATE NOCASE`,
        ).all<any>();
        result.players = (players.results ?? []).map((row) => ({
            id: row.id,
            displayName: row.display_name,
            username: row.username,
            groupName: row.group_name,
            status: row.status,
            dead: row.dead === 1,
            immunityUntil: row.immunity_until,
        }));
    }
    return result;
}

export function parseMapsCoords(rawUrl: string): { latitude: number; longitude: number } | null {
    let url: URL;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        return null;
    }
    if (
        url.protocol !== 'https:' ||
        !isGoogleHost(url.hostname) ||
        (['google.com', 'www.google.com'].includes(url.hostname.toLowerCase()) &&
            !url.pathname.startsWith('/maps'))
    )
        return null;
    const query = url.searchParams.get('query') ?? url.searchParams.get('q');
    if (query) {
        const point = parseCoordinatePair(query);
        if (point) return point;
    }
    const pinData = url.pathname.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (pinData) return validPoint(Number(pinData[1]), Number(pinData[2]));
    const pinPath = url.pathname.match(/^\/maps\/(?:search|place)\/([^/]+)(?:\/|$)/);
    if (pinPath) {
        try {
            const point = parseCoordinatePair(decodeURIComponent(pinPath[1]).replaceAll('+', ' '));
            if (point) return point;
        } catch {}
    }
    return null;
}
function parseCoordinatePair(value: string) {
    const match = value.match(/^\s*([+-]?\d{1,3}(?:\.\d+)?)\s*,\s*([+-]?\d{1,3}(?:\.\d+)?)\s*$/);
    return match ? validPoint(Number(match[1]), Number(match[2])) : null;
}
function validPoint(latitude: number, longitude: number) {
    return Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180
        ? { latitude, longitude }
        : null;
}
function isGoogleHost(host: string) {
    const hostname = host.toLowerCase();
    return (
        hostname === 'maps.google.com' ||
        hostname === 'www.google.com' ||
        hostname === 'google.com' ||
        hostname === 'maps.app.goo.gl' ||
        hostname === 'goo.gl'
    );
}
async function resolveMapsUrl(raw: string): Promise<{ latitude: number; longitude: number } | null> {
    const direct = parseMapsCoords(raw);
    if (direct) return direct;
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || !['maps.app.goo.gl', 'goo.gl'].includes(url.hostname.toLowerCase()))
        return null;
    for (const name of [...url.searchParams.keys()]) {
        if (!MAPS_PIN_PARAMS.has(name)) url.searchParams.delete(name);
    }
    const signal = AbortSignal.timeout(12_000);
    for (let redirect = 0; redirect < 5; redirect++) {
        try {
            const response = await fetch(url, { method: 'GET', redirect: 'manual', signal });
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) return null;
            url = new URL(location, url);
            if (url.protocol !== 'https:' || !isGoogleHost(url.hostname)) return null;
            const point = parseMapsCoords(url.href);
            if (point) return point;
        } catch {
            return null;
        }
    }
    return null;
}
function distanceMeters(
    fromLatitude: number,
    fromLongitude: number,
    toLatitude: number,
    toLongitude: number,
) {
    const radperdeg = Math.PI / 180;
    const dLat = (toLatitude - fromLatitude) * radperdeg;
    const dLng = (toLongitude - fromLongitude) * radperdeg;
    const haversine =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(fromLatitude * radperdeg) * Math.cos(toLatitude * radperdeg) * Math.sin(dLng / 2) ** 2;
    const earthRadM = 6_371_000;
    return earthRadM * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}
function parsePictureUrl(value: unknown): string | null | undefined {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href : undefined;
    } catch {
        return undefined;
    }
}

function validEventPassword(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length >= GAME_EVENT_PASSWORD_MIN_LENGTH &&
        value.length <= GAME_EVENT_PASSWORD_MAX_LENGTH &&
        value.trim().length > 0
    );
}

async function setEventPassword(db: D1Database, actorId: string, adminEmail: string, password: unknown) {
    if (!validEventPassword(password)) {
        return json(
            { error: `Use a password of ${GAME_EVENT_PASSWORD_MIN_LENGTH}–${GAME_EVENT_PASSWORD_MAX_LENGTH} characters.` },
            400,
        );
    }
    const { salt, hash } = await passwordHash(password);
    const update = await db.prepare(
        `INSERT INTO game_event_config(id,starts_at,ends_at,updated_at,password_salt,password_hash)
         SELECT 1,?,?,?,?,? WHERE EXISTS(${MAIN_ADMIN_SQL})
         ON CONFLICT(id) DO UPDATE SET password_salt=excluded.password_salt,password_hash=excluded.password_hash
         WHERE game_event_config.password_hash IS NULL`,
    )
        .bind(DEFAULT_START, DEFAULT_END, isoNow(), salt, hash, actorId, adminEmail)
        .run();
    if (!update.meta.changes) {
        return json({ error: 'The event password could not be set. Refresh and try again.' }, 409);
    }
    return json({ passwordSet: true });
}

async function verifyEventPassword(
    db: D1Database,
    actorId: string,
    credentials: EventPasswordRow | null,
    password: unknown,
): Promise<string | Response> {
    if (!credentials?.password_hash || !credentials.password_salt) {
        return json({ error: 'Set the revive event password first.' }, 409);
    }
    if (!validEventPassword(password)) return json({ error: 'Enter the correct revive event password.' }, 403);

    const key = `revive-event-password:${actorId}`;
    const now = Date.now();
    const current = new Date(now).toISOString();
    const expiry = new Date(now + EVENT_PASSWORD_WINDOW_MS).toISOString();
    const attempt = await db.prepare(
        `INSERT INTO auth_rate_buckets(bucket_key,count,expires_at) VALUES(?,1,?)
         ON CONFLICT(bucket_key) DO UPDATE SET
           count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
           expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
         WHERE expires_at<=? OR count<?
         RETURNING count`,
    )
        .bind(key, expiry, current, current, current, EVENT_PASSWORD_ATTEMPTS)
        .first();
    if (!attempt) return json({ error: 'Too many password attempts. Try again in a few minutes.' }, 429);
    if (!(await passwordMatches(password, credentials.password_salt, credentials.password_hash))) {
        return json({ error: 'Enter the correct revive event password.' }, 403);
    }

    await db.prepare('DELETE FROM auth_rate_buckets WHERE bucket_key=?').bind(key).run();
    return credentials.password_hash;
}

export async function gameRoute(
    request: Request,
    env: GameEnv,
    actor: Account,
    onWin?: () => Promise<void>,
): Promise<Response | null> {
    const { pathname } = new URL(request.url),
        method = request.method.toUpperCase();
    const eventSetup = pathname === '/api/admin/game-event';
    const eventPassword = pathname === '/api/admin/game-event/password';
    const eventUnlock = pathname === '/api/admin/game-event/unlock';
    if (eventSetup || eventPassword || eventUnlock) {
        const allowedMethods = eventSetup ? ['GET', 'PATCH'] : eventPassword ? ['PUT'] : ['POST'];
        if (!allowedMethods.includes(method)) return json({ error: 'Method not allowed.' }, 405);

        const adminEmail = env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase();
        if (!adminEmail || !(await isMainAdmin(env, actor))) {
            return json({ error: 'Only the main administrator can manage the game event.' }, 403);
        }
        if (method === 'GET') return json({ game: await loadGameDash(env, actor) });

        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const credentials = await env.DB.prepare(
            'SELECT password_salt,password_hash FROM game_event_config WHERE id=1',
        ).first<EventPasswordRow>();
        if (eventPassword) {
            if (credentials?.password_hash) {
                return json({ error: 'The revive event password has already been set.' }, 409);
            }
            return setEventPassword(env.DB, actor.id, adminEmail, body?.password);
        }

        const verifiedHash = await verifyEventPassword(env.DB, actor.id, credentials, body?.password);
        if (verifiedHash instanceof Response) return verifiedHash;
        if (eventUnlock) {
            const setup = await env.DB.prepare(
                `SELECT target_latitude,target_longitude,picture_url FROM game_event_config
                 WHERE id=1 AND password_hash=? AND EXISTS(${MAIN_ADMIN_SQL})`,
            )
                .bind(verifiedHash, actor.id, adminEmail)
                .first<Pick<ConfigRow, 'target_latitude' | 'target_longitude' | 'picture_url'>>();
            if (!setup) return json({ error: 'Event access changed. Refresh and try again.' }, 403);
            const result: GameEventSetup = {
                target:
                    setup.target_latitude === null || setup.target_longitude === null
                        ? null
                        : { latitude: setup.target_latitude, longitude: setup.target_longitude },
                pictureUrl: setup.picture_url,
            };
            return json(result);
        }

        let latitude = validCoord(body?.latitude, -90, 90);
        let longitude = validCoord(body?.longitude, -180, 180);
        if ((latitude === null || longitude === null) && typeof body?.mapsUrl === 'string') {
            const point = await resolveMapsUrl(body.mapsUrl);
            if (point) {
                latitude = point.latitude;
                longitude = point.longitude;
            }
        }
        if (latitude === null || longitude === null)
            return json({ error: 'Use a Google Maps link to a dropped pin with readable coordinates.' }, 400);
        const picture = parsePictureUrl(body?.pictureUrl);
        if (picture === undefined) return json({ error: 'Picture URL must be an HTTPS link.' }, 400);
        const update = await env.DB.prepare(
            `UPDATE game_event_config SET starts_at=?,ends_at=?,target_latitude=?,target_longitude=?,
                picture_url=?,configured_by=?,updated_at=?
             WHERE id=1 AND password_hash=? AND winner_account_id IS NULL AND NOT EXISTS(SELECT 1 FROM game_guesses)
               AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<starts_at
               AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<? AND EXISTS(${MAIN_ADMIN_SQL})`,
        )
            .bind(
                DEFAULT_START,
                DEFAULT_END,
                latitude,
                longitude,
                picture,
                actor.id,
                isoNow(),
                verifiedHash,
                DEFAULT_START,
                actor.id,
                adminEmail,
            )
            .run();
        if (!update.meta.changes)
            return json(
                {
                    error: 'Event setup is locked once guesses open. Refresh to see the current setup.',
                },
                409,
            );
        return json({ game: await loadGameDash(env, actor) });
    }
    const stateMatch = pathname.match(/^\/api\/admin\/game-players\/([^/]+)$/);
    if (stateMatch) {
        if (method !== 'PATCH') return json({ error: 'Method not allowed.' }, 405);
        const accountId = decodeURIComponent(stateMatch[1]);
        const body = (await request.json().catch(() => null)) as { caught?: unknown } | null;
        if (!body || typeof body.caught !== 'boolean')
            return json({ error: 'Choose whether this player was caught.' }, 400);
        const changedAt = isoNow();
        if (
            actor.role !== 'admin' ||
            !(await env.DB.prepare(
                `SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=? AND a.role='admin' AND aa.status='approved'`,
            )
                .bind(actor.id)
                .first())
        )
            return json({ error: 'Approved administrator access required.' }, 403);
        const target = await env.DB.prepare(
            `SELECT a.id FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
      WHERE a.id=? AND a.role='player' AND a.group_id IS NOT NULL AND aa.status='approved'`,
        )
            .bind(accountId)
            .first<{ id: string }>();
        if (!target) return json({ error: 'Approved player not found.' }, 404);
        if (body.caught) {
            const state = await playerState(env.DB, accountId, changedAt);
            if (state.dead) return json({ error: 'This player is already dead.' }, 409);
            if (state.immunity_until && state.immunity_until > changedAt)
                return json({ error: 'This player has active immunity.' }, 409);
            const eventId = crypto.randomUUID();
            const write = env.DB.prepare(
                `UPDATE game_player_states SET status='hunter',dead=1,immunity_until=NULL,caught_at=?,catch_event_id=?,updated_at=?
        WHERE account_id=? AND dead=0 AND (immunity_until IS NULL OR immunity_until<=?)
          AND EXISTS(SELECT 1 FROM accounts admin JOIN account_approvals aa ON aa.account_id=admin.id WHERE admin.id=? AND admin.role='admin' AND aa.status='approved')
          AND EXISTS(SELECT 1 FROM accounts target JOIN account_approvals aa ON aa.account_id=target.id WHERE target.id=? AND target.role='player' AND target.group_id IS NOT NULL AND aa.status='approved')`,
            ).bind(changedAt, eventId, changedAt, accountId, changedAt, actor.id, accountId);
            const config = await env.DB.prepare(
                'SELECT starts_at,ends_at,winner_account_id FROM game_event_config WHERE id=1',
            ).first<ConfigRow>();
            const beforeStart = changedAt < (config?.starts_at ?? DEFAULT_START);
            const ended = changedAt >= (config?.ends_at ?? DEFAULT_END) || !!config?.winner_account_id;
            const message = beforeStart
                ? 'You have been caught! Aw man… you can still revive at 1:30 though!'
                : ended
                  ? 'You have been caught! Aw man… the revive event has ended.'
                  : 'You have been caught! Aw man… you can still revive through Geoguessr before 2:00 p.m.!';
            const notifications = caughtNotificationStatements(env, {
                eventId,
                accountId,
                message,
                createdAt: changedAt,
            });
            const results = await env.DB.batch([write, ...notifications]);
            if (!results[0]?.meta.changes)
                return json({ error: 'This player can no longer be caught.' }, 409);
        } else {
            const restored = await env.DB.prepare(
                `UPDATE game_player_states SET status='survivor',dead=0,immunity_until=NULL,caught_at=NULL,catch_event_id=NULL,updated_at=?
        WHERE account_id=? AND dead=1
          AND EXISTS(SELECT 1 FROM accounts admin JOIN account_approvals aa ON aa.account_id=admin.id WHERE admin.id=? AND admin.role='admin' AND aa.status='approved')
          AND EXISTS(SELECT 1 FROM accounts target JOIN account_approvals aa ON aa.account_id=target.id WHERE target.id=? AND target.role='player' AND target.group_id IS NOT NULL AND aa.status='approved')`,
            )
                .bind(changedAt, accountId, actor.id, accountId)
                .run();
            if (!restored.meta.changes)
                return json(
                    { error: 'This player is already alive or access changed. Refresh and try again.' },
                    409,
                );
        }
        return json({ player: await playerState(env.DB, accountId) });
    }
    if (pathname === '/api/game-guess') {
        if (method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        const approved = await env.DB.prepare(
            `SELECT a.group_id FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=? AND a.role='player' AND a.group_id IS NOT NULL AND aa.status='approved'`,
        )
            .bind(actor.id)
            .first<{ group_id: string }>();
        if (!approved) return json({ error: 'Approved players with a team can submit a guess.' }, 403);
        const body = (await request.json().catch(() => null)) as {
            mapsUrl?: unknown;
            reward?: unknown;
        } | null;
        if (
            !body ||
            typeof body.mapsUrl !== 'string' ||
            body.mapsUrl.length > 2048 ||
            !['revive', 'immunity'].includes(String(body.reward))
        )
            return json({ error: 'Submit a Google Maps link and choose a reward.' }, 400);
        const point = await resolveMapsUrl(body.mapsUrl);
        if (!point)
            return json({ error: 'Could not read coordinates from that Google Maps dropped-pin link.' }, 400);
        const submittedAt = isoNow();
        const config = await env.DB.prepare(
            'SELECT starts_at,ends_at,target_latitude,target_longitude,winner_account_id FROM game_event_config WHERE id=1',
        ).first<Pick<ConfigRow, 'starts_at' | 'ends_at' | 'target_latitude' | 'target_longitude' | 'winner_account_id'>>();
        if (
            config?.target_latitude === null ||
            config?.target_latitude === undefined ||
            config.target_longitude === null
        )
            return json({ error: 'The organiser has not configured the revive event yet.' }, 409);
        if (submittedAt < config.starts_at || submittedAt >= config.ends_at)
            return json({ error: 'The revive event is not open or has ended.' }, 409);
        if (config.winner_account_id) return json({ error: 'The location has already been claimed.' }, 409);
        const grpGuess = await env.DB.prepare('SELECT COUNT(*) AS n FROM game_guesses WHERE group_id=?')
            .bind(approved.group_id)
            .first<{ n: number }>();
        const guessCnt = Number(grpGuess?.n ?? 0);
        if (guessCnt >= 2) return json({ error: 'Your team has used both guesses.' }, 409);
        const pl = await playerState(env.DB, actor.id, submittedAt);
        if (body.reward === 'revive' && !pl.dead)
            return json({ error: 'Only a dead player can choose revive.' }, 400);
        const distance = distanceMeters(
            point.latitude,
            point.longitude,
            config.target_latitude,
            config.target_longitude,
        );
        const correct = distance <= 200;
        const guessId = crypto.randomUUID();
        const submittedMs = Date.parse(submittedAt);
        const minsElapsed = Math.max(0, (submittedMs - Date.parse(config.starts_at)) / 60_000);
        const reward = body.reward as 'revive' | 'immunity';
        const immunityUntil =
            reward === 'revive'
                ? new Date(submittedMs + 5 * 60_000).toISOString()
                : new Date(submittedMs + (90 - 3 * minsElapsed) * 60_000).toISOString();
        const insertGuess = env.DB.prepare(
            `INSERT INTO game_guesses(id,account_id,group_id,maps_url,latitude,longitude,distance_m,submitted_at,correct,reward)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM game_guesses WHERE group_id=?)<2
        AND EXISTS(SELECT 1 FROM game_event_config WHERE id=1 AND target_latitude IS NOT NULL
          AND ((?=1 AND winner_guess_id=?) OR (?=0 AND winner_account_id IS NULL AND starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))))
        AND EXISTS(SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=? AND a.role='player' AND a.group_id=? AND aa.status='approved')`,
        ).bind(
            guessId,
            actor.id,
            approved.group_id,
            body.mapsUrl,
            point.latitude,
            point.longitude,
            correct ? distance : null,
            submittedAt,
            correct ? 1 : 0,
            correct ? reward : null,
            approved.group_id,
            correct ? 1 : 0,
            guessId,
            correct ? 1 : 0,
            actor.id,
            approved.group_id,
        );
        if (!correct) {
            const result = await insertGuess.run();
            if (!result.meta.changes)
                return json({ error: 'The team has used its guesses or the event has ended.' }, 409);
            return json({ correct: false, attemptsRemaining: Math.max(0, 1 - guessCnt) });
        }
        const claimEvent = env.DB.prepare(
            `UPDATE game_event_config SET winner_account_id=?,winner_group_id=?,winner_guess_id=?,winner_reward=?,winner_immunity_until=?
      WHERE id=1 AND winner_account_id IS NULL AND starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND target_latitude IS NOT NULL
      AND (SELECT COUNT(*) FROM game_guesses WHERE group_id=?)<2
      AND EXISTS(SELECT 1 FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id WHERE a.id=? AND a.role='player' AND a.group_id=? AND aa.status='approved')
      AND EXISTS(SELECT 1 FROM game_player_states s WHERE s.account_id=? AND (?='immunity' OR s.dead=1))`,
        ).bind(
            actor.id,
            approved.group_id,
            guessId,
            reward,
            immunityUntil,
            approved.group_id,
            actor.id,
            approved.group_id,
            actor.id,
            reward,
        );
        const updatePlayer =
            reward === 'revive'
                ? env.DB.prepare(
                      `UPDATE game_player_states SET status='survivor',dead=0,immunity_until=?,caught_at=NULL,updated_at=? WHERE account_id=? AND dead=1 AND EXISTS(SELECT 1 FROM game_event_config WHERE id=1 AND winner_account_id=?) AND EXISTS(SELECT 1 FROM game_guesses WHERE id=? AND correct=1)`,
                  ).bind(immunityUntil, submittedAt, actor.id, actor.id, guessId)
                : env.DB.prepare(
                      `UPDATE game_player_states SET immunity_until=?,updated_at=? WHERE account_id=? AND EXISTS(SELECT 1 FROM game_event_config WHERE id=1 AND winner_account_id=?) AND EXISTS(SELECT 1 FROM game_guesses WHERE id=? AND correct=1)`,
                  ).bind(immunityUntil, submittedAt, actor.id, actor.id, guessId);
        const markAsWinner = env.DB.prepare(
            'UPDATE game_guesses SET distance_m=?,correct=1,reward=? WHERE id=? AND EXISTS(SELECT 1 FROM game_event_config WHERE winner_account_id=?)',
        ).bind(distance, reward, guessId, actor.id);
        const results = await env.DB.batch([
            claimEvent,
            insertGuess,
            updatePlayer,
            markAsWinner,
            ...gameResultStatements(env, guessId),
        ]);
        if (!results[0]?.meta.changes)
            return json({ error: 'Another team already claimed the location.' }, 409);
        await onWin?.();
        return json({
            correct: true,
            distanceMeters: Math.round(distance),
            reward,
            immunityUntil,
            revived: reward === 'revive',
        });
    }
    return null;
}
