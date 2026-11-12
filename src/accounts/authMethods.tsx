import { useEffect, useState } from 'react';
import { rememberGoogleReturn } from '../app/navigation';
import { requestJson } from '../app/requestJson';
import { ActionButton } from '../ui/ActionButton';
import { normalizePhone, REGISTRATION_PHONE_ERROR } from '../../shared/accounts/registrationPhone';

export type AuthOptions = { googleEnabled: boolean; emailOtpEnabled?: boolean };
export type AuthMode = 'login' | 'register' | 'link';
type Identity = { id: string; provider: 'google'; identifier: string };

async function requestSignIn<T>(path: string, data?: unknown): Promise<T> {
    return requestJson<T>(
        path,
        {
            method: data === undefined ? 'GET' : 'POST',
            credentials: 'same-origin',
            ...(data === undefined
                ? {}
                : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
        },
        {
            fallbackMessage: 'Could not complete this sign-in step.',
            messageFields: ['error', 'message'],
        },
    );
}

function enrollment(mode: AuthMode, groupName?: string, members?: string[]) {
    return mode === 'register' && groupName?.trim() && members?.length
        ? { groupName: groupName.trim(), members }
        : {};
}

export function GoogleSignIn({
    mode,
    options,
    phoneOnly = false,
    phone,
    groupName,
    members,
}: {
    mode: AuthMode;
    options: AuthOptions;
    phoneOnly?: boolean;
    phone?: string;
    groupName?: string;
    members?: string[];
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function startGoogle() {
        setBusy(true);
        setError('');
        try {
            const normPhone = mode === 'register' ? normalizePhone(phone) : null;
            if (mode === 'register' && !normPhone) {
                document.getElementById('registration-phone')?.focus();
                throw new Error(REGISTRATION_PHONE_ERROR);
            }
            rememberGoogleReturn(mode);
            const result = await requestSignIn<{ authorizationUrl: string }>('/api/auth/google/start', {
                mode,
                ...(mode === 'register' ? { phone: normPhone } : {}),
                ...enrollment(mode, groupName, members),
            });
            window.location.assign(result.authorizationUrl);
        } catch (cause) {
            rememberGoogleReturn('link');
            setError(cause instanceof Error ? cause.message : 'Google sign-in is unavailable.');
            setBusy(false);
        }
    }

    const googleButton = (
        <ActionButton
            className="button secondary full auth-provider-button"
            type={phoneOnly ? 'submit' : 'button'}
            disabled={busy || !options.googleEnabled}
            unavailableReason={
                busy
                    ? 'Please wait while Google sign-in opens.'
                    : !options.googleEnabled
                      ? phoneOnly
                          ? 'Google sign-in is temporarily unavailable. Please try again later.'
                          : 'Google sign-in is not available yet. Use your email and password instead.'
                      : undefined
            }
            onClick={phoneOnly ? undefined : () => void startGoogle()}
        >
            {busy ? 'Opening Google…' : mode === 'register' ? 'Continue with Google' : 'Sign in with Google'}
        </ActionButton>
    );

    return (
        <section
            className="auth-methods"
            aria-label={mode === 'register' ? 'Create an account with Google' : 'Sign in with Google'}
        >
            {mode !== 'link' &&
                (phoneOnly ? (
                    <form
                        id="registration-form"
                        className="auth-method-actions"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void startGoogle();
                        }}
                    >
                        {googleButton}
                    </form>
                ) : (
                    <div className="auth-method-actions">{googleButton}</div>
                ))}
            {!options.googleEnabled && (
                <p className="hint auth-method-hint">
                    {phoneOnly
                        ? 'Google sign-in is temporarily unavailable. Please try again later.'
                        : 'Google sign-in is not available yet. You can use your email and password below.'}
                </p>
            )}
            {error && (
                <p className="alert error" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}

export function LinkedSignIns({ options }: { options: AuthOptions }) {
    const [methods, setMethods] = useState<Identity[]>([]);
    const [error, setError] = useState('');

    useEffect(() => {
        void loadMethods();
    }, []);

    async function loadMethods() {
        setError('');
        try {
            const result = await requestSignIn<{
                methods: Array<{ id: string; provider: string; identifier: string }>;
            }>('/api/auth/methods');
            setMethods(result.methods.filter((method): method is Identity => method.provider === 'google'));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not load sign-in methods.');
        }
    }

    return (
        <section className="linked-methods" aria-labelledby="linked-methods-title">
            <h2 id="linked-methods-title">Sign-in methods</h2>
            <div className="linked-methods-content">
                {methods.length ? (
                    <ul>
                        {methods.map((method) => (
                            <li key={method.id}>Google: {method.identifier}</li>
                        ))}
                    </ul>
                ) : (
                    <p className="hint">No Google account is linked yet.</p>
                )}
                <div className="auth-method-actions">
                    <LinkGoogle options={options} onError={setError} />
                </div>
                {!options.googleEnabled && (
                    <p className="hint">Google linking will be available once Google sign-in is enabled.</p>
                )}
                {error && (
                    <p className="alert error" role="alert">
                        {error}
                    </p>
                )}
            </div>
        </section>
    );
}

function LinkGoogle({ options, onError }: { options: AuthOptions; onError: (error: string) => void }) {
    return (
        <ActionButton
            className="button secondary full auth-provider-button"
            type="button"
            disabled={!options.googleEnabled}
            unavailableReason={!options.googleEnabled ? 'Google linking is not available yet.' : undefined}
            onClick={async () => {
                onError('');
                rememberGoogleReturn('link');
                try {
                    const result = await requestSignIn<{ authorizationUrl: string }>(
                        '/api/auth/google/start',
                        {
                            mode: 'link',
                        },
                    );
                    window.location.assign(result.authorizationUrl);
                } catch (cause) {
                    onError(cause instanceof Error ? cause.message : 'Google sign-in is unavailable.');
                }
            }}
        >
            Link Google account
        </ActionButton>
    );
}
