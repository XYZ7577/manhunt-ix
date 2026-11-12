const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000;

export function sgDateTimeInput(date: Date): string {
    return new Date(date.getTime() + SINGAPORE_OFFSET_MS).toISOString().slice(0, 16);
}

export function scheduleToIso(value: string, nowMs = Date.now()): string {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
        throw new Error('Choose a date and time for the announcement.');
    const date = new Date(`${value}:00+08:00`);
    if (!Number.isFinite(date.getTime()) || sgDateTimeInput(date) !== value)
        throw new Error('Choose a valid date and time.');
    if (date.getTime() <= nowMs) throw new Error('Choose a future date and time in Singapore time.');
    return date.toISOString();
}

export function formatAnnounceTime(value: string): string {
    return `${new Date(value).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' })} SGT`;
}
