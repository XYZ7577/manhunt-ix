import { useCallback, useEffect, useRef, useState } from 'react';
import { Brand } from '../ui/Brand';
import { ActionButton } from '../ui/ActionButton';
import { isBackgroundRefreshDue } from '../app/backgroundRefresh';
import './accountAccess.css';

export type AccountAccessStatus = 'pending' | 'approved' | 'rejected' | 'disabled';
export type AccountAccessInfo = {
    status: AccountAccessStatus;
    canSignIn: boolean;
    requestedAt: string | null;
    message: string;
};

type Props = {
    onSignOut: () => void;
    onApproved: () => void;
    onSignedOut?: () => void;
    invitationFeedback?: { message: string; error: boolean } | null;
    onRetryInvitation?: () => void;
};

export function AccountAccess({
    onSignOut,
    onApproved,
    onSignedOut,
    invitationFeedback,
    onRetryInvitation,
}: Props) {
    const [info, setInfo] = useState<AccountAccessInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const reqInFlight = useRef(false);
    const lastAutoReq = useRef(0);

    const refresh = useCallback(
        async (quiet = false) => {
            const now = Date.now();
            if (
                reqInFlight.current ||
                (quiet &&
                    !isBackgroundRefreshDue(
                        document.visibilityState === 'visible',
                        navigator.onLine,
                        reqInFlight.current,
                        lastAutoReq.current,
                        now,
                    ))
            )
                return;
            reqInFlight.current = true;
            lastAutoReq.current = now;
            if (!quiet) setLoading(true);
            try {
                const response = await fetch('/api/account-status', { credentials: 'same-origin' });
                if (response.status === 401) {
                    onSignedOut?.();
                    return;
                }
                const data = (await response.json()) as AccountAccessInfo & { error?: string };
                if (!response.ok) throw new Error(data.error || 'Could not check account status.');
                setInfo(data);
                setError('');
                if (data.status === 'approved' && data.canSignIn) onApproved();
            } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Could not check account status.');
            } finally {
                reqInFlight.current = false;
                if (!quiet) setLoading(false);
            }
        },
        [onApproved, onSignedOut],
    );

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(true), 60_000);
        const onFocus = () => void refresh(true);
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') void refresh(true);
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('online', onFocus);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('online', onFocus);
        };
    }, [refresh]);

    const status = info?.status ?? 'pending';
    const heading =
        status === 'pending'
            ? 'Waiting for admin approval'
            : status === 'rejected'
              ? 'Account not approved'
              : status === 'disabled'
                ? 'Account unavailable'
                : 'Account approved';
    const icon = status === 'pending' ? '…' : status === 'approved' ? '✓' : 'i';

    return (
        <main className="access-page" id="main-content" tabIndex={-1}>
            <section className="access-card" aria-labelledby="access-heading">
                <Brand />
                <div className={`access-mark access-mark-${status}`} aria-hidden="true">
                    {icon}
                </div>
                <h1 id="access-heading">{heading}</h1>
                {loading && !info ? (
                    <p className="access-copy">Checking your account…</p>
                ) : (
                    <p className="access-copy">
                        {info?.message ||
                            (status === 'pending'
                                ? 'Your account is ready. An administrator must approve it before you can access events.'
                                : 'Please contact an administrator if you think this is a mistake.')}
                    </p>
                )}
                {status === 'pending' && (
                    <p className="access-note">
                        Signing in confirms it’s your account. You do not need an email link, and you can
                        check back here after approval.
                    </p>
                )}
                {invitationFeedback && (
                    <p
                        className={invitationFeedback.error ? 'access-error' : 'access-note'}
                        role={invitationFeedback.error ? 'alert' : 'status'}
                    >
                        {invitationFeedback.message}
                    </p>
                )}
                {info?.requestedAt && (
                    <p className="access-date">
                        Request sent{' '}
                        {new Date(info.requestedAt).toLocaleString('en-SG', {
                            timeZone: 'Asia/Singapore',
                            dateStyle: 'medium',
                            timeStyle: 'short',
                        })}{' '}
                        SGT
                    </p>
                )}
                {error && (
                    <p className="access-error" role="alert">
                        {error}
                    </p>
                )}
                <div className="access-actions">
                    {onRetryInvitation && (
                        <button type="button" className="access-secondary" onClick={onRetryInvitation}>
                            Retry group invitation
                        </button>
                    )}
                    {status !== 'approved' && (
                        <ActionButton
                            type="button"
                            className="access-primary"
                            onClick={() => void refresh()}
                            disabled={loading}
                            unavailableReason={loading ? 'Your account status is being checked.' : undefined}
                        >
                            {loading ? 'Checking…' : 'Check approval status'}
                        </ActionButton>
                    )}
                    <button type="button" className="access-secondary" onClick={onSignOut}>
                        Sign out
                    </button>
                </div>
            </section>
        </main>
    );
}
