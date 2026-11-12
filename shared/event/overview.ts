import type { Submission, Task } from '../types';

export type EventPhase = 'upcoming' | 'game-day' | 'date-passed';

export function getEventPhase(at: Date = new Date()): EventPhase {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Singapore',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(at);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
    const sgDate = `${part('year')}-${part('month')}-${part('day')}`;
    return sgDate < '2026-11-13' ? 'upcoming' : sgDate === '2026-11-13' ? 'game-day' : 'date-passed';
}

export function latestTaskStatus(task: Task, submissions: Submission[]): Submission['status'] | null {
    let latest: Submission | undefined;
    for (const submission of submissions) {
        if (submission.taskId !== task.id) continue;
        if (!latest || isLaterAttempt(submission, latest)) latest = submission;
    }
    return latest?.status ?? null;
}

function isLaterAttempt(candidate: Submission, previous: Submission) {
    return (
        candidate.attempt > previous.attempt ||
        (candidate.attempt === previous.attempt && candidate.createdAt > previous.createdAt)
    );
}

export function latestTaskSubs(submissions: Submission[]): Submission[] {
    const latest = new Map<string, Submission>();
    for (const submission of submissions) {
        const key = JSON.stringify([submission.groupId, submission.taskId]);
        const previous = latest.get(key);
        if (!previous || isLaterAttempt(submission, previous)) latest.set(key, submission);
    }
    return [...latest.values()];
}

export function taskSubs(tasks: Task[], submissions: Submission[]): Submission[] {
    const taskIds = new Set(tasks.map((task) => task.id));
    return submissions.filter((submission) => taskIds.has(submission.taskId));
}

export function approvedCount(tasks: Task[], submissions: Submission[]): number {
    return tasks.filter((task) => latestTaskStatus(task, submissions) === 'approved').length;
}
