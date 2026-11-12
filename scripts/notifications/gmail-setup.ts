import { createServer, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const GMAIL_REDIRECT_URI = 'http://127.0.0.1:8976/callback';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GMAIL_SCOPE = GMAIL_SEND_SCOPE;
const LOCAL_CONFIG = new URL('../../.dev.vars', import.meta.url);
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const HTML_OK =
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail setup</title><body><p>Gmail sending is set up. You can close this page and return to the terminal.</p></body></html>';
const HTML_ERROR =
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail setup</title><body><p>Gmail setup did not complete. Return to the terminal for the next step.</p></body></html>';
const waitMs = 10 * 60_000;

export interface GmailEnvFile {
    GMAIL_CLIENT_ID?: string;
    GMAIL_CLIENT_SECRET?: string;
    GMAIL_REFRESH_TOKEN?: string;
    EMAIL_FROM?: string;
}

export function gmailSenderOpts(env: GmailEnvFile, state: string, challenge: string, nonce: string): string {
    const clientId = env.GMAIL_CLIENT_ID?.trim() ?? '';
    const sender = parseMailbox(env.EMAIL_FROM ?? '');
    if (!clientId || !env.GMAIL_CLIENT_SECRET?.trim() || !sender || !state || !challenge || !nonce)
        throw new Error('Configure GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and EMAIL_FROM in .dev.vars first.');
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: GMAIL_REDIRECT_URI,
        response_type: 'code',
        scope: `openid email ${GMAIL_SCOPE}`,
        access_type: 'offline',
        prompt: 'consent',
        login_hint: sender,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function parseMailbox(value: string): string | null {
    const trimmed = value.trim();
    const match = trimmed.match(/^(?:[^<>]*<([^<>]+)>|([^<>\s]+))$/);
    const email = (match?.[1] || match?.[2] || '').trim();
    return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

export function htmlMessage(success: boolean): string {
    return success ? HTML_OK : HTML_ERROR;
}

export function localConfigPath(): URL {
    return LOCAL_CONFIG;
}

export async function saveGmailEnv(path: URL, refreshToken: string): Promise<void> {
    if (!refreshToken.trim()) throw new Error('Google did not return a refresh token.');
    const current = await readFile(path, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Error('Create .dev.vars from .dev.vars.example before running Gmail setup.');
        throw new Error('Could not safely read .dev.vars.');
    });
    const newline = current.includes('\r\n') ? '\r\n' : '\n';
    const edited = updateEnvFile(current, 'EMAIL_PROVIDER', 'gmail', newline);
    const output = updateEnvFile(edited, 'GMAIL_REFRESH_TOKEN', refreshToken.trim(), newline);
    await writeFile(path, output, { encoding: 'utf8', mode: 0o600 });
    try {
        await chmod(path, 0o600);
    } catch {}
}

export function updateEnvFile(
    source: string,
    key: string,
    value: string,
    newline = source.includes('\r\n') ? '\r\n' : '\n',
): string {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*$`, 'm');
    if (pattern.test(source)) return source.replace(pattern, line);
    const suffix = source.length && !source.endsWith('\n') ? newline : '';
    return `${source}${suffix}${line}${newline}`;
}

export function pkceVerifier(bytes: Uint8Array = new Uint8Array(randomBytes(48))): string {
    return Buffer.from(bytes).toString('base64url');
}
export function pkceChallenge(verifier: string): string {
    return Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url');
}
export function randomState(bytes: Uint8Array = new Uint8Array(randomBytes(32))): string {
    return Buffer.from(bytes).toString('base64url');
}

export async function validateGoogleIdToken(
    token: string,
    clientId: string,
    sender: string,
    expectedNonce: string,
): Promise<void> {
    const expectedSender = parseMailbox(sender)?.toLowerCase();
    if (!token || !clientId || !expectedSender || !expectedNonce)
        throw new Error('Google identity confirmation failed. Retry setup.');
    let claims;
    try {
        ({ payload: claims } = await jwtVerify(token, GOOGLE_KEYS, {
            issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
            audience: clientId,
        }));
    } catch {
        throw new Error('Google identity confirmation failed. Retry setup.');
    }
    validateIdClaims(claims, expectedSender, expectedNonce);
}

export function validateIdClaims(
    claims: Record<string, unknown>,
    expectedSender: string,
    expectedNonce: string,
): void {
    if (
        claims.nonce !== expectedNonce ||
        claims.email_verified !== true ||
        typeof claims.email !== 'string' ||
        claims.email.trim().toLowerCase() !== expectedSender.toLowerCase()
    ) {
        throw new Error('Choose the same Google account as EMAIL_FROM, then retry setup.');
    }
}

export function validateTokenResponse(token: Record<string, unknown>): {
    refreshToken: string;
    idToken: string;
    grantedScopes: string[];
} {
    const refreshToken = typeof token.refresh_token === 'string' ? token.refresh_token : '';
    const idToken = typeof token.id_token === 'string' ? token.id_token : '';
    const scopesGranted = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [];
    if (!refreshToken || !idToken || !scopesGranted.includes(GMAIL_SCOPE))
        throw new Error(
            'Google did not grant persistent Gmail sending permission. Retry and accept all requested access.',
        );
    return { refreshToken, idToken, grantedScopes: scopesGranted };
}

export async function exchangeAuthCode(
    code: string,
    env: GmailEnvFile,
    verifier: string,
    providerFetch: typeof fetch = fetch,
): Promise<{ refreshToken: string; idToken: string; grantedScopes: string[] }> {
    const clientId = env.GMAIL_CLIENT_ID?.trim() ?? '';
    const clientSecret = env.GMAIL_CLIENT_SECRET?.trim() ?? '';
    if (!code || !clientId || !clientSecret)
        throw new Error('Configure the sender OAuth client in .dev.vars first.');
    let response: Response;
    try {
        response = await providerFetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: GMAIL_REDIRECT_URI,
                grant_type: 'authorization_code',
                code_verifier: verifier,
            }),
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        throw new Error('Could not finish Gmail authorization. Check your internet connection and retry.');
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
            'Google could not finish Gmail authorization. Check the OAuth client and redirect URI, then retry.',
        );
    }
    const token = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!token || typeof token !== 'object')
        throw new Error('Google returned an invalid authorization response. Retry setup.');
    return validateTokenResponse(token as Record<string, unknown>);
}

type PendingCallback = { code: string; error?: string; state: string };

export function collectCallback(url: URL, expectedState: string): PendingCallback | null {
    if (url.pathname !== '/callback') return null;
    const state = url.searchParams.get('state') ?? '';
    if (!state || state !== expectedState) return null;
    const error = url.searchParams.get('error') ?? '';
    if (error) return { code: '', error, state };
    const code = url.searchParams.get('code') ?? '';
    return code ? { code, state } : { code: '', error: 'authorization_failed', state };
}

function sendHtml(response: ServerResponse, body: string, status = 200): void {
    if (response.headersSent) return;
    response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
}

export interface OAuthCallback {
    code: string;
    complete(success: boolean): void;
}

export function waitForCallback(
    serverFactory: typeof createServer,
    expectedState: string,
    timeoutMs = waitMs,
    onListening?: () => void,
    onStartupError?: (error: Error) => void,
): Promise<OAuthCallback> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let gotCallback = false;
        let responsePending: ServerResponse | null = null;
        const closeServer = () => {
            clearTimeout(timeout);
            server.close();
        };
        const finishError = (error: Error) => {
            if (settled) return;
            settled = true;
            if (responsePending) sendHtml(responsePending, HTML_ERROR);
            responsePending = null;
            closeServer();
            reject(error);
        };
        const server: Server = serverFactory((request, response) => {
            const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
            if (request.method !== 'GET' || requestUrl.pathname !== '/callback') {
                sendHtml(response, HTML_ERROR, 404);
                return;
            }
            const callback = collectCallback(requestUrl, expectedState);
            if (!callback) {
                sendHtml(response, HTML_ERROR, 400);
                return;
            }
            if (callback.error) {
                sendHtml(response, HTML_ERROR);
                finishError(
                    new Error('Google authorization was cancelled. Restart Gmail setup to try again.'),
                );
                return;
            }
            if (settled || gotCallback) {
                sendHtml(response, HTML_ERROR, 409);
                return;
            }
            gotCallback = true;
            responsePending = response;
            clearTimeout(timeout);
            resolve({
                code: callback.code,
                complete(success: boolean) {
                    if (settled || !responsePending) return;
                    settled = true;
                    sendHtml(responsePending, success ? HTML_OK : HTML_ERROR);
                    responsePending = null;
                    closeServer();
                },
            });
        });
        server.on('error', (error) => {
            onStartupError?.(error);
            finishError(error);
        });
        const timeout = setTimeout(
            () => finishError(new Error('Gmail setup timed out. Run npm run gmail:setup to try again.')),
            timeoutMs,
        );
        server.listen(8976, '127.0.0.1', () => onListening?.());
    });
}

export async function runGmailSetup(): Promise<void> {
    let local: Record<string, string | undefined>;
    try {
        local = parseEnv(await readFile(LOCAL_CONFIG, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Error(
                'Create .dev.vars from .dev.vars.example, then set up a Google OAuth client first.',
            );
        throw new Error('Could not safely read .dev.vars.');
    }
    const sender = parseMailbox(local.EMAIL_FROM ?? '');
    if (!local.GMAIL_CLIENT_ID?.trim() || !local.GMAIL_CLIENT_SECRET?.trim() || !sender) {
        throw new Error(
            'Fill EMAIL_FROM, GMAIL_CLIENT_ID, and GMAIL_CLIENT_SECRET in .dev.vars before continuing.',
        );
    }
    const state = randomState();
    const verifier = pkceVerifier();
    const challenge = pkceChallenge(verifier);
    const server = createServer;
    const nonce = randomState();
    let ready!: () => void;
    let failToStart!: (error: Error) => void;
    const listening = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failToStart = reject;
    });
    const callbackWait = waitForCallback(server, state, waitMs, ready, failToStart);
    void callbackWait.catch(() => {});
    try {
        await listening;
    } catch {
        throw new Error(
            'Could not start the Gmail setup listener at http://127.0.0.1:8976. Close anything using that port and retry.',
        );
    }
    console.log(
        'Open this Google authorization URL in your browser and approve Gmail sending for the configured sender address.',
    );
    console.log(gmailSenderOpts(local, state, challenge, nonce));
    const callback = await callbackWait;
    try {
        const token = await exchangeAuthCode(callback.code, local, verifier);
        await validateGoogleIdToken(token.idToken, local.GMAIL_CLIENT_ID!, sender, nonce);
        await saveGmailEnv(LOCAL_CONFIG, token.refreshToken);
        callback.complete(true);
        console.log('Gmail sender is configured in the private .dev.vars file.');
    } catch (error) {
        callback.complete(false);
        throw error;
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length && args[0] !== '--help') throw new Error('Usage: npm run gmail:setup [-- --help]');
    if (args[0] === '--help') {
        console.log(
            'Usage: npm run gmail:setup\nStarts a local Google OAuth flow and stores Gmail sending credentials in .dev.vars.',
        );
        return;
    }
    await runGmailSetup();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : 'Gmail setup failed.');
        process.exitCode = 1;
    });
}
