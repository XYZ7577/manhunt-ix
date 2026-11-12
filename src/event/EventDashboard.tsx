import type { Dashboard, SubmissionStatus, Task } from '../../shared/types';
import { useState } from 'react';
import {
    approvedCount,
    getEventPhase,
    latestTaskSubs,
    latestTaskStatus,
    taskSubs,
} from '../../shared/event/overview';
import './eventDashboard.css';
import { ActionButton } from '../ui/ActionButton';
import { PushDeliveryStatus } from '../notifications/PushDeliveryStatus';
import { AdminAnnouncements } from '../announcements/AdminAnnouncements';
import { GamePanel } from './GameEvent';

const phaseText = {
    upcoming: 'Upcoming',
    'game-day': 'Game day',
    'date-passed': 'Event date passed',
} as const;
const statusText: Record<SubmissionStatus | 'not-started', string> = {
    draft: 'Draft saved',
    pending: 'Awaiting review',
    approved: 'Approved',
    changes_requested: 'Action needed',
    'not-started': 'Not started',
};

function nextPlayerTask(dashboard: Dashboard) {
    const { tasks, submissions } = dashboard;
    return (
        tasks.find((task) => latestTaskStatus(task, submissions) === 'changes_requested') ??
        tasks.find((task) => latestTaskStatus(task, submissions) === 'draft') ??
        tasks.find((task) => !latestTaskStatus(task, submissions))
    );
}

export interface EventDashboardProps {
    dashboard: Dashboard & {
        adminPendingCount?: number;
        submissionsEnabled?: boolean;
        canManageSubmissions?: boolean;
        groupMergingEnabled?: boolean;
        canManageGroupMerging?: boolean;
    };
    onOpenTask: (taskId: string) => void;
    onOpenReview: () => void;
    onOpenGroup: (groupId: string) => void;
    onChanged?: () => void | Promise<void>;
}

