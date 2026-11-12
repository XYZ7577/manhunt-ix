export interface GroupMemberView {
    accountId: string;
    displayName: string;
    username?: string;
    email?: string | null;
    phone?: string | null;
    role: 'leader' | 'member';
}

export interface GroupInvitationView {
    id: string;
    email: string;
    createdAt: string;
    expiresAt: string;
    joinLinkAvailable: boolean;
    emailDelivery?: 'not_sent' | 'sending' | 'sent' | 'failed' | 'not_available' | 'rate_limited';
}

export interface GroupMembersResponse {
    group: { id: string; name: string };
    currentAccountId: string;
    leaderAccountId: string | null;
    canManageMembers: boolean;
    disbanded?: boolean;
    emailVerificationAvailable?: boolean;
    disbandVerificationEmail?: string | null;
    members: GroupMemberView[];
    invitations: GroupInvitationView[];
    maxMembers: 12;
}
