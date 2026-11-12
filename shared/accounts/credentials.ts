export const USERNAME_MAX_LENGTH = 254;
export const USERNAME_ERROR = 'Enter a username.';

export function validUsername(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= USERNAME_MAX_LENGTH;
}

export const PASSWORD_MIN_LENGTH = 3;
export const PASSWORD_MAX_LENGTH = 16;
export const PASSWORD_PATTERN = '(?=[\\s\\S]*[A-Z])(?=[\\s\\S]*[0-9])[\\s\\S]{3,16}';
export const PASSWORD_HELP = '3–16 characters, including at least one uppercase letter and one number.';
export const PASSWORD_ERROR =
    'Use a password with 3–16 characters, at least one uppercase letter and one number.';

const passwordPattern = new RegExp(`^(?:${PASSWORD_PATTERN})$`);

export function validPassword(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length >= PASSWORD_MIN_LENGTH &&
        value.length <= PASSWORD_MAX_LENGTH &&
        passwordPattern.test(value)
    );
}