export function EventDashboard({
    dashboard,
    onOpenTask,
    onOpenReview,
    onOpenGroup,
    onChanged,
}: EventDashboardProps) {
    const [submissionsBusy, setSubmissionsBusy] = useState(false);
    const [submissionsError, setSubmissionsError] = useState('');
    const [groupMergingBusy, setGroupMergingBusy] = useState(false);
    const [groupMergingError, setGroupMergingError] = useState('');
    const phase = getEventPhase();
    const admin = dashboard.account.role === 'admin';
    const activeSubs = taskSubs(dashboard.tasks, dashboard.submissions);
    const lastSub = latestTaskSubs(activeSubs);
    const mainTasks = dashboard.tasks.filter((task) => !task.bonus);
    const bonusTasks = dashboard.tasks.filter((task) => task.bonus);
    const pending = lastSub.filter((submission) => submission.status === 'pending');
    const needsAction = lastSub.filter((submission) => submission.status === 'changes_requested');
    const drafts = lastSub.filter((submission) => submission.status === 'draft');
    const taskTarget = dashboard.tasks.length;
    const group = dashboard.group;
    const approved = approvedCount(dashboard.tasks, dashboard.submissions);
    const nextTask = nextPlayerTask(dashboard);
    const allApproved = taskTarget > 0 && approved >= taskTarget;
    const approvedpcnt = taskTarget > 0 ? (Math.min(approved, taskTarget) / taskTarget) * 100 : 0;
    const maxProgress = Math.max(1, taskTarget);

    function taskRow(task: Task, index: number) {
        const status = latestTaskStatus(task, activeSubs);
        const state = status ?? 'not-started';
        const markerStyle =
            status === 'approved'
                ? 'approved'
                : status === 'changes_requested'
                  ? 'attention'
                  : status === 'pending'
                    ? 'pending'
                    : 'open';
        return (
            <li key={task.id}>
                <button type="button" className="event-task-row" onClick={() => onOpenTask(task.id)}>
                    <span className={`event-task-number event-task-number-${markerStyle}`}>
                        {status === 'approved' ? '✓' : task.bonus ? '★' : String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="event-task-name">
                        <strong>
                            {task.emoji && <span aria-hidden="true">{task.emoji} </span>}
                            {task.title}
                        </strong>
                        <small>
                            {task.minFiles > 1
                                ? `${task.minFiles} ${task.media === 'photo' ? 'photos' : 'videos'}`
                                : task.media === 'photo'
                                  ? 'Photo evidence'
                                  : 'Video evidence'}
                        </small>
                    </span>
                    <span className={`event-task-status event-task-status-${state.replace('_', '-')}`}>
                        {statusText[state]}
                    </span>
                    <span className="event-task-arrow" aria-hidden="true">
                        →
                    </span>
                </button>
            </li>
        );
    }

    return (
        <section className="event-dashboard" aria-labelledby="event-dashboard-title">
            <div className="event-hero">
                <div className="event-hero-copy">
                    <p className="event-eyebrow">
                        MANHUNT IX <span aria-hidden="true">/</span> SINGAPORE
                    </p>
                    <h1 id="event-dashboard-title">
                        {admin
                            ? 'Event overview'
                            : `Welcome, ${group?.name || dashboard.account.displayName}`}
                    </h1>
                    <p className="event-intro">
                        {admin
                            ? 'Group progress and submissions awaiting review.'
                            : 'Tasks, evidence, and organiser feedback for your group.'}
                    </p>
                    <div className="event-hero-details">
                        <span className="event-date">Friday, 13 November 2026</span>
                        <span className={`event-phase event-phase-${phase}`}>
                            <span className="event-phase-dot" aria-hidden="true" />
                            {phaseText[phase]}
                        </span>
                    </div>
                </div>
                <img className="event-logo-frame" src="/manhunt-ix-logo.jpg" alt="Manhunt IX" />
            </div>

            {dashboard.game && <GamePanel game={dashboard.game} admin={admin} onChanged={onChanged} />}
            {admin ? (
                <>
                    <div className="event-metrics" aria-label="Event summary">
                        <article className="event-metric">
                            <strong>{dashboard.groups.length}</strong>
                            <span>Groups</span>
                        </article>
                        <article className="event-metric">
                            <strong>{dashboard.adminPendingCount ?? pending.length}</strong>
                            <span>Waiting for review</span>
                        </article>
                        <article className="event-metric">
                            <strong>{needsAction.length}</strong>
                            <span>Need changes</span>
                        </article>
                    </div>
                    <AdminAnnouncements
                        onPublished={() => window.dispatchEvent(new Event('manhunt-announcements-changed'))}
                    />
                    {dashboard.canManageSubmissions && (
                        <section
                            className="event-panel event-submission-control"
                            aria-labelledby="event-submission-control-title"
                        >
                            <div>
                                <h2 id="event-submission-control-title">Task submissions</h2>
                                <p>
                                    {dashboard.submissionsEnabled !== false
                                        ? 'Players can start tasks, upload evidence, and send work for review.'
                                        : 'Submissions are paused. Players can view existing work, but cannot add or send evidence.'}
                                </p>
                            </div>
                            <ActionButton
                                className={`button ${dashboard.submissionsEnabled !== false ? 'secondary' : 'primary'}`}
                                disabled={submissionsBusy}
                                unavailableReason="Wait for the current setting to finish saving."
                                onClick={async () => {
                                    setSubmissionsBusy(true);
                                    setSubmissionsError('');
                                    try {
                                        const response = await fetch('/api/admin/submission-settings', {
                                            method: 'PATCH',
                                            credentials: 'same-origin',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                enabled: dashboard.submissionsEnabled === false,
                                            }),
                                        });
                                        const body = (await response.json().catch(() => ({}))) as {
                                            error?: string;
                                        };
                                        if (!response.ok)
                                            throw new Error(
                                                body.error ||
                                                    `Could not update submission settings (${response.status}).`,
                                            );
                                        await onChanged?.();
                                    } catch (error) {
                                        setSubmissionsError(
                                            error instanceof Error
                                                ? error.message
                                                : 'Could not update submission settings.',
                                        );
                                    } finally {
                                        setSubmissionsBusy(false);
                                    }
                                }}
                            >
                                {submissionsBusy
                                    ? 'Saving…'
                                    : dashboard.submissionsEnabled !== false
                                      ? 'Pause submissions'
                                      : 'Allow submissions'}
                            </ActionButton>
                            {submissionsError && (
                                <p className="alert error" role="alert">
                                    {submissionsError}
                                </p>
                            )}
                        </section>
                    )}
                    {dashboard.canManageGroupMerging && (
                        <section
                            className="event-panel event-submission-control"
                            aria-labelledby="event-group-merging-title"
                        >
                            <div>
                                <h2 id="event-group-merging-title">Group merging</h2>
                                <p>
                                    {dashboard.groupMergingEnabled !== false
                                        ? 'Players can accept invitations to join another team. Pausing will temporarily stop everyone from joining a team by invitation.'
                                        : 'Group merging is paused. Players cannot accept invitations to join a team; sign-in, registration, and creating invitations remain available.'}
                                </p>
                            </div>
                            <ActionButton
                                className={`button ${dashboard.groupMergingEnabled !== false ? 'secondary' : 'primary'}`}
                                disabled={groupMergingBusy}
                                unavailableReason="Wait for the group merging setting to finish saving."
                                onClick={async () => {
                                    setGroupMergingBusy(true);
                                    setGroupMergingError('');
                                    try {
                                        const response = await fetch('/api/admin/group-merging-settings', {
                                            method: 'PATCH',
                                            credentials: 'same-origin',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                enabled: dashboard.groupMergingEnabled === false,
                                            }),
                                        });
                                        const body = (await response.json().catch(() => ({}))) as {
                                            error?: string;
                                        };
                                        if (!response.ok)
                                            throw new Error(
                                                body.error ||
                                                    `Could not update group merging settings (${response.status}).`,
                                            );
                                        await onChanged?.();
                                    } catch (error) {
                                        setGroupMergingError(
                                            error instanceof Error
                                                ? error.message
                                                : 'Could not update group merging settings.',
                                        );
                                    } finally {
                                        setGroupMergingBusy(false);
                                    }
                                }}
                            >
                                {groupMergingBusy
                                    ? 'Saving…'
                                    : dashboard.groupMergingEnabled !== false
                                      ? 'Pause group merging'
                                      : 'Resume group merging'}
                            </ActionButton>
                            {groupMergingError && (
                                <p className="alert error" role="alert">
                                    {groupMergingError}
                                </p>
                            )}
                        </section>
                    )}
                    <section className="event-panel" aria-labelledby="event-groups-title">
                        <div className="event-panel-heading">
                            <div>
                                <h2 id="event-groups-title">Group progress</h2>
                                <p>Select a group to see its roster and task details.</p>
                            </div>
                            <button className="event-text-action" type="button" onClick={onOpenReview}>
                                Review submissions <span aria-hidden="true">→</span>
                            </button>
                        </div>
                        {dashboard.groups.length === 0 ? (
                            <p className="event-empty">No groups have joined yet.</p>
                        ) : (
                            <div className="event-group-grid">
                                {dashboard.groups.map((item) => {
                                    const grpSubs = dashboard.submissions.filter(
                                        (submission) => submission.groupId === item.id,
                                    );
                                    const count = approvedCount(dashboard.tasks, grpSubs);
                                    const latestGroupSubs = latestTaskSubs(grpSubs);
                                    const groupPending = latestGroupSubs.filter(
                                        (submission) => submission.status === 'pending',
                                    ).length;
                                    const groupAction = latestGroupSubs.filter(
                                        (submission) => submission.status === 'changes_requested',
                                    ).length;
                                    return (
                                        <button
                                            className="event-group-card"
                                            key={item.id}
                                            type="button"
                                            onClick={() => onOpenGroup(item.id)}
                                        >
                                            <span className="event-group-copy">
                                                <strong>{item.name}</strong>
                                                <small>
                                                    {item.members.length}{' '}
                                                    {item.members.length === 1 ? 'member' : 'members'} ·{' '}
                                                    {count} of {taskTarget} tasks approved
                                                </small>
                                                <span
                                                    className="event-progress-track"
                                                    role="progressbar"
                                                    aria-label={`${item.name} approved tasks`}
                                                    aria-valuemin={0}
                                                    aria-valuemax={maxProgress}
                                                    aria-valuenow={Math.min(count, taskTarget)}
                                                >
                                                    <span
                                                        style={{
                                                            width: `${taskTarget > 0 ? (Math.min(count, taskTarget) / taskTarget) * 100 : 0}%`,
                                                        }}
                                                    />
                                                </span>
                                            </span>
                                            <span
                                                className={`event-group-status${groupPending > 0 || groupAction > 0 ? ' event-group-status-attention' : ''}`}
                                            >
                                                {groupPending > 0
                                                    ? `${groupPending} waiting`
                                                    : groupAction > 0
                                                      ? `${groupAction} need changes`
                                                      : 'View group'}
                                                <span aria-hidden="true">→</span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                    <PushDeliveryStatus />
                    <p className="event-organiser-note">
                        <strong>Event note</strong> Task approvals update group progress. Player catches and
                        Geoguessr rewards appear above. Organisers determine the final result.
                    </p>
                </>
            ) : (
                <>
                    {dashboard.submissionsEnabled === false && (
                        <div className="event-submissions-paused" role="status">
                            <strong>Submissions are paused</strong>
                            <span>
                                You can still view existing tasks and evidence. New evidence and reviews are
                                unavailable until an organiser reopens submissions.
                            </span>
                        </div>
                    )}
                    <div className="event-player-grid">
                        <section
                            className="event-panel event-progress-panel"
                            aria-labelledby="event-progress-title"
                        >
                            <div className="event-panel-heading">
                                <div>
                                    <p className="event-eyebrow">YOUR GROUP</p>
                                    <h2 id="event-progress-title">
                                        Tasks approved {approved}/{dashboard.tasks.length}
                                    </h2>
                                </div>
                            </div>
                            <div
                                className="event-progress-track event-progress-large"
                                role="progressbar"
                                aria-label="Tasks approved"
                                aria-valuemin={0}
                                aria-valuemax={maxProgress}
                                aria-valuenow={Math.min(approved, taskTarget)}
                            >
                                <span style={{ width: `${approvedpcnt}%` }} />
                            </div>
                            <div className="event-progress-legend">
                                <span>
                                    <i className="event-legend-approved" />
                                    {approved} approved
                                </span>
                                <span>
                                    <i className="event-legend-pending" />
                                    {pending.length} awaiting review
                                </span>
                                <span>
                                    <i className="event-legend-todo" />
                                    {Math.max(0, dashboard.tasks.length - approved)} still open
                                </span>
                            </div>
                        </section>
                        <aside
                            className={`event-next-card${needsAction.length > 0 ? ' event-next-urgent' : allApproved ? ' event-next-done' : ''}`}
                            aria-labelledby="event-next-title"
                        >
                            <p className="event-eyebrow">
                                {needsAction.length > 0
                                    ? 'ORGANISER FEEDBACK'
                                    : allApproved
                                      ? 'ALL TASKS APPROVED'
                                      : 'UP NEXT'}
                            </p>
                            <h2 id="event-next-title">
                                {needsAction.length > 0
                                    ? 'A task needs another look'
                                    : allApproved
                                      ? 'All tasks approved'
                                      : pending.length > 0
                                        ? 'Submission under review'
                                        : nextTask
                                          ? 'Continue with a task'
                                          : 'No tasks to show'}
                            </h2>
                            <p>
                                {needsAction.length > 0
                                    ? 'Open the task to read the feedback and prepare replacement evidence.'
                                    : allApproved
                                      ? `Your group has completed all ${dashboard.tasks.length} tasks. Organisers manage the game result.`
                                      : pending.length > 0
                                        ? 'Your group can keep working on other tasks while this submission is reviewed.'
                                        : nextTask
                                          ? `${nextTask.title} is ready when your group is.`
                                          : 'Refresh the page or ask an organiser for help.'}
                            </p>
                            {needsAction.length > 0 && (
                                <button
                                    className="event-button event-button-attention"
                                    type="button"
                                    onClick={() => onOpenTask(needsAction[0].taskId)}
                                >
                                    Read feedback <span aria-hidden="true">→</span>
                                </button>
                            )}
                            {allApproved && needsAction.length === 0 && (
                                <button
                                    className="event-button"
                                    type="button"
                                    onClick={() => onOpenGroup(group?.id ?? '')}
                                >
                                    View group <span aria-hidden="true">→</span>
                                </button>
                            )}
                            {pending.length > 0 && !allApproved && needsAction.length === 0 && (
                                <button
                                    className="event-button"
                                    type="button"
                                    onClick={() => onOpenTask(pending[0].taskId)}
                                >
                                    View submission <span aria-hidden="true">→</span>
                                </button>
                            )}
                            {needsAction.length === 0 && !allApproved && pending.length === 0 && nextTask && (
                                <button
                                    className="event-button"
                                    type="button"
                                    onClick={() => onOpenTask(nextTask.id)}
                                >
                                    {nextTask.description
                                        ? nextTaskStatusLabel(nextTask.id, dashboard)
                                        : 'Open task'}{' '}
                                    <span aria-hidden="true">→</span>
                                </button>
                            )}
                        </aside>
                    </div>

                    <section className="event-panel event-task-panel" aria-labelledby="event-tasks-title">
                        <div className="event-panel-heading">
                            <div>
                                <h2 id="event-tasks-title">Tasks</h2>
                                <p>
                                    {drafts.length} draft{drafts.length === 1 ? '' : 's'} saved ·{' '}
                                    {needsAction.length} need attention
                                </p>
                            </div>
                            <ActionButton
                                className="event-text-action"
                                type="button"
                                disabled={dashboard.tasks.length === 0}
                                unavailableReason="No tasks are available yet. Refresh later or ask an organiser for help."
                                onClick={() => onOpenTask(nextTask?.id ?? dashboard.tasks[0]?.id ?? '')}
                            >
                                View all tasks <span aria-hidden="true">→</span>
                            </ActionButton>
                        </div>
                        {mainTasks.length > 0 && (
                            <ul className="event-task-list">{mainTasks.map(taskRow)}</ul>
                        )}
                        {bonusTasks.length > 0 && (
                            <section className="event-bonus-section" aria-labelledby="event-bonus-title">
                                <h3 id="event-bonus-title">Bonus Task</h3>
                                <p>Insurmountable counts toward your total task completion.</p>
                                <ul className="event-task-list">{bonusTasks.map(taskRow)}</ul>
                            </section>
                        )}
                    </section>
                    <p className="event-organiser-note">
                        <strong>Event note</strong> Your player status and Geoguessr immunity appear above.
                        Organisers share game updates and determine the final result.
                    </p>
                </>
            )}
        </section>
    );
}

function nextTaskStatusLabel(taskId: string, dashboard: Dashboard) {
    return latestTaskStatus(dashboard.tasks.find((task) => task.id === taskId)!, dashboard.submissions) ===
        'changes_requested'
        ? 'Review feedback'
        : 'Open task';
}
