import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewInbox, ReviewNotification } from '../../shared/notifications/review';
import type { Submission, Task } from '../../shared/types';
import { ActionButton } from '../ui/ActionButton';
import { shouldApplyInbox } from './reviewInboxState';
import { canReplaceFromNotification } from './reviewNotificationActions';
import './reviewNotifications.css';

const emptyInbox: ReviewInbox = { notifications: [], unreadCount: 0 };
export function ReviewNotifs({
    accountId,
    tasks,
    archivedTasks,
    submissions,
    dashboardInbox,
    dashboardInboxRequestedAt,
    onOpenTask,
    onReplace,
}: {
    accountId: string;
    tasks: Task[];
    submissions: Submission[];
    archivedTasks: Task[];
    dashboardInbox?: ReviewInbox;
    dashboardInboxRequestedAt?: number;
    onOpenTask: (id: string) => void;
    onReplace: (taskId: string) => Promise<unknown>;
}) {
    const [inbox, setInbox] = useState<ReviewInbox>(() => dashboardInbox ?? emptyInbox);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState('');
    const [announcement, setAnnouncement] = useState('');
    const [busy, setBusy] = useState(false);
    const latestSeen = useRef<number | null>(null);
    const requestNumber = useRef(0);
    const lastLocalOpAt = useRef(0);
    const lastAutoReload = useRef(0);
    const load = useCallback(async () => {
        lastLocalOpAt.current = performance.now();
        const number = ++requestNumber.current;
        try {
            const response = await fetch('/api/notifications', {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) throw new Error('Could not refresh review updates.');
            const next: ReviewInbox = await response.json();
            if (number !== requestNumber.current) return;
            const newest = next.notifications[0]?.id ?? 0;
            if (latestSeen.current !== null && newest > latestSeen.current && next.unreadCount > 0)
                setAnnouncement('New organiser feedback is available in Review updates.');
            latestSeen.current = newest;
            setInbox(next);
            setError('');
        } catch (cause) {
            if (number === requestNumber.current)
                setError(cause instanceof Error ? cause.message : 'Could not load review updates.');
        }
    }, [accountId]);
    useEffect(() => {
        latestSeen.current = null;
        if (dashboardInbox === undefined) {
            setInbox(emptyInbox);
            void load();
        }
        return () => {
            requestNumber.current++;
        };
    }, [accountId]);
    useEffect(() => {
        if (
            dashboardInbox === undefined ||
            !shouldApplyInbox(dashboardInboxRequestedAt, lastLocalOpAt.current)
        )
            return;
        requestNumber.current++;
        const newest = dashboardInbox.notifications[0]?.id ?? 0;
        if (latestSeen.current !== null && newest > latestSeen.current && dashboardInbox.unreadCount > 0)
            setAnnouncement('New organiser feedback is available in Review updates.');
        latestSeen.current = newest;
        setError('');
        setInbox(dashboardInbox);
    }, [dashboardInbox, dashboardInboxRequestedAt]);
    useEffect(() => {
        if (dashboardInbox !== undefined) return;
        const automaticLoad = () => {
            if (document.visibilityState !== 'visible' || !navigator.onLine) return;
            const now = Date.now();
            if (now - lastAutoReload.current < 60_000) return;
            lastAutoReload.current = now;
            void load();
        };
        const timer = window.setInterval(automaticLoad, 60_000);
        return () => {
            window.clearInterval(timer);
        };
    }, [dashboardInbox, load]);
    useEffect(() => {
        const onPushOpen = (event: MessageEvent) => {
            if (event.data?.type === 'manhunt-open-review-updates') {
                setOpen(true);
                void load();
            }
        };
        navigator.serviceWorker?.addEventListener('message', onPushOpen);
        return () => navigator.serviceWorker?.removeEventListener('message', onPushOpen);
    }, [load]);
    async function markRead(notification?: ReviewNotification) {
        const id = notification?.id ?? inbox.notifications[0]?.id;
        if (!id) return;
        lastLocalOpAt.current = performance.now();
        setBusy(true);
        try {
            const response = await fetch('/api/notifications/read', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(notification ? { id } : { through: id }),
            });
            if (!response.ok) throw new Error('Could not mark these updates as read.');
            await load();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not update the inbox.');
        } finally {
            setBusy(false);
        }
    }
    return (
        <section className="review-notifications" aria-label="Organiser review updates">
            <span className="visually-hidden" role="status">
                {announcement}
            </span>
            <button
                className={`review-updates-toggle${inbox.unreadCount ? ' has-updates' : ''}`}
                type="button"
                aria-expanded={open}
                aria-controls="review-updates-panel"
                onClick={() => {
                    setOpen(!open);
                    if (!open) void load();
                }}
            >
                <span aria-hidden="true">◉</span> Review updates{' '}
                <span className="review-unread-count" aria-label={`${inbox.unreadCount} unread updates`}>
                    {inbox.unreadCount}
                </span>
                <span aria-hidden="true">{open ? '−' : '+'}</span>
            </button>
            {!open && inbox.unreadCount > 0 && (
                <p className="review-updates-hint">
                    Your organisers have reviewed your evidence. Open updates to see the result.
                </p>
            )}
            {open && (
                <div className="review-updates-panel" id="review-updates-panel">
                    <div className="review-inbox-heading">
                        <h2>Organiser feedback</h2>
                        <ActionButton
                            className="text-button"
                            disabled={busy || inbox.unreadCount === 0}
                            unavailableReason={
                                busy
                                    ? 'The inbox is being updated.'
                                    : inbox.unreadCount === 0
                                      ? 'There are no unread updates to mark as read.'
                                      : undefined
                            }
                            type="button"
                            onClick={() => void markRead()}
                        >
                            Mark all as read
                        </ActionButton>
                    </div>
                    {error && (
                        <p className="alert error" role="alert">
                            {error}{' '}
                            <button className="text-button" onClick={() => void load()}>
                                Try again
                            </button>
                        </p>
                    )}
                    {inbox.notifications.length === 0 && !error && (
                        <p className="muted">
                            Approvals, replacement requests, and feedback changes will appear here.
                        </p>
                    )}
                    <ul className="review-update-list">
                        {inbox.notifications.map((notification) => {
                            const activeTask = tasks.find((item) => item.id === notification.taskId);
                            const task =
                                activeTask ?? archivedTasks.find((item) => item.id === notification.taskId);
                            const canReplace =
                                !!activeTask && canReplaceFromNotification(notification, submissions);
                            return (
                                <li
                                    key={notification.id}
                                    className={`${notification.read ? '' : 'review-update-unread '}review-update-${notification.status}`}
                                >
                                    <div className="review-update-title">
                                        <strong>{task?.title || 'Task update'}</strong>
                                        <span>
                                            {notification.kind === 'feedback'
                                                ? 'Feedback updated'
                                                : notification.status === 'approved'
                                                  ? 'Approved'
                                                  : 'Replacement requested'}
                                        </span>
                                    </div>
                                    {notification.feedback && <p>{notification.feedback}</p>}
                                    <small>
                                        {new Date(notification.createdAt).toLocaleString('en-SG', {
                                            timeZone: 'Asia/Singapore',
                                            dateStyle: 'medium',
                                            timeStyle: 'short',
                                        })}{' '}
                                        SGT
                                    </small>
                                    <div className="review-update-actions">
                                        <ActionButton
                                            className={`button ${canReplace ? 'primary' : 'secondary'} small-button`}
                                            disabled={busy}
                                            unavailableReason={
                                                busy ? 'The inbox is being updated.' : undefined
                                            }
                                            type="button"
                                            onClick={async () => {
                                                void markRead(notification);
                                                if (canReplace) await onReplace(notification.taskId);
                                                else onOpenTask(notification.taskId);
                                            }}
                                        >
                                            {canReplace
                                                ? 'Upload replacement evidence'
                                                : 'View task & feedback'}
                                        </ActionButton>
                                        {!notification.read && (
                                            <ActionButton
                                                className="text-button"
                                                disabled={busy}
                                                unavailableReason={
                                                    busy ? 'The inbox is being updated.' : undefined
                                                }
                                                type="button"
                                                onClick={() => void markRead(notification)}
                                            >
                                                Mark read
                                            </ActionButton>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                    {inbox.notifications.length === 50 && (
                        <p className="hint">
                            Showing the 50 most recent updates. Full review history stays with each task.
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}
