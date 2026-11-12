import React, { FormEvent, useEffect, useState } from 'react';
import { ActionButton } from '../ui/ActionButton';
import { PasswordInput } from './PasswordInput';
import {
    PASSWORD_ERROR,
    PASSWORD_HELP,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PASSWORD_PATTERN,
    validPassword,
} from '../../shared/accounts/credentials';

async function request(path: string, data?: unknown) {
    const response = await fetch(path, {
        method: data === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        ...(data === undefined
            ? {}
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(result.error || 'This request could not be completed.'));
    return result;
}

export function AuthenticatorLogin({
    onSignedIn,
    onBack,
}: {
    onSignedIn: () => Promise<void>;
    onBack: () => void;
}) {
    const [identifier, setIdentifier] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await request('/api/auth/authenticator', { identifier, code });
            await onSignedIn();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not sign in.');
        } finally {
            setBusy(false);
        }
    }
    return (
        <section className="auth-card">
            <h1>Authenticator sign-in</h1>
            <p className="subtext">Use your authenticator app or one of your saved backup codes.</p>
            <form className="stack" onSubmit={(event) => void submit(event)}>
                <label>
                    Email or username
                    <input
                        autoComplete="username"
                        required
                        maxLength={254}
                        value={identifier}
                        onChange={(event) => setIdentifier(event.target.value)}
                    />
                </label>
                <label>
                    Authenticator or backup code
                    <input
                        type="text"
                        autoComplete="one-time-code"
                        required
                        maxLength={32}
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                    />
                </label>
                {error && (
                    <p className="alert error" role="alert">
                        {error}
                    </p>
                )}
                <ActionButton
                    className="button primary full"
                    disabled={busy}
                    unavailableReason={busy ? 'Please wait for sign-in to finish.' : undefined}
                >
                    {busy ? 'Signing in…' : 'Sign in'}
                </ActionButton>
            </form>
            <button type="button" className="text-button switch" onClick={onBack}>
                Other sign-in options
            </button>
        </section>
    );
}

