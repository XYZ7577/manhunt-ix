# Production deployment

The Worker is `manhunt`, served at https://manhunt.xyz2011a.workers.dev/.

The D1 binding must be `DB`, matching the Worker code. Its database is `manhunt-ix-prod`. `EVIDENCE` points to the private `manhunt-ix-evidence` R2 bucket. Local commands use the same binding name with local storage; never use `--remote` for integration tests.

## Google sign-in

The existing Worker secret `APP_ORIGIN` must be exactly `https://manhunt.xyz2011a.workers.dev`, with no path or trailing slash. Update it with `npx wrangler secret put APP_ORIGIN` if the public origin changes. It is intentionally not duplicated in `vars`, which would conflict with the existing secret. Keep local development's origin in private `.dev.vars`.

The Google Web OAuth client must allow this exact redirect URI:

```text
https://manhunt.xyz2011a.workers.dev/api/auth/google/callback
```

Retain the localhost callback too if that client is used locally. Do not replace the client, email-provider credentials, authenticator encryption key, or push keys when changing the origin. `keep_vars` preserves dashboard variables during deployment; Worker secrets are retained.

## Release checks

Before publishing changes to `/privacy` and `/tos`, complete the [PDPA launch checks](pdpa-operations.md), especially the guardian consent process, privacy mailbox coverage, retention schedule and overseas provider safeguards.

Caught-player status, the Geoguessr event, and caught email/device alerts require additive migrations `0030_game_event.sql` and `0031_caught_notifications.sql`. Apply them before deploying the updated Worker. The head administrator configures the private target pin on Overview before 13 November 2026, 1:30 p.m. Singapore time. The event closes at 2:00 p.m.; final task submissions pause from 12:30–1:30 p.m. that day. Keep the existing minute cron, email provider, and Web Push configuration for caught-alert delivery. No production catches, guesses, or messages should be generated as release checks.

