import { useCallback, useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { requestJson } from '../app/requestJson';
import type { GroupMembersResponse } from '../../shared/groups/members';
import { ActionButton } from '../ui/ActionButton';
import './groupMembers.css';

type Props = { groupId: string; refreshKey?: string; onChanged?: () => void | Promise<void> };

async function reqGrpMemb<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    return requestJson<T>(
        path,
        {
            method,
            credentials: 'same-origin',
            headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data),
        },
        {
            fallbackMessage: (response) => `Request failed (${response.status})`,
            messageFields: ['error', 'message'],
        },
    );
}

function dateLabel(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? value
        : `${date.toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' })} SGT`;
}

type EmailDelivery = 'not_sent' | 'sending' | 'sent' | 'failed' | 'not_available' | 'rate_limited';

function emailDeliveryLabel(status: EmailDelivery | undefined) {
    switch (status) {
        case 'not_sent':
            return 'Invitation email has not been sent yet.';
        case 'sending':
            return 'Sending invitation email…';
        case 'sent':
            return 'Invitation email sent.';
        case 'failed':
            return 'Email could not be sent. Share the link or QR code instead.';
        case 'not_available':
            return 'Invitation email is temporarily unavailable. Share the link or QR code instead.';
        case 'rate_limited':
            return 'The email send limit was reached. Share the link or QR code instead.';
        default:
            return 'Email delivery status is unavailable. You can share the link or QR code below.';
    }
}

function emailDeliveryNotice(status: EmailDelivery | undefined, action: 'created' | 'resent') {
    switch (status) {
        case 'not_sent':
            return 'Invitation created. The email has not been sent yet. Share the link or QR code below.';
        case 'sending':
            return 'Invitation created. The email is still sending; share the link or QR code below if needed.';
        case 'sent':
            return action === 'created'
                ? 'Invitation created and email sent.'
                : 'A new link was created and emailed. Older links are disabled.';
        case 'failed':
            return 'Invitation link is ready, but the email could not be sent. Share the link or QR code below.';
        case 'not_available':
            return 'Invitation link is ready, but email delivery is temporarily unavailable. Share the link or QR code below.';
        case 'rate_limited':
            return 'Invitation link is ready, but the email send limit was reached. Share the link or QR code below.';
        default:
            return action === 'created'
                ? 'Invitation created. Share the link or QR code below.'
                : 'A new invitation link is ready. Older links have been disabled.';
    }
}

function InvitationShare({
    invitationId,
    joinLinkAvailable,
    emailDelivery,
    token,
    onGenerate,
    busy,
    creating,
}: {
    invitationId: string;
    joinLinkAvailable: boolean;
    emailDelivery?: EmailDelivery;
    token?: string;
    onGenerate: () => void;
    busy: boolean;
    creating: boolean;
}) {
    const [qr, setQr] = useState('');
    const [copied, setCopied] = useState(false);
    const [shareError, setShareError] = useState('');
    const joinUrl = token
        ? `${window.location.origin}/join?invite=${encodeURIComponent(invitationId)}#token=${encodeURIComponent(token)}`
        : '';
    useEffect(() => {
        let active = true;
        if (!joinUrl) {
            setQr('');
            setShareError('');
            return () => {
                active = false;
            };
        }
        void QRCode.toDataURL(joinUrl, { width: 192, margin: 1, errorCorrectionLevel: 'Q' })
            .then((value) => {
                if (active) {
                    setQr(value);
                    setShareError('');
                }
            })
            .catch(() => {
                if (active) {
                    setQr('');
                    setShareError(
                        'The QR code could not be created. The invitation link below is still available to copy.',
                    );
                }
            });
        return () => {
            active = false;
        };
    }, [joinUrl]);
    async function copy() {
        try {
            await navigator.clipboard.writeText(joinUrl);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2400);
        } catch {
            setCopied(false);
            setShareError('Could not copy the invitation link. Select the link above and copy it manually.');
        }
    }
    return (
        <div className="group-invitation-share">
            <p>{emailDeliveryLabel(emailDelivery)}</p>
            {joinUrl ? (
                <>
                    <p>
                        The player can open the link to review the team, then sign in with their usual method
                        and choose whether to join. This link expires with the invitation.
                    </p>
                    {qr && (
                        <img
                            src={qr}
                            alt={`QR code to join invitation ${invitationId}`}
                            width="192"
                            height="192"
                        />
                    )}
                    {shareError && (
                        <p className="alert error" role="status">
                            {shareError}
                        </p>
                    )}
                    <label className="group-invitation-link-label" htmlFor={`invite-link-${invitationId}`}>
                        Player invitation link
                    </label>
                    <input
                        id={`invite-link-${invitationId}`}
                        type="text"
                        readOnly
                        value={joinUrl}
                        onFocus={(event) => event.currentTarget.select()}
                    />
                    <button className="button secondary" type="button" onClick={() => void copy()}>
                        {copied ? 'Copied' : 'Copy invitation link'}
                    </button>
                </>
            ) : (
                <>
                    <p>
                        {joinLinkAvailable
                            ? 'No link is available to share here. Resend the invitation email and create a new private link; this will invalidate the old link.'
                            : 'Create a private invitation link, email it to the player, and keep a link and QR code available to share.'}
                    </p>
                    <ActionButton
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        unavailableReason={
                            creating
                                ? 'The invitation link is being created.'
                                : busy
                                  ? 'Finish the current group change before creating another link.'
                                  : undefined
                        }
                        onClick={onGenerate}
                    >
                        {creating
                            ? 'Sending email…'
                            : joinLinkAvailable
                              ? 'Resend email and replace link'
                              : 'Create link and email invitation'}
                    </ActionButton>
                </>
            )}
        </div>
    );
}

