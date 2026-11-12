const regularMessages = ['boop', 'beep', 'hi', 'hiii'] as const;
const playfulMessages = ['stop pressing me :(', 'that tickles!'] as const;
const burstWindowMs = 2_000;

export interface PushTestBurstState {
    consecutiveClicks: number;
    lastClickAt: number | null;
}

export function nextTestMsg(
    state: PushTestBurstState,
    now: number,
    random: () => number = Math.random,
): { message: string; state: PushTestBurstState } {
    const continued =
        state.lastClickAt !== null && now >= state.lastClickAt && now - state.lastClickAt < burstWindowMs;
    const consecutiveClicks = continued ? state.consecutiveClicks + 1 : 1;
    const messages: readonly string[] = consecutiveClicks >= 3 ? playfulMessages : regularMessages;
    const choice = Math.max(0, Math.min(messages.length - 1, Math.floor(random() * messages.length)));
    return { message: messages[choice], state: { consecutiveClicks, lastClickAt: now } };
}
