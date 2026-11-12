export const REGISTRATION_PHONE_ERROR =
    'Enter a valid phone number for verification. Use an 8-digit Singapore phone number or an international number with country code.';
export const REGISTRATION_PHONE_MAX_LENGTH = 32;

export function normalizePhone(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const input = value.trim();
    if (!input || input.length > REGISTRATION_PHONE_MAX_LENGTH) return null;

    const compact = input.replace(/[\s().-]/g, '');
    if (/^[689]\d{7}$/.test(compact)) return `+65${compact}`;
    if (/^\+65[689]\d{7}$/.test(compact)) return compact;
    if (!compact.startsWith('+65') && /^\+[1-9]\d{7,14}$/.test(compact)) return compact;
    return null;
}
