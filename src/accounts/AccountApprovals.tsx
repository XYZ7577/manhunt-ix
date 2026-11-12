import { useCallback, useEffect, useState } from 'react';
import { Brand } from '../ui/Brand';
import { ActionButton } from '../ui/ActionButton';
import './accountApprovals.css';

type NotificationEmail = 'sent' | 'failed' | 'sending' | 'not_available' | 'not_sent';
type Account = {
    id: string;
    username: string;
    displayName: string | null;
    createdAt: string;
    email: string | null;
    phone: string | null;
    status: string;
    reviewedAt?: string | null;
    notificationEmail?: NotificationEmail;
    emailAttempts?: Array<{
        startedAt: string;
        completedAt: string | null;
        status: 'sending' | 'sent' | 'failed';
    }>;
};
type Notice = {
    accountId: string;
    status: string;
    reviewedAt: string | null;
    notificationEmail: 'sent' | 'failed' | 'sending' | 'not_available' | 'not_sent';
};
type Props = { onBack?: () => void };

async function readJson<T>(response: Response): Promise<T> {
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || 'That action could not be completed.');
    return data;
}

export function AccountApprovals({ onBack }: Props) {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState<Record<string, Notice>>({});
    const [emailHistory, setEmailHistory] = useState<Account[]>([]);
    const [message, setMessage] = useState('');

    const refresh = useCallback(async () => {
        setLoading(true);
        setError('');
        const [pendingResult, approvedResult] = await Promise.allSettled([
            fetch('/api/admin/accounts?status=pending', { credentials: 'same-origin' }).then(
                readJson<{ accounts: Account[] }>,
            ),
            fetch('/api/admin/accounts?status=approved', { credentials: 'same-origin' }).then(
                readJson<{ accounts: Account[] }>,
            ),
        ]);
        if (pendingResult.status === 'fulfilled') setAccounts(pendingResult.value.accounts || []);
        else
            setError(
                pendingResult.reason instanceof Error
                    ? pendingResult.reason.message
                    : 'Could not load account requests.',
            );
        if (approvedResult.status === 'fulfilled') {
            const recent = (approvedResult.value.accounts || [])
                .filter((account) => account.notificationEmail)
                .sort(
                    (a, b) =>
                        Date.parse(b.reviewedAt || b.createdAt) - Date.parse(a.reviewedAt || a.createdAt),
                )
                .slice(0, 20);
            setEmailHistory(recent);
        } else if (pendingResult.status === 'fulfilled') {
            setError(
                approvedResult.reason instanceof Error
                    ? `Account requests loaded, but email history could not be refreshed: ${approvedResult.reason.message}`
                    : 'Account requests loaded, but email history could not be refreshed.',
            );
        }
        setLoading(false);
    }, []);
    useEffect(() => {
        void refresh();
    }, [refresh]);

    const act = async (account: Account, action: 'approve' | 'reject' | 'retry') => {
        const key = `${action}:${account.id}`;
        setBusy(key);
        setError('');
        setMessage('');
        try {
            const path =
                action === 'retry'
                    ? `/api/admin/accounts/${encodeURIComponent(account.id)}/approval-email/retry`
                    : `/api/admin/accounts/${encodeURIComponent(account.id)}/${action}`;
            const response = await fetch(path, {
                method: 'POST',
                credentials: 'same-origin',
                headers: action === 'reject' ? { 'Content-Type': 'application/json' } : undefined,
                ...(action === 'reject' ? { body: JSON.stringify({}) } : {}),
            });
            const data = await readJson<{ approval: Notice }>(response);
            if (action === 'reject') {
                setAccounts((current) => current.filter((item) => item.id !== account.id));
                setMessage(`${account.displayName || account.username} was declined.`);
            } else {
                setNotice((current) => ({ ...current, [account.id]: data.approval }));
                if (action === 'approve') {
                    setAccounts((current) => current.filter((item) => item.id !== account.id));
                    setEmailHistory((current) =>
                        [
                            {
                                ...account,
                                status: 'approved',
                                reviewedAt: data.approval.reviewedAt,
                                notificationEmail: data.approval.notificationEmail,
                            },
                            ...current.filter((item) => item.id !== account.id),
                        ].slice(0, 20),
                    );
                } else {
                    setEmailHistory((current) =>
                        current.map((item) =>
                            item.id === account.id
                                ? {
                                      ...item,
                                      status: 'approved',
                                      reviewedAt: data.approval.reviewedAt,
                                      notificationEmail: data.approval.notificationEmail,
                                  }
                                : item,
                        ),
                    );
                }
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'That action could not be completed.');
        } finally {
            setBusy(null);
        }
    };

    return (
        <main className="approvals-page">
            <header className="approvals-header">
                <Brand />
                <div className="approvals-heading">
                    <div>
                        <p className="approvals-eyebrow">ADMIN</p>
                        <h1>Account requests</h1>
                        <p>Review who can join the event portal.</p>
                    </div>
                    <div className="approvals-header-actions">
                        <ActionButton
                            type="button"
                            className="approvals-quiet"
                            onClick={() => void refresh()}
                            disabled={loading}
                            unavailableReason={loading ? 'Account requests are still loading.' : undefined}
                        >
                            Refresh
                        </ActionButton>
                        {onBack && (
                            <button type="button" className="approvals-quiet" onClick={onBack}>
                                Back
                            </button>
                        )}
                    </div>
                </div>
            </header>
            <section className="approvals-content" aria-live="polite">
                {error && (
                    <p className="approvals-error" role="alert">
                        {error}
                    </p>
                )}
                {message && (
                    <p className="approvals-success" role="status">
                        {message}
                    </p>
                )}
                {loading ? (
                    <p className="approvals-empty">Loading requests…</p>
                ) : accounts.length === 0 ? (
                    <div className="approvals-empty-card">
                        <span aria-hidden="true">✓</span>
                        <h2>You’re all caught up</h2>
                        <p>New account requests will appear here.</p>
                    </div>
                ) : (
                    <div className="approval-list">
                        {accounts.map((account) => {
                            const result = notice[account.id];
                            return (
                                <article className="approval-card" key={account.id}>
                                    <div className="approval-person">
                                        <div className="approval-avatar" aria-hidden="true">
                                            {(account.displayName || account.username)
                                                .slice(0, 1)
                                                .toUpperCase()}
                                        </div>
                                        <div className="approval-person-copy">
                                            <h2>{account.displayName || account.username}</h2>
                                            <p>
                                                @{account.username}
                                                {account.email
                                                    ? ` · ${account.email}`
                                                    : ' · No email address'}
                                            </p>
                                            <p>
                                                Phone for verification:{' '}
                                                {account.phone || 'Not provided (existing account)'}
                                            </p>
                                            <small>
                                                Requested {new Date(account.createdAt).toLocaleDateString()}
                                            </small>
                                        </div>
                                    </div>
                                    <div className="approval-actions">
                                        <ActionButton
                                            type="button"
                                            className="approval-approve"
                                            disabled={!!busy}
                                            unavailableReason={
                                                busy
                                                    ? 'Please wait for the current account action to finish.'
                                                    : undefined
                                            }
                                            onClick={() => void act(account, 'approve')}
                                        >
                                            {busy === `approve:${account.id}` ? 'Approving…' : 'Approve'}
                                        </ActionButton>
                                        <ActionButton
                                            type="button"
                                            className="approval-reject"
                                            disabled={!!busy}
                                            unavailableReason={
                                                busy
                                                    ? 'Please wait for the current account action to finish.'
                                                    : undefined
                                            }
                                            onClick={() => void act(account, 'reject')}
                                        >
                                            {busy === `reject:${account.id}` ? 'Declining…' : 'Decline'}
                                        </ActionButton>
                                    </div>
                                    {result && (
                                        <div
                                            className={`approval-email-result approval-email-${result.notificationEmail}`}
                                            role="status"
                                        >
                                            <span>
                                                {result.notificationEmail === 'sent'
                                                    ? 'Approval email sent.'
                                                    : result.notificationEmail === 'failed'
                                                      ? 'Approval email could not be delivered.'
                                                      : result.notificationEmail === 'sending'
                                                        ? 'Sending approval email…'
                                                        : result.notificationEmail === 'not_available'
                                                          ? 'No email address was provided. The approved user can still sign in.'
                                                          : 'No email was sent.'}
                                            </span>
                                            {result.notificationEmail === 'failed' && (
                                                <ActionButton
                                                    type="button"
                                                    onClick={() => void act(account, 'retry')}
                                                    disabled={!!busy}
                                                    unavailableReason={
                                                        busy
                                                            ? 'Please wait for the current account action to finish.'
                                                            : undefined
                                                    }
                                                >
                                                    {busy === `retry:${account.id}`
                                                        ? 'Retrying…'
                                                        : 'Retry email'}
                                                </ActionButton>
                                            )}
                                        </div>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                )}
                {emailHistory.length > 0 && (
                    <div className="approval-history">
                        <h2>Recent approvals</h2>
                        {emailHistory.map((account) => (
                            <div className="approval-history-row" key={account.id}>
                                <span>
                                    <strong>{account.displayName || account.username}</strong>
                                    <small>
                                        {account.notificationEmail === 'sent'
                                            ? 'Approval email sent'
                                            : account.notificationEmail === 'failed'
                                              ? 'Approval email failed'
                                              : account.notificationEmail === 'sending'
                                                ? 'Sending approval email…'
                                                : account.notificationEmail === 'not_available'
                                                  ? 'No email address; user can still sign in'
                                                  : 'No email sent'}
                                        {account.reviewedAt
                                            ? ` · ${new Date(account.reviewedAt).toLocaleDateString()}`
                                            : ''}
                                    </small>
                                </span>
                                {account.notificationEmail === 'failed' && (
                                    <ActionButton
                                        type="button"
                                        className="approval-retry"
                                        disabled={!!busy}
                                        onClick={() => void act(account, 'retry')}
                                        unavailableReason={
                                            busy
                                                ? 'Please wait for the current account action to finish.'
                                                : undefined
                                        }
                                    >
                                        {busy === `retry:${account.id}` ? 'Retrying…' : 'Retry email'}
                                    </ActionButton>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </main>
    );
}
