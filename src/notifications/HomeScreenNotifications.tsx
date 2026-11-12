import { useEffect, useRef, useState } from 'react';
import { ActionButton } from '../ui/ActionButton';
import {
    disablePushNotifications,
    enablePushNotifications,
    isHomeScreenApp,
    prepareHomeScreenApp,
    pushAccount,
    pushRequest,
    savePushSubscription,
    supportsPush,
    type PushConfig,
} from './pushClient';
import { nextTestMsg, type PushTestBurstState } from './pushTestMessages';
import './homeScreenNotifications.css';

interface InstallPrompt extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function HomeScreenNotifs({ accountId, visible }: { accountId: string; visible: boolean }) {
    const [installed, setInstalled] = useState(isHomeScreenApp);
    const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
    const [config, setConfig] = useState<PushConfig | null>(null);
    const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [permission, setPermission] = useState(() =>
        'Notification' in window ? Notification.permission : 'default',
    );
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [testFeedback, setTestFeedback] = useState<{
        kind: 'pending' | 'success' | 'error';
        message: string;
    } | null>(null);
    const testBurst = useRef<PushTestBurstState>({ consecutiveClicks: 0, lastClickAt: null });
    const testInFlight = useRef(0);
    const lastTestReq = useRef(0);
    const supported = supportsPush();
    const ios =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    useEffect(() => {
        const beforeInstall = (event: Event) => {
            event.preventDefault();
            setInstallPrompt(event as InstallPrompt);
        };
        const afterInstall = () => {
            setInstalled(true);
            setInstallPrompt(null);
        };
        const displayMode = window.matchMedia('(display-mode: standalone)');
        const onDisplayMode = () => setInstalled(isHomeScreenApp());
        window.addEventListener('beforeinstallprompt', beforeInstall);
        window.addEventListener('appinstalled', afterInstall);
        displayMode.addEventListener('change', onDisplayMode);
        return () => {
            window.removeEventListener('beforeinstallprompt', beforeInstall);
            window.removeEventListener('appinstalled', afterInstall);
            displayMode.removeEventListener('change', onDisplayMode);
        };
    }, []);

    useEffect(() => {
        if (!supported) return;
        let cancelled = false;
        async function load() {
            try {
                const [nextConfig, worker] = await Promise.all([
                    pushRequest<PushConfig>('/api/push/config'),
                    prepareHomeScreenApp(),
                ]);
                const subscription = await worker.pushManager.getSubscription();
                const optedIn =
                    Notification.permission === 'granted' && !!subscription && pushAccount() === accountId;
                if (optedIn && nextConfig.enabled && subscription)
                    await savePushSubscription(accountId, subscription);
                if (cancelled) return;
                setConfig(nextConfig);
                setRegistration(worker);
                setEnabled(optedIn && nextConfig.enabled);
                setPermission(Notification.permission);
                setError('');
            } catch (cause) {
                if (!cancelled)
                    setError(cause instanceof Error ? cause.message : 'Could not check notifications.');
            }
        }
        void load();
        const onFocus = () => {
            setInstalled(isHomeScreenApp());
            void load();
        };
        window.addEventListener('focus', onFocus);
        return () => {
            cancelled = true;
            window.removeEventListener('focus', onFocus);
        };
    }, [accountId, supported, attempt]);

