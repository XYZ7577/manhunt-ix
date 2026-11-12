export function isBackgroundRefreshDue(
    visible: boolean,
    online: boolean,
    inFlight: boolean,
    lastStartedAt: number,
    now: number,
    intervalMs = 60_000,
): boolean {
    return visible && online && !inFlight && now - lastStartedAt >= intervalMs;
}
