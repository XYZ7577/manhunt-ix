import { useCallback, useEffect, useRef, useState } from 'react';
import type { Announcement } from '../../shared/notifications/announcements';
import { ActionButton } from '../ui/ActionButton';
import { formatAnnounceTime } from './announcementTime';
import './announcements.css';

type Inbox = { announcements: Array<Announcement & { read: boolean }>; unreadCount: number };
export function AnnouncementInbox({ accountId }: { accountId: string }) {
    const [inbox, setInbox] = useState<Inbox>({ announcements: [], unreadCount: 0 });
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const requestNumber = useRef(0);
    const lastAutoLoad = useRef(0);
    const load = useCallback(async () => {
        const number = ++requestNumber.current;
        try {
            const response = await fetch('/api/announcements', {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) throw new Error('Could not refresh announcements.');
            const result: Inbox = await response.json();
            if (number === requestNumber.current) {
                setInbox(result);
                setError('');
            }
        } catch (cause) {
            if (number === requestNumber.current)
                setError(cause instanceof Error ? cause.message : 'Could not load announcements.');
        }
    }, [accountId]);

    useEffect(() => {
        void load();
        const automaticLoad = () => {
            if (
                document.visibilityState !== 'visible' ||
                !navigator.onLine ||
                Date.now() - lastAutoLoad.current < 60_000
            )
                return;
            lastAutoLoad.current = Date.now();
            void load();
        };
        const openAnnouncement = (event: MessageEvent) => {
            if (event.data?.type === 'manhunt-open-announcements') {
                setOpen(true);
                void load();
            }
        };
        const refreshAnnouncements = () => {
            void load();
        };
        const timer = window.setInterval(automaticLoad, 60_000);
        document.addEventListener('visibilitychange', automaticLoad);
        window.addEventListener('online', automaticLoad);
        window.addEventListener('focus', automaticLoad);
        window.addEventListener('manhunt-announcements-changed', refreshAnnouncements);
        navigator.serviceWorker?.addEventListener('message', openAnnouncement);
        return () => {
            requestNumber.current++;
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', automaticLoad);
            window.removeEventListener('online', automaticLoad);
            window.removeEventListener('focus', automaticLoad);
            window.removeEventListener('manhunt-announcements-changed', refreshAnnouncements);
            navigator.serviceWorker?.removeEventListener('message', openAnnouncement);
        };
    }, [load]);

    async function markRead(id: string, all = false) {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const response = await fetch(
                all ? '/api/announcements/read' : `/api/announcements/${encodeURIComponent(id)}/read`,
                {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(all ? { through: id } : {}),
                },
            );
            if (!response.ok) throw new Error('Could not mark the announcement as read.');
            await load();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not update announcements.');
        } finally {
            setBusy(false);
        }
    }

    const newestUnread = inbox.announcements.find((item) => !item.read);
    return (
        <section className="announcement-inbox" aria-label="Event announcements">
            <button
                type="button"
                className={`announcement-inbox-toggle${inbox.unreadCount ? ' has-updates' : ''}`}
                aria-expanded={open}
                aria-controls="announcement-inbox-panel"
                onClick={() => {
                    setOpen(!open);
                    if (!open) void load();
                }}
            >
                <span aria-hidden="true">↗</span>
                <strong>Announcements</strong>
                {inbox.unreadCount > 0 && (
                    <span
                        className="announcement-unread"
                        aria-label={`${inbox.unreadCount} unread announcements`}
                    >
                        {inbox.unreadCount}
                    </span>
                )}
                <span className="announcement-toggle-symbol" aria-hidden="true">
                    {open ? '−' : '+'}
                </span>
            </button>
            {!open && newestUnread && (
                <p className="announcement-preview" role="status">
                    New: {newestUnread.title}
                </p>
            )}
            {error && (
                <p className="announcement-error" role="alert">
                    {error}{' '}
                    <button className="text-button" type="button" onClick={() => void load()}>
                        Try again
                    </button>
                </p>
            )}
            {open && (
                <div id="announcement-inbox-panel" className="announcement-inbox-panel">
                    <div className="announcement-section-heading">
                        <h2>From the organisers</h2>
                        <div className="announcement-inbox-actions">
                            <ActionButton
                                className="text-button"
                                type="button"
                                disabled={busy || inbox.unreadCount === 0 || inbox.announcements.length === 0}
                                unavailableReason={
                                    busy ? 'Just a moment, the inbox is updating.' : 'You’re all caught up.'
                                }
                                onClick={() => {
                                    if (inbox.announcements[0])
                                        void markRead(inbox.announcements[0].id, true);
                                }}
                            >
                                Mark all as read
                            </ActionButton>
                            <button className="text-button" type="button" onClick={() => void load()}>
                                Refresh
                            </button>
                        </div>
                    </div>
                    {inbox.announcements.length === 0 ? (
                        <p className="event-empty">No announcements yet. Check back here for updates.</p>
                    ) : (
                        <ul className="announcement-feed">
                            {inbox.announcements.map((item) => (
                                <li key={item.id} className={item.read ? '' : 'announcement-feed-unread'}>
                                    <div className="announcement-feed-title">
                                        <h3>{item.title}</h3>
                                        {!item.read && <span>New</span>}
                                    </div>
                                    <p>{item.message}</p>
                                    <div className="announcement-feed-footer">
                                        <time dateTime={item.publishedAt || item.scheduledFor}>
                                            {formatAnnounceTime(item.publishedAt || item.scheduledFor)}
                                        </time>
                                        {!item.read && (
                                            <ActionButton
                                                className="text-button"
                                                type="button"
                                                disabled={busy}
                                                unavailableReason="Just a moment, the inbox is updating."
                                                onClick={() => void markRead(item.id)}
                                            >
                                                Mark as read
                                            </ActionButton>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                    {inbox.announcements.length === 50 && (
                        <p className="announcement-field-hint">Showing the latest 50 announcements.</p>
                    )}
                </div>
            )}
        </section>
    );
}
