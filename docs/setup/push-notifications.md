# Review notifications

Manhunt IX can be added to a phone’s home screen as an app. Approved players can enable device notifications on Overview or Settings. New review decisions, replacement requests, decision changes, and edited feedback create alerts for the group’s subscribed devices, even when the app is closed. Each device opts in separately.

## Email alerts

The same new review updates are also emailed to approved players in the reviewed group. Each player receives an email at one verified contact address: the primary address if verified, otherwise another verified address. Add and verify an address under **Settings > Email addresses** to receive review mail. No browser notification permission or home-screen installation is needed for email.

Email includes the task, review outcome, and organiser feedback. The app link uses the configured `APP_ORIGIN`; evidence remains behind sign-in. Changing or removing the address, leaving the group, or losing account approval cancels pending mail to that old destination. Existing historical reviews are not emailed when the feature is installed.

Review mail uses the existing Gmail or Resend configuration. Run `npm run email:check` for a configuration check that sends no mail; see the [Gmail setup](gmail-setup.md) or [Resend setup](resend-setup.md) guide if needed. Apply `0018_review_emails.sql` locally and in production. Failed mail is retried independently of device push; a delivery failure never cancels an organiser’s review.

## On a phone

1. Open the published **HTTPS** website and sign in.
2. On iPhone or iPad, use the browser’s Share menu and choose **Add to Home Screen**. Keep **Open as Web App** enabled if shown. Open the new Manhunt IX icon. Web Push requires iOS/iPadOS 16.4 or newer and a home-screen web app; see [WebKit’s platform guidance](https://webkit.org/blog/13878/).
3. On Android, choose **Install app** or **Add to Home Screen** from the browser menu or the app’s install button, when available.
4. Tap **Enable notifications**, then **Allow**. Installation alone does not grant notification permission.

If permission was denied, allow notifications for Manhunt IX in the device or browser settings and return to the app. **Turn off on this device** removes this device’s subscription. Signing out also unsubscribes this browser. Other group members and devices keep their own choices.

The alert says that a review update is available. Task evidence, group names, and organiser feedback never appear on the lock screen. Tapping an alert opens or focuses the app; an existing app uses internal navigation so active uploads can continue. The app’s service worker does not cache private pages or evidence for offline use.

## Server setup

Generate one stable VAPID key pair with an organiser contact address:

```sh
npm run push:setup -- --subject mailto:organiser@your-domain.example
```

The address identifies the application operator to browser push services; it is not an email sender configuration. The command writes `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, and `PUSH_VAPID_SUBJECT` to the ignored `.dev.vars` file without displaying the keys. Preserve the private key and all existing Google, email, and authenticator settings. Restart the local server after setup. The local workspace has already been configured using its existing organiser contact.

`npm run dev` applies the database migrations, including `0017_web_push.sql`. On deployment, apply migrations to production and configure the same three values as Cloudflare Worker secrets. Keep the private key on the server. Changing the key pair requires devices to unsubscribe and enable notifications again.

The installed app’s origin must use HTTPS. A phone cannot use this computer’s `127.0.0.1` address; a public or otherwise phone-accessible HTTPS origin is required for mobile testing. Localhost is sufficient to verify installation assets and server behavior on the development computer.

Review updates and their pending push deliveries are recorded atomically. The Worker sends immediately after a successful review and retries pending deliveries through its per-minute scheduled trigger, up to five attempts. A successful provider response is recorded as sent; a delivery still failing after five attempts is marked failed, so it is no longer counted as sent or retried automatically. Expired device subscriptions are removed when the push provider returns 404 or 410. Delivery follows device/browser connectivity and notification settings; the private inbox remains available independently.

Admins can inspect **Device notification delivery** on the event overview. Its private summary shows the total sent, pending, and permanently failed deliveries, plus the ten most recent failures by group and task. It never displays device endpoints, subscription keys, or review feedback. The migration marks delivery records from older releases as **Older result unknown**: those releases used the same timestamp for confirmed deliveries and exhausted failures, so the original result cannot be established. New records distinguish sent from failed accurately.

Chrome, Firefox, Safari, and Microsoft Edge push providers are supported. The API accepts only HTTPS endpoints belonging to their push services, validates subscription keys, and requires an approved player session. Automated tests cover encryption using the published RFC 8291 vector, actual payload decryption, account isolation, delivery retries, expired subscriptions, permission handling, and sign-out cleanup. A real phone receiving a system notification still needs to be checked on the final HTTPS origin.
