import { useEffect, useId, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import type { Group } from '../../shared/types';
import type { AdminPerson } from '../../shared/accounts/settings';
import { GroupMembers } from '../groups/GroupMembers';
import { PasswordInput } from '../accounts/PasswordInput';
import { ActionButton } from '../ui/ActionButton';
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
import './adminPeopleSettings.css';

type Props = { groups: Group[]; accountId: string; onChanged?: () => Promise<void> };
type Panel = 'admin' | 'invite' | 'people' | 'delete' | null;
type DeletionOptions = {
    canDelete: boolean;
    players: Array<{
        id: string;
        username: string;
        displayName: string;
        groupId: string | null;
        status: string;
    }>;
    groups: Array<{ id: string; name: string; playerCount: number; disbanded: boolean }>;
};

export function AdminPeopleSettings({ groups, accountId, onChanged }: Props) {
    const id = useId();
    const [panel, setPanel] = useState<Panel>(null);
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [groupId, setGroupId] = useState('');
    const [copied, setCopied] = useState(false);
    const [shareError, setShareError] = useState('');
    const [signupQr, setSignupQr] = useState('');
    const [signupQrError, setSignupQrError] = useState(false);
    const [people, setPeople] = useState<AdminPerson[] | null>(null);
    const [loadingPeople, setLoadingPeople] = useState(false);
    const [roleBusy, setRoleBusy] = useState('');
    const [deletionOptions, setDeletionOptions] = useState<DeletionOptions | null>(null);
    const [canDelete, setCanDelete] = useState(false);
    const [deletionLoading, setDeletionLoading] = useState(false);
    const [deletionError, setDeletionError] = useState('');
    const [deletionNotice, setDeletionNotice] = useState('');
    const [deletionType, setDeletionType] = useState<'player' | 'group'>('player');
    const [deletionTargetId, setDeletionTargetId] = useState('');
    const [confirmDel, setConfirmDel] = useState('');
    const [deletionBusy, setDeletionBusy] = useState(false);
    const signupUrl = `${window.location.origin}/register`;

    useEffect(() => {
        let active = true;
        void QRCode.toDataURL(signupUrl, { width: 192, margin: 1, errorCorrectionLevel: 'Q' })
            .then((value) => {
                if (active) setSignupQr(value);
            })
            .catch(() => {
                if (active) {
                    setSignupQr('');
                    setSignupQrError(true);
                }
            });
        return () => {
            active = false;
        };
    }, [signupUrl]);

    useEffect(() => {
        void loadDelOpts();
    }, []);

    useEffect(() => {
        if (panel === 'people') void loadPeople();
    }, [panel]);

    async function loadPeople() {
        setLoadingPeople(true);
        setError('');
        try {
            const response = await fetch('/api/admin/people', { credentials: 'same-origin' });
            const data = (await response.json().catch(() => ({}))) as {
                people?: AdminPerson[];
                error?: string;
                message?: string;
            };
            if (!response.ok)
                throw new Error(data.error || data.message || 'Could not load administrator roles.');
            setPeople(data.people ?? []);
        } catch (cause) {
            setPeople(null);
            setError(cause instanceof Error ? cause.message : 'Could not load administrator roles.');
        } finally {
            setLoadingPeople(false);
        }
    }

    async function loadDelOpts() {
        setDeletionLoading(true);
        setDeletionError('');
        try {
            const response = await fetch('/api/admin/deletion-options', { credentials: 'same-origin' });
            const data = (await response.json().catch(() => ({}))) as DeletionOptions & {
                error?: string;
                message?: string;
            };
            if (!response.ok)
                throw new Error(data.error || data.message || 'Could not load deletion options.');
            setDeletionOptions({
                canDelete: data.canDelete === true,
                players: data.players ?? [],
                groups: data.groups ?? [],
            });
            setCanDelete(data.canDelete === true);
            if (!data.canDelete) {
                setDeletionTargetId('');
                setConfirmDel('');
            } else
                setDeletionTargetId((current) => {
                    const options = deletionType === 'player' ? (data.players ?? []) : (data.groups ?? []);
                    return options.some((option) => option.id === current) ? current : '';
                });
        } catch (cause) {
            setDeletionError(cause instanceof Error ? cause.message : 'Could not load deletion options.');
        } finally {
            setDeletionLoading(false);
        }
    }

    function openDelPnl() {
        setError('');
        setNotice('');
        setDeletionError('');
        setDeletionNotice('');
        setDeletionType('player');
        setDeletionTargetId('');
        setConfirmDel('');
        setPanel((current) => (current === 'delete' ? null : 'delete'));
        void loadDelOpts();
    }

    async function deleteSelected() {
        const target =
            deletionType === 'player'
                ? deletionOptions?.players.find((item) => item.id === deletionTargetId)
                : deletionOptions?.groups.find((item) => item.id === deletionTargetId);
        const exactName =
            deletionType === 'player' && target
                ? (target as DeletionOptions['players'][number]).username
                : (target as DeletionOptions['groups'][number] | undefined)?.name;
        if (!target || !exactName || confirmDel !== exactName) return;
        setDeletionBusy(true);
        setDeletionError('');
        setDeletionNotice('');
        let deleteok = false;
        try {
            const path =
                deletionType === 'player'
                    ? `/api/admin/accounts/${encodeURIComponent(target.id)}`
                    : `/api/admin/groups/${encodeURIComponent(target.id)}`;
            const response = await fetch(path, {
                method: 'DELETE',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmation: confirmDel }),
            });
            const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
            if (!response.ok)
                throw new Error(data.error || data.message || `Could not delete this ${deletionType}.`);
            deleteok = true;
            const deletedName =
                deletionType === 'player'
                    ? (target as DeletionOptions['players'][number]).displayName ||
                      (target as DeletionOptions['players'][number]).username
                    : (target as DeletionOptions['groups'][number]).name;
            if (deletionType === 'group' && groupId === target.id) setGroupId('');
            setDeletionTargetId('');
            setConfirmDel('');
            setDeletionNotice(
                deletionType === 'player'
                    ? `${deletedName} was deleted.`
                    : `${deletedName} was deleted. Player accounts remain active.`,
            );
            await loadDelOpts();
            await onChanged?.();
        } catch (cause) {
            if (deleteok) {
                setDeletionError(
                    'Deletion completed, but the dashboard could not refresh. Refresh the page to see current data.',
                );
            } else {
                setDeletionError(
                    cause instanceof Error ? cause.message : `Could not delete this ${deletionType}.`,
                );
            }
        } finally {
            setDeletionBusy(false);
        }
    }

    async function changeRole(person: AdminPerson, role: 'admin' | 'player') {
        setRoleBusy(person.id);
        setError('');
        setNotice('');
        try {
            const response = await fetch(`/api/admin/accounts/${encodeURIComponent(person.id)}/role`, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role }),
            });
            const data = (await response.json().catch(() => ({}))) as {
                person?: AdminPerson;
                error?: string;
                message?: string;
            };
            if (!response.ok)
                throw new Error(data.error || data.message || 'Could not change the administrator role.');
            if (data.person)
                setPeople(
                    (current) =>
                        current?.map((item) => (item.id === data.person!.id ? data.person! : item)) ??
                        current,
                );
            setNotice(
                role === 'admin'
                    ? `${person.displayName || person.username} is now an administrator.`
                    : `${person.displayName || person.username} is now a player.`,
            );
            await onChanged?.();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not change the administrator role.');
        } finally {
            setRoleBusy('');
        }
    }

    async function copySignupLink() {
        setShareError('');
        try {
            await navigator.clipboard.writeText(signupUrl);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2200);
        } catch {
            setCopied(false);
            setShareError('Could not copy the link. Select and copy it from the field above.');
        }
    }

    async function createAdmin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError('');
        setNotice('');
        if (!validUsername(username.trim())) {
            setError(USERNAME_ERROR);
            return;
        }
        if (!validPassword(password)) {
            setError(PASSWORD_ERROR);
            return;
        }
        if (password !== confirmPassword) {
            setError('The passwords do not match.');
            return;
        }
        setBusy(true);
        try {
            const response = await fetch('/api/admin/accounts/create', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: username.trim(),
                    displayName: displayName.trim(),
                    password,
                    ...(email.trim() ? { email: email.trim() } : {}),
                }),
            });
            const data = (await response.json().catch(() => ({}))) as {
                account?: { role?: string };
                message?: string;
                error?: string;
            };
            if (!response.ok)
                throw new Error(data.error || data.message || 'Could not create the administrator account.');
            if (data.account?.role !== 'admin')
                throw new Error('The administrator account could not be confirmed.');
            setUsername('');
            setDisplayName('');
            setEmail('');
            setPassword('');
            setConfirmPassword('');
            setNotice(data.message || 'Administrator account created.');
            await onChanged?.();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not create the administrator account.');
        } finally {
            setBusy(false);
        }
    }

    function toggle(next: Exclude<Panel, null>) {
        setError('');
        setNotice('');
        setPanel((current) => (current === next ? null : next));
    }

    return (
        <section className="admin-people-settings" aria-labelledby={`${id}-heading`}>
            <div className="admin-people-heading">
                <div>
                    <p>PEOPLE</p>
                    <h2 id={`${id}-heading`}>Admin and invitations</h2>
                    <span>Manage organiser accounts and share a signup link with players.</span>
                </div>
            </div>
            <div className="admin-people-actions">
                <button
                    className="admin-people-action"
                    type="button"
                    disabled={deletionBusy}
                    aria-expanded={panel === 'admin'}
                    aria-controls={`${id}-create-admin`}
                    onClick={() => toggle('admin')}
                >
                    <span className="admin-people-icon" aria-hidden="true">
                        +
                    </span>
                    <span>
                        <strong>Create new admin</strong>
                        <small>Add another trusted organiser account.</small>
                    </span>
                    <span className="admin-people-chevron" aria-hidden="true">
                        {panel === 'admin' ? '−' : '›'}
                    </span>
                </button>
                <button
                    className="admin-people-action"
                    type="button"
                    disabled={deletionBusy}
                    aria-expanded={panel === 'invite'}
                    aria-controls={`${id}-invite-user`}
                    onClick={() => toggle('invite')}
                >
                    <span className="admin-people-icon" aria-hidden="true">
                        ↗
                    </span>
                    <span>
                        <strong>Invite user</strong>
                        <small>Share signup or invite a player to a group.</small>
                    </span>
                    <span className="admin-people-chevron" aria-hidden="true">
                        {panel === 'invite' ? '−' : '›'}
                    </span>
                </button>
                <button
                    className="admin-people-action"
                    type="button"
                    disabled={deletionBusy}
                    aria-expanded={panel === 'people'}
                    aria-controls={`${id}-manage-roles`}
                    onClick={() => toggle('people')}
                >
                    <span className="admin-people-icon" aria-hidden="true">
                        ⇅
                    </span>
                    <span>
                        <strong>Promote or demote</strong>
                        <small>Change an approved account's administrator role.</small>
                    </span>
                    <span className="admin-people-chevron" aria-hidden="true">
                        {panel === 'people' ? '−' : '›'}
                    </span>
                </button>
                {canDelete && (
                    <button
                        className="admin-people-action"
                        type="button"
                        disabled={deletionBusy}
                        aria-expanded={panel === 'delete'}
                        aria-controls={`${id}-delete-people`}
                        onClick={openDelPnl}
                    >
                        <span className="admin-people-icon" aria-hidden="true">
                            −
                        </span>
                        <span>
                            <strong>Delete players or groups</strong>
                            <small>Remove player accounts or groups from active lists.</small>
                        </span>
                        <span className="admin-people-chevron" aria-hidden="true">
                            {panel === 'delete' ? '−' : '›'}
                        </span>
                    </button>
                )}
            </div>
            {error && (
                <p className="admin-people-error" role="alert">
                    {error}
                </p>
            )}
            {notice && (
                <p className="admin-people-success" role="status">
                    {notice}
                </p>
            )}
            {deletionOptions === null && deletionLoading && (
                <p className="admin-people-muted" role="status">
                    Checking deletion access…
                </p>
            )}
            {deletionOptions === null && deletionError && (
                <div className="admin-deletion-access-error">
                    <p className="admin-people-error" role="alert">
                        {deletionError}
                    </p>
                    <button
                        className="admin-people-secondary"
                        type="button"
                        disabled={deletionLoading}
                        onClick={() => void loadDelOpts()}
                    >
                        {deletionLoading ? 'Checking…' : 'Retry access check'}
                    </button>
                </div>
            )}

            {panel === 'admin' && (
                <section
                    id={`${id}-create-admin`}
                    className="admin-people-panel"
                    aria-labelledby={`${id}-create-admin-title`}
                >
                    <div>
                        <h3 id={`${id}-create-admin-title`}>Create an administrator</h3>
                        <p>
                            Choose their username and password. An email is optional and is saved as an
                            unverified contact.
                        </p>
                    </div>
                    <form className="admin-create-form" onSubmit={(event) => void createAdmin(event)}>
                        <label>
                            Username
                            <input
                                autoComplete="off"
                                name="new-admin-username"
                                value={username}
                                onChange={(event) => setUsername(event.target.value)}
                                required
                                maxLength={USERNAME_MAX_LENGTH}
                            />
                        </label>
                        <label>
                            Display name
                            <input
                                autoComplete="off"
                                name="new-admin-display-name"
                                value={displayName}
                                onChange={(event) => setDisplayName(event.target.value)}
                                required
                                maxLength={80}
                            />
                        </label>
                        <label>
                            Email address <span className="admin-people-optional">Optional</span>
                            <input
                                autoComplete="off"
                                name="new-admin-email"
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                maxLength={254}
                                placeholder="name@example.com"
                            />
                        </label>
                        <PasswordInput
                            label="Password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                            minLength={PASSWORD_MIN_LENGTH}
                            maxLength={PASSWORD_MAX_LENGTH}
                            pattern={PASSWORD_PATTERN}
                            title={PASSWORD_ERROR}
                            aria-describedby={`${id}-password-help`}
                        />
                        <p id={`${id}-password-help`} className="hint">
                            {PASSWORD_HELP}
                        </p>
                        <PasswordInput
                            label="Confirm password"
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            required
                            minLength={PASSWORD_MIN_LENGTH}
                            maxLength={PASSWORD_MAX_LENGTH}
                        />
                        <ActionButton
                            className="admin-people-primary"
                            type="submit"
                            disabled={
                                busy ||
                                !username.trim() ||
                                !displayName.trim() ||
                                !password ||
                                !confirmPassword
                            }
                            unavailableReason={
                                busy
                                    ? 'Please wait while the administrator account is created.'
                                    : !username.trim()
                                      ? 'Enter a username to continue.'
                                      : !displayName.trim()
                                        ? 'Enter a display name to continue.'
                                        : !password
                                          ? 'Enter a password to continue.'
                                          : !confirmPassword
                                            ? 'Confirm the password to continue.'
                                            : undefined
                            }
                        >
                            {busy ? 'Creating…' : 'Create admin account'}
                        </ActionButton>
                    </form>
                </section>
            )}

            {panel === 'people' && (
                <section
                    id={`${id}-manage-roles`}
                    className="admin-people-panel"
                    aria-labelledby={`${id}-manage-roles-title`}
                >
                    <div>
                        <h3 id={`${id}-manage-roles-title`}>Administrator roles</h3>
                        <p>
                            Promote a player to administrator or demote an administrator back to player. The
                            Manhunt head administrator cannot be changed.
                        </p>
                    </div>
                    {loadingPeople ? (
                        <p className="admin-people-muted" role="status">
                            Loading approved accounts…
                        </p>
                    ) : people === null ? (
                        <p className="admin-people-muted">
                            Could not load approved accounts. Close this panel and try again.
                        </p>
                    ) : people.length === 0 ? (
                        <p className="admin-people-muted">No approved accounts found.</p>
                    ) : (
                        <ul className="admin-people-list">
                            {people.map((person) => {
                                const roleLabel = person.headAdmin
                                    ? 'Head admin'
                                    : person.role === 'admin'
                                      ? 'Administrator'
                                      : 'Player';
                                const busyLabel = roleBusy === person.id;
                                return (
                                    <li className="admin-people-row" key={person.id}>
                                        <div className="admin-people-person">
                                            <strong>{person.displayName || person.username}</strong>
                                            <span>
                                                @{person.username}
                                                {person.email ? ` · ${person.email}` : ''}
                                            </span>
                                            <span
                                                className={
                                                    person.role === 'admin'
                                                        ? 'admin-people-badge admin'
                                                        : 'admin-people-badge'
                                                }
                                            >
                                                {roleLabel}
                                            </span>
                                        </div>
                                        {person.headAdmin ? (
                                            <p className="admin-people-protected">
                                                The Manhunt head administrator cannot be modified.
                                            </p>
                                        ) : person.id === accountId ? (
                                            <p className="admin-people-protected">
                                                You cannot change your own role.
                                            </p>
                                        ) : (
                                            <ActionButton
                                                className={
                                                    person.role === 'admin'
                                                        ? 'admin-people-secondary admin-role-action'
                                                        : 'admin-people-primary admin-role-action'
                                                }
                                                type="button"
                                                disabled={!!roleBusy}
                                                unavailableReason={
                                                    roleBusy
                                                        ? 'Wait for the current role change to finish.'
                                                        : undefined
                                                }
                                                onClick={() =>
                                                    void changeRole(
                                                        person,
                                                        person.role === 'admin' ? 'player' : 'admin',
                                                    )
                                                }
                                            >
                                                {busyLabel
                                                    ? 'Saving…'
                                                    : person.role === 'admin'
                                                      ? 'Demote to player'
                                                      : 'Make administrator'}
                                            </ActionButton>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            )}

            {panel === 'invite' && (
                <section
                    id={`${id}-invite-user`}
                    className="admin-people-panel"
                    aria-labelledby={`${id}-invite-user-title`}
                >
                    <div>
                        <h3 id={`${id}-invite-user-title`}>Invite a user</h3>
                        <p>
                            Share this signup page with someone who needs an account. New accounts must be
                            approved by an admin before they can access events.
                        </p>
                    </div>
                    <div className="admin-signup-share">
                        <label htmlFor={`${id}-signup-link`}>Signup link</label>
                        <div className="admin-signup-link-row">
                            <input
                                id={`${id}-signup-link`}
                                type="text"
                                readOnly
                                value={signupUrl}
                                onFocus={(event) => event.currentTarget.select()}
                            />
                            <button
                                type="button"
                                className="admin-people-secondary"
                                onClick={() => void copySignupLink()}
                            >
                                {copied ? 'Copied' : 'Copy link'}
                            </button>
                        </div>
                        {shareError && (
                            <p className="admin-people-error" role="alert">
                                {shareError}
                            </p>
                        )}
                        {signupQr ? (
                            <img
                                src={signupQr}
                                width="192"
                                height="192"
                                alt="QR code for the account signup page"
                            />
                        ) : signupQrError ? (
                            <p className="admin-people-error" role="alert">
                                Could not create the QR code. You can still share the signup link above.
                            </p>
                        ) : (
                            <p className="admin-people-muted">Creating QR code…</p>
                        )}
                    </div>
                    {groups.length > 0 && (
                        <div className="admin-group-invite">
                            <label htmlFor={`${id}-invite-group`}>Invite to a group with their email</label>
                            <select
                                id={`${id}-invite-group`}
                                value={groupId}
                                onChange={(event) => setGroupId(event.target.value)}
                            >
                                <option value="">Choose a group</option>
                                {groups.map((group) => (
                                    <option key={group.id} value={group.id}>
                                        {group.name}
                                    </option>
                                ))}
                            </select>
                            {groupId && (
                                <GroupMembers key={groupId} groupId={groupId} onChanged={onChanged} />
                            )}
                        </div>
                    )}
                </section>
            )}
            {panel === 'delete' && canDelete && (
                <section
                    id={`${id}-delete-people`}
                    className="admin-people-panel"
                    aria-labelledby={`${id}-delete-people-title`}
                >
                    <div>
                        <h3 id={`${id}-delete-people-title`}>Delete players or groups</h3>
                        <p>
                            Choose one item, then confirm by typing its exact name. Deleting a player removes
                            their sign-in access and contact details. Existing submissions and review history
                            are kept. Deleting a group removes it from active lists and cancels its
                            invitations and unfinished uploads; its players keep their accounts, and review
                            history and evidence stay available.
                        </p>
                    </div>
                    {deletionNotice && (
                        <p className="admin-people-success" role="status">
                            {deletionNotice}
                        </p>
                    )}
                    {deletionError && (
                        <p className="admin-people-error" role="alert">
                            {deletionError}
                        </p>
                    )}
                    {deletionLoading ? (
                        <p className="admin-people-muted" role="status">
                            Loading players and groups…
                        </p>
                    ) : deletionOptions === null || deletionError ? (
                        <button
                            className="admin-people-secondary"
                            type="button"
                            disabled={deletionBusy}
                            onClick={() => void loadDelOpts()}
                        >
                            Try again
                        </button>
                    ) : (
                        <>
                            <div className="admin-deletion-controls">
                                <label>
                                    What would you like to delete?
                                    <select
                                        value={deletionType}
                                        disabled={deletionBusy}
                                        onChange={(event) => {
                                            setDeletionType(event.target.value as 'player' | 'group');
                                            setDeletionTargetId('');
                                            setConfirmDel('');
                                            setDeletionError('');
                                        }}
                                    >
                                        <option value="player">Player account</option>
                                        <option value="group">Group</option>
                                    </select>
                                </label>
                                <label>
                                    {deletionType === 'player' ? 'Player account' : 'Group'}
                                    <select
                                        value={deletionTargetId}
                                        disabled={deletionBusy}
                                        onChange={(event) => {
                                            setDeletionTargetId(event.target.value);
                                            setConfirmDel('');
                                            setDeletionError('');
                                        }}
                                    >
                                        <option value="">
                                            Choose {deletionType === 'player' ? 'a player' : 'a group'}
                                        </option>
                                        {deletionType === 'player'
                                            ? deletionOptions.players.map((item) => (
                                                  <option key={item.id} value={item.id}>
                                                      {item.displayName || item.username} (@{item.username})
                                                      {item.groupId ? '' : ' · no group'}
                                                  </option>
                                              ))
                                            : deletionOptions.groups.map((item) => (
                                                  <option key={item.id} value={item.id}>
                                                      {item.name} · {item.playerCount}{' '}
                                                      {item.playerCount === 1 ? 'player' : 'players'}
                                                      {item.disbanded ? ' · disbanded' : ''}
                                                  </option>
                                              ))}
                                    </select>
                                </label>
                            </div>
                            {deletionType === 'player' && deletionOptions.players.length === 0 && (
                                <p className="admin-people-muted">
                                    No player accounts are available to delete.
                                </p>
                            )}
                            {deletionType === 'group' && deletionOptions.groups.length === 0 && (
                                <p className="admin-people-muted">No groups are available to delete.</p>
                            )}
                            {deletionTargetId &&
                                (() => {
                                    const target =
                                        deletionType === 'player'
                                            ? deletionOptions.players.find(
                                                  (item) => item.id === deletionTargetId,
                                              )
                                            : deletionOptions.groups.find(
                                                  (item) => item.id === deletionTargetId,
                                              );
                                    if (!target) return null;
                                    const exactName =
                                        deletionType === 'player'
                                            ? (target as DeletionOptions['players'][number]).username
                                            : (target as DeletionOptions['groups'][number]).name;
                                    return (
                                        <div className="admin-deletion-confirm">
                                            <label htmlFor={`${id}-delete-confirmation`}>
                                                Type <strong>{exactName}</strong> to confirm
                                                <input
                                                    id={`${id}-delete-confirmation`}
                                                    autoComplete="off"
                                                    value={confirmDel}
                                                    disabled={deletionBusy}
                                                    onChange={(event) => setConfirmDel(event.target.value)}
                                                />
                                            </label>
                                            <div className="admin-deletion-actions">
                                                <ActionButton
                                                    className="button danger"
                                                    type="button"
                                                    disabled={deletionBusy || confirmDel !== exactName}
                                                    unavailableReason={
                                                        deletionBusy
                                                            ? 'Wait for the current deletion to finish.'
                                                            : confirmDel !== exactName
                                                              ? `Type ${exactName} exactly to confirm.`
                                                              : undefined
                                                    }
                                                    onClick={() => void deleteSelected()}
                                                >
                                                    {deletionBusy ? 'Deleting…' : `Delete ${deletionType}`}
                                                </ActionButton>
                                                <ActionButton
                                                    className="button quiet"
                                                    type="button"
                                                    disabled={deletionBusy}
                                                    unavailableReason={
                                                        deletionBusy
                                                            ? 'Wait for the current deletion to finish.'
                                                            : undefined
                                                    }
                                                    onClick={() => {
                                                        setDeletionTargetId('');
                                                        setConfirmDel('');
                                                        setDeletionError('');
                                                    }}
                                                >
                                                    Cancel
                                                </ActionButton>
                                            </div>
                                        </div>
                                    );
                                })()}
                        </>
                    )}
                </section>
            )}
        </section>
    );
}
