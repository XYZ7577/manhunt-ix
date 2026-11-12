export type ContactEmail = { id: string; email: string };

export function validateDisplayName(value: string): string {
    const name = value.trim();
    if (!name) return 'Enter your full name.';
    if (name.length > 80) return 'Your full name must be 80 characters or fewer.';
    return '';
}

export function validateGroupName(value: string): string {
    const name = value.trim();
    if (!name) return 'Enter a group name.';
    if (name.length > 60) return 'The group name must be 60 characters or fewer.';
    return '';
}

export function validateContactEmail(value: string, ownEmails: ContactEmail[], exceptId?: string): string {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return 'Enter an email address.';
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
        return 'Enter a valid email address.';
    if (ownEmails.some((item) => item.id !== exceptId && item.email.trim().toLowerCase() === normalized))
        return 'This email address is already on your account.';
    if (!exceptId && ownEmails.length >= 5)
        return 'You can add up to 5 contact emails. Remove one before adding another.';
    return '';
}
