import type { OutboundEmail } from './email';

const SITE_URL = 'https://manhunt.xyz2011a.workers.dev';
const FOOTER = `This email was sent by Manhunt IX (${SITE_URL})`;
const DEVELOPER_CONTACT = [
    'If there is any issues, do not hesitate to contact me (the developer) at:',
    'WhatsApp (+65 9767 2522)',
    'Discord (xyz7577)',
    'Email (xyz2011a@gmail.com)',
];

export function withEmailFooter(text: string): string {
    return `${text.trimEnd()}\n\n${FOOTER}`;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function verificationCodeEmail(to: string, code: string, validMinutes: number): OutboundEmail {
    const subject = `Your verification code is ${code}`;
    const details = [
        'Do not share this with anyone.',
        `This code is valid for ${validMinutes} minutes.`,
        'If you did not do this, you can ignore this email.',
    ];
    return {
        to,
        subject,
        text: `${withEmailFooter([subject, ...details].join('\n'))}\n${DEVELOPER_CONTACT.join('\n')}`,
        html: `<p>Your verification code is <strong>${escapeHtml(code)}</strong><br>\n${details.map(escapeHtml).join('<br>\n')}</p>\n<p>This email was sent by Manhunt IX (<a href="${SITE_URL}">${SITE_URL}</a>)<br>\n${DEVELOPER_CONTACT.map(escapeHtml).join('<br>\n')}</p>`,
    };
}

export function groupInvitationEmail(
    to: string,
    inviterName: string,
    groupName: string,
    joinUrl: string,
    expiresAt: string,
): OutboundEmail {
    const inviter = inviterName.trim() || 'Your group leader';
    const team = groupName.trim() || 'a Manhunt IX team';
    let safeUrl: string | null = null;
    try {
        const parsed = new URL(joinUrl);
        if (
            (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
            !parsed.username &&
            !parsed.password
        )
            safeUrl = parsed.href;
    } catch {}
    const expiryDate = new Date(expiresAt);
    const expiry = Number.isNaN(expiryDate.getTime())
        ? 'in 7 days'
        : expiryDate.toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium' });
    const subject = 'You’re invited to join a Manhunt IX team';
    const linkLine = safeUrl ? `Join ${team}: ${safeUrl}` : 'Open your invitation link to continue.';
    const details = [
        `${inviter} invited you to join ${team}.`,
        `Your team name is “${team}”.`,
        '',
        'Open the invitation link to review the team and choose whether to join. Signing in will not join you until you choose Join team.',
        linkLine,
        `This invitation expires on ${expiry}.`,
        '',
        'If you were not expecting this invitation, you can ignore this email.',
    ].join('\n');
    const htmlLink = safeUrl
        ? `<p><a href="${escapeHtml(safeUrl)}" style="display:inline-block;padding:12px 18px;border-radius:5px;background:#1769aa;color:#fff;text-decoration:none;font-weight:600">Review invitation</a></p><p style="font-size:13px;color:#57606a;overflow-wrap:anywhere">Or open this link:<br><a href="${escapeHtml(safeUrl)}">${escapeHtml(safeUrl)}</a></p>`
        : '<p>Open the invitation link you received to continue.</p>';
    return {
        to,
        subject,
        text: withEmailFooter(details),
        html: `<p><strong>${escapeHtml(inviter)}</strong> invited you to join <strong>${escapeHtml(team)}</strong>.</p><p>Your team name is “${escapeHtml(team)}”.</p><p>Open the invitation to review the team. Signing in will not join you until you choose <strong>Join team</strong>.</p>${htmlLink}<p>This invitation expires on ${escapeHtml(expiry)}.</p><p>If you were not expecting this invitation, you can ignore this email.</p><p>This email was sent by Manhunt IX (<a href="${SITE_URL}">${SITE_URL}</a>).</p>`,
    };
}