export function GroupMembers({ groupId, refreshKey, onChanged }: Props) {
    const [data, setData] = useState<GroupMembersResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [email, setEmail] = useState('');
    const [inviteError, setInviteError] = useState('');
    const [leaderCandidate, setLeaderCandidate] = useState('');
    const [confirmLeader, setConfirmLeader] = useState('');
    const [activeInvLink, setActiveInvLink] = useState<Record<string, string>>({});
    const [showDisbandConfirm, setShowDisbandConfirm] = useState(false);
    const [disbandAcknowledged, setDisbandAcknowledged] = useState(false);
    const [disbandCode, setDisbandCode] = useState('');
    const [codeexpireat, setCodeexpireat] = useState('');
    const [disbandCodeEmail, setDisbandCodeEmail] = useState('');

    const membersPath = `/api/groups/${encodeURIComponent(groupId)}/members`;
    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const result = await reqGrpMemb<GroupMembersResponse>(membersPath);
            setData(result);
            setLeaderCandidate('');
            setConfirmLeader('');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not load group members.');
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [membersPath]);

    useEffect(() => {
        void load();
    }, [load, refreshKey]);

    async function mutate(
        label: string,
        action: () => Promise<unknown>,
        message: string | ((result: unknown) => string),
    ): Promise<boolean> {
        setBusy(label);
        setError('');
        if (label === 'invite') setInviteError('');
        setNotice('');
        try {
            const result = await action();
            await load();
            await onChanged?.();
            setNotice(typeof message === 'function' ? message(result) : message);
            return true;
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'The change could not be saved.';
            setError(message);
            if (label === 'invite') setInviteError(message);
            return false;
        } finally {
            setBusy('');
        }
    }

    async function invite(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const normalized = email.trim();
        if (!normalized) {
            setInviteError('Enter the player’s email address first.');
            document.getElementById('group-member-email')?.focus();
            return;
        }
        const emailKey = normalized.toLowerCase();
        const alreadyInGroup = data?.members.some(
            (member) => (member.email || '').trim().toLowerCase() === emailKey,
        );
        const alreadyInvited = data?.invitations.some(
            (invitation) => invitation.email.trim().toLowerCase() === emailKey,
        );
        if (alreadyInGroup || alreadyInvited) {
            setInviteError(
                alreadyInGroup
                    ? 'This email already belongs to a player in this group.'
                    : 'There is already a pending invitation for this email.',
            );
            document.getElementById('group-member-email')?.focus();
            return;
        }
        setInviteError('');
        let createdId = '';
        let createdPath = '';
        const success = await mutate(
            'invite',
            async () => {
                const result = await reqGrpMemb<{
                    invitation: { id: string };
                    joinPath?: string;
                    emailDelivery?: EmailDelivery;
                }>(`${membersPath}/invitations`, 'POST', { email: normalized });
                createdId = result.invitation.id;
                createdPath = result.joinPath ?? '';
                return result;
            },
            (result) =>
                emailDeliveryNotice((result as { emailDelivery?: EmailDelivery }).emailDelivery, 'created'),
        );
        if (success) {
            setEmail('');
            if (createdPath) {
                const match = createdPath.match(/#token=([A-Za-z0-9_-]+)/);
                if (match) setActiveInvLink((links) => ({ ...links, [createdId]: match[1] }));
            }
        }
    }

    async function makeInvLink(invitationId: string) {
        let joinPath = '';
        if (
            !(await mutate(
                `link:${invitationId}`,
                async () => {
                    const result = await reqGrpMemb<{
                        joinPath: string;
                        emailDelivery?: EmailDelivery;
                    }>(`${membersPath}/invitations/${encodeURIComponent(invitationId)}/link`, 'POST', {});
                    joinPath = result.joinPath;
                    return result;
                },
                (result) =>
                    emailDeliveryNotice(
                        (result as { emailDelivery?: EmailDelivery }).emailDelivery,
                        'resent',
                    ),
            ))
        )
            return;
        const match = joinPath.match(/#token=([A-Za-z0-9_-]+)/);
        if (match) setActiveInvLink((links) => ({ ...links, [invitationId]: match[1] }));
    }

    function revoke(invitationId: string) {
        void mutate(
            `revoke:${invitationId}`,
            () => reqGrpMemb(`${membersPath}/invitations/${encodeURIComponent(invitationId)}`, 'DELETE'),
            'Invitation cancelled.',
        );
    }

    function transferLeadership(accountId: string) {
        if (!data?.leaderAccountId) {
            setError('No current group leader is recorded. Refresh the group or ask an organiser for help.');
            return;
        }
        void mutate(
            'leader',
            () =>
                reqGrpMemb(`${membersPath}/leader`, 'POST', {
                    accountId,
                    previousLeaderAccountId: data.leaderAccountId,
                }),
            'Group leadership transferred.',
        );
    }

    async function disband(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!disbandAcknowledged || !/^\d{6}$/.test(disbandCode)) return;
        setBusy('disband');
        setError('');
        setNotice('');
        try {
            await reqGrpMemb(`${membersPath}/disband`, 'POST', { code: disbandCode });
            setData((current) =>
                current
                    ? { ...current, disbanded: true, canManageMembers: false, members: [], invitations: [] }
                    : current,
            );
            setShowDisbandConfirm(false);
            setDisbandCode('');
            setDisbandAcknowledged(false);
            await onChanged?.();
            setNotice(
                'The team has been disbanded. All players have left the team; its submission history is preserved.',
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The team could not be disbanded.');
        } finally {
            setBusy('');
        }
    }

    async function sendDisbandCode() {
        setBusy('disband-code');
        setError('');
        setNotice('');
        try {
            const result = await reqGrpMemb<{ sent: true; expiresAt: string; email: string }>(
                `${membersPath}/disband/code`,
                'POST',
                {},
            );
            setCodeexpireat(result.expiresAt);
            setDisbandCodeEmail(result.email);
            setDisbandCode('');
            setDisbandAcknowledged(false);
            setShowDisbandConfirm(true);
            setNotice(`A verification code was sent to ${result.email}.`);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not send the verification code.');
        } finally {
            setBusy('');
        }
    }

    const full = !!data && data.members.length + data.invitations.length >= data.maxMembers;

    return (
        <section className="group-members-panel" aria-labelledby="group-members-heading">
            <header className="group-members-heading">
                <div>
                    <h2 id="group-members-heading">Group members</h2>
                    {data && (
                        <p>
                            {data.group.name} · {data.members.length + data.invitations.length} of{' '}
                            {data.maxMembers} player accounts
                        </p>
                    )}
                </div>
                <ActionButton
                    className="button quiet"
                    type="button"
                    onClick={() => void load()}
                    disabled={loading || !!busy}
                    unavailableReason={
                        loading
                            ? 'Group members are already being refreshed.'
                            : busy
                              ? 'Finish the current group change before refreshing.'
                              : undefined
                    }
                >
                    Refresh
                </ActionButton>
            </header>

            {error && (
                <p className="alert error" role="alert">
                    {error}
                </p>
            )}
            {notice && (
                <p className="alert success" role="status">
                    {notice}
                </p>
            )}
            {loading && (
                <p className="group-members-muted" role="status">
                    Loading group members…
                </p>
            )}

            {!loading && data && (
                <>
                    {data.disbanded && (
                        <p className="group-disbanded-note" role="status">
                            This team has been disbanded. Its submission history is preserved.
                        </p>
                    )}
                    <ul className="group-members-list">
                        {data.members.map((member) => (
                            <li key={member.accountId}>
                                <div className="group-member-identity">
                                    <strong>
                                        {member.displayName || 'Player'}
                                        {member.accountId === data.currentAccountId ? ' (you)' : ''}
                                    </strong>
                                    {(member.email || member.username) && (
                                        <span>{member.email || member.username}</span>
                                    )}
                                    {member.phone !== undefined && (
                                        <span>Phone: {member.phone || 'Not provided'}</span>
                                    )}
                                </div>
                                <div className="group-member-actions">
                                    <span
                                        className={`group-member-role ${member.role === 'leader' ? 'is-leader' : ''}`}
                                    >
                                        {member.role === 'leader' ? 'Leader' : 'Member'}
                                    </span>
                                    {data.canManageMembers && member.role !== 'leader' && (
                                        <ActionButton
                                            type="button"
                                            className="button quiet"
                                            disabled={!!busy}
                                            unavailableReason={
                                                busy
                                                    ? 'Finish the current group change before changing leadership.'
                                                    : undefined
                                            }
                                            onClick={() => {
                                                setLeaderCandidate(member.accountId);
                                                setConfirmLeader('');
                                            }}
                                        >
                                            Make leader
                                        </ActionButton>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>

                    {data.members.length === 0 && (
                        <p className="group-members-muted">
                            No player accounts are currently attached to this group.
                        </p>
                    )}

                    {data.canManageMembers && (
                        <div className="group-members-management">
                            <section
                                className="group-members-subsection"
                                aria-labelledby="invite-player-heading"
                            >
                                <h3 id="invite-player-heading">Invite a player</h3>
                                <p className="group-members-muted">
                                    Add the player’s email and we’ll send them a private invitation link. A QR
                                    code and copyable link are also available below if the email cannot be
                                    delivered.
                                </p>
                                <p className="group-members-muted">
                                    Only enter an email address if the player agreed to receive an invitation.
                                    We use it to send the group invitation; see the{' '}
                                    <a href="/privacy">Privacy Policy</a>.
                                </p>
                                <form
                                    className="group-members-invite-form"
                                    onSubmit={(event) => void invite(event)}
                                >
                                    <label htmlFor="group-member-email">Player email</label>
                                    <div>
                                        <input
                                            id="group-member-email"
                                            type="email"
                                            autoComplete="email"
                                            required
                                            maxLength={254}
                                            value={email}
                                            aria-invalid={!!inviteError || undefined}
                                            aria-describedby={
                                                inviteError ? 'group-member-email-error' : undefined
                                            }
                                            onChange={(event) => {
                                                setEmail(event.target.value);
                                                setInviteError('');
                                            }}
                                            disabled={!!busy || full}
                                        />
                                        <ActionButton
                                            className="button primary"
                                            type="submit"
                                            disabled={!!busy || full || !email.trim()}
                                            unavailableReason={
                                                busy
                                                    ? 'The current group change is still in progress.'
                                                    : full
                                                      ? `This group has reached its ${data.maxMembers}-account limit.`
                                                      : !email.trim()
                                                        ? 'Enter the player’s email address first.'
                                                        : undefined
                                            }
                                        >
                                            {busy === 'invite' ? 'Sending invitation…' : 'Send invitation'}
                                        </ActionButton>
                                    </div>
                                    {full && (
                                        <small>
                                            This group has reached its {data.maxMembers}-account limit.
                                        </small>
                                    )}
                                    {inviteError && (
                                        <p id="group-member-email-error" className="alert error" role="alert">
                                            {inviteError}
                                        </p>
                                    )}
                                </form>
                            </section>

                            <section
                                className="group-members-subsection"
                                aria-labelledby="pending-invites-heading"
                            >
                                <h3 id="pending-invites-heading">Pending invitations</h3>
                                {data.invitations.length === 0 ? (
                                    <p className="group-members-muted">No pending invitations.</p>
                                ) : (
                                    <ul className="group-invitations-list">
                                        {data.invitations.map((invitation) => (
                                            <li key={invitation.id}>
                                                <div className="group-invitation-row-content">
                                                    <strong>{invitation.email}</strong>
                                                    <small>Expires {dateLabel(invitation.expiresAt)}</small>
                                                    <InvitationShare
                                                        invitationId={invitation.id}
                                                        joinLinkAvailable={invitation.joinLinkAvailable}
                                                        emailDelivery={
                                                            (
                                                                invitation as typeof invitation & {
                                                                    emailDelivery?: EmailDelivery;
                                                                }
                                                            ).emailDelivery
                                                        }
                                                        token={activeInvLink[invitation.id]}
                                                        onGenerate={() => void makeInvLink(invitation.id)}
                                                        busy={!!busy}
                                                        creating={busy === `link:${invitation.id}`}
                                                    />
                                                </div>
                                                <ActionButton
                                                    className="button quiet"
                                                    type="button"
                                                    disabled={!!busy}
                                                    unavailableReason={
                                                        busy
                                                            ? 'Finish the current group change before cancelling an invitation.'
                                                            : undefined
                                                    }
                                                    onClick={() => {
                                                        setActiveInvLink((links) => {
                                                            const next = { ...links };
                                                            delete next[invitation.id];
                                                            return next;
                                                        });
                                                        revoke(invitation.id);
                                                    }}
                                                >
                                                    {busy === `revoke:${invitation.id}`
                                                        ? 'Cancelling…'
                                                        : 'Cancel'}
                                                </ActionButton>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>

                            {leaderCandidate && (
                                <section
                                    className="group-leader-confirm"
                                    aria-labelledby="leader-confirm-heading"
                                >
                                    <h3 id="leader-confirm-heading">Confirm leadership transfer</h3>
                                    <p>
                                        {(() => {
                                            const member = data.members.find(
                                                (item) => item.accountId === leaderCandidate,
                                            );
                                            return (
                                                member?.email ||
                                                member?.username ||
                                                member?.displayName ||
                                                'This player'
                                            );
                                        })()}{' '}
                                        will become the group leader and can manage invitations and
                                        leadership.{' '}
                                        {data.members.some(
                                            (member) => member.accountId === data.currentAccountId,
                                        )
                                            ? 'You will remain a group member.'
                                            : 'The current leader will remain a group member.'}
                                    </p>
                                    {confirmLeader === leaderCandidate ? (
                                        <div className="group-leader-confirm-actions">
                                            <ActionButton
                                                className="button primary"
                                                type="button"
                                                disabled={!!busy}
                                                unavailableReason={
                                                    busy
                                                        ? 'The current group change is still in progress.'
                                                        : undefined
                                                }
                                                onClick={() => transferLeadership(leaderCandidate)}
                                            >
                                                {busy === 'leader' ? 'Transferring…' : 'Confirm transfer'}
                                            </ActionButton>
                                            <ActionButton
                                                className="button quiet"
                                                type="button"
                                                disabled={!!busy}
                                                unavailableReason={
                                                    busy
                                                        ? 'The current group change is still in progress.'
                                                        : undefined
                                                }
                                                onClick={() => {
                                                    setConfirmLeader('');
                                                    setLeaderCandidate('');
                                                }}
                                            >
                                                Keep current leader
                                            </ActionButton>
                                        </div>
                                    ) : (
                                        <div className="group-leader-confirm-actions">
                                            <ActionButton
                                                className="button secondary"
                                                type="button"
                                                disabled={!!busy}
                                                unavailableReason={
                                                    busy
                                                        ? 'The current group change is still in progress.'
                                                        : undefined
                                                }
                                                onClick={() => setConfirmLeader(leaderCandidate)}
                                            >
                                                Continue
                                            </ActionButton>
                                            <ActionButton
                                                className="button quiet"
                                                type="button"
                                                disabled={!!busy}
                                                unavailableReason={
                                                    busy
                                                        ? 'The current group change is still in progress.'
                                                        : undefined
                                                }
                                                onClick={() => setLeaderCandidate('')}
                                            >
                                                Cancel
                                            </ActionButton>
                                        </div>
                                    )}
                                </section>
                            )}

                            {data.currentAccountId === data.leaderAccountId && !data.disbanded && (
                                <section
                                    className="group-disband-section"
                                    aria-labelledby="group-disband-heading"
                                >
                                    <h3 id="group-disband-heading">Disband this team</h3>
                                    <p>
                                        This removes every player from the team, cancels pending invitations,
                                        and stops active uploads. Past submissions and evidence stay in the
                                        event history. This cannot be undone.
                                    </p>
                                    {!data.emailVerificationAvailable && (
                                        <p className="group-members-muted">
                                            {data.disbandVerificationEmail ? (
                                                'Email verification is temporarily unavailable.'
                                            ) : (
                                                <>
                                                    Add and verify an email address in{' '}
                                                    <a href="/settings">Settings</a> to disband your team.
                                                </>
                                            )}
                                        </p>
                                    )}
                                    {!showDisbandConfirm ? (
                                        <ActionButton
                                            className="button danger"
                                            type="button"
                                            disabled={!!busy || !data.emailVerificationAvailable}
                                            unavailableReason={
                                                busy
                                                    ? 'Finish the current group change first.'
                                                    : !data.emailVerificationAvailable
                                                      ? data.disbandVerificationEmail
                                                          ? 'Email verification is temporarily unavailable. Try again later.'
                                                          : 'Verify an email address in Settings first.'
                                                      : undefined
                                            }
                                            onClick={() => void sendDisbandCode()}
                                        >
                                            {busy === 'disband-code' ? 'Sending code…' : 'Disband team'}
                                        </ActionButton>
                                    ) : (
                                        <form
                                            className="group-disband-confirm"
                                            onSubmit={(event) => void disband(event)}
                                        >
                                            <p className="group-members-muted">
                                                Enter the 6-digit code sent to{' '}
                                                {disbandCodeEmail || data.disbandVerificationEmail}. It
                                                expires{' '}
                                                {codeexpireat ? dateLabel(codeexpireat) : 'in 10 minutes'}.
                                                Wait 60 seconds before requesting another code.
                                            </p>
                                            <label className="group-disband-ack">
                                                <input
                                                    type="checkbox"
                                                    checked={disbandAcknowledged}
                                                    onChange={(event) =>
                                                        setDisbandAcknowledged(event.target.checked)
                                                    }
                                                    disabled={!!busy}
                                                />{' '}
                                                I understand that all players will leave and this action
                                                cannot be undone.
                                            </label>
                                            <label htmlFor="group-disband-code">
                                                6-digit email verification code
                                            </label>
                                            <input
                                                id="group-disband-code"
                                                type="text"
                                                inputMode="numeric"
                                                autoComplete="one-time-code"
                                                pattern="[0-9]{6}"
                                                maxLength={6}
                                                value={disbandCode}
                                                onChange={(event) =>
                                                    setDisbandCode(
                                                        event.target.value.replace(/\D/g, '').slice(0, 6),
                                                    )
                                                }
                                                required
                                                disabled={!!busy}
                                            />
                                            <div className="group-leader-confirm-actions">
                                                <ActionButton
                                                    className="button danger"
                                                    type="submit"
                                                    disabled={
                                                        !!busy ||
                                                        !disbandAcknowledged ||
                                                        disbandCode.length !== 6
                                                    }
                                                    unavailableReason={
                                                        busy
                                                            ? 'The current group change is still in progress.'
                                                            : !disbandAcknowledged
                                                              ? 'Acknowledge the consequences to continue.'
                                                              : disbandCode.length !== 6
                                                                ? 'Enter all 6 digits.'
                                                                : undefined
                                                    }
                                                >
                                                    {busy === 'disband'
                                                        ? 'Disbanding…'
                                                        : 'Confirm team disband'}
                                                </ActionButton>
                                                <ActionButton
                                                    className="button quiet"
                                                    type="button"
                                                    disabled={!!busy}
                                                    unavailableReason={
                                                        busy
                                                            ? 'Wait for the current change to finish.'
                                                            : undefined
                                                    }
                                                    onClick={() => void sendDisbandCode()}
                                                >
                                                    {busy === 'disband-code' ? 'Sending…' : 'Resend code'}
                                                </ActionButton>
                                                <ActionButton
                                                    className="button quiet"
                                                    type="button"
                                                    disabled={!!busy}
                                                    unavailableReason={
                                                        busy
                                                            ? 'Wait for the current change to finish.'
                                                            : undefined
                                                    }
                                                    onClick={() => {
                                                        setShowDisbandConfirm(false);
                                                        setDisbandAcknowledged(false);
                                                        setDisbandCode('');
                                                        setCodeexpireat('');
                                                        setDisbandCodeEmail('');
                                                    }}
                                                >
                                                    Cancel
                                                </ActionButton>
                                            </div>
                                        </form>
                                    )}
                                </section>
                            )}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
