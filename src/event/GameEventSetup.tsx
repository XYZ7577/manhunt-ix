import { useState, type FormEvent } from 'react';
import {
    GAME_EVENT_PASSWORD_MAX_LENGTH,
    GAME_EVENT_PASSWORD_MIN_LENGTH,
    type GameEventSetup as Setup,
} from '../../shared/event/game';
import { ActionButton } from '../ui/ActionButton';
import { PasswordInput } from '../accounts/PasswordInput';
import { requestJson } from '../app/requestJson';

interface Props {
    eventPasswordSet: boolean;
    setupClosed: boolean;
    onChanged?: () => void | Promise<void>;
}

function send<T>(path: string, method: string, body: unknown) {
    return requestJson<T>(
        path,
        {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        { fallbackMessage: 'Could not complete this action. Try again.' },
    );
}

export function GameEventSetup({ eventPasswordSet, setupClosed, onChanged }: Props) {
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [mapsUrl, setMapsUrl] = useState('');
    const [pictureUrl, setPictureUrl] = useState('');
    const [unlocked, setUnlocked] = useState(false);
    const [passwordCreated, setPasswordCreated] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const hasPassword = eventPasswordSet || passwordCreated;

    async function run(action: () => Promise<void>) {
        setBusy(true);
        setError('');
        setMessage('');
        try {
            await action();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not complete this action.');
        } finally {
            setBusy(false);
        }
    }

    async function unlock(passwordToCheck: string) {
        const result = await send<Setup>('/api/admin/game-event/unlock', 'POST', {
            password: passwordToCheck,
        });
        if (result.target) {
            setMapsUrl(`https://www.google.com/maps?q=${result.target.latitude},${result.target.longitude}`);
        }
        setPictureUrl(result.pictureUrl || '');
        setUnlocked(true);
    }

    async function savePassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        if (password !== confirmation) {
            setError('The passwords do not match.');
            return;
        }
        await run(async () => {
            await send('/api/admin/game-event/password', 'PUT', { password });
            setPasswordCreated(true);
            setConfirmation('');
            await unlock(password);
            setMessage('Password saved. Event setup is unlocked.');
        });
    }

    async function unlockExisting(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        await run(() => unlock(password));
    }

    async function saveSetup(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || setupClosed) return;
        await run(async () => {
            await send('/api/admin/game-event', 'PATCH', {
                mapsUrl: mapsUrl.trim(),
                pictureUrl: pictureUrl.trim() || null,
                password,
            });
            setMessage('Geoguessr event setup saved.');
            await onChanged?.();
        });
    }

    function lock() {
        setUnlocked(false);
        setPassword('');
        setConfirmation('');
        setMapsUrl('');
        setPictureUrl('');
        setMessage('');
        setError('');
    }

    return (
        <section className="game-setup" aria-labelledby="game-setup-title">
            <div>
                <h3 id="game-setup-title">Revive event setup</h3>
                {!unlocked && hasPassword && <p>Enter the event password to see the location and setup form.</p>}
            </div>

            {unlocked ? (
                <form className="game-setup-fields" onSubmit={saveSetup} autoComplete="off">
                    <label>
                        Google Maps link to the original location
                        <input
                            type="url"
                            required
                            maxLength={2048}
                            value={mapsUrl}
                            onChange={(event) => setMapsUrl(event.target.value)}
                            readOnly={setupClosed}
                            placeholder="https://maps.google.com/?q=..."
                        />
                    </label>
                    <label>
                        Photo URL (optional)
                        <input
                            type="url"
                            maxLength={2048}
                            value={pictureUrl}
                            onChange={(event) => setPictureUrl(event.target.value)}
                            readOnly={setupClosed}
                            placeholder="https://…"
                        />
                    </label>
                    <div className="game-setup-actions">
                        <ActionButton
                            className="button primary"
                            type="submit"
                            disabled={busy || setupClosed}
                            unavailableReason={
                                setupClosed
                                    ? 'Event setup locks when guesses open at 1:30 p.m.'
                                    : 'Wait for the current save to finish.'
                            }
                        >
                            {busy ? 'Saving…' : 'Save event setup'}
                        </ActionButton>
                        <ActionButton className="button secondary" type="button" disabled={busy} onClick={lock}>
                            Lock setup
                        </ActionButton>
                    </div>
                </form>
            ) : (
                <form className="game-setup-fields" onSubmit={hasPassword ? unlockExisting : savePassword}>
                    <PasswordInput
                        label={hasPassword ? 'Revive event password' : 'Choose an event password'}
                        required
                        minLength={GAME_EVENT_PASSWORD_MIN_LENGTH}
                        maxLength={GAME_EVENT_PASSWORD_MAX_LENGTH}
                        autoComplete={hasPassword ? 'off' : 'new-password'}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={busy}
                    />
                    {!hasPassword && (
                        <>
                            <PasswordInput
                                label="Confirm event password"
                                required
                                minLength={GAME_EVENT_PASSWORD_MIN_LENGTH}
                                maxLength={GAME_EVENT_PASSWORD_MAX_LENGTH}
                                autoComplete="new-password"
                                value={confirmation}
                                onChange={(event) => setConfirmation(event.target.value)}
                                disabled={busy}
                            />
                            <p className="game-setup-hint">
                                Use at least {GAME_EVENT_PASSWORD_MIN_LENGTH} characters.
                            </p>
                        </>
                    )}
                    <ActionButton className="button primary" type="submit" disabled={busy}>
                        {hasPassword ? 'Unlock setup' : 'Save password'}
                    </ActionButton>
                </form>
            )}
            {message && <p className="game-feedback" role="status">{message}</p>}
            {error && <p className="game-feedback is-error" role="alert">{error}</p>}
        </section>
    );
}
