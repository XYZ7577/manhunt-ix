import type { Group, Submission, Task } from '../../shared/types';

export interface ReviewFilters {
    status: 'pending' | 'all';
    groupId: string;
    taskId: string;
    sort: 'oldest' | 'newest';
    search: string;
}
export function selectReviewQueue(
    submissions: Submission[],
    groups: Group[],
    tasks: Task[],
    filters: ReviewFilters,
) {
    const query = filters.search.trim().toLocaleLowerCase();
    const groupNames = new Map(groups.map((group) => [group.id, group.name]));
    const taskNames = new Map(tasks.map((task) => [task.id, task.title]));
    return submissions
        .filter(
            (submission) =>
                (filters.status === 'all' || submission.status === 'pending') &&
                (filters.groupId === 'all' || submission.groupId === filters.groupId) &&
                (filters.taskId === 'all' || submission.taskId === filters.taskId) &&
                (!query ||
                    `${groupNames.get(submission.groupId) ?? ''} ${taskNames.get(submission.taskId) ?? ''}`
                        .toLocaleLowerCase()
                        .includes(query)),
        )
        .sort((a, b) => {
            const order =
                (a.submittedAt || a.createdAt).localeCompare(b.submittedAt || b.createdAt) ||
                a.id.localeCompare(b.id);
            return filters.sort === 'oldest' ? order : -order;
        });
}
