export interface PushConfig {
    enabled: boolean;
    publicKey: string | null;
}
const BINDING_KEY = 'manhunt_push_account';
let workerPromise: Promise<ServiceWorkerRegistration> | undefined;

export function isHomeScreenApp(): boolean {
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
}

export function supportsPush(): boolean {
    return (
        window.isSecureContext &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    );
}

export function prepareHomeScreenApp(): Promise<ServiceWorkerRegistration> {
    if (!workerPromise) {
        workerPromise = navigator.serviceWorker
            .register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
            .then(() => navigator.serviceWorker.ready)
            .catch((error) => {
                workerPromise = undefined;
                throw error;
            });
    }
    return workerPromise;
}

export async function pushRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body === undefined
            ? {}
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error || 'Could not update notifications. Please try again.');
    return result as T;
}

export function pushKeyBytes(value: string): Uint8Array<ArrayBuffer> {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (character) =>
        character.charCodeAt(0),
    );
}

export function pushAccount(): string | null {
    try {
        return localStorage.getItem(BINDING_KEY);
    } catch {
        return null;
    }
}
function rememberPushAccount(accountId: string | null) {
    try {
        if (accountId) localStorage.setItem(BINDING_KEY, accountId);
        else localStorage.removeItem(BINDING_KEY);
    } catch {}
}

export async function savePushSubscription(accountId: string, subscription: PushSubscription) {
    await pushRequest('/api/push/subscriptions', 'POST', { subscription: subscription.toJSON() });
    rememberPushAccount(accountId);
}

export async function enablePushNotifications(
    accountId: string,
    registration: ServiceWorkerRegistration,
    publicKey: string,
): Promise<PushSubscription> {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted')
        throw new Error(
            permission === 'denied'
                ? 'Notifications are blocked. Allow notifications for Manhunt IX in your device or browser settings, then try again.'
                : 'Notifications were not enabled. Tap Enable notifications when you are ready.',
        );
    const existing = await registration.pushManager.getSubscription();
    const subscription =
        existing ??
        (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: pushKeyBytes(publicKey),
        }));
    try {
        await savePushSubscription(accountId, subscription);
    } catch (error) {
        if (!existing) await subscription.unsubscribe().catch(() => false);
        throw error;
    }
    return subscription;
}

export async function disablePushNotifications(registration: ServiceWorkerRegistration): Promise<void> {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
        await pushRequest('/api/push/subscriptions', 'DELETE', { endpoint: subscription.endpoint });
        if (!(await subscription.unsubscribe()))
            throw new Error(
                'Notifications were removed from your account. Try turning them off again to finish removing them from this device.',
            );
    }
    rememberPushAccount(null);
    for (const notification of await registration.getNotifications()) notification.close();
}

export async function clearPushOnSignOut(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration('/');
    try {
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
            try {
                await pushRequest('/api/push/subscriptions', 'DELETE', { endpoint: subscription.endpoint });
            } finally {
                await subscription.unsubscribe();
            }
        }
    } finally {
        rememberPushAccount(null);
        if (registration)
            for (const notification of await registration.getNotifications()) notification.close();
    }
}
