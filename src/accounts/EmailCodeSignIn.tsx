import React, { FormEvent, useEffect, useState } from 'react';
import { ActionButton } from '../ui/ActionButton';

type Props = { enabled: boolean; onSignedIn: () => Promise<void> };

export function EmailCodeSignIn({ enabled, onSignedIn }: Props) {
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [codeSent, setCodeSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [retryAt, setRetryAt] = useState(0);
    const [clock, setClock] = useState(Date.now());

    useEffect(() => {
        if (retryAt <= Date.now()) return;
        const timer = window.setInterval(() => {
            const now = Date.now();
            setClock(now);
            if (retryAt <= now) window.clearInterval(timer);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [retryAt]);

    async function requestCode(event?: FormEvent) {
        event?.preventDefault();
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const response = await fetch('/api/auth/email/start', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim() }),
            });
            const result = (await response.json().catch(() => ({}))) as {
                error?: string;
                retryAfterSeconds?: number;
            };
            const now = Date.now();
            setClock(now);
            if (!response.ok) {
                if (response.status === 429 && typeof result.retryAfterSeconds === 'number')
                    setRetryAt(now + result.retryAfterSeconds * 1000);
                throw new Error(result.error || 'Could not send a code. Try again shortly.');
            }
            const seconds = typeof result.retryAfterSeconds === 'number' ? result.retryAfterSeconds : 60;
            setRetryAt(now + seconds * 1000);
            setCodeSent(true);
            setCode('');
            setMessage(
                'If this address can sign in, a code will arrive shortly. Enter it in this browser within 10 minutes.',
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not send a code. Try again shortly.');
        } finally {
            setBusy(false);
        }
    }

    async function verifyCode(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const response = await fetch('/api/auth/email/verify', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim(), code }),
            });
            const result = (await response.json().catch(() => ({}))) as { error?: string; account?: unknown };
            if (!response.ok)
                throw new Error(result.error || 'That code could not be verified. Check it and try again.');
            setCode('');
            setEmail('');
            setCodeSent(false);
            await onSignedIn();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not sign in.');
        } finally {
            setBusy(false);
        }
    }

    function changeEmail() {
        setCodeSent(false);
        setCode('');
        setError('');
        setMessage('');
        setRetryAt(0);
    }

    const waitSeconds = Math.max(0, Math.ceil((retryAt - clock) / 1000));
    return (
        <div className="email-code-signin">
            {!enabled ? (
                <>
                    <ActionButton
                        className="button secondary"
                        type="button"
                        disabled
                        unavailableReason="Email code sign-in is temporarily unavailable. Use your password instead."
                    >
                        Email code
                    </ActionButton>
                    <p className="email-code-unavailable" role="status">
                        Email code sign-in is temporarily unavailable. Use your password instead.
                    </p>
                </>
            ) : (
                <form className="stack" onSubmit={codeSent ? verifyCode : requestCode}>
                    <p className="hint">Use your verified registration email or linked Google email.</p>
                    <label htmlFor="email-code-address">
                        Email address
                        <input
                            id="email-code-address"
                            type="email"
                            autoComplete="email"
                            required
                            value={email}
                            disabled={busy || codeSent}
                            onChange={(event) => setEmail(event.target.value)}
                        />
                    </label>
                    {codeSent && (
                        <>
                            <p className="email-code-message" role="status">
                                {message}
                            </p>
                            <label htmlFor="email-code-value">
                                6-digit code
                                <input
                                    id="email-code-value"
                                    type="text"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    pattern="[0-9]{6}"
                                    maxLength={6}
                                    required
                                    value={code}
                                    disabled={busy}
                                    onChange={(event) =>
                                        setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                                    }
                                />
                            </label>
                        </>
                    )}
                    {error && (
                        <p className="alert error" role="alert" aria-live="assertive">
                            {error}
                        </p>
                    )}
                    <ActionButton
                        className="button primary full"
                        type="submit"
                        disabled={
                            busy ||
                            !email.trim() ||
                            (codeSent && code.length !== 6) ||
                            (!codeSent && waitSeconds > 0)
                        }
                        unavailableReason={
                            busy
                                ? 'Please wait for the current sign-in request to finish.'
                                : !email.trim()
                                  ? 'Enter your email address first.'
                                  : codeSent && code.length !== 6
                                    ? 'Enter the 6-digit code from your email.'
                                    : waitSeconds > 0
                                      ? `Please wait ${waitSeconds} seconds before requesting another code.`
                                      : undefined
                        }
                    >
                        {busy
                            ? 'Please wait…'
                            : codeSent
                              ? 'Verify and sign in'
                              : waitSeconds > 0
                                ? `Send another code in ${waitSeconds}s`
                                : 'Send code'}
                    </ActionButton>
                    {codeSent && (
                        <div className="email-code-actions">
                            <ActionButton
                                className="text-button"
                                type="button"
                                onClick={changeEmail}
                                disabled={busy}
                                unavailableReason={
                                    busy
                                        ? 'Please wait for the current sign-in request to finish.'
                                        : undefined
                                }
                            >
                                Change email
                            </ActionButton>
                            <ActionButton
                                className="text-button"
                                type="button"
                                onClick={() => void requestCode()}
                                disabled={busy || waitSeconds > 0}
                                unavailableReason={
                                    busy
                                        ? 'Please wait for the current sign-in request to finish.'
                                        : waitSeconds > 0
                                          ? `Please wait ${waitSeconds} seconds before requesting another code.`
                                          : undefined
                                }
                            >
                                {waitSeconds > 0 ? `Resend code in ${waitSeconds}s` : 'Resend code'}
                            </ActionButton>
                        </div>
                    )}
                </form>
            )}
        </div>
    );
}
