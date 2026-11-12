export type ConnectionScope = 'dashboard' | 'queue' | 'detail';
export type ConnectionState = {
    lastUpdated: number | null;
    failedScopes: ConnectionScope[];
    online: boolean;
};

export function initialConnectionState(online: boolean): ConnectionState {
    return { lastUpdated: null, failedScopes: [], online };
}

export function markConnectionFresh(
    state: ConnectionState,
    scope: ConnectionScope,
    at = Date.now(),
): ConnectionState {
    return {
        ...state,
        failedScopes: state.failedScopes.filter((failed) => failed !== scope),
        lastUpdated: at,
    };
}

export function markConnectionFailed(state: ConnectionState, scope: ConnectionScope): ConnectionState {
    return state.failedScopes.includes(scope)
        ? state
        : { ...state, failedScopes: [...state.failedScopes, scope] };
}

export function resetConnectionState(state: ConnectionState): ConnectionState {
    return { ...state, lastUpdated: null, failedScopes: [] };
}
