self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let payload = null;
    try {
        payload = event.data?.json() ?? null;
    } catch {}
    const announcement = payload?.type === 'announcement';
    const gameResultMessage =
        payload?.body === 'No one was able to solve it!' ||
        (typeof payload?.body === 'string' && /^It was solved by [^\r\n]+!$/.test(payload.body));
    const gameResult =
        announcement &&
        payload.tag === 'geoguessr-result' &&
        payload.title === 'The Geoguessr Revival event was over.' &&
        gameResultMessage;
    const catchMsgs = new Set([
        'You have been caught! Aw man… you can still revive at 1:30 though!',
        'You have been caught! Aw man… you can still revive through Geoguessr before 2:00 p.m.!',
        'You have been caught! Aw man… the revive event has ended.',
    ]);
    const caught = payload?.type === 'caught' && catchMsgs.has(payload.body);
    const testMessages = new Set(['boop', 'beep', 'hi', 'hiii', 'stop pressing me :(', 'that tickles!']);
    const pushTest = payload?.type === 'push-test' && testMessages.has(payload.body);
    const legacyTest = !payload?.type && payload?.body === 'Notifications are enabled for this device.';
    const test = pushTest || legacyTest;
    let notificationTitle = 'Manhunt IX';
    let notificationBody = 'Your group has a new review update. Open the app to see it.';
    let notificationTag = 'manhunt-review-update';
    let notificationType = 'review';
    if (gameResult) {
        notificationTitle = payload.title;
        notificationBody = payload.body;
        notificationTag = payload.tag;
        notificationType = 'announcement';
    } else if (announcement) {
        notificationBody = 'The organisers have shared an announcement. Open the app to read it.';
        notificationTag = 'manhunt-announcement';
        notificationType = 'announcement';
    } else if (caught) {
        notificationBody = payload.body;
        notificationTag = 'manhunt-caught';
        notificationType = 'caught';
    } else if (test) {
        notificationTitle = 'Manhunt IX notifications';
        notificationBody = pushTest ? payload.body : 'Notifications are enabled for this device.';
        notificationTag =
            pushTest && typeof payload.tag === 'string' && /^push-test-[0-9a-f-]{36}$/i.test(payload.tag)
                ? payload.tag
                : 'manhunt-push-test';
        notificationType = 'push-test';
    }
    const display = self.registration.showNotification(notificationTitle, {
        body: notificationBody,
        icon: '/app-icon-192.png',
        badge: '/app-icon-192.png',
        tag: notificationTag,
        data: { url: '/home', type: notificationType },
    });
    const refreshGame =
        (caught || gameResult) && typeof self.clients.matchAll === 'function'
            ? (async () => {
                  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
                  for (const client of windows) {
                      if (new URL(client.url).origin === self.location.origin)
                          client.postMessage({ type: 'manhunt-game-updated' });
                  }
              })()
            : Promise.resolve();
    event.waitUntil(Promise.all([display, refreshGame]));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const destination = new URL('/home', self.location.origin).href;
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of windows) {
                if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
                    const type = event.notification.data?.type;
                    if (type !== 'push-test')
                        client.postMessage({
                            type:
                                type === 'caught'
                                    ? 'manhunt-open-game'
                                    : type === 'announcement'
                                      ? 'manhunt-open-announcements'
                                      : 'manhunt-open-review-updates',
                        });
                    return client.focus();
                }
            }
            return self.clients.openWindow(destination);
        })(),
    );
});
