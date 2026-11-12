export interface EmailEnv {
    EMAIL_PROVIDER?: string;
    EMAIL_FROM?: string;
    RESEND_API_KEY?: string;
    GMAIL_CLIENT_ID?: string;
    GMAIL_CLIENT_SECRET?: string;
    GMAIL_REFRESH_TOKEN?: string;
}

export interface OutboundEmail {
    to: string;
    subject: string;
    text: string;
    html?: string;
}

export type EmailConfiguration =
    | { provider: 'resend'; apiKey: string; from: string }
    | {
          provider: 'gmail';
          from: string;
          mailbox: string;
          clientId: string;
          clientSecret: string;
          refreshToken: string;
      };

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const EMAIL_TIMEOUT_MS = 10_000;

function validMailbox(value: string): boolean {
    return (
        value.length <= 254 &&
        /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
            value,
        )
    );
}

function senderMailbox(value: string): string | null {
    if (!value || value.length > 254 || /[\r\n\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null;
    if (validMailbox(value)) return value;
    const named = value.match(/^([^<>]{1,100}) <([^<>]+)>$/);
    return named && named[1].trim() && validMailbox(named[2]) ? named[2] : null;
}

export function getEmailConfiguration(env: EmailEnv): EmailConfiguration | null {
    const provider = env.EMAIL_PROVIDER?.trim().toLowerCase() || 'resend';
    const from = env.EMAIL_FROM?.trim() || '';
    const mailbox = senderMailbox(from);
    if (!mailbox) return null;
    if (provider === 'resend') {
        const apiKey = env.RESEND_API_KEY?.trim() || '';
        return apiKey ? { provider, apiKey, from } : null;
    }
    if (provider === 'gmail') {
        const clientId = env.GMAIL_CLIENT_ID?.trim() || '';
        const clientSecret = env.GMAIL_CLIENT_SECRET?.trim() || '';
        const refreshToken = env.GMAIL_REFRESH_TOKEN?.trim() || '';
        return clientId && clientSecret && refreshToken
            ? { provider, from, mailbox, clientId, clientSecret, refreshToken }
            : null;
    }
    return null;
}

function safeHeader(value: string): boolean {
    return !/[\r\n\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
}

function base64Utf8(value: string): string {
    return toBase64(new TextEncoder().encode(value));
}

function wrapBase64(value: string): string {
    return (
        base64Utf8(value)
            .match(/.{1,76}/g)
            ?.join('\r\n') ?? ''
    );
}

function encodeHeader(value: string): string {
    return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64Utf8(value)}?=`;
}

function encodeDisplayName(value: string): string {
    return /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]+$/.test(value) ? value : `=?UTF-8?B?${base64Utf8(value)}?=`;
}

function gmailRaw(from: string, mailbox: string, message: OutboundEmail): string | null {
    if (!validMailbox(mailbox) || !validMailbox(message.to) || !safeHeader(message.subject)) return null;
    const named = from.match(/^([^<>]+) <[^<>]+>$/);
    const fromHeader = named ? `${encodeDisplayName(named[1].trim())} <${mailbox}>` : mailbox;
    const body =
        message.html === undefined
            ? [
                  'Content-Type: text/plain; charset=UTF-8',
                  'Content-Transfer-Encoding: base64',
                  '',
                  wrapBase64(message.text),
              ]
            : (() => {
                  const boundary = `manhunt-${crypto.randomUUID()}`;
                  return [
                      `Content-Type: multipart/alternative; boundary="${boundary}"`,
                      '',
                      `--${boundary}`,
                      'Content-Type: text/plain; charset=UTF-8',
                      'Content-Transfer-Encoding: base64',
                      '',
                      wrapBase64(message.text),
                      `--${boundary}`,
                      'Content-Type: text/html; charset=UTF-8',
                      'Content-Transfer-Encoding: base64',
                      '',
                      wrapBase64(message.html),
                      `--${boundary}--`,
                  ];
              })();
    const mime = [
        `From: ${fromHeader}`,
        `To: ${message.to}`,
        `Subject: ${encodeHeader(message.subject)}`,
        'MIME-Version: 1.0',
        ...body,
    ].join('\r\n');
    return toBase64(new TextEncoder().encode(mime))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

async function sendViaGmail(
    config: Extract<EmailConfiguration, { provider: 'gmail' }>,
    message: OutboundEmail,
    providerFetch: typeof fetch,
): Promise<boolean> {
    const raw = gmailRaw(config.from, config.mailbox, message);
    if (!raw) return false;
    try {
        const tokenResponse = await providerFetch(GMAIL_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                refresh_token: config.refreshToken,
                grant_type: 'refresh_token',
            }),
            signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
        });
        if (!tokenResponse.ok) return false;
        const token = (await tokenResponse.json()) as { access_token?: unknown; token_type?: unknown };
        if (
            typeof token.access_token !== 'string' ||
            !token.access_token ||
            (typeof token.token_type === 'string' && token.token_type.toLowerCase() !== 'bearer')
        )
            return false;
        const sent = await providerFetch(GMAIL_SEND_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw }),
            signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
        });
        return sent.ok;
    } catch {
        return false;
    }
}

export async function sendEmail(
    env: EmailEnv,
    message: OutboundEmail,
    providerFetch: typeof fetch = fetch,
): Promise<boolean> {
    const config = getEmailConfiguration(env);
    if (!config || !validMailbox(message.to) || !safeHeader(message.subject)) return false;
    if (config.provider === 'gmail') return sendViaGmail(config, message, providerFetch);

    try {
        const response = await providerFetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: config.from,
                to: message.to,
                subject: message.subject,
                text: message.text,
                ...(message.html === undefined ? {} : { html: message.html }),
            }),
            signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
        });
        return response.ok;
    } catch {
        return false;
    }
}
