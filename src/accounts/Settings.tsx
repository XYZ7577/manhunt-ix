import React, { FormEvent, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { Account, Group } from '../../shared/types';
import { GroupMembers } from '../groups/GroupMembers';
import { PasswordInput } from './PasswordInput';
import {
    PASSWORD_ERROR,
    PASSWORD_HELP,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PASSWORD_PATTERN,
    USERNAME_ERROR,
    USERNAME_MAX_LENGTH,
    validPassword,
    validUsername,
} from '../../shared/accounts/credentials';
import { AdminPeopleSettings } from '../admin/AdminPeopleSettings';
import { ActionButton } from '../ui/ActionButton';
import { validateContactEmail, validateDisplayName, validateGroupName } from './settingsValidation';
import './settings.css';

type EmailContact = { id: string; email: string; verified: boolean; primary: boolean };
type EmailVerification = { sent: boolean; error?: string; retryAfterSeconds?: number; expiresAt?: string };
type EmailSaveResult = { email: EmailContact; verification: EmailVerification };
type EmailVerificationState = { code: string; message: string; isError: boolean };
type Member = { displayName: string; username: string; role: string };
type SettingsData = {
    emails: EmailContact[];
    emailVerificationAvailable?: boolean;
    members: Member[];
    canRenameGroup?: boolean;
    hasPassword: boolean;
    recentSignInExpiresAt: string | null;
    twoFactor: { enabled: boolean };
};

const editableUsername = (username: string) =>
    /^(google:|sms:)[0-9a-f-]{36}$/i.test(username) ? '' : username;

class SettingsRequestError extends Error {
    constructor(
        message: string,
        readonly code?: string,
        readonly retryAfterSeconds?: number,
    ) {
        super(message);
    }
}

async function settingsReq<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
        throw new SettingsRequestError(
            String(body.error || body.message || `Request failed (${response.status})`),
            typeof body.code === 'string' ? body.code : undefined,
            typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined,
        );
    return body as T;
}

