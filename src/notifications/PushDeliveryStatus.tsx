import { useCallback, useEffect, useState } from 'react';
import './pushDeliveryStatus.css';

interface PushDeliveryOverview {
    counts: { pending: number; sent: number; failed: number; unknown: number };
    recentFailures: Array<{
        notificationId: number;
        groupName: string;
        taskTitle: string;
        attempts: number;
        failedAt: string;
    }>;
}

function deliveryTime(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? value
        : `${parsed.toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' })} SGT`;
}

export function PushDeliveryStatus() {
    const [overview, setOverview] = useState<PushDeliveryOverview | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        try {
            const response = await fetch('/api/push/delivery-status', { credentials: 'same-origin' });
            const body = (await response.json().catch(() => ({}))) as PushDeliveryOverview & {
                error?: string;
            };
            if (!response.ok) throw new Error(body.error || 'Could not load push delivery status.');
            setOverview(body);
            setError('');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not load push delivery status.');
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        const interval = window.setInterval(() => {
            void refresh(true);
        }, 60_000);
        const onFocus = () => {
            void refresh(true);
        };
        window.addEventListener('focus', onFocus);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener('focus', onFocus);
        };
    }, [refresh]);

    return (
        <section className="push-delivery-status" aria-labelledby="push-delivery-heading">
            <div className="push-delivery-heading">
                <div>
                    <h2 id="push-delivery-heading">Device notification delivery</h2>
                    <p>Delivery results for group review alerts.</p>
                </div>
                <button
                    className="event-text-action"
                    type="button"
                    onClick={() => void refresh()}
                    disabled={loading}
                >
                    {loading ? 'Refreshing…' : 'Refresh'}
                </button>
            </div>
            {overview ? (
                <>
                    <dl className="push-delivery-counts">
                        <div>
                            <dt>Pending</dt>
                            <dd>{overview.counts.pending}</dd>
                        </div>
                        <div>
                            <dt>Sent</dt>
                            <dd>{overview.counts.sent}</dd>
                        </div>
                        <div className={overview.counts.failed ? 'push-delivery-count-failed' : ''}>
                            <dt>Failed</dt>
                            <dd>{overview.counts.failed}</dd>
                        </div>
                        {overview.counts.unknown > 0 && (
                            <div>
                                <dt>Older result unknown</dt>
                                <dd>{overview.counts.unknown}</dd>
                            </div>
                        )}
                    </dl>
                    {overview.counts.unknown > 0 && (
                        <p className="push-delivery-unknown-note">
                            Older releases did not record whether every completed delivery attempt reached the
                            device, so these results cannot be confirmed.
                        </p>
                    )}
                    {overview.recentFailures.length > 0 && (
                        <div className="push-delivery-failures">
                            <h3>Recent failures</h3>
                            <ul>
                                {overview.recentFailures.map((failure) => (
                                    <li key={failure.notificationId}>
                                        <span>
                                            <strong>{failure.groupName}</strong>
                                            <small>
                                                {failure.taskTitle} · {failure.attempts} attempts
                                            </small>
                                        </span>
                                        <time dateTime={failure.failedAt}>
                                            {deliveryTime(failure.failedAt)}
                                        </time>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {overview.counts.failed === 0 && (
                        <p className="push-delivery-empty">No failed device notifications recorded.</p>
                    )}
                </>
            ) : loading ? (
                <p role="status">Loading delivery status…</p>
            ) : null}
            {error && (
                <p className="push-delivery-error" role="alert">
                    {error}{' '}
                    <button className="text-button" type="button" onClick={() => void refresh()}>
                        Try again
                    </button>
                </p>
            )}
        </section>
    );
}
