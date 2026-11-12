import React, {
    type FormEvent,
    type MouseEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { Evidence, Submission } from '../../shared/types';
import type { AdminSubmissionPage, AdminSubmissionSummary } from '../../shared/admin/dashboard';
import {
    DIRECT_UPLOAD_MAX_BYTES,
    MAX_FILE_BYTES,
    UPLOAD_PART_BYTES,
    type UploadSession,
} from '../../shared/evidence/uploads';
import {
    PASSWORD_ERROR,
    USERNAME_ERROR,
    validPassword,
    validUsername,
} from '../../shared/accounts/credentials';
import { normalizePhone, REGISTRATION_PHONE_ERROR } from '../../shared/accounts/registrationPhone';
import type { AccountApprovalStatusResponse } from '../../shared/accounts/approval';
import { latestTaskStatus, taskSubs } from '../../shared/event/overview';
import {
    DEAD_TASK_MESSAGE,
    isLunchBreak,
    LUNCH_MESSAGE,
    taskBlockReason,
} from '../../shared/event/taskAvailability';
import { LegalLinks } from '../ui/LegalLinks';
import { UploadQueue } from '../evidence/uploadQueue';
import { missingParts, verifyUploadFile } from '../evidence/uploadRecovery';
import { getCapture } from '../evidence/cameraCapture';
import { LinkedSignIns, type AuthOptions } from '../accounts/authMethods';
import { Settings } from '../accounts/Settings';
import { GroupMembers } from '../groups/GroupMembers';
import { Brand } from '../ui/Brand';
import { AuthPage } from '../accounts/AuthPage';
import { EventDashboard } from '../event/EventDashboard';
import { InvitationPage } from '../invitations/InvitationPage';
import {
    clearPendingInvite,
    getPendingInvite,
    shouldClearInviteOnError,
    type PendingInvitation,
} from '../invitations/invitation';
import { createEvidencePreview, saveEvidencePreview } from '../evidence/EvidencePicker';
import { AdminSubmission } from '../admin/AdminSubmission';
import { ReviewNotifs } from '../notifications/ReviewNotifications';
import { AnnouncementInbox } from '../announcements/AnnouncementInbox';
import { HomeScreenNotifs } from '../notifications/HomeScreenNotifications';
import { clearPushOnSignOut, prepareHomeScreenApp } from '../notifications/pushClient';
import { AccountAccess } from '../accounts/AccountAccess';
import { AccountApprovals } from '../accounts/AccountApprovals';
import {
    consumeGoogleReturn,
    isPortalPage,
    PAGE_PATHS,
    signInDestination,
    useNavigation,
    type PortalPage,
} from './navigation';
import { ActionButton } from '../ui/ActionButton';
import { DraftNoteConflict, DraftNotes } from '../submissions/draftNotes';
import { SubmissionCard } from '../submissions/SubmissionCard';
import { ConnectionStatus, useConnectionStatus } from '../notifications/ConnectionStatus';
import { isBackgroundRefreshDue } from './backgroundRefresh';
import { shouldResetAdminPage } from '../admin/adminQueuePagination';
import {
    ApiError,
    SessionExpiredError,
    UploadCancelledError,
    UploadRequestError,
    api,
    completionInProgress,
    retryDelay,
    retryable,
    RETRY_DELAYS,
} from './api';
import { formatDate, submissionStatusClass, submissionStatusLabel } from './presentation';
import { UploadRecoveryPanel } from '../evidence/UploadRecoveryPanel';
import type { DashboardView, FailedUpload, UploadProgress } from './types';

export function App() {
    const [dashboard, setDashboard] = useState<DashboardView | null>(null);
    const [authOpts, setAuthOpts] = useState<AuthOptions>({
        googleEnabled: false,
        emailOtpEnabled: false,
    });
    const { route, navigateUrl } = useNavigation();
    const page = route.page;
    const activePage = useRef(page);
    activePage.current = page;
    const [authReady, setAuthReady] = useState(false);
    const [accountAccess, setAccountAccess] = useState<AccountApprovalStatusResponse['status'] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [pendingInv, setPendingInv] = useState<PendingInvitation | null>(() => getPendingInvite());
    const [invFeedback, setInvFeedback] = useState<{ message: string; error: boolean } | null>(null);
    const errorMessage = useRef<HTMLParagraphElement>(null);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [cfPW, setCfPW] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [regEmail, setRegEmail] = useState('');
    const [regPhone, setRegPhone] = useState('');
    const [loginMethod, setLoginMethod] = useState<'password' | 'email-code'>('password');
    const register = page === 'register';
    const authParams = new URLSearchParams(route.search);
    const googlePhoneOnly =
        register &&
        (authParams.get('method') === 'google' || authParams.get('auth_error') === 'phone_required');
    authParams.delete('method');
    const loginHref = `/login${authParams.size ? `?${authParams}` : ''}`;
    const authPage =
        page === 'login' || page === 'register' || page === 'authenticator' || page === 'recovery';
    const [groupName, setGroupName] = useState('');
    const [members, setMembers] = useState('');
    const [selectedTask, setSelectedTask] = useState('');
    const [filter, setFilter] = useState<'pending' | 'all'>('pending');
    const [filterGroup, setFilterGroup] = useState('all');
    const [filterTask, setFilterTask] = useState('all');
    const [reviewSort, setReviewSort] = useState<'oldest' | 'newest'>('oldest');
    const [reviewSearch, setReviewSearch] = useState('');
    const [reviewPage, setReviewPage] = useState(1);
    const [checkCursorReq, setCheckCursorReq] = useState<{
        cursor: string;
        direction: 'next' | 'previous';
    } | null>(null);
    const [reviewCursors, setReviewCursors] = useState<{ next: string | null; previous: string | null }>({
        next: null,
        previous: null,
    });
    const [adminSub, setAdminSub] = useState<AdminSubmissionSummary[]>([]);
    const [adminTotal, setAdminTotal] = useState(0);
    const [reviewDetails, setReviewDetails] = useState<Record<string, Submission>>({});
    const checkDetailVers = useRef<Record<string, number>>({});
    const [checkRev, setCheckRev] = useState(0);
    const prevRevPg = useRef(page);
    const checkQueueID = useRef(0);
    const [reviewMode, setReviewMode] = useState<'focus' | 'list'>('focus');
    const [activeReviewId, setActiveReviewId] = useState('');
    const [managedGroupId, setManagedGroupId] = useState('');
    const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
    const [uploadProgress, setUploadProgress] = useState<Record<string, UploadProgress>>({});
    const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
    const [uploadQueue] = useState(() => new UploadQueue(2));
    const pendUplInfo = useRef(new Map<string, { submissionId: string }>());
    const uploadTasks = useRef(new Map<string, Promise<void>>());
    const dashReq = useRef(0);
    const bgDashReq = useRef(false);
    const dashReqs = useRef(0);
    const lastBgDashReq = useRef(0);
    const [localUploadIds, setLocalUploadIds] = useState<string[]>([]);
    const activeUploads = useRef(new Map<string, XMLHttpRequest>());
    const cancelledUploads = useRef(new Set<string>());
    const verifyCtrls = useRef(new Map<string, AbortController>());
    const signedinAcc = dashboard?.account.id;
    const subsEnabRef = useRef(false);
    const dead = dashboard?.game?.player.dead === true;
    const [clockNow, setClockNow] = useState(Date.now);
    const serverOffsetms = useMemo(
        () => (dashboard?.serverNow ? Date.parse(dashboard.serverNow) - Date.now() : 0),
        [dashboard?.serverNow],
    );
    const serverClockOffset = useRef(0);
    serverClockOffset.current = serverOffsetms;
    useEffect(() => {
        const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    const lunch = isLunchBreak(clockNow + serverClockOffset.current);
    const deadRef = useRef(false);
    deadRef.current = dead;
    subsEnabRef.current = dashboard?.submissionsEnabled !== false && !dead;
    const connection = useConnectionStatus();
    const { markFresh, markFailed, reset: resetConnection } = connection;
    const [refreshing, setRefreshing] = useState(false);
    const draftNotes = useMemo(() => {
        let storage: Storage | undefined;
        try {
            storage = window.sessionStorage;
        } catch {}
        return new DraftNotes(
            signedinAcc || '',
            async (id, note, previousNote) => {
                try {
                    await api(`/api/submissions/${id}/note`, {
                        method: 'PATCH',
                        keepalive: true,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ note, previousNote }),
                    });
                } catch (error) {
                    if (error instanceof ApiError && error.statusCode === 409)
                        throw new DraftNoteConflict(
                            error.message,
                            typeof error.body?.note === 'string' ? error.body.note : undefined,
                        );
                    throw error;
                }
            },
            storage,
        );
    }, [signedinAcc]);
    useEffect(() => {
        draftNotes.activate();
        return () => draftNotes.dispose();
    }, [draftNotes]);
    useEffect(() => {
        const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
            if (pendUplInfo.current.size || draftNotes.hasUnsaved()) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', warnBeforeLeaving);
        return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
    }, [draftNotes]);

    useEffect(() => {
        if (error) errorMessage.current?.focus();
    }, [error]);

    useEffect(() => {
        if (!authReady) return;
        if (page === 'join') return;
        window.scrollTo(0, 0);
        document.getElementById('main-content')?.focus({ preventScroll: true });
    }, [page, signedinAcc, authReady]);

    useEffect(() => {
        if (!authReady) return;
        if (page === 'join') return;
        if (accountAccess && accountAccess !== 'approved') {
            if (page !== 'approval') navigateUrl('/account-pending', true);
        } else if (dashboard && (authPage || page === 'approval')) {
            navigateUrl(signInDestination(route.search), true);
        } else if (!dashboard && (isPortalPage(page) || page === 'approval')) {
            const path = isPortalPage(page) ? PAGE_PATHS[page] : '/home';
            navigateUrl(path === '/home' ? '/login' : `/login?next=${encodeURIComponent(path)}`, true);
        }
    }, [authReady, dashboard, accountAccess, page, route.search, navigateUrl, authPage]);

    useEffect(() => {
        const title =
            page === 'home'
                ? 'Event overview'
                : page === 'join'
                  ? 'Group invitation'
                  : page === 'tasks'
                    ? dashboard?.account.role === 'admin'
                        ? 'Submissions'
                        : 'Tasks'
                    : page === 'group'
                      ? dashboard?.account.role === 'admin'
                          ? 'Groups'
                          : 'My group'
                      : page === 'settings'
                        ? 'Settings'
                        : page === 'register'
                          ? 'Create account'
                          : page === 'authenticator'
                            ? 'Authenticator sign-in'
                            : page === 'recovery'
                              ? 'Forgot password'
                              : page === 'login'
                                ? 'Sign in'
                                : page === 'approval'
                                  ? 'Account approval'
                                  : page === 'accounts'
                                    ? 'Account requests'
                                    : 'Page not found';
        document.title = `${title} · Manhunt IX`;
    }, [page, dashboard?.account.role]);

    function navigate(next: PortalPage) {
        navigateUrl(PAGE_PATHS[next]);
    }
    function resetReviewQueuePage() {
        setReviewPage(1);
        setCheckCursorReq(null);
        setReviewCursors({ next: null, previous: null });
        setActiveReviewId('');
    }
    function openTask(taskId: string) {
        if (taskId) setSelectedTask(taskId);
        navigate('tasks');
    }
    async function replaceTaskEvidence(taskId: string) {
        openTask(taskId);
        return createSubmission(taskId);
    }

    function followLink(event: MouseEvent<HTMLAnchorElement>, href: string) {
        if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
        )
            return;
        event.preventDefault();
        setError('');
        if (href.startsWith('/login') || href.startsWith('/register') || href.startsWith('/forgot-password'))
            setPassword('');
        navigateUrl(href);
    }

    const refresh = useCallback(
        async (quiet = false) => {
            const requestId = ++dashReq.current;
            dashReqs.current++;
            setRefreshing(true);
            try {
                const access = await api<AccountApprovalStatusResponse>('/api/account-status');
                if (requestId !== dashReq.current) return;
                setAccountAccess(access.status);
                if (!/^\/join\/?$/.test(window.location.pathname)) {
                    const invitation = getPendingInvite();
                    setPendingInv(invitation);
                    if (invitation) {
                        try {
                            const joined = await api<{ joined: true; groupId: string; groupName: string }>(
                                `/api/invitations/${encodeURIComponent(invitation.id)}/accept`,
                                {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ token: invitation.token }),
                                },
                            );
                            clearPendingInvite(invitation);
                            if (requestId !== dashReq.current) return;
                            setPendingInv(getPendingInvite());
                            const message = `You’ve joined ${joined.groupName}.`;
                            setInvFeedback({ message, error: false });
                            setNotice(message);
                        } catch (cause) {
                            if (cause instanceof SessionExpiredError) throw cause;
                            if (
                                cause instanceof ApiError &&
                                shouldClearInviteOnError(cause.statusCode, cause.body?.code)
                            )
                                clearPendingInvite(invitation);
                            if (requestId !== dashReq.current) return;
                            setPendingInv(getPendingInvite());
                            const message =
                                cause instanceof Error
                                    ? cause.message
                                    : 'Could not join the invited group. Try again.';
                            setInvFeedback({ message, error: true });
                            setError(message);
                        }
                    }
                }
                if (requestId !== dashReq.current) return;
                if (!access.canSignIn) {
                    setDashboard(null);
                    markFresh('dashboard');
                    return;
                }
                const reqStart = performance.now();
                const dashData = await api<DashboardView>('/api/dashboard');
                if (requestId !== dashReq.current) return;
                if (dashData.reviewInbox) dashData.reviewInboxRequestedAt = reqStart;
                setDashboard(dashData);
                lastBgDashReq.current = Date.now();
                setSelectedTask((current) => current || dashData.tasks[0]?.id || '');
                markFresh('dashboard');
                if (dashData.account.role === 'admin' && activePage.current === 'tasks')
                    setCheckRev((revision) => revision + 1);
            } catch (e) {
                if (requestId !== dashReq.current) return;
                const message = e instanceof Error ? e.message : 'Could not load your dashboard.';
                if (e instanceof SessionExpiredError) {
                    if (!quiet) setError(message);
                    setDashboard(null);
                    setAccountAccess(null);
                    resetConnection();
                } else {
                    markFailed('dashboard');
                    if (!quiet) setError(message);
                }
            } finally {
                dashReqs.current = Math.max(0, dashReqs.current - 1);
                if (requestId === dashReq.current) {
                    setAuthReady(true);
                    setRefreshing(false);
                }
            }
        },
        [markFailed, markFresh, resetConnection],
    );
    const refreshDashinbg = useCallback(async () => {
        const now = Date.now();
        if (
            !isBackgroundRefreshDue(
                document.visibilityState === 'visible',
                navigator.onLine,
                bgDashReq.current || dashReqs.current > 0,
                lastBgDashReq.current,
                now,
            )
        )
            return;
        bgDashReq.current = true;
        lastBgDashReq.current = now;
        const requestId = dashReq.current;
        try {
            const reqStart = performance.now();
            const dashData = await api<DashboardView>('/api/dashboard');
            if (requestId !== dashReq.current) return;
            if (dashData.reviewInbox) dashData.reviewInboxRequestedAt = reqStart;
            setAccountAccess('approved');
            setDashboard(dashData);
            setSelectedTask((current) => current || dashData.tasks[0]?.id || '');
            markFresh('dashboard');
            if (dashData.account.role === 'admin' && activePage.current === 'tasks')
                setCheckRev((revision) => revision + 1);
        } catch (cause) {
            if (requestId !== dashReq.current) return;
            if (cause instanceof SessionExpiredError) {
                setDashboard(null);
                setAccountAccess(null);
                resetConnection();
            } else if (
                cause instanceof ApiError &&
                cause.statusCode === 403 &&
                cause.body?.code === 'approval_required'
            ) {
                const status = cause.body.approval;
                if (status === 'pending' || status === 'rejected' || status === 'disabled')
                    setAccountAccess(status);
                setDashboard(null);
            } else {
                markFailed('dashboard');
            }
        } finally {
            bgDashReq.current = false;
        }
    }, [markFailed, markFresh, resetConnection]);
    const handleApproved = useCallback(() => {
        void refresh(true);
    }, [refresh]);
    const handleSignedOut = useCallback(() => {
        setDashboard(null);
        setAccountAccess(null);
        navigateUrl('/login', true);
    }, [navigateUrl]);

    useEffect(() => {
        if (window.isSecureContext && 'serviceWorker' in navigator)
            void prepareHomeScreenApp().catch(() => {});
        fetch('/api/auth/options', { credentials: 'same-origin' })
            .then((response) => (response.ok ? (response.json() as Promise<AuthOptions>) : null))
            .then((options) => {
                if (options && typeof options.googleEnabled === 'boolean') setAuthOpts(options);
            })
            .catch(() => {});
        refresh(true);
    }, [refresh]);

    function retryPendingInvitation() {
        setError('');
        setNotice('');
        setInvFeedback(null);
        void refresh();
    }
    useEffect(() => {
        if (!('serviceWorker' in navigator)) return;
        const openReviewUpdates = (event: MessageEvent) => {
            if (event.data?.type === 'manhunt-game-updated') {
                void refresh(true);
                return;
            }
            if (
                !['manhunt-open-review-updates', 'manhunt-open-announcements', 'manhunt-open-game'].includes(
                    event.data?.type,
                )
            )
                return;
            navigateUrl('/home');
            void refresh(true);
        };
        navigator.serviceWorker.addEventListener('message', openReviewUpdates);
        return () => navigator.serviceWorker.removeEventListener('message', openReviewUpdates);
    }, [refresh, navigateUrl]);
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const auth = params.get('auth');
        const authError = params.get('auth_error');
        if (!auth && !authError) return;
        const googleReturn = consumeGoogleReturn();
        params.delete('auth');
        params.delete('auth_error');
        if (authError === 'phone_required') {
            params.set('method', 'google');
            if (googleReturn !== '/home') params.set('next', googleReturn);
        }
        const search = params.toString();
        navigateUrl(
            `${authError === 'phone_required' ? '/register' : window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
            true,
        );
        if (auth === 'signed-in') {
            setNotice('Signed in successfully.');
            navigateUrl(googleReturn, true);
            void refresh();
        } else if (auth === 'linked') {
            setNotice('Sign-in method linked to this account.');
            navigateUrl('/settings', true);
            void refresh(true);
        } else if (auth === 'two-factor') {
            navigateUrl(
                googleReturn === '/home'
                    ? '/login/authenticator'
                    : `/login/authenticator?next=${encodeURIComponent(googleReturn)}`,
                true,
            );
        } else if (authError === 'phone_required') {
            setError('');
            setNotice('');
        } else if (authError) {
            const messages: Record<string, string> = {
                cancelled: 'Sign-in was cancelled.',
                invalid_request: 'That sign-in request could not be completed. Try again.',
                invalid_state: 'That sign-in link expired. Try again.',
                provider_unavailable: 'Google sign-in is currently unavailable. Use your password.',
                configuration_missing: 'Google sign-in is not available yet. Use your password.',
                identity_not_linked:
                    'No account uses that Google identity yet. Create a group account or sign in with a password, then link Google.',
                identity_already_linked: 'That Google identity is already linked to an account.',
                account_not_found: 'The account could not be found. Try signing in again.',
                account_setup_required:
                    'That account needs setup before you can sign in. Use your password or contact an admin.',
                rate_limited: 'Too many attempts. Wait a little and try again.',
                verification_failed: 'Google could not verify this sign-in. Try again.',
            };
            setError(messages[authError] || 'Google sign-in could not be completed. Try again.');
            if (window.location.pathname === '/login' && googleReturn !== '/home')
                navigateUrl(`/login?next=${encodeURIComponent(googleReturn)}`, true);
        }
    }, [refresh, navigateUrl]);
    useEffect(() => {
        if (!dashboard) return;
        const refreshWhenActive = () => {
            void refreshDashinbg();
        };
        const timer = window.setInterval(refreshWhenActive, 60_000);
        window.addEventListener('focus', refreshWhenActive);
        document.addEventListener('visibilitychange', refreshWhenActive);
        window.addEventListener('online', refreshWhenActive);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', refreshWhenActive);
            document.removeEventListener('visibilitychange', refreshWhenActive);
            window.removeEventListener('online', refreshWhenActive);
        };
    }, [dashboard?.account.id, refreshDashinbg]);

    useEffect(() => {
        if (page === 'tasks' && prevRevPg.current !== 'tasks' && dashboard?.account.role === 'admin') {
            setCheckRev((revision) => revision + 1);
        }
        prevRevPg.current = page;
    }, [dashboard?.account.role, page]);

    useEffect(() => {
        if (dashboard?.account.role !== 'admin' || page !== 'tasks') return;
        const requestId = ++checkQueueID.current;
        let live = true;
        const timer = window.setTimeout(
            () => {
                const params = new URLSearchParams({
                    status: filter,
                    groupId: filterGroup,
                    taskId: filterTask,
                    sort: reviewSort,
                    search: reviewSearch,
                    page: String(reviewPage),
                    pageSize: '20',
                });
                if (checkCursorReq) {
                    params.set('cursor', checkCursorReq.cursor);
                    params.set('cursorDirection', checkCursorReq.direction);
                }
                void api<AdminSubmissionPage>(`/api/admin/submissions?${params}`)
                    .then((result) => {
                        if (!live || requestId !== checkQueueID.current) return;
                        setAdminSub(result.items);
                        setAdminTotal(result.total);
                        setReviewCursors({
                            next: result.nextCursor ?? null,
                            previous: result.previousCursor ?? null,
                        });
                        if (shouldResetAdminPage(reviewPage, !!checkCursorReq, result.items.length)) {
                            setAdminSub([]);
                            setReviewPage(1);
                            setCheckCursorReq(null);
                            setReviewCursors({ next: null, previous: null });
                            setActiveReviewId('');
                            markFresh('queue');
                            return;
                        }
                        setActiveReviewId((current) =>
                            result.items.some((item) => item.id === current)
                                ? current
                                : (result.items[0]?.id ?? ''),
                        );
                        markFresh('queue');
                    })
                    .catch((cause) => {
                        if (live && requestId === checkQueueID.current) {
                            markFailed('queue');
                            setError(cause instanceof Error ? cause.message : 'Could not load submissions.');
                        }
                    });
            },
            reviewSearch ? 250 : 0,
        );
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [
        dashboard?.account.role,
        page,
        filter,
        filterGroup,
        filterTask,
        reviewSort,
        reviewSearch,
        reviewPage,
        checkRev,
        checkCursorReq,
        markFailed,
    ]);

    useEffect(() => {
        setCheckCursorReq(null);
        setReviewCursors({ next: null, previous: null });
    }, [filter, filterGroup, filterTask, reviewSort, reviewSearch]);

    useEffect(() => {
        if (
            dashboard?.account.role !== 'admin' ||
            page !== 'tasks' ||
            reviewMode !== 'focus' ||
            !activeReviewId ||
            checkDetailVers.current[activeReviewId] === checkRev
        )
            return;
        let live = true;
        const requestedRevision = checkRev;
        void api<{ submission: Submission }>(`/api/admin/submissions/${encodeURIComponent(activeReviewId)}`)
            .then(({ submission }) => {
                if (!live) return;
                checkDetailVers.current[submission.id] = requestedRevision;
                setReviewDetails((current) => ({ ...current, [submission.id]: submission }));
                markFresh('detail');
            })
            .catch((cause) => {
                if (live) {
                    markFailed('detail');
                    setError(
                        cause instanceof Error ? cause.message : 'Could not load the selected submission.',
                    );
                }
            });
        return () => {
            live = false;
        };
    }, [dashboard?.account.role, page, reviewMode, activeReviewId, checkRev, markFailed]);

    async function submitAuth(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError('');
        setNotice('');
        try {
            if (register) {
                const phone = normalizePhone(regPhone);
                if (!phone) throw new Error(REGISTRATION_PHONE_ERROR);
                if (!validUsername(username)) throw new Error(USERNAME_ERROR);
                if (!validPassword(password)) throw new Error(PASSWORD_ERROR);
                if (password !== cfPW) throw new Error('The passwords do not match.');
                await api('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username,
                        password,
                        displayName,
                        phone,
                        email: regEmail,
                        groupName: pendingInv ? '' : groupName,
                        members: pendingInv
                            ? []
                            : members
                                  .split(/\r?\n/)
                                  .map((memberName) => memberName.trim())
                                  .filter(Boolean),
                    }),
                });
            } else {
                await api('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                });
            }
            setPassword('');
            setCfPW('');
            setRegPhone('');
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not sign in.');
        } finally {
            setBusy(false);
        }
    }
    async function logout() {
        setBusy(true);
        for (const key of pendUplInfo.current.keys()) cancelUpload(key);
        await Promise.allSettled([...uploadTasks.current.values()]);
        await clearPushOnSignOut().catch(() => {});
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        dashReq.current++;
        setDashboard(null);
        setAccountAccess(null);
        resetConnection();
        setError('');
        setNotice('');
        setInvFeedback(null);
        setPassword('');
        setCfPW('');
        setRegPhone('');
        setFailedUploads([]);
        setSelectedTask('');
        navigateUrl('/login', true);
        setBusy(false);
    }
    async function createSubmission(taskId: string) {
        if (deadRef.current) {
            setError(DEAD_TASK_MESSAGE);
            return null;
        }
        if (!subsEnabRef.current) {
            setError(
                deadRef.current
                    ? DEAD_TASK_MESSAGE
                    : 'Submissions are paused. Wait for an organiser to reopen them.',
            );
            return null;
        }
        setError('');
        setNotice('');
        setBusy(true);
        try {
            const result = await api<{ submission: Submission }>('/api/submissions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId }),
            });
            await refresh();
            return result.submission;
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not start a submission.');
            return null;
        } finally {
            setBusy(false);
        }
    }
    function cancelUpload(key: string) {
        cancelledUploads.current.add(key);
        verifyCtrls.current.get(key)?.abort();
        uploadQueue.cancelQueued(key);
        activeUploads.current.get(key)?.abort();
    }
    function updateUploadProgress(key: string, percent: number) {
        setUploadProgress((current) =>
            current[key] ? { ...current, [key]: { ...current[key], percent, queued: false } } : current,
        );
    }
    function sendUploadRequest(
        key: string,
        url: string,
        method: string,
        body: XMLHttpRequestBodyInit,
        headers: Record<string, string> = {},
        onProgress?: (loaded: number) => void,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url);
            xhr.withCredentials = true;
            for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
            activeUploads.current.set(key, xhr);
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) onProgress?.(event.loaded);
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
                else {
                    let message = `Upload failed (${xhr.status})`;
                    try {
                        message = JSON.parse(xhr.responseText).error || message;
                    } catch {}
                    reject(
                        new UploadRequestError(
                            message,
                            xhr.status,
                            xhr.status === 408 || xhr.status === 429 || xhr.status >= 500,
                        ),
                    );
                }
            };
            xhr.onerror = () =>
                reject(new UploadRequestError('Network error. Check your connection and retry.', 0, true));
            xhr.onabort = () => reject(new UploadCancelledError('Upload cancelled.'));
            xhr.onloadend = () => {
                if (activeUploads.current.get(key) === xhr) activeUploads.current.delete(key);
            };
            if (cancelledUploads.current.has(key)) {
                if (activeUploads.current.get(key) === xhr) activeUploads.current.delete(key);
                reject(new UploadCancelledError('Upload cancelled.'));
                return;
            }
            xhr.send(body);
        });
    }
    async function finishUpload(uploadId: string): Promise<string> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
            try {
                const result = await api<{ evidence: Evidence }>(`/api/uploads/${uploadId}/complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                });
                return result.evidence.id;
            } catch (e) {
                lastError = e;
                if (completionInProgress(e)) {
                    let readyToRetry = false;
                    for (let poll = 0; poll < 12; poll++) {
                        await retryDelay(0);
                        let latest: { upload: UploadSession };
                        try {
                            latest = await api<{ upload: UploadSession }>(`/api/uploads/${uploadId}`);
                        } catch (pollError) {
                            if (retryable(pollError)) continue;
                            throw pollError;
                        }
                        if (latest.upload.state === 'completed' && latest.upload.evidenceId)
                            return latest.upload.evidenceId;
                        if (latest.upload.state === 'aborted' || latest.upload.state === 'expired')
                            throw new Error(
                                'This upload session is no longer available. Please select the file again.',
                            );
                        if (latest.upload.state === 'uploading') {
                            readyToRetry = true;
                            break;
                        }
                    }
                    if (readyToRetry && attempt < RETRY_DELAYS.length) continue;
                    if (!readyToRetry) throw e;
                } else if (retryable(e) && attempt < RETRY_DELAYS.length) {
                    await retryDelay(attempt);
                    continue;
                } else throw e;
            }
        }
        throw lastError instanceof Error ? lastError : new Error('The server could not finish this upload.');
    }
    async function finishRecoveredUpload(upload: UploadSession) {
        if (!subsEnabRef.current) {
            setError(
                deadRef.current
                    ? DEAD_TASK_MESSAGE
                    : 'Submissions are paused. Resume this unfinished upload when submissions reopen, or cancel it if you no longer need it.',
            );
            return;
        }
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await finishUpload(upload.id);
            await refresh(true);
            setNotice('Upload finished and added to your task.');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not finish this upload.');
        } finally {
            setBusy(false);
        }
    }
    async function cancelRecoveredUpload(upload: UploadSession) {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await api(`/api/uploads/${upload.id}`, { method: 'DELETE' });
            await refresh(true);
            setNotice('Upload cancelled. You can select the file again to restart it.');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not cancel this upload.');
        } finally {
            setBusy(false);
        }
    }
    async function uploadOneFile(submission: Submission, file: File, key: string, resume?: UploadSession) {
        if (!subsEnabRef.current)
            throw new Error(
                deadRef.current
                    ? DEAD_TASK_MESSAGE
                    : 'Submissions are paused. Wait for an organiser to reopen them.',
            );
        const cameraCapture = getCapture(file);
        if (file.size <= DIRECT_UPLOAD_MAX_BYTES) {
            const data = new FormData();
            data.append('file', file);
            if (cameraCapture) data.append('cameraCapture', JSON.stringify(cameraCapture));
            const result = await sendUploadRequest(
                key,
                `/api/submissions/${submission.id}/evidence`,
                'POST',
                data,
                {},
                (loaded) => {
                    updateUploadProgress(
                        key,
                        Math.min(99, Math.round((loaded / Math.max(file.size, 1)) * 99)),
                    );
                },
            );
            return (JSON.parse(result) as { evidence: Evidence }).evidence.id;
        }

        const created = resume
            ? await api<{ upload: UploadSession }>(`/api/uploads/${encodeURIComponent(resume.id)}`)
            : await api<{ upload: UploadSession }>(`/api/submissions/${submission.id}/uploads`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      filename: file.name,
                      size: file.size,
                      ...(cameraCapture ? { cameraCapture } : {}),
                  }),
              });
        const active = created.upload;
        const uploadId = active.id;
        setLocalUploadIds((ids) => (ids.includes(uploadId) ? ids : [...ids, uploadId]));
        let completed = false;
        try {
            if (cancelledUploads.current.has(key)) throw new UploadCancelledError('Upload cancelled.');
            if (
                active.submissionId !== submission.id ||
                active.filename !== file.name ||
                active.size !== file.size
            ) {
                throw new Error(
                    'The selected file does not match this task upload. Please select the original file.',
                );
            }
            if (active.state === 'completed' || active.state === 'completing') {
                const evidenceId = await finishUpload(uploadId);
                completed = true;
                return evidenceId;
            }
            if (active.state !== 'uploading')
                throw new Error(
                    'This upload can no longer be resumed. Cancel it and select the original file again.',
                );
            if (resume) {
                const controller = new AbortController();
                verifyCtrls.current.set(key, controller);
                try {
                    const verification = await verifyUploadFile(file, active, controller.signal);
                    if (!verification.ok) throw new Error(verification.reason);
                } finally {
                    verifyCtrls.current.delete(key);
                }
            }
            const partSize = active.partSize || UPLOAD_PART_BYTES;
            const partCount = active.partCount || Math.ceil(file.size / partSize);
            const missing = new Set(missingParts(active));
            let uploadedBytes = active.parts.reduce((sum, part) => sum + part.size, 0);
            updateUploadProgress(key, Math.min(99, Math.round((uploadedBytes / file.size) * 99)));
            for (let partNumber = 1; partNumber <= partCount; partNumber++) {
                if (!subsEnabRef.current)
                    throw new Error(
                        deadRef.current
                            ? DEAD_TASK_MESSAGE
                            : 'Submissions were paused. Resume this unfinished upload when submissions reopen, or cancel it if you no longer need it.',
                    );
                if (cancelledUploads.current.has(key)) throw new UploadCancelledError('Upload cancelled.');
                if (!missing.has(partNumber)) continue;
                const start = (partNumber - 1) * partSize;
                const chunk = file.slice(start, Math.min(start + partSize, file.size));
                for (let attempt = 0; ; attempt++) {
                    try {
                        await sendUploadRequest(
                            key,
                            `/api/uploads/${uploadId}/parts/${partNumber}`,
                            'PUT',
                            chunk,
                            { 'Content-Type': 'application/octet-stream' },
                            (loaded) => {
                                const total = uploadedBytes + loaded;
                                updateUploadProgress(key, Math.min(99, Math.round((total / file.size) * 99)));
                            },
                        );
                        uploadedBytes += chunk.size;
                        updateUploadProgress(key, Math.min(99, Math.round((uploadedBytes / file.size) * 99)));
                        break;
                    } catch (e) {
                        if (
                            e instanceof UploadCancelledError ||
                            cancelledUploads.current.has(key) ||
                            !retryable(e) ||
                            attempt >= RETRY_DELAYS.length
                        )
                            throw e;
                        await retryDelay(attempt);
                    }
                }
            }

            if (cancelledUploads.current.has(key)) throw new UploadCancelledError('Upload cancelled.');
            if (!subsEnabRef.current)
                throw new Error(
                    deadRef.current
                        ? DEAD_TASK_MESSAGE
                        : 'Submissions were paused. Resume this unfinished upload when submissions reopen, or cancel it if you no longer need it.',
                );
            updateUploadProgress(key, 99);
            const evidenceId = await finishUpload(uploadId);
            completed = true;
            return evidenceId;
        } finally {
            if (!completed && cancelledUploads.current.has(key))
                await api(`/api/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {});
            verifyCtrls.current.delete(key);
            setLocalUploadIds((ids) => ids.filter((id) => id !== uploadId));
        }
    }
    function resumeUpload(upload: UploadSession, file: File) {
        if (!subsEnabRef.current) {
            setError(
                deadRef.current
                    ? DEAD_TASK_MESSAGE
                    : 'Submissions are paused. You can resume this upload when submissions reopen.',
            );
            return;
        }
        const submission = dashboard?.submissions.find((item) => item.id === upload.submissionId);
        if (!submission || submission.status !== 'draft') {
            setError('This task is no longer an editable draft. Refresh and try again.');
            return;
        }
        if (
            file.size <= DIRECT_UPLOAD_MAX_BYTES ||
            file.name !== upload.filename ||
            file.size !== upload.size
        ) {
            setError('Choose the same original file that started this unfinished upload.');
            return;
        }
        uploadFiles(submission, [file], upload);
    }
    function uploadFiles(submission: Submission, files: FileList | File[], resume?: UploadSession) {
        if (!subsEnabRef.current) {
            setError(
                deadRef.current
                    ? DEAD_TASK_MESSAGE
                    : 'Submissions are paused. Wait for an organiser to reopen them.',
            );
            return;
        }
        const list = Array.from(files);
        if (!list.length) return;
        setError('');
        setNotice('');
        const failures: string[] = [];
        for (const file of list) {
            if (file.size <= 0) {
                failures.push(`${file.name}: empty files cannot be uploaded.`);
                continue;
            }
            if (file.size > MAX_FILE_BYTES) {
                failures.push(`${file.name} is larger than the 2 GB limit.`);
                continue;
            }
            const key = crypto.randomUUID();
            pendUplInfo.current.set(key, { submissionId: submission.id });
            setUploadProgress((current) => ({
                ...current,
                [key]: { submissionId: submission.id, filename: file.name, percent: 0, queued: true },
            }));
            if (resume) setLocalUploadIds((ids) => (ids.includes(resume.id) ? ids : [...ids, resume.id]));
            const task = uploadQueue
                .enqueue(key, async () => {
                    if (cancelledUploads.current.has(key))
                        throw new UploadCancelledError('Upload cancelled.');
                    updateUploadProgress(key, 0);
                    const evidenceId = await uploadOneFile(submission, file, key, resume);
                    try {
                        const preview = await createEvidencePreview(file);
                        if (preview) await saveEvidencePreview(evidenceId, preview);
                    } catch {}
                })
                .then(async () => {
                    await refresh(true);
                    setNotice(
                        `${file.name} was received. Your group can add more evidence before submitting for review.`,
                    );
                })
                .catch(async (uploadError) => {
                    if (uploadError instanceof UploadCancelledError || cancelledUploads.current.has(key))
                        setNotice(`${file.name}: upload cancelled.`);
                    else {
                        const message =
                            uploadError instanceof Error
                                ? uploadError.message
                                : 'This upload could not be completed.';
                        setError((current) =>
                            [current, `${file.name}: ${message}`].filter(Boolean).join(' '),
                        );
                        setFailedUploads((current) => [
                            ...current,
                            { id: key, submissionId: submission.id, file, message },
                        ]);
                    }
                    await refresh(true);
                })
                .finally(() => {
                    pendUplInfo.current.delete(key);
                    uploadTasks.current.delete(key);
                    cancelledUploads.current.delete(key);
                    verifyCtrls.current.delete(key);
                    setUploadProgress((current) => {
                        const next = { ...current };
                        delete next[key];
                        return next;
                    });
                    if (resume) setLocalUploadIds((ids) => ids.filter((id) => id !== resume.id));
                });
            uploadTasks.current.set(key, task);
        }
        if (failures.length) setError(failures.join(' '));
    }
    async function removeEvidence(evidenceId: string) {
        if (deadRef.current) {
            setError(DEAD_TASK_MESSAGE);
            return;
        }
        try {
            await api(`/api/evidence/${evidenceId}`, { method: 'DELETE' });
            await refresh(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove this file.');
        }
    }
    function applySavedComment(evidence: Evidence) {
        setDashboard(
            (current) =>
                current && {
                    ...current,
                    submissions: current.submissions.map((submission) =>
                        submission.id === evidence.submissionId
                            ? {
                                  ...submission,
                                  evidence: submission.evidence.map((file) =>
                                      file.id === evidence.id ? { ...file, comment: evidence.comment } : file,
                                  ),
                              }
                            : submission,
                    ),
                },
        );
        void refresh(true);
    }
    async function sendForReview(submission: Submission) {
        const block = taskBlockReason(deadRef.current, true, Date.now() + serverClockOffset.current);
        if (block) {
            setError(block);
            return;
        }
        if (!subsEnabRef.current) {
            setError(
                deadRef.current
                    ? DEAD_TASK_MESSAGE
                    : 'Submissions are paused. Wait for an organiser to reopen them.',
            );
            return;
        }
        setBusy(true);
        setError('');
        try {
            await draftNotes.flush(submission.id);
            await api(`/api/submissions/${submission.id}/submit`, { method: 'POST' });
            draftNotes.clear(submission.id);
            setNotice('Submission sent to admins for review.');
            await refresh(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not submit for review.');
        } finally {
            setBusy(false);
        }
    }
    async function review(submission: Submission, decision: 'approved' | 'changes_requested') {
        const note = (reviewNotes[submission.id] || '').trim();
        if (decision === 'changes_requested' && !note) {
            setError('Add a reason before requesting replacement evidence.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            await api(`/api/submissions/${submission.id}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision, note }),
            });
            setNotice(
                decision === 'approved'
                    ? 'Submission approved. The group has a review update.'
                    : 'Replacement requested. The group has a review update.',
            );
            setReviewNotes((notes) => {
                const next = { ...notes };
                delete next[submission.id];
                return next;
            });
            setReviewDetails((details) => {
                const next = { ...details };
                delete next[submission.id];
                return next;
            });
            setActiveReviewId('');
            setCheckRev((revision) => revision + 1);
            await refresh(true);
            document.getElementById('review-workspace')?.focus({ preventScroll: true });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save the review.');
        } finally {
            setBusy(false);
        }
    }
    async function updateFeedback(
        submission: Submission,
        note: string,
        previousNote: string | null,
    ): Promise<boolean> {
        if (submission.status === 'changes_requested' && !note.trim()) {
            setError('Feedback cannot be empty when a replacement has been requested.');
            return false;
        }
        setBusy(true);
        setError('');
        try {
            await api(`/api/submissions/${submission.id}/feedback`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note, previousNote }),
            });
            setReviewDetails((details) => {
                const next = { ...details };
                delete next[submission.id];
                return next;
            });
            setCheckRev((revision) => revision + 1);
            await refresh(true);
            setNotice('Feedback updated.');
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not update feedback.');
            return false;
        } finally {
            setBusy(false);
        }
    }
    async function toggleDecision(submission: Submission): Promise<void> {
        const nextStatus = submission.status === 'approved' ? 'changes_requested' : 'approved';
        setBusy(true);
        setError('');
        try {
            await api(`/api/submissions/${submission.id}/decision`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ previousStatus: submission.status }),
            });
            setReviewDetails((details) => {
                const next = { ...details };
                delete next[submission.id];
                return next;
            });
            setCheckRev((revision) => revision + 1);
            await refresh(true);
            setNotice(`Decision changed to ${nextStatus === 'approved' ? 'Approved' : 'Denied'}.`);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not change the decision.');
        } finally {
            setBusy(false);
        }
    }

    async function handleSignIn() {
        setError('');
        setNotice('Signed in successfully.');
        await refresh();
    }

    if (page === 'join') return <InvitationPage />;
    if (authReady && accountAccess && accountAccess !== 'approved')
        return (
            <AccountAccess
                onSignOut={() => void logout()}
                onApproved={handleApproved}
                onSignedOut={handleSignedOut}
                invitationFeedback={invFeedback}
                onRetryInvitation={pendingInv && invFeedback?.error ? retryPendingInvitation : undefined}
            />
        );

    if (page === 'not-found')
        return (
            <main className="auth-page" id="main-content" tabIndex={-1}>
                <div className="auth-shell">
                    <header className="brand">
                        <Brand />
                    </header>
                    <section className="auth-card">
                        <h1>Page not found</h1>
                        <p className="subtext">This page does not exist.</p>
                        <a
                            className="button primary"
                            href="/tasks"
                            onClick={(event) => followLink(event, '/tasks')}
                        >
                            Go to tasks
                        </a>
                    </section>
                </div>
            </main>
        );

    if (
        !authReady ||
        (!dashboard && (isPortalPage(page) || page === 'approval')) ||
        (dashboard && authPage)
    ) {
        return (
            <main className="auth-page" id="main-content" tabIndex={-1}>
                <p role="status">Loading your account…</p>
            </main>
        );
    }

    if (!dashboard)
        return (
            <AuthPage
                mode={{ page, googlePhoneOnly }}
                authOptions={authOpts}
                pendingInvitation={pendingInv}
                registration={{
                    phone: regPhone,
                    setPhone: setRegPhone,
                    groupName,
                    setGroupName,
                    members,
                    setMembers,
                    displayName,
                    setDisplayName,
                    email: regEmail,
                    setEmail: setRegEmail,
                }}
                login={{
                    method: loginMethod,
                    setMethod: setLoginMethod,
                    username,
                    setUsername,
                    password,
                    setPassword,
                    confirmPassword: cfPW,
                    setConfirmPassword: setCfPW,
                }}
                feedback={{ error, setError, notice, setNotice, errorMessage }}
                navigation={{
                    search: route.search,
                    loginHref,
                    followLink,
                    navigateUrl,
                }}
                actions={{
                    busy,
                    submitAuth,
                    onSignedIn: handleSignIn,
                }}
            />
        );
    const isAdmin = dashboard.account.role === 'admin';
    if (page === 'accounts')
        return isAdmin ? (
            <AccountApprovals onBack={() => navigate('home')} />
        ) : (
            <main className="auth-page">
                <section className="auth-card">
                    <h1>Admin access required</h1>
                    <ActionButton className="button primary" onClick={() => navigate('home')}>
                        Return to overview
                    </ActionButton>
                </section>
            </main>
        );
    const groupSubs = dashboard.submissions;
    const archivedTasks = dashboard.archivedTasks ?? [];
    const allTask = [...dashboard.tasks, ...archivedTasks];
    const taskSections = [
        { label: 'Tasks', tasks: dashboard.tasks.filter((task) => !task.bonus), archived: false },
        { label: 'Bonus Task', tasks: dashboard.tasks.filter((task) => task.bonus), archived: false },
        { label: 'Archived tasks', tasks: archivedTasks, archived: true },
    ];
    const selected = allTask.find((task) => task.id === selectedTask) || dashboard.tasks[0];
    const isArchived = !!selected && archivedTasks.some((task) => task.id === selected.id);
    const activeSubs = taskSubs(dashboard.tasks, groupSubs);
    const approvedIds = new Set(
        activeSubs
            .filter((submission) => submission.status === 'approved')
            .map((submission) => submission.taskId),
    );
    const pendingCount = isAdmin
        ? (dashboard.adminPendingCount ??
          activeSubs.filter((submission) => submission.status === 'pending').length)
        : activeSubs.filter((submission) => submission.status === 'pending').length;
    const current = groupSubs.find(
        (submission) => submission.taskId === selected?.id && submission.status === 'draft',
    );
    const archivedReadOnly = isArchived && !current;
    const selHist = groupSubs
        .filter((submission) => submission.taskId === selected?.id)
        .sort((a, b) => b.attempt - a.attempt);
    const recoverableUploads = (dashboard.uploads || []).filter(
        (upload) =>
            upload.submissionId === current?.id &&
            !localUploadIds.includes(upload.id) &&
            upload.state !== 'completed' &&
            upload.state !== 'aborted' &&
            upload.state !== 'expired',
    );
    const reviewQueue = isAdmin ? adminSub : [];
    const reviewIdx = Math.max(
        0,
        reviewQueue.findIndex((item) => item.id === activeReviewId),
    );
    const pageCount = Math.max(1, Math.ceil(adminTotal / 20));

    return (
        <div className="app-shell">
            <a
                className="skip-link"
                href="#main-content"
                onClick={(event) => {
                    event.preventDefault();
                    document.getElementById('main-content')?.focus();
                }}
            >
                Skip to content
            </a>
            <header className="topbar">
                <a className="header-brand" href="/home" onClick={(event) => followLink(event, '/home')}>
                    <Brand compact />
                </a>
                <nav className="site-nav" aria-label="Main navigation">
                    <a
                        className={`nav-link ${page === 'home' ? 'active' : ''}`}
                        aria-current={page === 'home' ? 'page' : undefined}
                        href="/home"
                        onClick={(event) => followLink(event, '/home')}
                    >
                        Overview
                    </a>
                    <a
                        className={`nav-link ${page === 'tasks' ? 'active' : ''}`}
                        aria-current={page === 'tasks' ? 'page' : undefined}
                        href="/tasks"
                        onClick={(event) => followLink(event, '/tasks')}
                    >
                        {isAdmin ? 'Submissions' : 'Tasks'}
                    </a>
                    <a
                        className={`nav-link ${page === 'group' ? 'active' : ''}`}
                        aria-current={page === 'group' ? 'page' : undefined}
                        href="/groups"
                        onClick={(event) => followLink(event, '/groups')}
                    >
                        {isAdmin ? 'Groups' : 'My group'}
                    </a>
                    <a
                        className={`nav-link ${page === 'settings' ? 'active' : ''}`}
                        aria-current={page === 'settings' ? 'page' : undefined}
                        href="/settings"
                        onClick={(event) => followLink(event, '/settings')}
                    >
                        Settings
                    </a>
                </nav>
                <div className="top-actions">
                    <span className="account-name">{dashboard.account.displayName}</span>
                    <ActionButton className="button quiet" onClick={() => refresh()}>
                        Refresh
                    </ActionButton>
                    <ActionButton
                        className="button quiet"
                        disabled={busy}
                        unavailableReason="Please wait for the current action to finish."
                        onClick={logout}
                    >
                        Sign out
                    </ActionButton>
                </div>
            </header>
            <main className="page" id="main-content" tabIndex={-1}>
                <ConnectionStatus
                    state={connection}
                    refreshing={refreshing}
                    onRetry={() => {
                        if (
                            isAdmin &&
                            page !== 'tasks' &&
                            connection.failedScopes.some((scope) => scope === 'queue' || scope === 'detail')
                        )
                            navigate('tasks');
                        else void refresh(true);
                    }}
                />
                {error && (
                    <p className="alert error" role="alert" tabIndex={-1} ref={errorMessage}>
                        {error}
                    </p>
                )}
                {pendingInv && invFeedback?.error && (
                    <ActionButton
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        unavailableReason={busy ? 'Your account is being refreshed.' : undefined}
                        onClick={retryPendingInvitation}
                    >
                        Retry group invitation
                    </ActionButton>
                )}
                {notice && (
                    <p className="alert success" role="status">
                        {notice}
                    </p>
                )}
                {isAdmin && (
                    <div className="account-requests-bar">
                        <span>Manage access to the event portal</span>
                        <a
                            className="button secondary small-button"
                            href="/accounts"
                            onClick={(event) => followLink(event, '/accounts')}
                        >
                            Account requests →
                        </a>
                    </div>
                )}
                {!isAdmin && (
                    <ReviewNotifs
                        key={dashboard.account.id}
                        accountId={dashboard.account.id}
                        tasks={dashboard.tasks}
                        archivedTasks={archivedTasks}
                        submissions={dashboard.submissions}
                        dashboardInbox={dashboard.reviewInbox}
                        dashboardInboxRequestedAt={dashboard.reviewInboxRequestedAt}
                        onOpenTask={openTask}
                        onReplace={replaceTaskEvidence}
                    />
                )}
                <AnnouncementInbox
                    key={`announcements-${dashboard.account.id}`}
                    accountId={dashboard.account.id}
                />
                {!isAdmin && (
                    <HomeScreenNotifs
                        key={`push-${dashboard.account.id}`}
                        accountId={dashboard.account.id}
                        visible={page === 'home' || page === 'settings'}
                    />
                )}
                {page === 'home' && (
                    <EventDashboard
                        dashboard={dashboard}
                        onChanged={() => refresh(true)}
                        onOpenTask={openTask}
                        onOpenReview={() => {
                            setFilter('pending');
                            setFilterGroup('all');
                            setFilterTask('all');
                            setReviewSearch('');
                            resetReviewQueuePage();
                            navigate('tasks');
                        }}
                        onOpenGroup={(groupId) => {
                            setManagedGroupId(groupId);
                            navigate('group');
                        }}
                    />
                )}
                {page === 'settings' && (
                    <div className="account-page">
                        <Settings
                            key={dashboard.account.id}
                            account={dashboard.account}
                            group={dashboard.group}
                            adminGroups={isAdmin ? dashboard.groups : undefined}
                            onChanged={() => refresh(true)}
                        />
                        <LinkedSignIns key={dashboard.account.id} options={authOpts} />
                    </div>
                )}
                {page === 'group' &&
                    (isAdmin ? (
                        <div className="group-page">
                            <div className="main-heading">
                                <div>
                                    <h1>Groups</h1>
                                    <p className="page-summary">
                                        View task progress and submissions for each group.
                                    </p>
                                </div>
                            </div>
                            <section className="simple-panel">
                                <div className="progress-table-wrap">
                                    <table className="progress-table">
                                        <thead>
                                            <tr>
                                                <th scope="col">Group</th>
                                                <th scope="col">Game roster</th>
                                                <th scope="col">Approved</th>
                                                <th scope="col">Awaiting review</th>
                                                <th scope="col">Submissions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {dashboard.groups.map((group) => {
                                                const submissions = groupSubs.filter(
                                                    (submission) => submission.groupId === group.id,
                                                );
                                                const approved = new Set(
                                                    taskSubs(dashboard.tasks, submissions)
                                                        .filter(
                                                            (submission) => submission.status === 'approved',
                                                        )
                                                        .map((submission) => submission.taskId),
                                                ).size;
                                                const pending = taskSubs(dashboard.tasks, submissions).filter(
                                                    (submission) => submission.status === 'pending',
                                                ).length;
                                                return (
                                                    <tr key={group.id}>
                                                        <td>{group.name}</td>
                                                        <td>{group.members.join(', ')}</td>
                                                        <td>
                                                            {approved} / {dashboard.tasks.length}
                                                        </td>
                                                        <td>{pending}</td>
                                                        <td>
                                                            <ActionButton
                                                                type="button"
                                                                className="text-button"
                                                                onClick={() => {
                                                                    setFilterGroup(group.id);
                                                                    setFilter('all');
                                                                    navigate('tasks');
                                                                }}
                                                            >
                                                                View submissions
                                                            </ActionButton>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        </div>
                    ) : (
                        <div className="group-page">
                            <div className="main-heading">
                                <div>
                                    <h1>My group</h1>
                                    <p className="page-summary">
                                        {dashboard.group?.name} · {approvedIds.size} of{' '}
                                        {dashboard.tasks.length} tasks approved
                                    </p>
                                </div>
                            </div>
                            <section className="simple-panel">
                                <h2>Game roster</h2>
                                <p className="group-roster">{dashboard.group?.members.join(', ')}</p>
                                <p className="hint">
                                    Members share the same task progress. Evidence is visible to your group
                                    and administrators.
                                </p>
                            </section>
                            <section className="simple-panel">
                                <h2>Task progress</h2>
                                <div className="progress-table-wrap">
                                    <table className="progress-table">
                                        <thead>
                                            <tr>
                                                <th scope="col">Task</th>
                                                <th scope="col">Status</th>
                                                <th scope="col">Details</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {dashboard.tasks.map((task) => {
                                                const latest = groupSubs
                                                    .filter((submission) => submission.taskId === task.id)
                                                    .sort((a, b) => b.attempt - a.attempt)[0];
                                                return (
                                                    <tr key={task.id}>
                                                        <td>
                                                            {task.emoji ? `${task.emoji} ` : ''}
                                                            {task.title}
                                                        </td>
                                                        <td>
                                                            {latest
                                                                ? submissionStatusLabel(latest.status)
                                                                : 'Not started'}
                                                        </td>
                                                        <td>
                                                            <ActionButton
                                                                type="button"
                                                                className="text-button"
                                                                onClick={() => {
                                                                    setSelectedTask(task.id);
                                                                    navigate('tasks');
                                                                }}
                                                            >
                                                                View task
                                                            </ActionButton>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            {archivedTasks.map((task) => {
                                                const latest = groupSubs
                                                    .filter((submission) => submission.taskId === task.id)
                                                    .sort((a, b) => b.attempt - a.attempt)[0];
                                                return (
                                                    <tr className="archived-task-row" key={task.id}>
                                                        <td>
                                                            {task.emoji ? `${task.emoji} ` : ''}
                                                            {task.title} <small>Archived</small>
                                                        </td>
                                                        <td>
                                                            {latest
                                                                ? submissionStatusLabel(latest.status)
                                                                : 'Not started'}
                                                        </td>
                                                        <td>
                                                            <ActionButton
                                                                type="button"
                                                                className="text-button"
                                                                onClick={() => {
                                                                    setSelectedTask(task.id);
                                                                    navigate('tasks');
                                                                }}
                                                            >
                                                                View evidence
                                                            </ActionButton>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        </div>
                    ))}
                {page === 'group' &&
                    (isAdmin
                        ? dashboard.groups.length > 0 && (
                              <div className="group-management">
                                  <label className="group-filter">
                                      Manage members for{' '}
                                      <select
                                          value={
                                              dashboard.groups.some((group) => group.id === managedGroupId)
                                                  ? managedGroupId
                                                  : dashboard.groups[0].id
                                          }
                                          onChange={(event) => setManagedGroupId(event.target.value)}
                                      >
                                          {dashboard.groups.map((group) => (
                                              <option key={group.id} value={group.id}>
                                                  {group.name}
                                              </option>
                                          ))}
                                      </select>
                                  </label>
                                  <GroupMembers
                                      key={managedGroupId || dashboard.groups[0].id}
                                      groupId={
                                          dashboard.groups.some((group) => group.id === managedGroupId)
                                              ? managedGroupId
                                              : dashboard.groups[0].id
                                      }
                                      onChanged={() => refresh(true)}
                                  />
                              </div>
                          )
                        : dashboard.group && (
                              <GroupMembers groupId={dashboard.group.id} onChanged={() => refresh(true)} />
                          ))}
                {page === 'tasks' &&
                    (isAdmin ? (
                        <>
                            <div className="main-heading">
                                <div>
                                    <h1>Submissions</h1>
                                    <p className="page-summary">
                                        {adminTotal}{' '}
                                        {filter === 'pending'
                                            ? 'waiting submissions match your filters.'
                                            : 'submissions match your filters.'}{' '}
                                        {pendingCount} awaiting review overall.
                                    </p>
                                </div>
                            </div>
                            <div className="filter-row">
                                <ActionButton
                                    aria-pressed={filter === 'pending'}
                                    className={filter === 'pending' ? 'filter active' : 'filter'}
                                    onClick={() => {
                                        setFilter('pending');
                                        resetReviewQueuePage();
                                    }}
                                >
                                    Needs review
                                </ActionButton>
                                <ActionButton
                                    aria-pressed={filter === 'all'}
                                    className={filter === 'all' ? 'filter active' : 'filter'}
                                    onClick={() => {
                                        setFilter('all');
                                        resetReviewQueuePage();
                                    }}
                                >
                                    All submissions
                                </ActionButton>
                                <div className="review-mode">
                                    <ActionButton
                                        className="button small-button"
                                        aria-pressed={reviewMode === 'focus'}
                                        onClick={() => setReviewMode('focus')}
                                    >
                                        One at a time
                                    </ActionButton>
                                    <ActionButton
                                        className="button small-button"
                                        aria-pressed={reviewMode === 'list'}
                                        onClick={() => setReviewMode('list')}
                                    >
                                        List view
                                    </ActionButton>
                                </div>
                            </div>
                            <div className="admin-review-tools">
                                <label>
                                    Group
                                    <select
                                        value={filterGroup}
                                        onChange={(event) => {
                                            setFilterGroup(event.target.value);
                                            resetReviewQueuePage();
                                        }}
                                    >
                                        <option value="all">All groups</option>
                                        {dashboard.groups.map((group) => (
                                            <option key={group.id} value={group.id}>
                                                {group.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    Task
                                    <select
                                        value={filterTask}
                                        onChange={(event) => {
                                            setFilterTask(event.target.value);
                                            resetReviewQueuePage();
                                        }}
                                    >
                                        <option value="all">All tasks</option>
                                        {allTask.map((task) => (
                                            <option key={task.id} value={task.id}>
                                                {task.title}
                                                {archivedTasks.some((archived) => archived.id === task.id)
                                                    ? ' (Archived)'
                                                    : ''}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    Order
                                    <select
                                        value={reviewSort}
                                        onChange={(event) => {
                                            setReviewSort(event.target.value as 'oldest' | 'newest');
                                            resetReviewQueuePage();
                                        }}
                                    >
                                        <option value="oldest">Oldest waiting first</option>
                                        <option value="newest">Newest first</option>
                                    </select>
                                </label>
                                <label>
                                    Find a group or task
                                    <input
                                        type="search"
                                        value={reviewSearch}
                                        onChange={(event) => {
                                            setReviewSearch(event.target.value);
                                            resetReviewQueuePage();
                                        }}
                                        placeholder="Search submissions"
                                    />
                                </label>
                            </div>
                            {filter === 'all' && (
                                <p className="review-help">
                                    Use the Approval status button on a reviewed submission to switch between
                                    Approved and Denied.
                                </p>
                            )}
                            {adminTotal > 0 && (
                                <div className="review-position">
                                    <p role="status">{`Page ${reviewPage} of ${pageCount} · ${adminTotal} submission${adminTotal === 1 ? '' : 's'}`}</p>
                                    <div>
                                        <ActionButton
                                            className="button secondary small-button"
                                            disabled={busy || reviewPage <= 1 || !reviewCursors.previous}
                                            unavailableReason="You are on the first page."
                                            onClick={() => {
                                                if (!reviewCursors.previous) return;
                                                setCheckCursorReq({
                                                    cursor: reviewCursors.previous,
                                                    direction: 'previous',
                                                });
                                                setReviewPage((value) => Math.max(1, value - 1));
                                                setActiveReviewId('');
                                            }}
                                        >
                                            Previous page
                                        </ActionButton>
                                        <ActionButton
                                            className="button secondary small-button"
                                            disabled={busy || reviewPage >= pageCount || !reviewCursors.next}
                                            unavailableReason="You are on the last page."
                                            onClick={() => {
                                                if (!reviewCursors.next) return;
                                                setCheckCursorReq({
                                                    cursor: reviewCursors.next,
                                                    direction: 'next',
                                                });
                                                setReviewPage((value) => Math.min(pageCount, value + 1));
                                                setActiveReviewId('');
                                            }}
                                        >
                                            Next page
                                        </ActionButton>
                                    </div>
                                </div>
                            )}
                            <div className="review-list" id="review-workspace" tabIndex={-1}>
                                {reviewQueue.length === 0 ? (
                                    <div className="empty">
                                        <strong>
                                            {filter === 'pending' && pendingCount === 0
                                                ? 'You’re all caught up'
                                                : 'No submissions match these filters'}
                                        </strong>
                                        <p>
                                            {filter === 'pending' && pendingCount === 0
                                                ? 'New group submissions will appear here.'
                                                : 'Choose another group or task, or clear the search.'}
                                        </p>
                                    </div>
                                ) : reviewMode === 'list' ? (
                                    reviewQueue.map((item) => (
                                        <article className="admin-card" key={item.id}>
                                            <div className="admin-head">
                                                <div>
                                                    <h2>
                                                        {item.groupName} <span>·</span> {item.taskTitle}
                                                    </h2>
                                                    <p>
                                                        Attempt {item.attempt} ·{' '}
                                                        {item.latest ? 'Latest attempt' : 'History'}
                                                        {item.submittedAt
                                                            ? ` · Uploaded ${formatDate(item.submittedAt)}`
                                                            : ''}
                                                    </p>
                                                </div>
                                                <span className={submissionStatusClass(item.status)}>
                                                    {submissionStatusLabel(item.status)}
                                                </span>
                                            </div>
                                            <ActionButton
                                                className="button secondary small-button"
                                                onClick={() => {
                                                    setActiveReviewId(item.id);
                                                    setReviewMode('focus');
                                                }}
                                            >
                                                Open submission
                                            </ActionButton>
                                        </article>
                                    ))
                                ) : (
                                    (() => {
                                        const selectSumm = reviewQueue[reviewIdx];
                                        const detail = selectSumm ? reviewDetails[selectSumm.id] : undefined;
                                        if (!selectSumm) return null;
                                        return detail ? (
                                            <>
                                                <div className="review-position">
                                                    <p role="status">
                                                        Showing {reviewIdx + 1} of {adminTotal} submissions
                                                    </p>
                                                    <div>
                                                        <ActionButton
                                                            className="button secondary small-button"
                                                            disabled={busy || reviewIdx === 0}
                                                            unavailableReason="You are already at the first submission on this page."
                                                            onClick={() =>
                                                                setActiveReviewId(
                                                                    reviewQueue[reviewIdx - 1].id,
                                                                )
                                                            }
                                                        >
                                                            Previous
                                                        </ActionButton>
                                                        <ActionButton
                                                            className="button secondary small-button"
                                                            disabled={
                                                                busy || reviewIdx >= reviewQueue.length - 1
                                                            }
                                                            unavailableReason="You are already at the last submission on this page."
                                                            onClick={() =>
                                                                setActiveReviewId(
                                                                    reviewQueue[reviewIdx + 1].id,
                                                                )
                                                            }
                                                        >
                                                            Review next →
                                                        </ActionButton>
                                                    </div>
                                                </div>
                                                <AdminSubmission
                                                    key={detail.id}
                                                    submission={detail}
                                                    task={allTask.find((task) => task.id === detail.taskId)}
                                                    group={dashboard.groups.find(
                                                        (group) => group.id === detail.groupId,
                                                    )}
                                                    note={reviewNotes[detail.id] || ''}
                                                    setNote={(note) =>
                                                        setReviewNotes((notes) => ({
                                                            ...notes,
                                                            [detail.id]: note,
                                                        }))
                                                    }
                                                    onReview={(decision) => review(detail, decision)}
                                                    canEditFeedback={
                                                        filter === 'all' &&
                                                        (detail.status === 'approved' ||
                                                            detail.status === 'changes_requested')
                                                    }
                                                    canToggleDecision={
                                                        filter === 'all' &&
                                                        (detail.status === 'approved' ||
                                                            detail.status === 'changes_requested') &&
                                                        selectSumm.latest
                                                    }
                                                    hasNewerAttempt={filter === 'all' && !selectSumm.latest}
                                                    onToggleDecision={() => toggleDecision(detail)}
                                                    onSaveFeedback={(note, previousNote) =>
                                                        updateFeedback(detail, note, previousNote)
                                                    }
                                                    busy={busy}
                                                />
                                            </>
                                        ) : (
                                            <p role="status" className="event-empty">
                                                Loading original evidence…
                                            </p>
                                        );
                                    })()
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="main-heading">
                                <div>
                                    <h1>Tasks</h1>
                                    <p className="page-summary">
                                        {dashboard.group?.name || dashboard.account.displayName} ·{' '}
                                        {approvedIds.size} of {dashboard.tasks.length} tasks approved
                                        {pendingCount > 0 ? ` · ${pendingCount} awaiting review` : ''}
                                    </p>
                                </div>
                            </div>
                            {(dead || lunch) && (
                                <p className="alert" role="status">
                                    {dead ? DEAD_TASK_MESSAGE : LUNCH_MESSAGE}
                                </p>
                            )}
                            <select
                                className="task-select"
                                aria-label="Select a task"
                                value={selected?.id || ''}
                                onChange={(event) => setSelectedTask(event.target.value)}
                            >
                                {taskSections
                                    .filter((section) => section.tasks.length > 0)
                                    .map((section) => (
                                        <optgroup key={section.label} label={section.label}>
                                            {section.tasks.map((task) => {
                                                const status = latestTaskStatus(task, groupSubs);
                                                return (
                                                    <option key={task.id} value={task.id}>
                                                        {task.emoji ? `${task.emoji} ` : ''}
                                                        {task.title} —{' '}
                                                        {status
                                                            ? submissionStatusLabel(status)
                                                            : 'Not started'}
                                                    </option>
                                                );
                                            })}
                                        </optgroup>
                                    ))}
                            </select>
                            <div className="task-workspace">
                                <aside className="task-panel task-sidebar">
                                    <div className="section-title">
                                        <h2>Task list</h2>
                                        <span>{dashboard.tasks.length}</span>
                                    </div>
                                    <nav className="task-list" aria-label="Task list">
                                        {taskSections.map(
                                            (section, sectionIndex) =>
                                                section.tasks.length > 0 && (
                                                    <React.Fragment key={section.label}>
                                                        {sectionIndex > 0 && (
                                                            <h3 className="task-list-heading">
                                                                {section.label}
                                                            </h3>
                                                        )}
                                                        {section.tasks.map((task, index) => {
                                                            const status = latestTaskStatus(task, groupSubs);
                                                            const marker = section.archived
                                                                ? '—'
                                                                : task.bonus
                                                                  ? '★'
                                                                  : `${index + 1}.`;
                                                            return (
                                                                <ActionButton
                                                                    key={task.id}
                                                                    onClick={() => setSelectedTask(task.id)}
                                                                    aria-current={
                                                                        selected?.id === task.id
                                                                            ? 'true'
                                                                            : undefined
                                                                    }
                                                                    className={`task-nav ${selected?.id === task.id ? 'selected' : ''}`}
                                                                >
                                                                    <span
                                                                        className="task-number"
                                                                        aria-hidden="true"
                                                                    >
                                                                        {marker}
                                                                    </span>
                                                                    <span className="task-nav-copy">
                                                                        <strong>
                                                                            {task.emoji && (
                                                                                <span aria-hidden="true">
                                                                                    {task.emoji}{' '}
                                                                                </span>
                                                                            )}
                                                                            {task.title}
                                                                        </strong>
                                                                        <small>
                                                                            {status
                                                                                ? submissionStatusLabel(
                                                                                      status,
                                                                                  )
                                                                                : 'Not started'}
                                                                        </small>
                                                                    </span>
                                                                </ActionButton>
                                                            );
                                                        })}
                                                    </React.Fragment>
                                                ),
                                        )}
                                    </nav>
                                </aside>
                                {selected && (
                                    <section className="task-detail">
                                        <div className="detail-head">
                                            <div>
                                                <h2>
                                                    {selected.emoji && (
                                                        <span aria-hidden="true">{selected.emoji} </span>
                                                    )}
                                                    {selected.title}
                                                </h2>
                                                <p>{selected.description}</p>
                                            </div>
                                            <span className="media-tag">
                                                {selected.media === 'photo'
                                                    ? 'Photo evidence'
                                                    : 'Video evidence'}
                                            </span>
                                        </div>
                                        {isArchived && (
                                            <p className="archived-task-notice">
                                                Archived task · Existing submissions and evidence are
                                                available for reference.
                                            </p>
                                        )}
                                        <div className="requirements">
                                            <h3>Requirements</h3>
                                            <ul>
                                                {selected.requirements.map((requirement) => (
                                                    <li key={requirement}>{requirement}</li>
                                                ))}
                                            </ul>
                                        </div>
                                        <UploadRecoveryPanel
                                            uploads={recoverableUploads}
                                            busy={busy}
                                            submissionsEnabled={
                                                dashboard.submissionsEnabled !== false &&
                                                !dead &&
                                                !archivedReadOnly
                                            }
                                            blockedReason={dead ? DEAD_TASK_MESSAGE : undefined}
                                            onFinish={finishRecoveredUpload}
                                            onResume={resumeUpload}
                                            onCancel={cancelRecoveredUpload}
                                        />
                                        {failedUploads
                                            .filter((upload) =>
                                                groupSubs.some(
                                                    (submission) =>
                                                        submission.id === upload.submissionId &&
                                                        submission.taskId === selected.id &&
                                                        submission.status === 'draft',
                                                ),
                                            )
                                            .map((upload) => {
                                                const draft = groupSubs.find(
                                                    (submission) => submission.id === upload.submissionId,
                                                )!;
                                                return (
                                                    <div className="failed-upload" key={upload.id}>
                                                        <div>
                                                            <strong>{upload.file.name}</strong>
                                                            <p>{upload.message}</p>
                                                            <small>
                                                                Your other evidence is safe. Check the
                                                                evidence list before retrying a transfer with
                                                                an uncertain result.
                                                            </small>
                                                        </div>
                                                        <div>
                                                            <ActionButton
                                                                className="button secondary small-button"
                                                                disabled={
                                                                    busy ||
                                                                    dead ||
                                                                    dashboard.submissionsEnabled === false
                                                                }
                                                                unavailableReason={
                                                                    dead
                                                                        ? DEAD_TASK_MESSAGE
                                                                        : dashboard.submissionsEnabled ===
                                                                            false
                                                                          ? 'Submissions are paused.'
                                                                          : busy
                                                                            ? 'Please wait for the current action to finish.'
                                                                            : undefined
                                                                }
                                                                onClick={() => {
                                                                    setFailedUploads((uploads) =>
                                                                        uploads.filter(
                                                                            (item) => item.id !== upload.id,
                                                                        ),
                                                                    );
                                                                    uploadFiles(draft, [upload.file]);
                                                                }}
                                                            >
                                                                Retry upload
                                                            </ActionButton>
                                                            <ActionButton
                                                                className="text-button"
                                                                onClick={() =>
                                                                    setFailedUploads((uploads) =>
                                                                        uploads.filter(
                                                                            (item) => item.id !== upload.id,
                                                                        ),
                                                                    )
                                                                }
                                                            >
                                                                Dismiss
                                                            </ActionButton>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        {selHist.map((submission) => (
                                            <SubmissionCard
                                                key={submission.id}
                                                submission={submission}
                                                editable={
                                                    submission.id === current?.id &&
                                                    submission.status === 'draft'
                                                }
                                                submissionsEnabled={
                                                    dashboard.submissionsEnabled !== false && !dead
                                                }
                                                blockedReason={dead ? DEAD_TASK_MESSAGE : undefined}
                                                submitBlockedReason={
                                                    taskBlockReason(
                                                        dead,
                                                        true,
                                                        clockNow + serverClockOffset.current,
                                                    ) ?? undefined
                                                }
                                                dead={dead}
                                                draftNotes={draftNotes}
                                                task={selected}
                                                uploadProgress={uploadProgress}
                                                serverUploads={(dashboard.uploads || []).filter(
                                                    (upload) =>
                                                        upload.submissionId === submission.id &&
                                                        !['completed', 'aborted', 'expired'].includes(
                                                            upload.state,
                                                        ),
                                                )}
                                                onUpload={(files) => uploadFiles(submission, files)}
                                                onCancelUpload={cancelUpload}
                                                onRemove={removeEvidence}
                                                onSubmit={() => sendForReview(submission)}
                                                onCommentSaved={applySavedComment}
                                                busy={busy}
                                            />
                                        ))}
                                        {!isArchived &&
                                            !selHist.some(
                                                (submission) =>
                                                    submission.status === 'pending' ||
                                                    submission.status === 'approved',
                                            ) &&
                                            !current && (
                                                <ActionButton
                                                    className="button primary"
                                                    disabled={
                                                        busy ||
                                                        dead ||
                                                        dashboard.submissionsEnabled === false ||
                                                        approvedIds.has(selected.id)
                                                    }
                                                    unavailableReason={
                                                        dead
                                                            ? DEAD_TASK_MESSAGE
                                                            : dashboard.submissionsEnabled === false
                                                              ? 'Submissions are paused.'
                                                              : busy
                                                                ? 'Please wait for the current action to finish.'
                                                                : 'This task is already approved and counts toward your group’s progress.'
                                                    }
                                                    onClick={() => createSubmission(selected.id)}
                                                >
                                                    {selHist.some(
                                                        (submission) =>
                                                            submission.status === 'changes_requested',
                                                    )
                                                        ? 'Upload replacement evidence'
                                                        : 'Start this task'}
                                                </ActionButton>
                                            )}
                                        {approvedIds.has(selected.id) && (
                                            <div className="approved-note">
                                                <strong>Task approved</strong>
                                                <span>
                                                    This task counts once towards your group’s approved task
                                                    progress.
                                                </span>
                                            </div>
                                        )}
                                        {selHist.length === 0 && (
                                            <p className="muted small-note">
                                                You can save evidence here over time, then send it to admins
                                                when the group is ready.
                                            </p>
                                        )}
                                    </section>
                                )}
                            </div>
                        </>
                    ))}
            </main>
            <footer className="footer">
                <p>Manhunt IX · Task submissions</p>
                <LegalLinks />
            </footer>
        </div>
    );
}
