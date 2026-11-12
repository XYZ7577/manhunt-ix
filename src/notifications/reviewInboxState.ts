export function shouldApplyInbox(
    requestStartedAt: number | undefined,
    latestLocalOperationAt: number,
): boolean {
    return requestStartedAt === undefined || requestStartedAt >= latestLocalOperationAt;
}
