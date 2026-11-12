import type { FormEventHandler, MouseEvent, RefObject } from 'react';
import type { AuthOptions } from './authMethods';
import type { PendingInvitation } from '../invitations/invitation';
import type { SitePage } from '../app/navigation';
import { Brand } from '../ui/Brand';
import { ActionButton } from '../ui/ActionButton';
import { GoogleSignIn } from './authMethods';
import { AuthenticatorLogin, PasswordRecovery } from './AccountRecovery';
import { EmailCodeSignIn } from './EmailCodeSignIn';
import { PasswordInput } from './PasswordInput';
import { LegalLinks } from '../ui/LegalLinks';
import { REGISTRATION_PHONE_MAX_LENGTH } from '../../shared/accounts/registrationPhone';
import {
    PASSWORD_ERROR,
    PASSWORD_HELP,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PASSWORD_PATTERN,
    USERNAME_MAX_LENGTH,
} from '../../shared/accounts/credentials';

type AuthPageProps = {
    mode: {
        page: SitePage;
        googlePhoneOnly: boolean;
    };
    authOptions: AuthOptions;
    pendingInvitation: PendingInvitation | null;
    registration: {
        phone: string;
        setPhone: (value: string) => void;
        groupName: string;
        setGroupName: (value: string) => void;
        members: string;
        setMembers: (value: string) => void;
        displayName: string;
        setDisplayName: (value: string) => void;
        email: string;
        setEmail: (value: string) => void;
    };
    login: {
        method: 'password' | 'email-code';
        setMethod: (value: 'password' | 'email-code') => void;
        username: string;
        setUsername: (value: string) => void;
        password: string;
        setPassword: (value: string) => void;
        confirmPassword: string;
        setConfirmPassword: (value: string) => void;
    };
    feedback: {
        error: string;
        setError: (value: string) => void;
        notice: string;
        setNotice: (value: string) => void;
        errorMessage: RefObject<HTMLParagraphElement | null>;
    };
    navigation: {
        search: string;
        loginHref: string;
        followLink: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
        navigateUrl: (url: string) => void;
    };
    actions: {
        busy: boolean;
        submitAuth: FormEventHandler<HTMLFormElement>;
        onSignedIn: () => Promise<void>;
    };
};

