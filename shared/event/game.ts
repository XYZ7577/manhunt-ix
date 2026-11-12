export type GamePlayerStatus = 'survivor' | 'hunter';
export interface GamePlayerState {
    status: GamePlayerStatus;
    dead: boolean;
    immunityUntil: string | null;
}
export interface GameEventState {
    configured: boolean;
    claimed: boolean;
    startsAt: string;
    endsAt: string;
    pictureUrl: string | null;
    submissions: number;
    attemptsRemaining: number;
    canGuess: boolean;
    winner: boolean;
    reward: 'revive' | 'immunity' | null;
    immunityUntil: string | null;
}
export interface GameDashboard {
    serverNow: string;
    player: GamePlayerState;
    event: GameEventState;
    canManage?: boolean;
    canManagePlayers?: boolean;
    hasTeam?: boolean;
    players?: Array<{
        id: string;
        displayName: string;
        username: string;
        groupName: string;
        status: GamePlayerStatus;
        dead: boolean;
        immunityUntil: string | null;
    }>;
    target?: { latitude: number; longitude: number };
}