export function Settings({
    account,
    group,
    adminGroups,
    onChanged,
}: {
    account: Account;
    group: Group | null;
    adminGroups?: Group[];
    onChanged?: () => void | Promise<void>;
}) {
    const [data, setData] = useState<SettingsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [username, setUsername] = useState(() => editableUsername(account.username));
    const [displayName, setDisplayName] = useState(account.displayName);
    const [groupName, setGroupName] = useState(group?.name ?? '');
    const [email, setEmail] = useState('');
    const [emailError, setEmailError] = useState('');
    const [editingEmailId, setEditingEmailId] = useState('');
    const [editingEmail, setEditingEmail] = useState('');
    const [editingEmailError, setEditingEmailError] = useState('');
    const [emailActionErrors, setEmailActionErrors] = useState<Record<string, string>>({});
    const [verifyEmailID, setVerifyEmailID] = useState('');
    const [emailVerification, setEmailVerification] = useState<Record<string, EmailVerificationState>>({});
    const [verifyCD, setVerifyCD] = useState<Record<string, number>>({});
    const [clock, setClock] = useState(Date.now());
    const [currentPassword, setCurrentPassword] = useState('');
    const [passwordError, setPasswordError] = useState('');
    const [wrongcurrpw, setWrongcurrpw] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
    const [totpQr, setTotpQr] = useState('');
    const [setupPassword, setSetupPassword] = useState('');
    const [totpError, setTotpError] = useState('');
    const [totpCode, setTotpCode] = useState('');
    const [disablePassword, setDisablePassword] = useState('');
    const [recoveryCode, setRecoveryCode] = useState('');
    const [recoveryPassword, setRecoveryPassword] = useState('');
    const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

    async function load() {
        setLoading(true);
        setError('');
        try {
            const result = await settingsReq<{ settings: SettingsData }>('/api/settings');
            setData(result.settings);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not load settings.');
        } finally {
            setLoading(false);
        }
    }
    async function refreshGroupSettings() {
        await load();
        await onChanged?.();
    }
    useEffect(() => {
        void load();
    }, [account.id]);
    useEffect(() => {
        setUsername(editableUsername(account.username));
    }, [account.id, account.username]);
    useEffect(() => {
        setDisplayName(account.displayName);
    }, [account.id, account.displayName]);
    useEffect(() => {
        setGroupName(group?.name ?? '');
    }, [group?.id, group?.name]);
    useEffect(() => {
        const expiresAt = data?.recentSignInExpiresAt;
        if (!expiresAt) return;
        setSetupPassword('');
        const remaining = Date.parse(expiresAt) - Date.now();
        const timer = window.setTimeout(
            () => {
                setData((current) =>
                    current?.recentSignInExpiresAt === expiresAt
                        ? { ...current, recentSignInExpiresAt: null }
                        : current,
                );
            },
            Math.max(0, Number.isFinite(remaining) ? remaining : 0),
        );
        return () => window.clearTimeout(timer);
    }, [data?.recentSignInExpiresAt]);
    useEffect(() => {
        if (!Object.values(verifyCD).some((until) => until > Date.now())) return;
        const timer = window.setInterval(() => {
            const now = Date.now();
            setClock(now);
            if (!Object.values(verifyCD).some((until) => until > now)) window.clearInterval(timer);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [verifyCD]);
    useEffect(() => {
        let active = true;
        if (!totpSetup?.otpauthUri) {
            setTotpQr('');
            return;
        }
        QRCode.toDataURL(totpSetup.otpauthUri, { width: 192, margin: 2, errorCorrectionLevel: 'M' })
            .then((url) => {
                if (active) setTotpQr(url);
            })
            .catch(() => {
                if (active) setTotpQr('error');
            });
        return () => {
            active = false;
        };
    }, [totpSetup?.otpauthUri]);

    async function perform<T>(
        label: string,
        action: () => Promise<T>,
        success: string,
        after?: (value: T) => void | Promise<void>,
    ) {
        setBusy(label);
        setError('');
        setTotpError('');
        setNotice('');
        if (label === 'password') {
            setPasswordError('');
            setWrongcurrpw(false);
        }
        try {
            const value = await action();
            await after?.(value);
            setNotice(success);
            await onChanged?.();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'The change could not be saved.';
            if (label === 'password') {
                const invalidCurrent =
                    cause instanceof SettingsRequestError &&
                    (cause.code === 'incorrect_current_password' ||
                        cause.code === 'current_password_required');
                setPasswordError(message);
                setWrongcurrpw(invalidCurrent);
                if (invalidCurrent) document.getElementById('settings-current-password')?.focus();
            } else if (label.startsWith('totp-') || label === 'recovery') setTotpError(message);
            else setError(message);
        } finally {
            setBusy('');
        }
    }
    async function addEmail(event: FormEvent) {
        event.preventDefault();
        const validation = validateContactEmail(email, data?.emails || []);
        if (validation) {
            setEmailError(validation);
            document.getElementById('settings-email')?.focus();
            return;
        }
        setEmailError('');
        await saveContactEmail('email', '/api/settings/emails', 'POST', email.trim(), 'Email added.');
    }
    async function changeUsername(event: FormEvent) {
        event.preventDefault();
        setError('');
        setNotice('');
        const nextUsername = username.trim();
        if (!validUsername(nextUsername)) {
            setError(USERNAME_ERROR);
            return;
        }
        await perform(
            'username',
            () =>
                settingsReq<{ account: Account }>('/api/settings/username', 'PUT', {
                    username: nextUsername,
                }),
            'Username saved.',
            (result) => {
                setUsername(result.account.username);
            },
        );
    }
    async function changeDisplayName(event: FormEvent) {
        event.preventDefault();
        const validation = validateDisplayName(displayName);
        if (validation) {
            setError(validation);
            document.getElementById('settings-display-name')?.focus();
            return;
        }
        await perform(
            'display-name',
            () =>
                settingsReq<{ account: Account }>('/api/settings/display-name', 'PUT', {
                    displayName: displayName.trim(),
                }),
            'Full name saved.',
            (result) => {
                setDisplayName(result.account.displayName);
            },
        );
    }
    async function changeGroupName(event: FormEvent) {
        event.preventDefault();
        const validation = validateGroupName(groupName);
        if (validation) {
            setError(validation);
            document.getElementById('settings-group-name')?.focus();
            return;
        }
        await perform(
            'group-name',
            () =>
                settingsReq<{ group: { id: string; name: string } }>('/api/settings/group-name', 'PUT', {
                    groupName: groupName.trim(),
                }),
            'Group name saved.',
            (result) => {
                setGroupName(result.group.name);
            },
        );
    }
    async function changePassword(event: FormEvent) {
        event.preventDefault();
        setError('');
        setNotice('');
        setPasswordError('');
        setWrongcurrpw(false);
        if (newPassword !== confirmPassword) {
            setPasswordError('The new passwords do not match.');
            return;
        }
        if (!validPassword(newPassword)) {
            setPasswordError(PASSWORD_ERROR);
            return;
        }
        await perform(
            'password',
            () =>
                settingsReq('/api/settings/password', 'POST', {
                    currentPassword: currentPassword || undefined,
                    newPassword,
                }),
            'Password saved.',
            async () => {
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
                await load();
            },
        );
    }
    async function beginTotp() {
        const recentSignIn =
            !!data?.recentSignInExpiresAt && Date.parse(data.recentSignInExpiresAt) > Date.now();
        await perform(
            'totp-setup',
            () =>
                settingsReq<{ secret: string; otpauthUri: string }>('/api/settings/totp/setup', 'POST', {
                    password: recentSignIn ? undefined : setupPassword || undefined,
                }),
            'Authenticator setup is ready. Add the key to your authenticator app.',
            (result) => {
                setTotpSetup(result);
                setTotpCode('');
                setSetupPassword('');
            },
        );
    }
    async function activateTotp(event: FormEvent) {
        event.preventDefault();
        await perform(
            'totp-activate',
            () =>
                settingsReq<{ recoveryCodes: string[] }>('/api/settings/totp/activate', 'POST', {
                    code: totpCode.replace(/\s/g, ''),
                }),
            'Authenticator sign-in is enabled. Save these backup codes now.',
            (result) => {
                setRecoveryCodes(result.recoveryCodes);
                setTotpSetup(null);
                setTotpCode('');
                void load();
            },
        );
    }
    async function disableTotp(event: FormEvent) {
        event.preventDefault();
        await perform(
            'totp-disable',
            () =>
                settingsReq('/api/settings/totp/disable', 'POST', {
                    password: disablePassword || undefined,
                    code: totpCode.replace(/\s/g, ''),
                }),
            'Authenticator sign-in disabled.',
            async () => {
                setDisablePassword('');
                setTotpCode('');
                await load();
            },
        );
    }
    async function regenerateRecovery(event: FormEvent) {
        event.preventDefault();
        await perform(
            'recovery',
            () =>
                settingsReq<{ recoveryCodes: string[] }>('/api/settings/totp/recovery-codes', 'POST', {
                    password: recoveryPassword || undefined,
                    code: recoveryCode.trim(),
                }),
            'New backup codes generated. Save them now; old codes no longer work.',
            (result) => {
                setRecoveryCodes(result.recoveryCodes);
                setRecoveryCode('');
                setRecoveryPassword('');
            },
        );
    }
    function downloadRecovery() {
        if (!recoveryCodes) return;
        const blob = new Blob([`Manhunt IX backup codes\n\n${recoveryCodes.join('\n')}\n`], {
            type: 'text/plain',
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'manhunt-ix-recovery-codes.txt';
        link.click();
        URL.revokeObjectURL(url);
    }
    async function emailAction(id: string, action: 'primary' | 'delete') {
        const path =
            action === 'primary'
                ? `/api/settings/emails/${encodeURIComponent(id)}/primary`
                : `/api/settings/emails/${encodeURIComponent(id)}`;
        const label = `email-${id}`;
        setBusy(label);
        setError('');
        setNotice('');
        setEmailActionErrors((current) => ({ ...current, [id]: '' }));
        try {
            await settingsReq(path, action === 'primary' ? 'PUT' : 'DELETE');
            if (action === 'delete') clearVerificationState(id);
            await load();
            setNotice(action === 'primary' ? 'Primary email updated.' : 'Email removed.');
            await onChanged?.();
        } catch (cause) {
            const message =
                cause instanceof Error ? cause.message : 'The email action could not be completed.';
            setEmailActionErrors((current) => ({ ...current, [id]: message }));
        } finally {
            setBusy('');
        }
    }
    async function saveEmailEdit(event: FormEvent, id: string) {
        event.preventDefault();
        const validation = validateContactEmail(editingEmail, data?.emails || [], id);
        if (validation) {
            setEditingEmailError(validation);
            document.getElementById(`edit-email-${id}`)?.focus();
            return;
        }
        setEditingEmailError('');
        await saveContactEmail(
            `edit-${id}`,
            `/api/settings/emails/${encodeURIComponent(id)}`,
            'PUT',
            editingEmail.trim(),
            'Email updated.',
            id,
        );
    }

    function clearVerificationState(id: string) {
        setEmailVerification((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
        setVerifyCD((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
        if (verifyEmailID === id) setVerifyEmailID('');
    }
    function applyVerificationResult(id: string, result: EmailVerification) {
        const remaining = result.retryAfterSeconds ?? (result.sent ? 60 : 0);
        const now = Date.now();
        setClock(now);
        setVerifyCD((current) => ({
            ...current,
            [id]: remaining > 0 ? now + remaining * 1000 : 0,
        }));
        setEmailVerification((current) => ({
            ...current,
            [id]: {
                ...current[id],
                code: '',
                message: result.sent
                    ? 'A verification code was sent. Check your inbox and enter it below.'
                    : result.error ||
                      'The email was saved, but the verification code could not be sent. Try again shortly.',
                isError: !result.sent,
            },
        }));
    }
    async function saveContactEmail(
        label: string,
        path: string,
        method: string,
        address: string,
        success: string,
        previousId?: string,
    ) {
        setBusy(label);
        setError('');
        setNotice('');
        try {
            const result = await settingsReq<EmailSaveResult>(path, method, { email: address });
            if (previousId) clearVerificationState(previousId);
            setEmail('');
            setEditingEmailId('');
            setEditingEmail('');
            setEmailError('');
            setEditingEmailError('');
            setVerifyEmailID(result.email.id);
            applyVerificationResult(result.email.id, result.verification);
            await load();
            setNotice(success);
            await onChanged?.();
        } catch (cause) {
            const rawMessage = cause instanceof Error ? cause.message : 'The email could not be saved.';
            const message = /already in use|duplicate/i.test(rawMessage)
                ? 'This address could not be saved. Check your contact list and try another address.'
                : rawMessage;
            if (label === 'email') {
                setEmailError(message);
                document.getElementById('settings-email')?.focus();
            } else {
                setEditingEmailError(message);
                if (previousId) document.getElementById(`edit-email-${previousId}`)?.focus();
            }
        } finally {
            setBusy('');
        }
    }
    async function resendEmailVerification(id: string) {
        setBusy(`verification-resend-${id}`);
        setError('');
        setNotice('');
        try {
            const result = await settingsReq<EmailSaveResult>(
                `/api/settings/emails/${encodeURIComponent(id)}/verification`,
                'POST',
            );
            setVerifyEmailID(id);
            applyVerificationResult(id, result.verification);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'Could not send a verification code.';
            const retryAfter = cause instanceof SettingsRequestError ? cause.retryAfterSeconds : undefined;
            if (retryAfter) {
                const now = Date.now();
                setClock(now);
                setVerifyCD((current) => ({ ...current, [id]: now + retryAfter * 1000 }));
            }
            setEmailVerification((current) => ({
                ...current,
                [id]: { ...current[id], message, isError: true },
            }));
            setVerifyEmailID(id);
        } finally {
            setBusy('');
        }
    }
    async function verifyEmail(event: FormEvent, id: string) {
        event.preventDefault();
        const code = emailVerification[id]?.code || '';
        setBusy(`verification-verify-${id}`);
        setError('');
        setNotice('');
        try {
            const result = await settingsReq<{ email: EmailContact }>(
                `/api/settings/emails/${encodeURIComponent(id)}/verify`,
                'POST',
                { code },
            );
            setData((current) =>
                current
                    ? {
                          ...current,
                          emails: current.emails.map((item) => (item.id === id ? result.email : item)),
                      }
                    : current,
            );
            clearVerificationState(id);
            setNotice('Email verified.');
            await onChanged?.();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'The code could not be verified.';
            setEmailVerification((current) => ({
                ...current,
                [id]: { ...current[id], message, isError: true },
            }));
        } finally {
            setBusy('');
        }
    }

    if (!data)
        return (
            <div className="settings-page">
                <header className="settings-heading">
                    <div>
                        <h1>Settings</h1>
                        <p className="page-summary">Manage your account, contact details, and security.</p>
                    </div>
                </header>
                {error && (
                    <p className="alert error" role="alert" aria-live="assertive">
                        {error}
                    </p>
                )}
                {loading ? (
                    <p className="settings-loading" role="status">
                        Loading settings…
                    </p>
                ) : (
                    <button className="button secondary" type="button" onClick={() => void load()}>
                        Try again
                    </button>
                )}
            </div>
        );

    const recentSignIn = !!data.recentSignInExpiresAt && Date.parse(data.recentSignInExpiresAt) > Date.now();
    return (
        <div className="settings-page">
            <header className="settings-heading">
                <div>
                    <h1>Settings</h1>
                    <p className="page-summary">Manage your account, contact details, and security.</p>
                </div>
            </header>
            {notice && (
                <p className="alert success" role="status" aria-live="polite">
                    {notice}
                </p>
            )}
            {error && (
                <p className="alert error" role="alert" aria-live="assertive">
                    {error}
                </p>
            )}
            {loading && (
                <p className="settings-loading" role="status">
                    Loading settings…
                </p>
            )}
            <section className="settings-panel" aria-labelledby="settings-account-title">
                <div className="settings-section-heading">
                    <div>
                        <h2 id="settings-account-title">Account</h2>
                        <p>Your profile and group membership.</p>
                    </div>
                </div>
                <dl className="settings-account-grid">
                    <div>
                        <dt>Name</dt>
                        <dd>{displayName}</dd>
                    </div>
                    <div>
                        <dt>Role</dt>
                        <dd>{account.role === 'admin' ? 'Administrator' : 'Player'}</dd>
                    </div>
                    {group && (
                        <div>
                            <dt>Group</dt>
                            <dd>{groupName}</dd>
                        </div>
                    )}
                </dl>
                <form
                    className="settings-form settings-inline-form"
                    onSubmit={(event) => void changeDisplayName(event)}
                >
                    <label htmlFor="settings-display-name">
                        Full name
                        <input
                            id="settings-display-name"
                            autoComplete="name"
                            required
                            maxLength={80}
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                        />
                    </label>
                    <div>
                        <ActionButton
                            className="button primary"
                            type="submit"
                            disabled={
                                loading ||
                                !!busy ||
                                !displayName.trim() ||
                                displayName.trim() === account.displayName
                            }
                            unavailableReason={
                                loading
                                    ? 'Settings are still loading.'
                                    : busy
                                      ? 'Wait for the current change to finish.'
                                      : !displayName.trim()
                                        ? 'Enter your full name first.'
                                        : 'This is already your full name.'
                            }
                        >
                            {busy === 'display-name' ? 'Saving…' : 'Save full name'}
                        </ActionButton>
                    </div>
                </form>
                {group && data.canRenameGroup && (
                    <form
                        className="settings-form settings-inline-form"
                        onSubmit={(event) => void changeGroupName(event)}
                    >
                        <label htmlFor="settings-group-name">
                            Group name
                            <input
                                id="settings-group-name"
                                autoComplete="organization"
                                required
                                maxLength={60}
                                value={groupName}
                                onChange={(event) => setGroupName(event.target.value)}
                            />
                        </label>
                        <div>
                            <ActionButton
                                className="button primary"
                                type="submit"
                                disabled={
                                    loading || !!busy || !groupName.trim() || groupName.trim() === group.name
                                }
                                unavailableReason={
                                    loading
                                        ? 'Settings are still loading.'
                                        : busy
                                          ? 'Wait for the current change to finish.'
                                          : !groupName.trim()
                                            ? 'Enter a group name first.'
                                            : 'This is already your group name.'
                                }
                            >
                                {busy === 'group-name' ? 'Saving…' : 'Save group name'}
                            </ActionButton>
                        </div>
                    </form>
                )}
                <form
                    className="settings-form settings-username-form"
                    onSubmit={(event) => void changeUsername(event)}
                >
                    <label htmlFor="settings-username">
                        Username
                        <input
                            id="settings-username"
                            name="username"
                            autoComplete="username"
                            autoCapitalize="none"
                            spellCheck={false}
                            required
                            maxLength={USERNAME_MAX_LENGTH}
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            placeholder="Choose a username"
                            aria-describedby="settings-username-help"
                        />
                    </label>
                    <p id="settings-username-help" className="hint">
                        {data.hasPassword
                            ? 'Use this username with your password to sign in.'
                            : 'Set a password below to sign in with your username.'}
                    </p>
                    <ActionButton
                        className="button primary"
                        type="submit"
                        disabled={
                            loading || !!busy || !username.trim() || username.trim() === account.username
                        }
                        unavailableReason={
                            loading
                                ? 'Settings are still loading.'
                                : busy
                                  ? 'Wait for the current change to finish.'
                                  : !username.trim()
                                    ? 'Enter a username first.'
                                    : username.trim() === account.username
                                      ? 'This is already your username.'
                                      : undefined
                        }
                    >
                        {busy === 'username' ? 'Saving…' : 'Save username'}
                    </ActionButton>
                </form>
                {account.role === 'admin' && (
                    <AdminPeopleSettings
                        accountId={account.id}
                        groups={adminGroups ?? []}
                        onChanged={async () => {
                            await onChanged?.();
                        }}
                    />
                )}
                {!group && account.role !== 'admin' && (
                    <p className="settings-footnote">View and manage group members on the Groups page.</p>
                )}
            </section>
            {group && (
                <GroupMembers
                    groupId={group.id}
                    refreshKey={JSON.stringify([account.displayName, group.name, data.emails])}
                    onChanged={refreshGroupSettings}
                />
            )}

            <section className="settings-panel" aria-labelledby="settings-email-title">
                <div className="settings-section-heading">
                    <div>
                        <h2 id="settings-email-title">Email addresses</h2>
                        <p>
                            Your Google sign-in email is filled in automatically. Add other personal contact
                            emails here; invite other players under Group members.
                        </p>
                    </div>
                </div>
                {account.role === 'player' && (
                    <p className="settings-footnote">
                        Review updates are emailed to your verified primary address, or another verified
                        address if your primary is unverified. Add and verify an email to receive them.
                    </p>
                )}
                <ul className="settings-contact-list">
                    {data?.emails.map((item) => (
                        <li key={item.id}>
                            {editingEmailId === item.id ? (
                                <form
                                    className="settings-edit-email"
                                    onSubmit={(event) => void saveEmailEdit(event, item.id)}
                                >
                                    <label htmlFor={`edit-email-${item.id}`}>Edit email address</label>
                                    <div>
                                        <input
                                            id={`edit-email-${item.id}`}
                                            type="email"
                                            autoComplete="email"
                                            required
                                            value={editingEmail}
                                            aria-invalid={!!editingEmailError || undefined}
                                            aria-describedby={
                                                editingEmailError ? `edit-email-error-${item.id}` : undefined
                                            }
                                            onChange={(event) => {
                                                const value = event.target.value;
                                                setEditingEmail(value);
                                                setEditingEmailError(
                                                    validateContactEmail(value, data.emails, item.id),
                                                );
                                            }}
                                        />
                                        <ActionButton
                                            type="submit"
                                            className="button primary small-button"
                                            disabled={!!busy}
                                            unavailableReason={
                                                busy ? 'Wait for the current change to finish.' : undefined
                                            }
                                        >
                                            {busy === `edit-${item.id}` ? 'Saving…' : 'Save'}
                                        </ActionButton>
                                        <ActionButton
                                            type="button"
                                            className="button quiet small-button"
                                            disabled={!!busy}
                                            unavailableReason={
                                                busy ? 'Wait for the current change to finish.' : undefined
                                            }
                                            onClick={() => {
                                                setEditingEmailId('');
                                                setEditingEmail('');
                                                setEditingEmailError('');
                                            }}
                                        >
                                            Cancel
                                        </ActionButton>
                                    </div>
                                    {editingEmailError && (
                                        <p
                                            id={`edit-email-error-${item.id}`}
                                            className="settings-email-verify-message error"
                                            role="alert"
                                        >
                                            {editingEmailError}
                                        </p>
                                    )}
                                </form>
                            ) : (
                                <>
                                    <div className="settings-contact-main">
                                        <div className="settings-contact-summary">
                                            <strong>{item.email}</strong>
                                            <span
                                                className={
                                                    item.verified
                                                        ? 'settings-badge verified'
                                                        : 'settings-badge'
                                                }
                                            >
                                                {item.verified ? 'Verified' : 'Unverified'}
                                            </span>
                                            {item.primary && (
                                                <span className="settings-badge primary-badge">Primary</span>
                                            )}
                                        </div>
                                        <div className="settings-row-actions">
                                            <ActionButton
                                                type="button"
                                                className="button quiet small-button"
                                                disabled={!!busy}
                                                unavailableReason={
                                                    busy
                                                        ? 'Wait for the current change to finish.'
                                                        : undefined
                                                }
                                                onClick={() => {
                                                    setEditingEmailId(item.id);
                                                    setEditingEmail(item.email);
                                                    setEditingEmailError('');
                                                    clearVerificationState(item.id);
                                                }}
                                            >
                                                Edit
                                            </ActionButton>
                                            {!item.primary && (
                                                <ActionButton
                                                    type="button"
                                                    className="button secondary small-button"
                                                    disabled={!!busy}
                                                    unavailableReason={
                                                        busy
                                                            ? 'Wait for the current change to finish.'
                                                            : undefined
                                                    }
                                                    onClick={() => void emailAction(item.id, 'primary')}
                                                >
                                                    Make primary
                                                </ActionButton>
                                            )}
                                            <ActionButton
                                                type="button"
                                                className="button quiet small-button"
                                                disabled={!!busy}
                                                unavailableReason={
                                                    busy
                                                        ? 'Wait for the current change to finish.'
                                                        : undefined
                                                }
                                                onClick={() => void emailAction(item.id, 'delete')}
                                            >
                                                Remove
                                            </ActionButton>
                                        </div>
                                    </div>
                                    {emailActionErrors[item.id] && (
                                        <p className="settings-email-verify-message error" role="alert">
                                            {emailActionErrors[item.id]}
                                        </p>
                                    )}
                                    {!item.verified && (
                                        <div className="settings-email-verify">
                                            {!data.emailVerificationAvailable ? (
                                                <p
                                                    className="settings-email-verify-message error"
                                                    role="status"
                                                >
                                                    {emailVerification[item.id]?.message ||
                                                        'Email verification is temporarily unavailable. Your address is saved, but it still needs to be verified.'}
                                                </p>
                                            ) : verifyEmailID === item.id ? (
                                                <form
                                                    className="settings-email-verify-form"
                                                    onSubmit={(event) => void verifyEmail(event, item.id)}
                                                >
                                                    <p>
                                                        Check <strong>{item.email}</strong> for a verification
                                                        code.
                                                    </p>
                                                    <label htmlFor={`verify-email-code-${item.id}`}>
                                                        6-digit verification code
                                                    </label>
                                                    <div className="settings-email-verify-controls">
                                                        <input
                                                            id={`verify-email-code-${item.id}`}
                                                            type="text"
                                                            inputMode="numeric"
                                                            autoComplete="one-time-code"
                                                            pattern="[0-9]{6}"
                                                            maxLength={6}
                                                            value={emailVerification[item.id]?.code || ''}
                                                            aria-describedby={
                                                                emailVerification[item.id]?.message
                                                                    ? `verify-email-message-${item.id}`
                                                                    : undefined
                                                            }
                                                            onChange={(event) =>
                                                                setEmailVerification((current) => ({
                                                                    ...current,
                                                                    [item.id]: {
                                                                        ...current[item.id],
                                                                        code: event.target.value
                                                                            .replace(/\D/g, '')
                                                                            .slice(0, 6),
                                                                        message: '',
                                                                        isError: false,
                                                                    },
                                                                }))
                                                            }
                                                            required
                                                        />
                                                        <ActionButton
                                                            className="button primary small-button"
                                                            type="submit"
                                                            disabled={
                                                                !!busy ||
                                                                (emailVerification[item.id]?.code || '')
                                                                    .length !== 6
                                                            }
                                                            unavailableReason={
                                                                busy
                                                                    ? 'Wait for the current change to finish.'
                                                                    : (emailVerification[item.id]?.code || '')
                                                                            .length !== 6
                                                                      ? 'Enter all 6 digits to verify this address.'
                                                                      : undefined
                                                            }
                                                        >
                                                            {busy === `verification-verify-${item.id}`
                                                                ? 'Verifying…'
                                                                : 'Verify email'}
                                                        </ActionButton>
                                                        <ActionButton
                                                            className="button quiet small-button"
                                                            type="button"
                                                            onClick={() => clearVerificationState(item.id)}
                                                            disabled={!!busy}
                                                            unavailableReason={
                                                                busy
                                                                    ? 'Wait for the current change to finish.'
                                                                    : undefined
                                                            }
                                                        >
                                                            Cancel
                                                        </ActionButton>
                                                    </div>
                                                    {emailVerification[item.id]?.message && (
                                                        <p
                                                            id={`verify-email-message-${item.id}`}
                                                            className={
                                                                emailVerification[item.id].isError
                                                                    ? 'settings-email-verify-message error'
                                                                    : 'settings-email-verify-message'
                                                            }
                                                            role={
                                                                emailVerification[item.id].isError
                                                                    ? 'alert'
                                                                    : 'status'
                                                            }
                                                        >
                                                            {emailVerification[item.id].message}
                                                        </p>
                                                    )}
                                                    <ActionButton
                                                        type="button"
                                                        className="button secondary small-button"
                                                        disabled={!!busy || (verifyCD[item.id] || 0) > clock}
                                                        unavailableReason={
                                                            busy
                                                                ? 'Wait for the current change to finish.'
                                                                : (verifyCD[item.id] || 0) > clock
                                                                  ? `You can request another code in ${Math.ceil(((verifyCD[item.id] || 0) - clock) / 1000)} seconds.`
                                                                  : undefined
                                                        }
                                                        onClick={() => void resendEmailVerification(item.id)}
                                                    >
                                                        {busy === `verification-resend-${item.id}`
                                                            ? 'Sending…'
                                                            : (verifyCD[item.id] || 0) > clock
                                                              ? `Resend code in ${Math.ceil(((verifyCD[item.id] || 0) - clock) / 1000)}s`
                                                              : 'Resend code'}
                                                    </ActionButton>
                                                </form>
                                            ) : (
                                                <div className="settings-email-verify-prompt">
                                                    <span>
                                                        Verify this address to confirm you can receive email.
                                                    </span>
                                                    <ActionButton
                                                        type="button"
                                                        className="button secondary small-button"
                                                        disabled={!!busy}
                                                        unavailableReason={
                                                            busy
                                                                ? 'Wait for the current change to finish.'
                                                                : undefined
                                                        }
                                                        onClick={() => {
                                                            setVerifyEmailID(item.id);
                                                            setEmailVerification((current) => ({
                                                                ...current,
                                                                [item.id]: {
                                                                    ...current[item.id],
                                                                    code: '',
                                                                    message: '',
                                                                    isError: false,
                                                                },
                                                            }));
                                                            void resendEmailVerification(item.id);
                                                        }}
                                                    >
                                                        {busy === `verification-resend-${item.id}`
                                                            ? 'Sending…'
                                                            : 'Send verification code'}
                                                    </ActionButton>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </li>
                    ))}
                </ul>
                <form
                    className="settings-form settings-inline-form"
                    onSubmit={(event) => void addEmail(event)}
                >
                    <label htmlFor="settings-email">Add email address</label>
                    <div>
                        <input
                            id="settings-email"
                            type="email"
                            autoComplete="email"
                            required
                            value={email}
                            aria-invalid={!!emailError || undefined}
                            aria-describedby={emailError ? 'settings-email-error' : undefined}
                            onChange={(event) => {
                                const value = event.target.value;
                                setEmail(value);
                                setEmailError(value.trim() ? validateContactEmail(value, data.emails) : '');
                            }}
                            placeholder="name@example.com"
                            disabled={!data || loading}
                        />
                        <ActionButton
                            className="button primary"
                            type="submit"
                            disabled={!data || loading || !!busy}
                            unavailableReason={
                                loading
                                    ? 'Settings are still loading.'
                                    : busy
                                      ? 'Wait for the current change to finish.'
                                      : !data
                                        ? 'Settings are unavailable.'
                                        : undefined
                            }
                        >
                            {busy === 'email' ? 'Adding…' : 'Add email'}
                        </ActionButton>
                    </div>
                    {emailError && (
                        <p
                            id="settings-email-error"
                            className="settings-email-verify-message error"
                            role="alert"
                        >
                            {emailError}
                        </p>
                    )}
                </form>
                <p className="settings-footnote">
                    New or edited contact emails must be verified.{' '}
                    {data.emailVerificationAvailable
                        ? 'We’ll send a 6-digit code to the address you add.'
                        : 'Email verification is temporarily unavailable; you can still save an address and request a code later.'}
                </p>
            </section>

            <section className="settings-panel" aria-labelledby="settings-password-title">
                <div className="settings-section-heading">
                    <div>
                        <h2 id="settings-password-title">Password</h2>
                        <p>
                            {data.hasPassword
                                ? 'Choose a new password for your account.'
                                : 'Add a password as another way to sign in.'}
                        </p>
                    </div>
                </div>
                <form
                    className="settings-form settings-password-form"
                    onSubmit={(event) => void changePassword(event)}
                >
                    {data?.hasPassword && (
                        <PasswordInput
                            id="settings-current-password"
                            label="Current password"
                            autoComplete="current-password"
                            maxLength={128}
                            value={currentPassword}
                            onChange={(event) => {
                                setCurrentPassword(event.target.value);
                                if (wrongcurrpw) {
                                    setPasswordError('');
                                    setWrongcurrpw(false);
                                }
                            }}
                            aria-invalid={wrongcurrpw || undefined}
                            aria-describedby={wrongcurrpw ? 'settings-password-error' : undefined}
                            required
                        />
                    )}
                    {passwordError && (
                        <p
                            id="settings-password-error"
                            className="alert error"
                            role="alert"
                            aria-live="assertive"
                        >
                            {passwordError}
                        </p>
                    )}
                    <PasswordInput
                        label="New password"
                        autoComplete="new-password"
                        minLength={PASSWORD_MIN_LENGTH}
                        maxLength={PASSWORD_MAX_LENGTH}
                        pattern={PASSWORD_PATTERN}
                        title={PASSWORD_ERROR}
                        aria-describedby="settings-password-help"
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        required
                    />
                    <p id="settings-password-help" className="hint">
                        {PASSWORD_HELP}
                    </p>
                    <PasswordInput
                        label="Confirm new password"
                        autoComplete="new-password"
                        minLength={PASSWORD_MIN_LENGTH}
                        maxLength={PASSWORD_MAX_LENGTH}
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        required
                    />
                    <ActionButton
                        className="button primary"
                        type="submit"
                        disabled={!data || loading || !!busy}
                        unavailableReason={
                            loading
                                ? 'Settings are still loading.'
                                : busy
                                  ? 'Wait for the current change to finish.'
                                  : !data
                                    ? 'Settings are unavailable.'
                                    : undefined
                        }
                    >
                        {busy === 'password'
                            ? 'Saving…'
                            : data?.hasPassword
                              ? 'Change password'
                              : 'Set password'}
                    </ActionButton>
                </form>
                {!data.hasPassword && (
                    <p className="settings-footnote">
                        For Google accounts, setting a password requires a recent Google sign-in. You can then
                        use your linked Google email with that password.
                    </p>
                )}
            </section>

            <section className="settings-panel" aria-labelledby="settings-2fa-title">
                <div className="settings-section-heading">
                    <div>
                        <h2 id="settings-2fa-title">Authenticator sign-in</h2>
                        <p>
                            Use an authenticator or backup code instead of your password. You can also use
                            these codes to reset a forgotten password.
                        </p>
                    </div>
                    <span className={data?.twoFactor.enabled ? 'settings-badge verified' : 'settings-badge'}>
                        {data?.twoFactor.enabled ? 'Enabled' : 'Not enabled'}
                    </span>
                </div>
                {totpError && (
                    <p className="alert error" role="alert" aria-live="assertive">
                        {totpError}
                    </p>
                )}
                {data?.twoFactor.enabled ? (
                    <>
                        <form
                            className="settings-form settings-totp-form"
                            onSubmit={(event) => void disableTotp(event)}
                        >
                            {data.hasPassword && (
                                <PasswordInput
                                    label="Password"
                                    autoComplete="current-password"
                                    maxLength={128}
                                    value={disablePassword}
                                    onChange={(event) => setDisablePassword(event.target.value)}
                                    required
                                />
                            )}
                            <label>
                                Authenticator or backup code
                                <input
                                    type="text"
                                    autoComplete="one-time-code"
                                    maxLength={32}
                                    value={totpCode}
                                    onChange={(event) => setTotpCode(event.target.value)}
                                    required
                                    aria-describedby="settings-totp-disable-help"
                                />
                            </label>
                            <p id="settings-totp-disable-help" className="settings-footnote">
                                Enter a current 6-digit code, or a backup code.
                            </p>
                            <ActionButton
                                className="button secondary"
                                type="submit"
                                disabled={!!busy}
                                unavailableReason={
                                    busy ? 'Wait for the current change to finish.' : undefined
                                }
                            >
                                {busy === 'totp-disable' ? 'Disabling…' : 'Disable authenticator sign-in'}
                            </ActionButton>
                        </form>
                        <form
                            className="settings-form settings-recovery-form"
                            onSubmit={(event) => void regenerateRecovery(event)}
                        >
                            <label>
                                Current authenticator or backup code
                                <input
                                    type="text"
                                    autoComplete="one-time-code"
                                    maxLength={32}
                                    value={recoveryCode}
                                    onChange={(event) => setRecoveryCode(event.target.value)}
                                    required
                                />
                            </label>
                            {data.hasPassword && (
                                <PasswordInput
                                    label="Password"
                                    autoComplete="current-password"
                                    maxLength={128}
                                    value={recoveryPassword}
                                    onChange={(event) => setRecoveryPassword(event.target.value)}
                                    required
                                />
                            )}
                            <ActionButton
                                className="button secondary"
                                type="submit"
                                disabled={!!busy}
                                unavailableReason={
                                    busy ? 'Wait for the current change to finish.' : undefined
                                }
                            >
                                {busy === 'recovery' ? 'Generating…' : 'Generate new codes'}
                            </ActionButton>
                        </form>
                    </>
                ) : (
                    <>
                        {!totpSetup ? (
                            <div className="settings-totp-start">
                                {recentSignIn ? (
                                    <p className="settings-footnote">
                                        Your recent sign-in is confirmed. You can continue without entering
                                        your website password.
                                    </p>
                                ) : (
                                    <p className="settings-footnote">
                                        {data.hasPassword
                                            ? 'Enter your current Manhunt IX website password, or sign out and sign in again, then return here within five minutes.'
                                            : 'Sign out and sign in with Google again, then return here within five minutes.'}
                                    </p>
                                )}
                                {data.hasPassword && !recentSignIn && (
                                    <PasswordInput
                                        label="Current password"
                                        autoComplete="current-password"
                                        maxLength={128}
                                        value={setupPassword}
                                        onChange={(event) => setSetupPassword(event.target.value)}
                                        disabled={!!busy}
                                    />
                                )}
                                <ActionButton
                                    className="button primary"
                                    type="button"
                                    disabled={
                                        !!busy || (!recentSignIn && (!data.hasPassword || !setupPassword))
                                    }
                                    unavailableReason={
                                        busy
                                            ? 'Wait for the current change to finish.'
                                            : !recentSignIn && !data.hasPassword
                                              ? 'Sign in with Google again, then return here within five minutes.'
                                              : !recentSignIn && !setupPassword
                                                ? 'Enter your current password to confirm this change.'
                                                : undefined
                                    }
                                    onClick={() => void beginTotp()}
                                >
                                    {busy === 'totp-setup' ? 'Preparing…' : 'Set up authenticator app'}
                                </ActionButton>
                            </div>
                        ) : (
                            <div className="settings-totp-setup">
                                <p>
                                    Scan this QR code in your authenticator app. If scanning is unavailable,
                                    add the setup key manually. Keep it private.
                                </p>
                                {totpQr === 'error' ? (
                                    <p className="settings-email-verify-message error" role="alert">
                                        The QR code could not be generated. Enter the setup key below in your
                                        authenticator app instead.
                                    </p>
                                ) : totpQr ? (
                                    <img
                                        className="settings-totp-qr"
                                        src={totpQr}
                                        alt="QR code for authenticator app setup"
                                    />
                                ) : (
                                    <p className="settings-muted">Preparing QR code…</p>
                                )}
                                <label className="settings-secret-label">
                                    Setup key<code>{totpSetup.secret}</code>
                                </label>
                                <details>
                                    <summary>Show setup link</summary>
                                    <code className="settings-otpauth">{totpSetup.otpauthUri}</code>
                                </details>
                                <form
                                    className="settings-form settings-totp-form"
                                    onSubmit={(event) => void activateTotp(event)}
                                >
                                    <label>
                                        6-digit code from your app
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            autoComplete="one-time-code"
                                            pattern="[0-9]{6}"
                                            maxLength={6}
                                            value={totpCode}
                                            onChange={(event) =>
                                                setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                                            }
                                            required
                                        />
                                    </label>
                                    <ActionButton
                                        className="button primary"
                                        type="submit"
                                        disabled={!!busy || totpCode.length !== 6}
                                        unavailableReason={
                                            busy
                                                ? 'Wait for the current change to finish.'
                                                : totpCode.length !== 6
                                                  ? 'Enter all 6 digits to continue.'
                                                  : undefined
                                        }
                                    >
                                        {busy === 'totp-activate' ? 'Verifying…' : 'Verify and enable'}
                                    </ActionButton>
                                    <ActionButton
                                        className="button quiet"
                                        type="button"
                                        disabled={!!busy}
                                        unavailableReason={
                                            busy ? 'Wait for the current change to finish.' : undefined
                                        }
                                        onClick={() => {
                                            setTotpSetup(null);
                                            setTotpCode('');
                                        }}
                                    >
                                        Cancel setup
                                    </ActionButton>
                                </form>
                            </div>
                        )}
                    </>
                )}
                {recoveryCodes && (
                    <div className="settings-recovery-codes" role="status">
                        <h3>Save your backup codes</h3>
                        <p>Each code can be used once. This list will disappear when you leave this page.</p>
                        <ul>
                            {recoveryCodes.map((code) => (
                                <li key={code}>
                                    <code>{code}</code>
                                </li>
                            ))}
                        </ul>
                        <button className="button secondary" type="button" onClick={downloadRecovery}>
                            Download codes
                        </button>
                        <button className="button quiet" type="button" onClick={() => setRecoveryCodes(null)}>
                            Done
                        </button>
                    </div>
                )}
            </section>
        </div>
    );
}
