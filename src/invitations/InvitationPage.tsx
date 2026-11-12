import { useEffect, useState } from 'react';
import { Brand } from '../ui/Brand';
import {
    clearPendingInvite,
    parseInvitation,
    rememberInvitation,
    type PendingInvitation,
} from './invitation';
import './invitationPage.css';

type InvitationPreview = {
    groupName: string;
    inviterName?: string;
    expiresAt: string;
    joined: boolean;
    accepted: boolean;
    signedInToDifferentGroup: boolean;
    mergingPaused?: boolean;
};

type JoinState =
    | 'loading'
    | 'ready'
    | 'invalid'
    | 'unavailable'
    | 'paused'
    | 'joined'
    | 'declined'
    | 'network-error'
    | 'storage-blocked'
    | 'proceeding';

async function loadPreview(invitation: PendingInvitation): Promise<InvitationPreview> {
    const response = await fetch(`/api/invitations/${encodeURIComponent(invitation.id)}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: invitation.token }),
    });
    if (response.status === 404 || response.status === 410) throw new Error('invalid');
    if (!response.ok) throw new Error('network');
    const body: unknown = await response.json().catch(() => null);
    if (
        !body ||
        typeof body !== 'object' ||
        !('groupName' in body) ||
        typeof body.groupName !== 'string' ||
        !('expiresAt' in body) ||
        typeof body.expiresAt !== 'string' ||
        !('joined' in body) ||
        typeof body.joined !== 'boolean' ||
        !('accepted' in body) ||
        typeof body.accepted !== 'boolean' ||
        !('signedInToDifferentGroup' in body) ||
        typeof body.signedInToDifferentGroup !== 'boolean'
    ) {
        throw new Error('invalid');
    }
    const result = body as InvitationPreview;
    if ('inviterName' in body && typeof body.inviterName !== 'string') throw new Error('invalid');
    if ('mergingPaused' in body && typeof body.mergingPaused !== 'boolean') throw new Error('invalid');
    return result;
}

export function InvitationPage() {
    const [state, setState] = useState<JoinState>('loading');
    const [invitation, setInvitation] = useState<PendingInvitation | null>(null);
    const [preview, setPreview] = useState<InvitationPreview | null>(null);

    async function inspect(parsed: PendingInvitation, active: () => boolean) {
        setState('loading');
        try {
            const result = await loadPreview(parsed);
            if (!active()) return;
            setInvitation(parsed);
            setPreview(result);
            setState(
                result.joined
                    ? 'joined'
                    : result.accepted
                      ? 'unavailable'
                      : result.mergingPaused
                        ? 'paused'
                        : 'ready',
            );
        } catch (cause) {
            if (!active()) return;
            setState(cause instanceof Error && cause.message === 'invalid' ? 'invalid' : 'network-error');
        }
    }

    useEffect(() => {
        let active = true;
        clearPendingInvite();
        const parsed = parseInvitation({ search: window.location.search, hash: window.location.hash });
        if (!parsed) {
            setState('invalid');
            return () => {
                active = false;
            };
        }
        setInvitation(parsed);
        void inspect(parsed, () => active);
        return () => {
            active = false;
        };
    }, []);

    function accept() {
        if (!invitation) return;
        if (!rememberInvitation(invitation)) {
            setState('storage-blocked');
            return;
        }
        setState('proceeding');
        window.location.replace('/login');
    }

    function decline() {
        clearPendingInvite();
        setState('declined');
    }

    function retry() {
        if (!invitation) return;
        void inspect(invitation, () => true);
    }

    const inviter = preview?.inviterName?.trim() || 'the group leader';
    const continueLink = (
        <a className="button secondary invitation-continue" href="/login">
            Continue to sign in
        </a>
    );

    return (
        <main className="invitation-page" id="main-content" tabIndex={-1}>
            <section className="invitation-card" aria-labelledby="invitation-title">
                <div className="invitation-page-brand">
                    <Brand />
                    <span>Group invitation</span>
                </div>
                <h1 id="invitation-title">
                    {state === 'ready' || state === 'proceeding'
                        ? `Join ${inviter}’s team?`
                        : 'Group invitation'}
                </h1>
                {state === 'loading' && <p role="status">Checking this invitation…</p>}
                {(state === 'ready' || state === 'proceeding') && preview && (
                    <>
                        <div className="invitation-group" aria-label="Invited team">
                            <span>Their team name is</span>
                            <strong>“{preview.groupName}”</strong>
                        </div>
                        <p>
                            Continue to sign in or create an account to join this team. If you are already on
                            another team, joining moves your account when that team has at most one player.
                            Its past submissions and evidence stay with that team.
                        </p>
                        {preview.signedInToDifferentGroup && (
                            <p className="invitation-unavailable">
                                You are currently signed in to a different team. You can switch after
                                confirming, if that team has at most one player.
                            </p>
                        )}
                        <div className="invitation-actions">
                            <button
                                className="button primary invitation-continue"
                                type="button"
                                onClick={accept}
                                disabled={state === 'proceeding'}
                            >
                                {state === 'proceeding' ? 'Opening sign in…' : 'Join team'}
                            </button>
                            <button
                                className="button secondary invitation-continue"
                                type="button"
                                onClick={decline}
                            >
                                Not now
                            </button>
                        </div>
                    </>
                )}
                {state === 'invalid' && (
                    <div role="alert" className="invitation-invalid">
                        <strong>This invitation link is invalid or expired.</strong>
                        <p>
                            Ask the person who invited you for a new link. Replaced and cancelled links stop
                            working.
                        </p>
                        {continueLink}
                    </div>
                )}
                {state === 'unavailable' && (
                    <div role="alert" className="invitation-invalid">
                        <strong>This invitation has already been used.</strong>
                        <p>Ask the person who invited you for a new link.</p>
                        {continueLink}
                    </div>
                )}
                {state === 'paused' && (
                    <div role="status" className="invitation-invalid">
                        <strong>Joining teams is paused.</strong>
                        <p>
                            {preview?.groupName ? `This invitation is for “${preview.groupName}”. ` : ''}Try
                            again later or contact the person who invited you.
                        </p>
                        {continueLink}
                    </div>
                )}
                {state === 'joined' && (
                    <div role="status" className="invitation-success">
                        <strong>You’re already on “{preview?.groupName}”.</strong>
                        <span>Continue to sign in to open your team.</span>
                        {continueLink}
                    </div>
                )}
                {state === 'declined' && (
                    <div role="status" className="invitation-invalid">
                        <strong>Invitation declined.</strong>
                        <p>You can sign in without joining this team.</p>
                        {continueLink}
                    </div>
                )}
                {state === 'network-error' && (
                    <div role="alert" className="invitation-invalid">
                        <strong>We couldn’t check this invitation.</strong>
                        <p>Check your connection and try again.</p>
                        <button className="button primary invitation-continue" type="button" onClick={retry}>
                            Try again
                        </button>
                        {continueLink}
                    </div>
                )}
                {state === 'storage-blocked' && (
                    <div role="alert" className="invitation-invalid">
                        <strong>Your browser couldn’t save this invitation.</strong>
                        <p>Allow site storage in your browser settings, then retry.</p>
                        <button className="button primary invitation-continue" type="button" onClick={accept}>
                            Retry
                        </button>
                        {continueLink}
                    </div>
                )}
                {state === 'proceeding' && <p role="status">Opening sign in…</p>}
                <p className="invitation-help">Need help? Contact the person who invited you.</p>
            </section>
        </main>
    );
}
