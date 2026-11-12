export interface SettingsEmail {
    id: string;
    email: string;
    verified: boolean;
    primary: boolean;
}

export interface SettingsMember {
    displayName: string;
    username: string;
    role: 'player' | 'admin';
}

export interface AdminPerson {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    role: 'player' | 'admin';
    headAdmin: boolean;
}

export interface AccountSettings {
    emails: SettingsEmail[];
    members: SettingsMember[];
    canRenameGroup: boolean;
    hasPassword: boolean;
    emailVerificationAvailable: boolean;
    recentSignInExpiresAt: string | null;
    twoFactor: { enabled: boolean };
}