export function PasswordRecovery({ onBack }: { onBack: () => void }) {
    const [identifier, setIdentifier] = useState('');
    const [method, setMethod] = useState<'authenticator' | 'backup' | 'email'>('authenticator');
    const [emailEnabled, setEmailEnabled] = useState(false);
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [complete, setComplete] = useState(false);
    const [optionsLoaded, setOptionsLoaded] = useState(false);
    useEffect(() => {
        request('/api/auth/recovery-options')
            .then((result) => setEmailEnabled(result.emailEnabled === true))
            .catch(() => setEmailEnabled(false))
            .finally(() => setOptionsLoaded(true));
    }, []);
    const emailRecoveryReason = !optionsLoaded
        ? 'Checking whether email recovery is available…'
        : 'Email recovery is not available. Use an authenticator or backup code.';
    async function sendEmail() {
        setBusy('email');
        setError('');
        setNotice('');
        try {
            await request('/api/auth/password-reset/request', { identifier });
            setNotice(
                'If this is a verified sign-in email, a reset code will arrive shortly. Use it in this browser within 10 minutes.',
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not request a code.');
        } finally {
            setBusy('');
        }
    }
    async function reset(event: FormEvent) {
        event.preventDefault();
        setError('');
        setNotice('');
        if (!validPassword(password)) {
            setError(PASSWORD_ERROR);
            return;
        }
        if (password !== confirmation) {
            setError('The passwords do not match.');
            return;
        }
        setBusy('reset');
        try {
            await request('/api/auth/password-reset/confirm', {
                identifier,
                method,
                code,
                newPassword: password,
            });
            setPassword('');
            setConfirmation('');
            setCode('');
            setComplete(true);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not reset your password.');
        } finally {
            setBusy('');
        }
    }
    return (
        <section className="auth-card">
            <h1>Forgot password</h1>
            {complete ? (
                <>
                    <p className="alert success" role="status">
                        Your password has been reset. Sign in with your new password.
                    </p>
                    <button className="button primary full" onClick={onBack}>
                        Back to sign in
                    </button>
                </>
            ) : (
                <>
                    <p className="subtext">Choose a way to confirm your account and set a new password.</p>
                    <form className="stack" onSubmit={(event) => void reset(event)}>
                        <label>
                            Recovery method
                            <select
                                value={method}
                                onChange={(event) => {
                                    setMethod(event.target.value as typeof method);
                                    setCode('');
                                    setError('');
                                    setNotice('');
                                }}
                            >
                                <option value="authenticator">Authenticator app</option>
                                <option value="backup">Backup code</option>
                                <option value="email">Email reset code</option>
                            </select>
                        </label>
                        <label>
                            {method === 'email' ? 'Verified Google email address' : 'Email or username'}
                            <input
                                type={method === 'email' ? 'email' : 'text'}
                                autoComplete="username"
                                required
                                maxLength={254}
                                value={identifier}
                                onChange={(event) => setIdentifier(event.target.value)}
                            />
                        </label>
                        {method === 'email' && (
                            <>
                                <ActionButton
                                    type="button"
                                    className="button secondary"
                                    disabled={!!busy || !identifier.trim() || !emailEnabled}
                                    unavailableReason={
                                        busy
                                            ? 'Please wait for the current recovery request to finish.'
                                            : !identifier.trim()
                                              ? 'Enter your email address first.'
                                              : !emailEnabled
                                                ? emailRecoveryReason
                                                : undefined
                                    }
                                    onClick={() => void sendEmail()}
                                >
                                    {busy === 'email' ? 'Sending…' : 'Send reset code'}
                                </ActionButton>
                                <p className="hint">
                                    {emailEnabled
                                        ? 'Reset codes go to a verified email linked through Google sign-in.'
                                        : 'Email recovery is not available yet. Use an authenticator or backup code, or return to Google sign-in.'}
                                </p>
                            </>
                        )}
                        {notice && (
                            <p className="alert success" role="status">
                                {notice}
                            </p>
                        )}
                        <label>
                            {method === 'backup'
                                ? 'Backup code'
                                : method === 'email'
                                  ? 'Email reset code'
                                  : 'Authenticator code'}
                            <input
                                type="text"
                                inputMode={method === 'backup' ? 'text' : 'numeric'}
                                autoComplete="one-time-code"
                                required
                                maxLength={32}
                                value={code}
                                onChange={(event) => setCode(event.target.value)}
                            />
                        </label>
                        <PasswordInput
                            label="New password"
                            autoComplete="new-password"
                            required
                            minLength={PASSWORD_MIN_LENGTH}
                            maxLength={PASSWORD_MAX_LENGTH}
                            pattern={PASSWORD_PATTERN}
                            title={PASSWORD_ERROR}
                            aria-describedby="recovery-password-help"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                        <p id="recovery-password-help" className="hint">
                            {PASSWORD_HELP}
                        </p>
                        <PasswordInput
                            label="Confirm new password"
                            autoComplete="new-password"
                            required
                            minLength={PASSWORD_MIN_LENGTH}
                            maxLength={PASSWORD_MAX_LENGTH}
                            value={confirmation}
                            onChange={(event) => setConfirmation(event.target.value)}
                        />
                        {error && (
                            <p className="alert error" role="alert">
                                {error}
                            </p>
                        )}
                        <ActionButton
                            className="button primary full"
                            disabled={!!busy || (method === 'email' && !emailEnabled)}
                            unavailableReason={
                                busy
                                    ? 'Please wait for the current recovery request to finish.'
                                    : method === 'email' && !emailEnabled
                                      ? emailRecoveryReason
                                      : undefined
                            }
                        >
                            {busy === 'reset' ? 'Resetting…' : 'Reset password'}
                        </ActionButton>
                    </form>
                    <button type="button" className="text-button switch" onClick={onBack}>
                        Back to sign in
                    </button>
                </>
            )}
        </section>
    );
}
