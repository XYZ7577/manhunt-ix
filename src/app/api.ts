import { fetchJson } from './requestJson';

export class SessionExpiredError extends Error {}
export class ApiError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
        readonly body?: Record<string, unknown>,
    ) {
        super(message);
    }
}
export class UploadRequestError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
        readonly retryable: boolean,
    ) {
        super(message);
    }
}
export class UploadCancelledError extends Error {}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const { response, body } = await fetchJson(path, { credentials: 'same-origin', ...init });
    if (response.status === 401) {
        const detail = String(body.error || body.message || 'Invalid email, username or password.');
        if (path === '/api/login' || path === '/api/register') throw new Error(detail);
        throw new SessionExpiredError('Your session has ended. Please sign in again.');
    }
    if (!response.ok)
        throw new ApiError(
            String(
                body.error ||
                    body.message ||
                    (response.status === 503
                        ? 'The server is temporarily unavailable. Wait a moment, then try again.'
                        : `Request failed (${response.status})`),
            ),
            response.status,
            body,
        );
    return body as T;
}

export const RETRY_DELAYS = [500, 1000, 2000];
export function retryable(error: unknown) {
    if (error instanceof UploadRequestError) return error.retryable;
    if (error instanceof ApiError)
        return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
    return error instanceof TypeError;
}
export function completionInProgress(error: unknown) {
    return (
        error instanceof ApiError &&
        error.statusCode === 409 &&
        /upload completion is already in progress|upload finalization is still in progress/i.test(
            error.message,
        )
    );
}
export function retryDelay(attempt: number) {
    return new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAYS[attempt]));
}
