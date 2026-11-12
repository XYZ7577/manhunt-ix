import { GAME_RESULT_ANNOUNCEMENT_ID } from '../../shared/notifications/announcements';
import { announcementRecipientStatements, type AnnouncementEnv } from '../announcements/announcements';

const TITLE = 'The Geoguessr Revival event was over.';
const SOLVED_PREFIX = 'It was solved by ';
const NO_WINNER = 'No one was able to solve it!';

type ResultEnv = Pick<AnnouncementEnv, 'DB' | 'DEMO_MODE'>;

export function gameResultStatements(env: ResultEnv, guessId?: string): D1PreparedStatement[] {
    const token = crypto.randomUUID();
    const publishedAt = new Date().toISOString();
    const resultFilter =
        guessId !== undefined
            ? 'winner.id=?'
            : `(winner.id IS NOT NULL OR (
        cfg.winner_account_id IS NULL AND cfg.ends_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ))`;
    const announcement = env.DB.prepare(
        `INSERT INTO announcements (
        id, title, message, created_by, created_at, scheduled_for, published_at,
        status, send_email, publication_token
    )
    SELECT ?, ?,
        CASE WHEN winner.id IS NULL THEN ?
            ELSE ? || trim(replace(replace(team.name, char(13), ' '), char(10), ' ')) || '!'
        END,
        organiser.id, ?, COALESCE(winner.submitted_at, cfg.ends_at), ?, 'published', 1, ?
    FROM game_event_config cfg
    LEFT JOIN game_guesses winner ON winner.id=cfg.winner_guess_id AND winner.correct=1
        AND winner.account_id=cfg.winner_account_id AND winner.group_id=cfg.winner_group_id
    LEFT JOIN groups team ON team.id=cfg.winner_group_id
    JOIN accounts organiser ON organiser.id=COALESCE(cfg.configured_by,(
        SELECT a.id FROM accounts a JOIN account_approvals aa ON aa.account_id=a.id
        WHERE a.role='admin' AND aa.status='approved' AND (?=1 OR a.id NOT LIKE 'demo-account-%')
        ORDER BY a.created_at,a.id LIMIT 1
    ))
    WHERE cfg.id=1 AND (winner.id IS NULL OR team.id IS NOT NULL) AND ${resultFilter}
    ON CONFLICT(id) DO NOTHING`,
    ).bind(
        GAME_RESULT_ANNOUNCEMENT_ID,
        TITLE,
        NO_WINNER,
        SOLVED_PREFIX,
        publishedAt,
        publishedAt,
        token,
        env.DEMO_MODE === 'true' ? 1 : 0,
        ...(guessId === undefined ? [] : [guessId]),
    );
    return [announcement, ...announcementRecipientStatements(env, GAME_RESULT_ANNOUNCEMENT_ID, token)];
}

export async function publishDueGameResult(env: ResultEnv): Promise<void> {
    await env.DB.batch(gameResultStatements(env));
}
