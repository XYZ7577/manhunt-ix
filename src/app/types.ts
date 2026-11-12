import type { Dashboard } from '../../shared/types';

export type DashboardView = Dashboard & {
    adminPendingCount?: number;
    reviewInboxRequestedAt?: number;
};

export type UploadProgress = {
    submissionId: string;
    filename: string;
    percent: number;
    queued: boolean;
};

export type FailedUpload = {
    id: string;
    submissionId: string;
    file: File;
    message: string;
};
