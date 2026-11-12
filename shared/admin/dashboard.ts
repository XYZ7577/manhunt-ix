import type { Group, SubmissionStatus } from '../types';

export interface AdminSubmissionSummary {
    id: string;
    groupId: string;
    groupName: string;
    taskId: string;
    taskTitle: string;
    status: SubmissionStatus;
    attempt: number;
    createdAt: string;
    submittedAt: string | null;
    reviewedAt: string | null;
    latest: boolean;
}

export interface AdminSubmissionPage {
    items: AdminSubmissionSummary[];
    total: number;
    page: number;
    pageSize: number;
    nextCursor?: string | null;
    previousCursor?: string | null;
}

export interface AdminDashboardSummary {
    groups: Group[];
    progress: Array<{ groupId: string; taskId: string; status: SubmissionStatus }>;
    pendingCount: number;
}