    async function enable() {
        if (!registration || !config?.publicKey) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
            await enablePushNotifications(accountId, registration, config.publicKey);
            setEnabled(true);
            setPermission(Notification.permission);
            setMessage(
                'Notifications are enabled on this device. You’ll be alerted when your group receives a review update, even with the app closed.',
            );
        } catch (cause) {
            setPermission(Notification.permission);
            setError(cause instanceof Error ? cause.message : 'Could not enable notifications.');
        } finally {
            setBusy(false);
        }
    }
    async function disable() {
        if (!registration) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
            await disablePushNotifications(registration);
            setEnabled(false);
            setMessage('Notifications are turned off on this device.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not turn off notifications.');
        } finally {
            setBusy(false);
        }
    }
    async function sendTestNotification() {
        if (testInFlight.current >= 3) {
            setTestFeedback({
                kind: 'error',
                message: 'Please wait for a test notification to finish before sending another.',
            });
            return;
        }
        const next = nextTestMsg(testBurst.current, Date.now());
        testBurst.current = next.state;
        const requestId = ++lastTestReq.current;
        testInFlight.current += 1;
        setTestFeedback({ kind: 'pending', message: 'Sending test notification...' });
        try {
            const subscription = await registration?.pushManager.getSubscription();
            if (!subscription)
                throw new Error(
                    'This device’s notification subscription is missing. Turn notifications off and on again.',
                );
            await pushRequest('/api/push/test', 'POST', {
                endpoint: subscription.endpoint,
                message: next.message,
            });
            if (lastTestReq.current === requestId)
                setTestFeedback({ kind: 'success', message: 'Sent test notification!' });
        } catch (cause) {
            if (lastTestReq.current === requestId)
                setTestFeedback({
                    kind: 'error',
                    message: cause instanceof Error ? cause.message : 'Could not send a test notification.',
                });
        } finally {
            testInFlight.current = Math.max(0, testInFlight.current - 1);
        }
    }
    async function install() {
        if (!installPrompt) return;
        setError('');
        setBusy(true);
        try {
            await installPrompt.prompt();
            await installPrompt.userChoice;
            setInstallPrompt(null);
        } catch {
            setError(
                'Could not open installation. Use your browser menu to add Manhunt IX to your home screen.',
            );
        } finally {
            setBusy(false);
        }
    }

    if (!visible) return null;
    const needsInstall = ios && !installed;
    return (
        <section className="home-screen-notifications" aria-labelledby="home-screen-heading">
            <div>
                <h2 id="home-screen-heading">
                    {enabled ? 'Notifications enabled' : 'Home-screen notifications'}
                </h2>
                <p>
                    {enabled
                        ? 'Review updates and announcements can reach this device when the app is closed.'
                        : 'Add Manhunt IX to your home screen and enable notifications for review updates and event announcements.'}
                </p>
            </div>
            {!installed && (
                <div className="home-screen-install">
                    {installPrompt && (
                        <ActionButton
                            className="button secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void install()}
                        >
                            Add to home screen
                        </ActionButton>
                    )}
                    <p className="hint">
                        {ios
                            ? 'Open your browser’s Share menu, choose Add to Home Screen, then open Manhunt IX from its new icon. Keep Open as Web App enabled if shown.'
                            : 'Use your browser’s Install app or Add to Home Screen option, then open Manhunt IX from its new icon.'}
                    </p>
                </div>
            )}
            {!window.isSecureContext ? (
                <p className="hint">Home-screen notifications need a secure HTTPS website.</p>
            ) : needsInstall ? (
                <p className="hint">
                    After opening the home-screen app, tap Enable notifications and choose Allow.
                </p>
            ) : !supported ? (
                <p className="hint">
                    This browser does not support device notifications. Review updates are available in your
                    inbox.
                </p>
            ) : config && !config.enabled ? (
                <p className="hint">
                    Device notifications are not available yet. Your review inbox will still update here.
                </p>
            ) : (
                <div className="home-screen-actions">
                    <ActionButton
                        className={`button ${enabled ? 'secondary' : 'primary'}`}
                        type="button"
                        disabled={
                            busy ||
                            !registration ||
                            !config?.publicKey ||
                            (!enabled && permission === 'denied')
                        }
                        unavailableReason={
                            permission === 'denied' && !enabled
                                ? 'Allow notifications for Manhunt IX in your device or browser settings, then return here.'
                                : busy
                                  ? 'Please wait for the current change to finish.'
                                  : 'Notifications are still being prepared. Try again in a moment.'
                        }
                        onClick={() => void (enabled ? disable() : enable())}
                    >
                        {busy ? 'Please wait…' : enabled ? 'Turn off on this device' : 'Enable notifications'}
                    </ActionButton>
                    {enabled && (
                        <ActionButton
                            className="button secondary"
                            type="button"
                            disabled={busy}
                            unavailableReason={
                                busy
                                    ? 'Please wait for the current notification change to finish.'
                                    : undefined
                            }
                            onClick={() => void sendTestNotification()}
                        >
                            Send test notification
                        </ActionButton>
                    )}
                    {permission === 'denied' && !enabled && (
                        <p className="hint">
                            Notifications are blocked. Allow them in your device or browser settings, then
                            return to the app.
                        </p>
                    )}
                </div>
            )}
            {message && (
                <p className="hint" role="status">
                    {message}
                </p>
            )}
            {testFeedback && (
                <p
                    className={`hint notification-test-${testFeedback.kind}`}
                    role={testFeedback.kind === 'error' ? 'alert' : 'status'}
                >
                    {testFeedback.message}
                </p>
            )}
            {error && (
                <p className="hint notification-error" role="alert">
                    {error}{' '}
                    <button
                        className="text-button"
                        type="button"
                        onClick={() => setAttempt((value) => value + 1)}
                    >
                        Try again
                    </button>
                </p>
            )}
        </section>
    );
}
