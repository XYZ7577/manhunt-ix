export type AccountApprovalStatus = 'pending' | 'approved' | 'rejected' | 'disabled';
export type ApprovalEmailState = 'sent' | 'failed' | 'sending' | 'not_available' | 'not_sent';

export interface AccountApproval {
    accountId: string;
    status: AccountApprovalStatus;
    requestedAt: string;
    reviewedAt: string | null;
    reviewedBy: string | null;
    reviewNote: string | null;
    notificationEmail: ApprovalEmailState;
}

export interface AccountApprovalStatusResponse {
    status: AccountApprovalStatus;
    canSignIn: boolean;
    requestedAt: string | null;
    message: string;
}

export interface AdminApprovalAccount {
    id: string;
    username: string;
    displayName: string;
    createdAt: string;
    email: string | null;
    phone: string | null;
    status: AccountApprovalStatus;
    notificationEmail?: ApprovalEmailState;
    reviewedAt?: string | null;
    emailAttempts?: Array<{
        startedAt: string;
        completedAt: string | null;
        status: 'sending' | 'sent' | 'failed';
    }>;
}