```sh
npm test
npm run build
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Review pending migrations before applying them to an existing database. Production originally had no application tables, so the first release requires the complete migration set.

For phone registration and announcements, apply `0022_registration_phone.sql` and `0023_announcements.sql` before deploying the Worker. If `0021_admin_submission_order.sql` is still pending, apply that too; it only adds indexes. These updates keep existing accounts, passwords, sessions, groups, evidence, and review history. Existing users can still sign in without a phone number. Only new player registrations need one.

Announcements use the existing once-a-minute scheduled trigger. Keep that trigger enabled so scheduled posts and queued email/device alerts can go out. No sample announcements should be sent to production as part of a release check.

The submission switch and team disband features require `0024_submission_settings.sql`, `0025_group_disband.sql`, and `0027_group_disband_verification.sql` before deploying the updated Worker. These migrations add tables without changing existing accounts, groups, or evidence. After migration, submissions are disabled until the main administrator enables **Task submissions** on **Overview**. Only the approved account linked through Google to `ADMIN_GOOGLE_EMAIL` can use this switch; adding that email as a contact or username does not grant access. Team disbanding uses a fresh email verification code sent to the current leader's verified email. Keep email delivery and the existing `TOTP_ENCRYPTION_KEY` configured; leaders do not need an authenticator app.

Invitation emails and the group-merging pause control also require `0028_group_merging_settings.sql` and `0029_invitation_email_delivery.sql`. Apply all pending migrations before deploying the Worker: the dashboard reads the merging setting on every signed-in request, so deploying code without its table causes HTTP 500.

### Live database repair: 9 November 2026

The live Worker was running the new invitation/dashboard code while migrations `0027`–`0029` were still pending. A private database export was saved before applying all three updates. No migrations remain pending. Counts stayed at 38 accounts, 32 groups, 48 sessions, and 5 invitations; submissions and evidence were both empty before and after. Foreign-key checks passed. Group merging starts enabled. Public sign-in and auth-options requests returned 200; an unauthenticated dashboard request returned the expected 401, and a nonexistent invitation returned 404. An authenticated browser dashboard was not checked during the repair. No credentials were changed, and no invitation emails were sent as part of verification.

## Default administrator

`ADMIN_GOOGLE_EMAIL` is set to `noreply.manhunt@gmail.com`. Sign in through Google using that exact account to create its approved administrator account. Google must supply a valid signed ID token with that verified email; a matching typed username or contact email does not grant admin access. Ordinary sign-ups still wait for approval.

The administrator starts without a website password or player group. To add a password, open **Settings > Password** within five minutes of a Google sign-in. Later sign-ins keep any password that has been deliberately added. The old `/setup-admin` page redirects to normal sign-in, and `/api/admin-setup` returns 404 on both local and production hosts.

After deployment, the sign-in page should load, a deliberately nonexistent invitation lookup should return 404 rather than 500, and starting Google sign-in from the site's origin should return an authorization URL with the callback above. Stop at Google's sign-in or account chooser when checking configuration; completing authentication can create an account request.

Run player/admin integration tests only against a separately persisted localhost Worker without live email or Google credentials. The test scripts reject public production URLs.

## Main administrator deletion and test notifications: 5 November 2026

Worker version `08282b96-94a7-4784-a1e0-c3d83341ce7d` adds **Settings > Admin and invitations > Delete players or groups**. Only the approved administrator linked through Google to `ADMIN_GOOGLE_EMAIL` can use it; a matching username or verified contact address does not grant deletion access. Administrator accounts are protected. Exact typed confirmation is required. Player deletion revokes sessions and removes sign-in methods and contacts, retaining an anonymous account reference for historical records. Group deletion releases member accounts, revokes invitations, stops unfinished uploads, and removes the group from active lists while retaining submissions and original evidence.

Migration `0026_admin_deletion.sql` adds audit tables and guards against in-flight requests restoring deleted credentials or membership. It does not change existing rows. The production database was exported to a private ignored backup first. Applying the migration to a copy preserved all existing rows across 38 tables. Production checks confirmed that every original account and group remained present, no deletion audit entries were created, and foreign-key checks passed. New registrations during the release were retained too. No migrations remain pending. The existing reset script includes the two new tables.

The enabled notification card now has **Send test notification**, which sends only to the current device. Regular messages are `boop`, `beep`, `hi`, and `hiii`. Three or more taps without a two-second pause use `stop pressing me :(` or `that tickles!`. Status text is exactly **Sending test notification...** and **Sent test notification!**, without quoting the notification body. Both the server and background handler restrict test text to these messages. Test sends do not create inbox entries or email deliveries. Existing requests without a message remain supported, and review and announcement alerts retain their private generic wording.

All 353 automated tests and the production build passed, along with 20 isolated deletion checks, 69 workflow checks, 45 invitation/evidence/review checks, and 17 sign-in checks. Browser verification covered the deletion panel and exact confirmation safeguard. Fourteen live checks passed after the final wording update, including sign-in and policy pages, signed-out access protections, cross-origin rejection, and byte-for-byte JavaScript, stylesheet, and background-handler verification. Demo access remains disabled, both scheduled triggers remain active, and existing secrets and storage bindings are retained. No production players or groups were deleted as part of verification.

## Submission controls and team disband release: 5 November 2026

Worker version `543bb5a1-3e45-4d1a-9e63-a5da8e49c723` deploys the main-admin-only **Task submissions** switch on **Overview** and the leader-only, authenticator-confirmed **Disband this team** action on **Groups**. Submissions are disabled in production until the main administrator enables them.

All 341 unit tests and the production build passed. The live database was exported to a private, ignored backup before release. Applying `0024` and `0025` to a copy preserved all existing rows across 36 tables. Both migrations were then applied in production; account, group, submission, evidence, session, email, and invitation counts remained unchanged, and foreign-key checks found no broken references. No migrations remain pending.

Eleven live checks passed at 17:09 SGT. The sign-in and policy pages load, both new action endpoints require sign-in, and the published JavaScript and stylesheet hashes match the reviewed build. Demo access remains disabled, both scheduled triggers remain active, and the live submission setting is off. No production accounts, teams, submissions, or emails were created by verification.

## Public policies release: 5 November 2026

Worker version `288fe6d6-b9f8-4438-a199-65a5c8461b22` adds public HTML documents at `/privacy` and `/tos`, linked from sign-in, registration, and the portal footer. Both documents and their stylesheet return HTTP 200 without authentication or JavaScript. Browser checks confirmed the live documents and sign-in links, and live file hashes match the reviewed build. Use these policy URLs in Google Auth Platform's Branding settings.

All 312 existing tests and the production build passed. This release requires no database migration; existing bindings, secrets, and scheduled triggers are retained.

## Announcements release: 4 November 2026

Worker version `9864b178-9242-4436-b559-fdb12602696d` adds the admin announcement panel, send-now and Singapore-time scheduling, cancellation, announcement inboxes, optional verified-contact emails, and device alerts. It also deploys the required phone field for new player registrations. Existing users can still sign in without one.

All 312 tests and the build passed. Before deployment, the live database was exported to a private, ignored backup. Applying `0021` through `0023` to a copy kept all 122 existing rows across 32 tables unchanged. After the live update, account, group, submission, evidence, session, contact, and review notification counts still matched; foreign-key checks found no broken references. No R2 evidence was changed. No database migrations remain pending.

Live checks confirmed the new app loads, the announcement routes require sign-in, both registration methods reject missing phone numbers, and the service worker supports announcement and existing review alerts. Both scheduled triggers remain active. No test announcements or emails were sent to production users.

## Verified release: 30 October 2026

Worker version `bf9e84ec-4c3e-4064-9f09-ffe4c19dd017` contains the requested origin, database binding, build, organiser refresh, draft-note saving, and connection-status fixes. The existing `APP_ORIGIN` secret now uses the production origin above. The matching Google Web OAuth client has both localhost and production callback URIs saved.

- Production build and all 262 automated tests passed.
- The isolated local Worker passed 69 workflow, 17 authentication, and 45 feature integration checks.
- Browser verification covered organiser queue refresh, draft-note navigation/reload persistence, and an injected API outage followed by recovery.
- Live verification returned 200 for the sign-in page and Google authorization start, and 404 for a nonexistent invitation. Google now reaches its normal sign-in page without `redirect_uri_mismatch` or `invalid_client`; no production Google sign-in was completed.
- All 19 production migrations have been applied, with none pending.

No local accounts, demo accounts, or test evidence were copied to production. Administrator provisioning is now handled by the verified Google sign-in described above; no separate setup page is used.

### Google administrator update

Worker version `aaba9f27-e94a-4585-9934-eb181354f1cb` configures `noreply.manhunt@gmail.com` as the default verified Google administrator and removes the old setup page and handler. All 270 automated tests and the production build passed, including Google-first account creation, safe pending-account promotion, privilege boundaries, session revocation, and adding a first password after Google sign-in.

Live checks confirmed that both GET and POST `/api/admin-setup` return 404, the old `/setup-admin` URL opens `/login`, and Google authorization still starts successfully. The nominated Manhunt account is already an allowed test user in the Google OAuth project. Its first production sign-in is left to the account owner; no account or password was created on their behalf.
