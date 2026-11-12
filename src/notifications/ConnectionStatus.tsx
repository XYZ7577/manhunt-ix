import { useCallback, useEffect, useState } from 'react';
import './connectionStatus.css';
import {
    initialConnectionState,
    markConnectionFailed,
    markConnectionFresh,
    resetConnectionState,
    type ConnectionScope,
    type ConnectionState,
} from './connectionStatusState';
export type { ConnectionState } from './connectionStatusState';

export function useConnectionStatus() {
    const [state, setState] = useState<ConnectionState>(() =>
        initialConnectionState(typeof navigator === 'undefined' || navigator.onLine !== false),
    );
    const markFresh = useCallback(
        (scope: ConnectionScope) => setState((previous) => markConnectionFresh(previous, scope)),
        [],
    );
    const markFailed = useCallback(
        (scope: ConnectionScope) => setState((previous) => markConnectionFailed(previous, scope)),
        [],
    );
    const reset = useCallback(() => setState(resetConnectionState), []);
    useEffect(() => {
        const update = () => setState((previous) => ({ ...previous, online: navigator.onLine !== false }));
        window.addEventListener('online', update);
        window.addEventListener('offline', update);
        return () => {
            window.removeEventListener('online', update);
            window.removeEventListener('offline', update);
        };
    }, []);
    return { ...state, markFresh, markFailed, reset };
}

export function ConnectionStatus({
    state,
    refreshing = false,
    onRetry,
}: {
    state: ConnectionState;
    refreshing?: boolean;
    onRetry: () => void;
}) {
    const stale = state.failedScopes.length > 0 || !state.online;
    const scopeNames = state.failedScopes.map(
        (scope) =>
            ({ dashboard: 'the overview', queue: 'the submissions list', detail: 'the selected submission' })[
                scope
            ],
    );
    const message = !state.online
        ? 'You’re offline. Displayed progress may be out of date.'
        : scopeNames.length > 0
          ? `Could not refresh ${scopeNames.join(', ')}. Displayed information may be out of date.`
          : 'Connected.';
    return (
        <div className={`connection-status${stale ? ' connection-stale' : ''}`}>
            <p role="status">
                {message}{' '}
                {state.lastUpdated !== null && (
                    <span>
                        Latest successful refresh{' '}
                        <time dateTime={new Date(state.lastUpdated).toISOString()}>
                            {new Date(state.lastUpdated).toLocaleTimeString('en-SG', {
                                timeZone: 'Asia/Singapore',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false,
                            })}{' '}
                            SGT
                        </time>
                        .
                    </span>
                )}
            </p>
            {stale && (
                <button type="button" className="text-button" disabled={refreshing} onClick={onRetry}>
                    {refreshing ? 'Retrying…' : 'Retry connection'}
                </button>
            )}
        </div>
    );
}