export function AuthPage({
    mode,
    authOptions,
    pendingInvitation,
    registration,
    login,
    feedback,
    navigation,
    actions,
}: AuthPageProps) {
    const { page, googlePhoneOnly } = mode;
    const register = page === 'register';
    const {
        phone: registrationPhone,
        setPhone: setRegistrationPhone,
        groupName,
        members,
        setGroupName,
        setMembers,
        displayName,
        setDisplayName,
        email: registrationEmail,
        setEmail: setRegistrationEmail,
    } = registration;
    const {
        method: loginMethod,
        setMethod: setLoginMethod,
        username,
        setUsername,
        password,
        setPassword,
        confirmPassword,
        setConfirmPassword,
    } = login;
    const { error, setError, notice, setNotice, errorMessage } = feedback;
    const { search, loginHref, followLink, navigateUrl } = navigation;
    const { busy } = actions;

    return (
        <main className="auth-page" id="main-content" tabIndex={-1}>
            <div className="auth-layout">
                <aside className="auth-event" aria-label="About Manhunt IX">
                    <Brand />
                    <p className="auth-event-kicker">Manhunt IX · Singapore</p>
                    <p className="auth-event-title">
                        The hunt starts
                        <br />
                        with your group.
                    </p>
                    <p className="auth-event-description">
                        Your tasks, your evidence, and a little help from the organisers. All together here.
                    </p>
                    <div className="auth-event-date">
                        <time dateTime="2026-11-13">Friday, 13 November 2026</time>
                        <span>Group challenge portal</span>
                    </div>
                </aside>
                <div className="auth-shell">
                    {page === 'authenticator' ? (
                        <AuthenticatorLogin
                            onSignedIn={actions.onSignedIn}
                            onBack={() => navigateUrl(`/login${search}`)}
                        />
                    ) : page === 'recovery' ? (
                        <PasswordRecovery onBack={() => navigateUrl(`/login${search}`)} />
                    ) : (
                        <>
                            <section className="auth-card">
                                <h1>{register ? 'Create your account' : 'Welcome back'}</h1>
                                <p className="subtext">
                                    {googlePhoneOnly
                                        ? 'Enter your phone number, then continue with Google to create your account.'
                                        : register
                                          ? 'Create an account, then wait for an organiser to approve your access.'
                                          : 'Sign in to pick up where your group left off.'}
                                </p>
                                {pendingInvitation && (
                                    <p className="auth-invitation-note" role="status">
                                        Your group invitation is saved.{' '}
                                        {register
                                            ? 'Create your account to join the group.'
                                            : 'Sign in or create an account to join the group.'}
                                    </p>
                                )}
                                {register && (
                                    <label className="registration-phone">
                                        Phone number (required)
                                        <input
                                            id="registration-phone"
                                            name="phone"
                                            form="registration-form"
                                            required
                                            type="tel"
                                            autoComplete="tel"
                                            maxLength={REGISTRATION_PHONE_MAX_LENGTH}
                                            value={registrationPhone}
                                            onChange={(event) => setRegistrationPhone(event.target.value)}
                                            placeholder="e.g. 8123 4567 or +65 8123 4567"
                                            aria-describedby="registration-phone-help"
                                        />
                                        <span id="registration-phone-help" className="hint">
                                            Only authorised organisers can see this number. They use it to
                                            review your account request.
                                        </span>
                                    </label>
                                )}
                                <GoogleSignIn
                                    key={
                                        googlePhoneOnly ? 'google-register' : register ? 'register' : 'login'
                                    }
                                    mode={register ? 'register' : 'login'}
                                    options={authOptions}
                                    phoneOnly={googlePhoneOnly}
                                    phone={registrationPhone}
                                    groupName={pendingInvitation || googlePhoneOnly ? '' : groupName}
                                    members={
                                        pendingInvitation || googlePhoneOnly
                                            ? []
                                            : members
                                                  .split(/\r?\n/)
                                                  .map((member) => member.trim())
                                                  .filter(Boolean)
                                    }
                                />
                                {googlePhoneOnly && error && (
                                    <p className="alert error" role="alert" tabIndex={-1} ref={errorMessage}>
                                        {error}
                                    </p>
                                )}
                                {!register && (
                                    <a
                                        className="button secondary full signup-primary-link"
                                        href={`/register${search}`}
                                        onClick={(event) => followLink(event, `/register${search}`)}
                                    >
                                        Sign Up
                                    </a>
                                )}
                                {!googlePhoneOnly && (
                                    <p className="auth-divider">
                                        {register
                                            ? 'Or sign up with a username'
                                            : 'Or sign in with your password'}
                                    </p>
                                )}
                                {!register && (
                                    <div
                                        className="login-method-switch"
                                        role="group"
                                        aria-label="Choose sign-in method"
                                    >
                                        <ActionButton
                                            type="button"
                                            className={`button ${loginMethod === 'password' ? 'primary' : 'secondary'}`}
                                            aria-pressed={loginMethod === 'password'}
                                            onClick={() => {
                                                setLoginMethod('password');
                                                setError('');
                                                setNotice('');
                                            }}
                                        >
                                            Password
                                        </ActionButton>
                                        <ActionButton
                                            type="button"
                                            className={`button ${loginMethod === 'email-code' ? 'primary' : 'secondary'}`}
                                            aria-pressed={loginMethod === 'email-code'}
                                            disabled={!authOptions.emailOtpEnabled}
                                            unavailableReason="Email-code sign-in is unavailable right now. Use your password or another available sign-in method."
                                            onClick={() => {
                                                setLoginMethod('email-code');
                                                setPassword('');
                                                setError('');
                                                setNotice('');
                                            }}
                                        >
                                            Email code
                                        </ActionButton>
                                    </div>
                                )}
                                {!register && !authOptions.emailOtpEnabled && (
                                    <p className="hint email-code-unavailable">
                                        Email code sign-in is temporarily unavailable. Use your password
                                        instead.
                                    </p>
                                )}
                                {!googlePhoneOnly &&
                                    (register || loginMethod === 'password' ? (
                                        <form
                                            id={register ? 'registration-form' : undefined}
                                            onSubmit={actions.submitAuth}
                                            className="stack"
                                        >
                                            {register && (
                                                <label>
                                                    Your name
                                                    <input
                                                        required
                                                        autoComplete="name"
                                                        maxLength={80}
                                                        value={displayName}
                                                        onChange={(event) =>
                                                            setDisplayName(event.target.value)
                                                        }
                                                        placeholder="How your name appears"
                                                    />
                                                </label>
                                            )}
                                            <label>
                                                {register ? 'Username' : 'Email or username'}
                                                <input
                                                    required
                                                    type="text"
                                                    autoComplete="username"
                                                    maxLength={USERNAME_MAX_LENGTH}
                                                    value={username}
                                                    onChange={(event) => setUsername(event.target.value)}
                                                    placeholder={
                                                        register
                                                            ? 'Choose a username for signing in'
                                                            : undefined
                                                    }
                                                />
                                            </label>
                                            {register && (
                                                <label>
                                                    Email address (optional)
                                                    <input
                                                        type="email"
                                                        autoComplete="email"
                                                        maxLength={254}
                                                        value={registrationEmail}
                                                        onChange={(event) =>
                                                            setRegistrationEmail(event.target.value)
                                                        }
                                                        placeholder="For your approval notification"
                                                    />
                                                    <span className="hint">
                                                        You can leave this blank and sign in with your
                                                        username. No email confirmation is required.
                                                    </span>
                                                </label>
                                            )}
                                            <PasswordInput
                                                key={register ? 'register' : 'login'}
                                                label="Password"
                                                required
                                                minLength={register ? PASSWORD_MIN_LENGTH : undefined}
                                                maxLength={register ? PASSWORD_MAX_LENGTH : 128}
                                                pattern={register ? PASSWORD_PATTERN : undefined}
                                                title={register ? PASSWORD_ERROR : undefined}
                                                aria-describedby={
                                                    register ? 'registration-password-help' : undefined
                                                }
                                                autoComplete={register ? 'new-password' : 'current-password'}
                                                value={password}
                                                onChange={(event) => setPassword(event.target.value)}
                                            />
                                            {register && (
                                                <p id="registration-password-help" className="hint">
                                                    {PASSWORD_HELP}
                                                </p>
                                            )}
                                            {register && (
                                                <PasswordInput
                                                    label="Confirm password"
                                                    required
                                                    minLength={PASSWORD_MIN_LENGTH}
                                                    maxLength={PASSWORD_MAX_LENGTH}
                                                    autoComplete="new-password"
                                                    value={confirmPassword}
                                                    onChange={(event) =>
                                                        setConfirmPassword(event.target.value)
                                                    }
                                                />
                                            )}
                                            {register && !pendingInvitation && (
                                                <details className="signup-group-details">
                                                    <summary>Group details (optional)</summary>
                                                    <label>
                                                        Group name
                                                        <input
                                                            autoComplete="organization"
                                                            maxLength={60}
                                                            value={groupName}
                                                            onChange={(event) =>
                                                                setGroupName(event.target.value)
                                                            }
                                                            placeholder="Defaults to your name"
                                                        />
                                                    </label>
                                                    <label>
                                                        Group members
                                                        <span className="hint">
                                                            One name per line; defaults to you.
                                                        </span>
                                                        <textarea
                                                            rows={3}
                                                            value={members}
                                                            onChange={(event) =>
                                                                setMembers(event.target.value)
                                                            }
                                                            placeholder={'Member one\nMember two'}
                                                        />
                                                    </label>
                                                </details>
                                            )}
                                            {error && (
                                                <p
                                                    className="alert error"
                                                    role="alert"
                                                    tabIndex={-1}
                                                    ref={errorMessage}
                                                >
                                                    {error}
                                                </p>
                                            )}
                                            <ActionButton
                                                className="button primary full"
                                                disabled={busy}
                                                unavailableReason="Your sign-in request is already in progress. Please wait."
                                            >
                                                {busy ? 'Please wait…' : register ? 'Sign Up' : 'Sign in'}
                                            </ActionButton>
                                            {!register && (
                                                <p className="hint">
                                                    New player accounts require administrator approval.
                                                </p>
                                            )}
                                        </form>
                                    ) : (
                                        <EmailCodeSignIn
                                            enabled={!!authOptions.emailOtpEnabled}
                                            onSignedIn={actions.onSignedIn}
                                        />
                                    ))}
                                {!register && (
                                    <div className="auth-secondary-links">
                                        <a
                                            href={`/forgot-password${search}`}
                                            onClick={(event) =>
                                                followLink(event, `/forgot-password${search}`)
                                            }
                                        >
                                            Forgot password?
                                        </a>
                                        <a
                                            href={`/login/authenticator${search}`}
                                            onClick={(event) =>
                                                followLink(event, `/login/authenticator${search}`)
                                            }
                                        >
                                            Use authenticator or backup code
                                        </a>
                                    </div>
                                )}
                                {notice && (
                                    <p className="alert success" role="status">
                                        {notice}
                                    </p>
                                )}
                                {register && (
                                    <a
                                        className="text-button switch"
                                        href={loginHref}
                                        onClick={(event) => followLink(event, loginHref)}
                                    >
                                        Already have an account? Sign in
                                    </a>
                                )}
                            </section>
                        </>
                    )}
                    <p className="auth-foot">Evidence is visible to your group and administrators.</p>
                    <LegalLinks />
                </div>
            </div>
        </main>
    );
}
