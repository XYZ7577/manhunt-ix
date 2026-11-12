import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Announcement } from '../../shared/notifications/announcements';
import { requestJson } from '../app/requestJson';
import { ActionButton } from '../ui/ActionButton';
import { scheduleToIso, formatAnnounceTime, sgDateTimeInput } from './announcementTime';
import './announcements.css';

type AnnouncementOverview = { announcements: Announcement[]; emailEnabled: boolean; pushEnabled?: boolean };

function deliverySummary(
    label: string,
    counts: { pending: number; sent: number; failed: number; cancelled: number },
): string {
    return `${label}: ${counts.sent} sent · ${counts.pending} queued${counts.failed ? ` · ${counts.failed} failed` : ''}${counts.cancelled ? ` · ${counts.cancelled} cancelled` : ''}`;
}

async function requestAnnouncement<T>(path: string, data?: unknown): Promise<T> {
    return requestJson<T>(
        path,
        {
            credentials: 'same-origin',
            cache: 'no-store',
            ...(data === undefined
                ? {}
                : {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(data),
                  }),
        },
        { fallbackMessage: 'Could not update announcements. Try again.' },
    );
}

export function AdminAnnouncements({ onPublished }: { onPublished?: () => void }) {
    const [overview, setOverview] = useState<AnnouncementOverview | null>(null);
    const [title, setTitle] = useState('');
    const [message, setMessage] = useState('');
    const [timing, setTiming] = useState<'now' | 'schedule'>('now');
    const [scheduledFor, setScheduledFor] = useState('');
    const [sendEmail, setSendEmail] = useState(true);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const requestNumber = useRef(0);
    const load = useCallback(async () => {
        const number = ++requestNumber.current;
        try {
            const result = await requestAnnouncement<AnnouncementOverview>('/api/admin/announcements');
            if (number === requestNumber.current) {
                setOverview(result);
                setError('');
            }
        } catch (cause) {
            if (number === requestNumber.current)
                setError(cause instanceof Error ? cause.message : 'Could not load announcements.');
        } finally {
            if (number === requestNumber.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
        const refresh = () => {
            if (document.visibilityState === 'visible' && navigator.onLine) void load();
        };
        const timer = window.setInterval(refresh, 60_000);
        window.addEventListener('online', refresh);
        return () => {
            requestNumber.current++;
            window.clearInterval(timer);
            window.removeEventListener('online', refresh);
        };
    }, [load]);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || !overview) return;
        setError('');
        setNotice('');
        try {
            const schedule = timing === 'schedule' ? scheduleToIso(scheduledFor) : undefined;
            if (!title.trim() || !message.trim()) throw new Error('Add a title and a message first.');
            setBusy(true);
            const result = await requestAnnouncement<{ announcement: Announcement }>(
                '/api/admin/announcements',
                {
                    title: title.trim(),
                    message: message.trim(),
                    sendEmail: sendEmail && overview.emailEnabled,
                    ...(schedule ? { scheduledFor: schedule } : {}),
                },
            );
            setTitle('');
            setMessage('');
            setScheduledFor('');
            setTiming('now');
            setNotice(
                result.announcement.status === 'published'
                    ? 'Posted. Everyone can read it here. Notifications and emails may take a little longer.'
                    : `All set for ${formatAnnounceTime(result.announcement.scheduledFor)}. It'll go out even if you close this page.`,
            );
            await load();
            onPublished?.();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save the announcement.');
        } finally {
            setBusy(false);
        }
    }

    async function cancel(announcement: Announcement) {
        if (busy) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await requestAnnouncement(
                `/api/admin/announcements/${encodeURIComponent(announcement.id)}/cancel`,
                {},
            );
            setNotice('Cancelled. This announcement won’t be sent.');
            await load();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not cancel the announcement.');
        } finally {
            setBusy(false);
        }
    }

    const scheduled = overview?.announcements.filter((item) => item.status === 'scheduled') ?? [];
    const history = overview?.announcements.filter((item) => item.status !== 'scheduled') ?? [];
    return (
        <section className="event-panel admin-announcements" aria-labelledby="admin-announcements-title">
            <div className="event-panel-heading">
                <div>
                    <h2 id="admin-announcements-title">Announcements</h2>
                    <p>Send a message to everyone, now or later.</p>
                </div>
                <span className="announcement-audience">All players and admins</span>
            </div>
            <form onSubmit={submit} className="announcement-compose">
                <fieldset disabled={busy || loading || !overview}>
                    <label htmlFor="announcement-title">
                        Title
                        <input
                            id="announcement-title"
                            required
                            maxLength={120}
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            placeholder="e.g. Meet at the starting point"
                        />
                    </label>
                    <label htmlFor="announcement-message">
                        Message
                        <textarea
                            id="announcement-message"
                            required
                            rows={4}
                            maxLength={4000}
                            value={message}
                            onChange={(event) => setMessage(event.target.value)}
                            placeholder="What does everyone need to know?"
                        />
                        <span className="announcement-field-hint">
                            {message.length.toLocaleString()}/4,000 characters
                        </span>
                    </label>
                    <div className="announcement-options">
                        <fieldset className="announcement-timing">
                            <legend>When to send</legend>
                            <label>
                                <input
                                    type="radio"
                                    name="announcement-timing"
                                    checked={timing === 'now'}
                                    onChange={() => setTiming('now')}
                                />
                                Send now
                            </label>
                            <label>
                                <input
                                    type="radio"
                                    name="announcement-timing"
                                    checked={timing === 'schedule'}
                                    onChange={() => setTiming('schedule')}
                                />
                                Schedule for later
                            </label>
                        </fieldset>
                        {timing === 'schedule' && (
                            <label htmlFor="announcement-schedule">
                                Date and time (Singapore)
                                <input
                                    id="announcement-schedule"
                                    type="datetime-local"
                                    required
                                    min={sgDateTimeInput(new Date(Date.now() + 60_000))}
                                    value={scheduledFor}
                                    onChange={(event) => setScheduledFor(event.target.value)}
                                    aria-describedby="announcement-schedule-help"
                                />
                                <span id="announcement-schedule-help" className="announcement-field-hint">
                                    Pick a time up to a year ahead. It'll go out within about a minute of that
                                    time.
                                </span>
                            </label>
                        )}
                        <label className="announcement-email-option">
                            <input
                                type="checkbox"
                                checked={sendEmail && !!overview?.emailEnabled}
                                disabled={!overview?.emailEnabled}
                                onChange={(event) => setSendEmail(event.target.checked)}
                            />
                            Also send by email
                        </label>
                        <p className="announcement-field-hint">
                            Only approved accounts get announcements. Emails go to verified addresses.
                        </p>
                    </div>
                </fieldset>
                <div className="announcement-send-row">
                    <p>
                        Everyone can read it here. Players who've turned on notifications will also get an
                        alert.{overview && !overview.emailEnabled ? ' Email isn’t available right now.' : ''}
                        {overview?.pushEnabled === false
                            ? ' Device notifications aren’t available right now.'
                            : ''}
                    </p>
                    <ActionButton
                        type="submit"
                        className="event-button"
                        disabled={busy || loading || !overview}
                        unavailableReason={
                            busy
                                ? 'Just a moment, this announcement is saving.'
                                : loading
                                  ? 'Announcements are still loading.'
                                  : 'Refresh announcements before sending.'
                        }
                    >
                        {busy
                            ? 'Saving…'
                            : timing === 'schedule'
                              ? 'Schedule announcement'
                              : 'Send announcement'}
                    </ActionButton>
                </div>
            </form>
            {error && (
                <p className="announcement-error" role="alert">
                    {error}{' '}
                    <button className="text-button" type="button" onClick={() => void load()}>
                        Refresh
                    </button>
                </p>
            )}
            {notice && (
                <p className="announcement-success" role="status">
                    {notice}
                </p>
            )}
            <div className="announcement-management">
                <div className="announcement-section-heading">
                    <h3>
                        Scheduled <span>{scheduled.length}</span>
                    </h3>
                    <ActionButton
                        type="button"
                        className="event-text-action"
                        disabled={busy || loading}
                        onClick={() => void load()}
                    >
                        Refresh
                    </ActionButton>
                </div>
                {loading ? (
                    <p className="event-empty">Loading announcements…</p>
                ) : scheduled.length === 0 ? (
                    <p className="event-empty">No announcements scheduled.</p>
                ) : (
                    <ul className="announcement-history">
                        {scheduled.map((item) => (
                            <li key={item.id}>
                                <div className="announcement-history-copy">
                                    <strong>{item.title}</strong>
                                    <time dateTime={item.scheduledFor}>
                                        {formatAnnounceTime(item.scheduledFor)}
                                    </time>
                                    <p>{item.message}</p>
                                </div>
                                <ActionButton
                                    className="announcement-cancel"
                                    type="button"
                                    disabled={busy}
                                    unavailableReason="Please wait for the current announcement action to finish."
                                    onClick={() => void cancel(item)}
                                >
                                    Cancel schedule
                                </ActionButton>
                            </li>
                        ))}
                    </ul>
                )}
                {history.length > 0 && (
                    <details className="announcement-past">
                        <summary>Recent announcements ({history.length})</summary>
                        <ul className="announcement-history">
                            {history.map((item) => (
                                <li key={item.id}>
                                    <div className="announcement-history-copy">
                                        <strong>{item.title}</strong>
                                        <small>
                                            {item.status === 'cancelled'
                                                ? 'Cancelled'
                                                : `Posted to ${item.recipientCount} account${item.recipientCount === 1 ? '' : 's'}`}{' '}
                                            ·{' '}
                                            {formatAnnounceTime(
                                                item.publishedAt || item.cancelledAt || item.createdAt,
                                            )}
                                        </small>
                                        <p>{item.message}</p>
                                        {item.status === 'published' && item.delivery && (
                                            <div className="announcement-delivery-summary">
                                                {item.sendEmail && (
                                                    <small>
                                                        {deliverySummary('Email', item.delivery.email)}
                                                    </small>
                                                )}
                                                <small>
                                                    {deliverySummary(
                                                        'Device notifications',
                                                        item.delivery.push,
                                                    )}
                                                </small>
                                            </div>
                                        )}
                                    </div>
                                    <span className={`announcement-state announcement-state-${item.status}`}>
                                        {item.status === 'published' ? 'Posted' : 'Cancelled'}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
            </div>
        </section>
    );
}
