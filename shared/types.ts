import type { UploadSession } from './evidence/uploads';
import type { ReviewInbox } from './notifications/review';
import type { GameDashboard } from './event/game';

export type Role = 'player' | 'admin';
export interface Account {
    id: string;
    username: string;
    displayName: string;
    role: Role;
    groupId: string | null;
}
export interface Group {
    id: string;
    name: string;
    members: string[];
}
export interface Task {
    id: string;
    title: string;
    emoji?: string;
    bonus?: boolean;
    description: string;
    requirements: string[];
    media: 'photo' | 'video';
    minFiles: number;
    timeWindows?: [string, string][];
}
export type SubmissionStatus = 'draft' | 'pending' | 'approved' | 'changes_requested';
export type DateCheckStatus = 'consistent' | 'mismatch' | 'unavailable' | 'uncertain';
export interface CameraCaptureReport {
    source: 'camera-input';
    openedAt: string;
    returnedAt: string;
    fileModifiedAt: string | null;
}
export interface MetadataResult {
    capturedAt: string | null;
    rawDate: string | null;
    timezone: string | null;
    status: DateCheckStatus;
    flags: string[];
    source: string | null;
    cameraCapture?: CameraCaptureReport;
}
export interface Evidence {
    id: string;
    submissionId: string;
    filename: string;
    mediaType: string;
    size: number;
    url: string;
    previewUrl?: string;
    uploadedAt: string;
    slot: string | null;
    comment?: string;
    metadata?: MetadataResult;
}
export interface Submission {
    id: string;
    groupId: string;
    taskId: string;
    status: SubmissionStatus;
    attempt: number;
    note: string;
    reviewNote: string | null;
    createdAt: string;
    submittedAt: string | null;
    reviewedAt: string | null;
    evidence: Evidence[];
}
export interface Dashboard {
    game?: GameDashboard;
    serverNow?: string;
    account: Account;
    group: Group | null;
    tasks: Task[];
    archivedTasks?: Task[];
    submissions: Submission[];
    groups: Group[];
    demoMode: boolean;
    submissionsEnabled?: boolean;
    canManageSubmissions?: boolean;
    groupMergingEnabled?: boolean;
    canManageGroupMerging?: boolean;
    uploads?: UploadSession[];
    reviewInbox?: ReviewInbox;
}
export interface DemoAccount {
    username: string;
    role: Role;
    group: string;
}
