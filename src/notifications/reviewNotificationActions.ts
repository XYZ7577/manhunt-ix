import { latestTaskSubs } from '../../shared/event/overview';
import type { ReviewNotification } from '../../shared/notifications/review';
import type { Submission } from '../../shared/types';

export function canReplaceFromNotification(
    notification: ReviewNotification,
    submissions: Submission[],
): boolean {
    if (notification.status !== 'changes_requested') return false;
    const current = latestTaskSubs(submissions).find(
        (submission) =>
            submission.id === notification.submissionId && submission.taskId === notification.taskId,
    );
    return current?.status === 'changes_requested';
}
