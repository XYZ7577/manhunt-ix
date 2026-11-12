export interface ReviewNotification {
    id: number;
    submissionId: string;
    taskId: string;
    status: 'approved' | 'changes_requested';
    feedback: string | null;
    kind: 'decision' | 'feedback';
    createdAt: string;
    read: boolean;
}
export interface ReviewInbox {
    notifications: ReviewNotification[];
    unreadCount: number;
}
