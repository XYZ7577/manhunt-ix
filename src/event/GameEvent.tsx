import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { GameDashboard } from '../../shared/event/game';
import { ActionButton } from '../ui/ActionButton';
import { GameEventSetup } from './GameEventSetup';
import './gameEvent.css';

interface Props {
    game: GameDashboard;
    admin: boolean;
    onChanged?: () => void | Promise<void>;
}
type Reward = 'revive' | 'immunity';

function timeLabel(value: string | null | undefined) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return (
        new Intl.DateTimeFormat('en-SG', {
            timeZone: 'Asia/Singapore',
            hour: 'numeric',
            minute: '2-digit',
        }).format(date) + ' SGT'
    );
}
function activeImmunity(until: string | null, now: number) {
    return !!until && new Date(until).getTime() > now;
}

async function request(path: string, body: unknown) {
    const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
}

export function GamePanel({ game, admin, onChanged }: Props) {
    const [now, setNow] = useState(Date.now());
    const clockOffset = useMemo(
        () => (game.serverNow ? new Date(game.serverNow).getTime() - Date.now() : 0),
        [game.serverNow],
    );
    const [guessUrl, setGuessUrl] = useState('');
    const [reward, setReward] = useState<Reward>('immunity');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [selected, setSelected] = useState<string[]>([]);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, []);
    useEffect(() => {
        if (!game.player.dead && reward === 'revive') setReward('immunity');
    }, [game.player.dead, reward]);

    const start = new Date(game.event.startsAt).getTime();
    const end = new Date(game.event.endsAt).getTime();
    const eventTime = now + clockOffset;
    const eventOpen =
        game.event.configured &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        eventTime >= start &&
        eventTime < end;
    const ownImmunityUntil =
        game.event.reward === 'immunity' ? game.event.immunityUntil : game.player.immunityUntil;
    const hasImmunity = activeImmunity(ownImmunityUntil, eventTime);
    const filteredPlayers = useMemo(
        () =>
            (game.players || []).filter((player) =>
                `${player.displayName} ${player.username} ${player.groupName}`
                    .toLocaleLowerCase()
                    .includes(search.trim().toLocaleLowerCase()),
            ),
        [game.players, search],
    );
    const catchSel = (game.players || []).filter(
        (player) =>
            selected.includes(player.id) && !player.dead && !activeImmunity(player.immunityUntil, eventTime),
    );
    const restoreSel = (game.players || []).filter((player) => selected.includes(player.id) && player.dead);
    let guessNotice = 'The event is not accepting guesses right now.';
    if (eventTime >= end) {
        guessNotice = `This event closed at ${timeLabel(game.event.endsAt)}.`;
    } else if (!game.hasTeam) {
        guessNotice = 'Join an approved team to take part.';
    } else if (!game.event.configured) {
        guessNotice = 'The organiser is setting up the event. Guesses open at 1:30 p.m. SGT.';
    } else if (eventTime < start) {
        guessNotice = `Guesses open at ${timeLabel(game.event.startsAt)}.`;
    }

    async function run(action: () => Promise<string | void>, success: string) {
        setBusy(true);
        setError('');
        setMessage('');
        try {
            setMessage((await action()) || success);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save this change.');
        } finally {
            try {
                await onChanged?.();
            } catch {}
            setBusy(false);
        }
    }

    async function submitGuess(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        await run(async () => {
            const result = (await request('/api/game-guess', { mapsUrl: guessUrl.trim(), reward })) as {
                correct: boolean;
                reward?: Reward;
                immunityUntil?: string;
                revived?: boolean;
                attemptsRemaining?: number;
            };
            setGuessUrl('');
            return result.correct
                ? result.revived
                    ? 'Correct! You are revived as a survivor and have 5 minutes of immunity.'
                    : `Correct! Your immunity lasts until ${timeLabel(result.immunityUntil)}.`
                : `That guess was outside 200 m.${typeof result.attemptsRemaining === 'number' ? ` ${result.attemptsRemaining} team ${result.attemptsRemaining === 1 ? 'guess' : 'guesses'} remaining.` : ''}`;
        }, 'Guess submitted.');
    }
    async function updatePlayers(players: typeof game.players, caught: boolean) {
        if (!players?.length) return;
        await run(
            async () => {
                const results = await Promise.allSettled(
                    players.map(async (player) => {
                        const response = await fetch(
                            `/api/admin/game-players/${encodeURIComponent(player.id)}`,
                            {
                                method: 'PATCH',
                                credentials: 'same-origin',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ caught }),
                            },
                        );
                        const body = (await response.json().catch(() => ({}))) as { error?: string };
                        if (!response.ok)
                            throw new Error(body.error || `Could not update ${player.displayName}.`);
                    }),
                );
                const failures = results.filter((result) => result.status === 'rejected');
                if (failures.length)
                    throw new Error(
                        `${players.length - failures.length} updated; ${failures.length} could not be updated. ${String((failures[0] as PromiseRejectedResult).reason?.message || '')}`,
                    );
                setSelected([]);
            },
            caught ? 'Selected players marked dead.' : 'Selected players restored.',
        );
    }

    return (
        <section className="event-panel game-event-panel" aria-labelledby="game-event-title">
            <div className="event-panel-heading game-event-heading">
                <div>
                    <p className="event-eyebrow">GAME STATUS</p>
                    <h2 id="game-event-title">Revive Event — Geoguessr!</h2>
                    <p>
                        Friday, 13 November · {timeLabel(game.event.startsAt)}–{timeLabel(game.event.endsAt)}
                    </p>
                </div>
                {!admin && (
                    <span
                        className={`game-status-pill${game.player.dead ? ' is-dead' : game.player.status === 'hunter' ? ' is-hunter' : ''}`}
                    >
                        {game.player.dead ? 'Dead' : game.player.status === 'hunter' ? 'Hunter' : 'Survivor'}
                    </span>
                )}
            </div>

            {!admin && (
                <div className="game-player-status" role="status">
                    <strong>
                        {game.player.dead
                            ? 'You are currently dead.'
                            : game.player.status === 'hunter'
                              ? 'You are currently a hunter.'
                              : 'You are currently a survivor.'}
                    </strong>
                    {hasImmunity && <span>Immune until {timeLabel(ownImmunityUntil)}.</span>}
                </div>
            )}

            <div className="game-rules">
                <p>
                    At 1:30 p.m., Gareth posts a photo from somewhere in Announcements. Submit a dropped pin
                    as a Google Maps link. The first player globally to guess within 200 m wins. Each team
                    gets up to two guesses, including guesses from living players.
                </p>
                <ul>
                    <li>
                        <strong>Immunity:</strong> 90 − 3 × minutes elapsed after 1:30 p.m. For example, a
                        correct guess at 1:45 p.m. earns 45 minutes, until 2:30 p.m.
                    </li>
                    <li>
                        <strong>Revive:</strong> a dead player becomes a survivor immediately and receives 5
                        minutes of immunity to get away.
                    </li>
                </ul>
                <p className="game-deadline">
                    Guesses close at 2:00 p.m. SGT. The reward cannot be claimed after the event closes.
                </p>
            </div>

            {game.event.pictureUrl && eventOpen && (
                <figure className="game-picture">
                    <img src={game.event.pictureUrl} alt="Gareth’s Geoguessr location photo" />
                    <figcaption>Guess the location shown in Gareth’s announcement.</figcaption>
                </figure>
            )}

            {!admin && (
                <div className="game-attempts" aria-live="polite">
                    <strong>{game.event.submissions} of 2 guesses used</strong>
                    <span>
                        {game.event.attemptsRemaining}{' '}
                        {game.event.attemptsRemaining === 1 ? 'guess' : 'guesses'} remaining for your team
                    </span>
                </div>
            )}
            {game.event.claimed && (
                <div className="game-result" role="status">
                    <strong>
                        {game.event.winner
                            ? 'Your guess won the event!'
                            : 'A correct guess has already claimed the event.'}
                    </strong>
                    {game.event.winner && game.event.reward && (
                        <span>
                            Your reward:{' '}
                            {game.event.reward === 'revive'
                                ? 'revive + 5 minutes of immunity'
                                : `immunity until ${timeLabel(game.event.immunityUntil)}`}
                            .
                        </span>
                    )}
                </div>
            )}

            {!admin && eventOpen && !game.event.claimed && game.hasTeam && (
                <form className="game-guess-form" onSubmit={submitGuess}>
                    <label>
                        Google Maps dropped-pin link
                        <input
                            type="url"
                            required
                            maxLength={2048}
                            value={guessUrl}
                            onChange={(event) => setGuessUrl(event.target.value)}
                            placeholder="https://maps.google.com/?q=..."
                            autoComplete="url"
                        />
                    </label>
                    <fieldset>
                        <legend>Choose your reward if your guess is correct</legend>
                        <label className="game-choice">
                            <input
                                type="radio"
                                name="game-reward"
                                value="immunity"
                                checked={reward === 'immunity'}
                                onChange={() => setReward('immunity')}
                            />
                            <span>
                                <strong>Immunity</strong>
                                <small>90 − 3 × minutes elapsed after 1:30 p.m.</small>
                            </span>
                        </label>
                        <label className={`game-choice${!game.player.dead ? ' is-unavailable' : ''}`}>
                            <input
                                type="radio"
                                name="game-reward"
                                value="revive"
                                checked={reward === 'revive'}
                                disabled={!game.player.dead}
                                onChange={() => setReward('revive')}
                            />
                            <span>
                                <strong>Revive + 5 minutes</strong>
                                <small>
                                    {game.player.dead
                                        ? 'Become a survivor with five minutes to get away.'
                                        : 'Available only to dead players.'}
                                </small>
                            </span>
                        </label>
                    </fieldset>
                    <div className="game-guess-actions">
                        <ActionButton
                            className="button primary"
                            type="submit"
                            disabled={
                                busy ||
                                game.event.claimed ||
                                game.event.attemptsRemaining <= 0 ||
                                (reward === 'revive' && !game.player.dead)
                            }
                            unavailableReason={
                                game.event.claimed
                                    ? 'A correct guess has already claimed the event.'
                                    : game.event.attemptsRemaining <= 0
                                      ? 'Your team has used both guesses.'
                                      : reward === 'revive' && !game.player.dead
                                        ? 'Only dead players can choose revive.'
                                        : 'Wait for the current request to finish.'
                            }
                        >
                            {busy ? 'Submitting…' : 'Submit guess'}
                        </ActionButton>
                        <span>
                            Your pin is checked automatically against the original location; it must be within
                            200 m.
                        </span>
                    </div>
                </form>
            )}
            {!admin && !game.event.claimed && (!eventOpen || !game.hasTeam) && (
                <p className="game-event-notice" role="status">
                    {guessNotice}
                </p>
            )}

            {admin && (
                <div className="game-admin-tools">
                    {game.canManage && (
                        <GameEventSetup
                            eventPasswordSet={game.eventPasswordSet ?? false}
                            setupClosed={eventTime >= start}
                            onChanged={onChanged}
                        />
                    )}
                    {game.canManagePlayers && (
                        <div className="game-catch-tools">
                            <div>
                                <h3>Mark players caught or restore them</h3>
                                <p>Players with active immunity cannot be marked dead.</p>
                            </div>
                            <label className="game-player-search">
                                Search players
                                <input
                                    type="search"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder="Name, username, or team"
                                />
                            </label>
                            <div
                                className="game-player-list"
                                role="group"
                                aria-label="Select players to update"
                            >
                                {filteredPlayers.length ? (
                                    filteredPlayers.map((player) => {
                                        const immune = activeImmunity(
                                            player.immunityUntil,
                                            now + clockOffset,
                                        );
                                        return (
                                            <label
                                                className={`game-player-row${player.dead ? ' is-dead' : ''}`}
                                                key={player.id}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selected.includes(player.id)}
                                                    onChange={(event) =>
                                                        setSelected((items) =>
                                                            event.target.checked
                                                                ? [...items, player.id]
                                                                : items.filter((id) => id !== player.id),
                                                        )
                                                    }
                                                />
                                                <span>
                                                    <strong>{player.displayName}</strong>
                                                    <small>
                                                        {player.groupName} · {player.status}
                                                        {player.dead ? ' · dead' : ''}
                                                        {immune
                                                            ? ` · immune until ${timeLabel(player.immunityUntil)}`
                                                            : ''}
                                                    </small>
                                                </span>
                                            </label>
                                        );
                                    })
                                ) : (
                                    <p className="event-empty">No matching players.</p>
                                )}
                            </div>
                            <div className="game-catch-actions">
                                <ActionButton
                                    className="button secondary"
                                    disabled={busy || !catchSel.length}
                                    unavailableReason={
                                        busy
                                            ? 'Wait for the current update to finish.'
                                            : 'Select at least one player who is not dead or immune.'
                                    }
                                    onClick={() => void updatePlayers(catchSel, true)}
                                >
                                    Mark dead
                                </ActionButton>
                                <ActionButton
                                    className="button secondary"
                                    disabled={busy || !restoreSel.length}
                                    unavailableReason={
                                        busy
                                            ? 'Wait for the current update to finish.'
                                            : 'Select at least one dead player to restore.'
                                    }
                                    onClick={() => void updatePlayers(restoreSel, false)}
                                >
                                    Restore selected
                                </ActionButton>
                            </div>
                        </div>
                    )}
                </div>
            )}
            {message && (
                <p className="game-feedback" role="status">
                    {message}
                </p>
            )}
            {error && (
                <p className="game-feedback is-error" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
