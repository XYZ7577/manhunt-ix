export const DEAD_TASK_MESSAGE = 'you are currently dead!';
export const LUNCH_MESSAGE = 'go get your lunch >:(';
export const LUNCH_START = '2026-11-13T12:30:00+08:00';
export const LUNCH_END = '2026-11-13T13:30:00+08:00';

export function isLunchBreak(at: number | Date = Date.now()): boolean {
    const time = Number(at);
    return time >= Date.parse(LUNCH_START) && time < Date.parse(LUNCH_END);
}

export function taskBlockReason(
    dead: boolean,
    submitting: boolean,
    at: number | Date = Date.now(),
): string | null {
    if (dead) return DEAD_TASK_MESSAGE;
    return submitting && isLunchBreak(at) ? LUNCH_MESSAGE : null;
}
