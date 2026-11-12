# Manhunt IX
# this readme is AI-generated

DISCLAIMER: PART OF THIS PROJECT IS MADE WITH AI ASSISTANCE.

A group challenge portal for Manhunt IX on **13 November 2026**. Players follow their event overview, share task progress, upload original evidence, and receive organiser review updates. Admins review task requirements and date-check flags before crediting a group. The project runs locally and on [Cloudflare Workers](https://manhunt.xyz2011a.workers.dev/). See [deployment and verification](docs/operations/deployment.md).

## Project layout

- `src/` contains the React app. Feature folders keep each screen near its styles and browser-side helpers. Start at `src/main.tsx`.
- `server/` contains the Cloudflare Worker. Its entry point is `server/index.ts`, and related handlers live in feature folders.
- `shared/` contains types, validation, and rules used by both the browser and the Worker.
- `tests/` groups tests by feature, with the end-to-end workflows in `tests/integrations/`.
- `scripts/` contains local development, database maintenance, and notification setup commands.
- `public/` contains files served at public URLs. `migrations/` holds the database changes in application order.
- `docs/` contains the project overview, setup guides, and operations instructions.

## Event overview and organiser tools

The site uses the supplied Manhunt IX logo and a purple, pink, and gold visual identity. **Overview** at `/home` is the default entry page. It shows the event date and Singapore-calendar phase, **Tasks approved n/10**, drafts, waiting reviews, and the group's next action. There is no five-task requirement. Historical denials stop appearing as current action items after a newer attempt is started or reviewed. The calendar phase is informational; organisers still control game operations and results.

Players can choose **Take a photo** or **Record a video** on supported phones, or select existing files of any type. Received originals and capture metadata are preserved. Supported images can also receive a separate small preview, generated in the browser; player previews load lazily. Admin review always shows original evidence rather than trusting a player-generated thumbnail. Failed transfers have retry controls while the tab retains the selected file. After a refresh, incomplete uploads must be cancelled and reselected, while fully received uploads can be finished.

**Review updates** is a private, in-site inbox for approvals, replacement requests, and feedback edits. Player dashboard and inbox updates share one automatic request per minute while the tab is visible and online. Returning to the tab refreshes them if a minute has elapsed; opening the inbox, manual actions, and push notifications can refresh immediately. Read state is saved per account, so one member does not clear another member's inbox. Updates link to the task and offer replacement evidence when the latest attempt still needs changes. New reviews and feedback changes also email each approved group member at one verified contact address, preferring their verified primary address. Users without a verified address continue to receive in-site updates. Players can also enable device push notifications from Overview or Settings, including in the home-screen app. Lock-screen messages are generic; private feedback stays in the signed-in inbox. See [notification setup](docs/setup/push-notifications.md).

Admins can send announcements from **Overview**. Add a title and message, then send it now or schedule it in Singapore time. Everyone with approved access gets it in their announcement inbox. Players who have enabled device notifications get a generic alert, and admins can also email verified contact addresses. Scheduled posts run on the server, even when the page is closed. Admins can cancel a scheduled post and check email and device delivery counts in the history. Posts usually appear within a minute of the chosen time; emails and device alerts may take longer.

Admins can filter submissions by group and task, search group/task names, and sort by submission time. The default queue shows the oldest waiting submission first, with larger original evidence and one-at-a-time or list views. Queue pages use stable receipt-time and submission-ID cursors, backed by database indexes, so navigating a long history does not skip over every earlier page. A successful review moves the focused queue forward. Existing review history, editable feedback, and stale-write protections remain available.

Group leaders and admins can invite players by email; each invitation also has a private link and locally generated QR code to share if email delivery fails. Opening the link shows who invited the player and the team name, then asks whether they want to join. The invitation is saved in the browser and the player is sent to sign in only after choosing **Join team**. Sign-in alone does not accept the invitation. Any available sign-in method works; new players still need organiser approval. An existing player can switch to the invited group if their current group has at most one registered player; the invitation is rejected if it has more than one. Submissions and evidence remain with the previous group. Invitations expire after seven days, and replacing or cancelling a link invalidates its old token. Apply migrations `0028_group_merging_settings.sql` and `0029_invitation_email_delivery.sql` before deploying these features.

The main administrator, established by Google sign-in as `ADMIN_GOOGLE_EMAIL` (`noreply.manhunt@gmail.com`), can open or pause **Task submissions** and pause or resume group merging from **Overview**. Other administrators cannot use these controls. Submissions start paused until enabled. Group merging starts enabled; pausing it stops all invitation joins, including links already sent, while sign-in, registration, and invitation creation remain available. Both settings persist across restarts and the server applies changes immediately.

The current group leader can choose **Disband this team** on **Groups**, acknowledge the consequences, and enter a six-digit verification code sent to their verified email. No authenticator app is required. Leaders without a verified email can add and verify one under **Settings** first. Disbanding moves every player, including the leader, into a new personal group named `<player name>'s group`, with that player as its leader. It cancels pending invitations and stops unfinished transfers. Accounts and approvals remain. The old group and its submission history and evidence are retained for admin review, and the old group cannot be reopened or rejoined. Apply migrations `0024_submission_settings.sql`, `0025_group_disband.sql`, and `0027_group_disband_verification.sql` before deploying these features.

See [the project summary](docs/project-summary.md) for a plain-language overview of the whole project.

## Public policies

The [Privacy Policy](https://manhunt.xyz2011a.workers.dev/privacy) and [Terms of Service](https://manhunt.xyz2011a.workers.dev/tos) are public HTML documents, available without signing in or running JavaScript. Links appear on the sign-in and registration screens and in the portal footer. Use these URLs in Google Auth Platform's Branding settings. Source documents are `public/privacy.html` and `public/tos.html`; Cloudflare serves them at the extensionless URLs using `assets.html_handling`.

## Run locally

Requires Node.js 22.12 or newer and npm. No Cloudflare account is needed locally.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:8787**. The command automatically applies local database migrations without an interactive confirmation, builds the frontend into `.wrangler/dev-assets`, and starts the local Worker. Migration and server commands explicitly share `.wrangler/state/`. This keeps its served files separate from `dist`, so `npm run build` can verify production output without replacing the assets used by the running local server. Worker source edits can still reload the Worker. Stop it with Ctrl+C. Accounts, sessions, submissions, and original files persist under `.wrangler/state/`; restarting or signing out does not delete them.

Pages use normal URLs: `/tasks`, `/groups`, `/settings`, `/login`, `/register`, `/login/authenticator`, and `/forgot-password`. They support direct links, refresh, and browser Back/Forward. Older section links such as `/#settings` are converted to their matching path. Internal navigation keeps active uploads running. Signed-out visitors are sent to `/login` and return to the requested portal page after signing in; Google remembers this destination in the current tab when browser session storage is available.

The command creates a private authenticator encryption key in ignored `.dev.vars` if missing. Preserve that file and its key when changing provider settings.

For frontend hot reload, keep the Worker running and use a second terminal:

```sh
npm run dev:ui
```

Open http://127.0.0.1:5173. Its API requests proxy to port 8787. Use the main port 8787 URL for Google sign-in and linking; the hot-reload URL is not an authorised Google sign-in origin. Production builds write to `dist` and do not touch `.wrangler/dev-assets`. Restart an already-running local server once after updating this workflow so it starts serving from the isolated directory.

## Reset all data

Wipe local accounts, sessions, submissions, evidence, and caches:

```sh
npm run reset:local
```

Stop `npm run dev` first. The next `npm run dev` recreates the local database and applies migrations. `.dev.vars` is left untouched.

Wipe the deployed app:

```sh
npm run reset:remote
```

Close the site on all devices first. This checks access to the configured remote R2 bucket using your existing Wrangler login, exports a D1 backup to `.wrangler/backups/`, aborts tracked unfinished uploads, and deletes every listed R2 object in batches before clearing the production D1 tables. Originals, previews, and files left by an earlier failed reset are included. The R2 bucket and its settings are preserved; no extra API key or temporary public cleanup endpoint is needed. A final sweep and live listing verify that the bucket is empty. R2 files are not backed up.

An R2 access or cleanup failure stops the script before it clears D1; files already removed during a partial cleanup remain removed. You can rerun after fixing the error. Unfinished multipart uploads can be aborted only when their IDs are still recorded in D1. If a previous reset already erased those IDs, their uncommitted parts are left to the bucket's multipart-abort lifecycle policy rather than being claimed as deleted by this script.

Add `-- --yes` to skip the typed confirmation, `-- --recreate-db` to delete and recreate the production D1 database (updates `database_id`, applies migrations, and redeploys), or `-- --keep-r2` to reset D1 without connecting to or changing R2. After a remote reset, sign in with `ADMIN_GOOGLE_EMAIL` through Google to recreate the organiser account. Clear the site's browser storage separately so cached sessions and saved invitations are removed.

## Normal sign-up and account approval

The portal now starts with **`DEMO_MODE=false`**. Sample logins and the demo banner are hidden, seeded sample accounts cannot authenticate, and sample groups are excluded from the normal admin overview. Existing data is preserved.

The default organiser is the exact Google account configured as `ADMIN_GOOGLE_EMAIL`: **noreply.manhunt@gmail.com**. Use **Sign in with Google** with that account for its first sign-in. Google verifies the identity before the portal creates an approved administrator account. No initial website password or player group is created. After signing in, the organiser can add a password under **Settings > Password** within five minutes of a Google sign-in. The former setup page and setup API have been removed; older `/setup-admin` links go to normal sign-in.

The **Sign Up** button below Google sign-in opens `/register` (also available as `/signup`). Players must provide a phone number for account verification, whether they choose Google or a name, username and password; an email address and group details are optional. Singapore phone numbers can be entered as eight digits, and international numbers include a `+` country code. Unknown Google sign-ins go to registration to collect the number; unknown native sign-ins also require it before an account can be created. Wrong passwords for existing accounts never create or replace accounts. Existing Google identities and contact addresses are not silently turned into new password accounts.

Phone numbers are shown only to approved administrators in **Account requests** for verification and under **Groups > Group members**. Members without a saved number show **Phone: Not provided** to admins. Numbers are hidden from all players, including group leaders. Collection does not send an SMS, enable phone sign-in, or mark the number as verified. Existing accounts do not need to provide a number to sign in. Apply migration `0022_registration_phone.sql` before deploying the updated Worker so Google registration can carry the number through its sign-in flow.

Usernames have no case, number, or special-character requirements. New passwords must be 3–16 characters and include at least one uppercase letter and one number. This applies when signing up, creating an admin, changing a password, or resetting it; existing passwords still work for sign-in.

Approved users and admins can change their own username under **Settings > Account** using **Save username**. The new username must be available and becomes their username for password and authenticator sign-in. Group membership, approval, and uploaded evidence remain attached to the same account. Linked Google sign-in and verified original registration-email sign-in continue to work; changing a username never makes an added contact email into a login identity.

Members can also change their own full name under **Settings > Account**. Only the current group owner can change the group name. These changes keep the same accounts, group, and submission history.

Every new player account, including invited players, waits for admin approval. A new account's group name and roster are saved with its request; the group is created only when the account is approved. Declined requests do not leave a group behind. Pending sessions can check their own approval status and redeem a saved group invitation, but cannot access event data or settings. Joining an existing group discards the account's separate group request and still requires approval. Approved admins open **Account requests** to approve or decline users. If a contact email is provided, approval sends an informational email through the configured Gmail/Resend sender. No confirmation link is required. A failed email never cancels approval, and username-only users can sign in without any email. Delivery results and retries are saved in the admin history.

Previously existing non-demo accounts keep their access when the upgrade is applied. The Google and email provider checks remain separate from account approval.

The public login page has one **Sign Up** link below Google sign-in. Once the default organiser has signed in with Google, approved admins use **Settings > Account > Admin and invitations** to **Create new admin** or **Invite user**. New admins are approved immediately by the creating admin; their passwords are never emailed or returned by the API. Invite user provides the signup link and QR code, plus secure invitations to an existing group. Invited players still require account approval.

## Optional test-only accounts

These accounts are available only on an explicitly isolated Worker with **`DEMO_MODE=true`**. They are disabled in the normal website.

The local placeholder password is **`manhunt123`**.

| Login | Access |
| --- | --- |
| `player1` through `player5` | Five separate solo groups |
| `team1-1`, `team1-2` | Team 1, shared task progress |
| `team2-1`, `team2-2` | Team 2, shared task progress |
| `admin1`, `admin2` | Admin review and all groups |

The numbered team accounts are separate accounts in the same group. The same account can also sign in from multiple devices. Normal password sign-up supports usernames without an email address. Google is the primary external sign-in option. Authenticator and backup codes can also sign in or reset a forgotten password; email reset codes work for eligible verified identities after configuring the sender below.

## Email sign-in

At `/login`, switch between **Password** and **Email code**. Password sign-in accepts your registration email (or an existing demo username) and password. Email-code sign-in accepts your verified original registration email or linked Google email and does not ask for your password. Google and authenticator sign-in remain available independently.

For email-code sign-in, request a six-digit code and enter it in the same browser within ten minutes. Codes work once, allow five attempts, and have resend and request limits. Requests respond the same way for eligible, unknown, unverified, and rate-limited addresses. A Google-linked identity takes priority over a colliding unverified native username; extra contact addresses do not become login identities merely by being added or verified.

Create a native account at `/register` with a name, phone number, username and password, optionally adding a contact email and group details. Wait for admin approval, then sign in with that username and password. An optional contact email is for notifications; it does not become a login identity merely by being added. Accounts originally registered using an email as their username can verify that original email under **Settings > Email addresses** to enable email-code sign-in. Google sign-in verifies its linked email. Approved Google-created accounts can set a website password in **Settings > Password** within five minutes of signing in with Google.

Email-code sign-in and contact verification require a configured Gmail or Resend sender plus `TOTP_ENCRYPTION_KEY`. If these are unavailable, the app explains that email codes are unavailable and password sign-in remains usable. Contact verification, login codes, and password-reset codes are separate proofs and cannot be exchanged between flows. Email-code challenges are bound to the browser, trusted email identity, and account security state.

## Enable Google sign-in

Username/password sign-in works without external services after account approval. The Google button becomes available after its server credentials are configured. The app never pretends a Google sign-in succeeded when configuration is missing.

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Open **Google Auth Platform**, configure **Branding**, and choose the appropriate **Audience**. For personal Gmail accounts, use **External**. While the app is in testing, add the Google accounts that will test it under **Audience / Test users**.
3. Under **Clients**, create an OAuth client with application type **Web application**.
4. Add this exact **Authorized redirect URI**:

   ```text
   http://127.0.0.1:8787/api/auth/google/callback
   ```

5. Add the following values to the existing `.dev.vars` file, preserving `TOTP_ENCRYPTION_KEY`, then restart `npm run dev`:

   ```dotenv
   APP_ORIGIN="http://127.0.0.1:8787"
   GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="your-client-secret"
   ```

Use **http://127.0.0.1:8787** for the configured Google flow. A different host, port, or trailing path needs its own matching redirect URI. `.dev.vars.example` documents the settings; keep the real values private and server-side. Do not place the secret in frontend variables or share it in chat.

New players enter a phone number on **Sign Up** before continuing with Google; group name and roster are optional. Existing accounts first sign in with their password and use **Settings > Sign-in methods > Link Google account** to preserve their group, submissions, and access level. A matching unverified contact email does not automatically link an account. A Google identity can belong to only one account. Its verified email is saved automatically as the primary contact on every successful Google sign-in or link, preserving other contacts.

When a new player starts with **Sign in with Google**, the phone-number step opens at `/register?method=google` using the registration page design, with only a phone field and **Continue with Google**. Refreshing retains this phone-only step.

The OAuth flow uses an authorization code, PKCE, state, nonce, and signed ID-token validation. It requests `openid email profile`, which identifies the user; it does not access their Gmail inbox or send notification emails. See [Google's OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).

For Cloudflare later, use the HTTPS launch URL as `APP_ORIGIN`, register its callback URI in Google, and store the client secret and authenticator encryption key as Worker secrets. Live Google sign-in cannot be tested until real client credentials are configured.

## Settings and account security

The main administrator can open **Settings > Admin and invitations > Delete players or groups**. This control is restricted on the server to the approved administrator linked through Google to `ADMIN_GOOGLE_EMAIL`; other admins and matching contact addresses do not grant deletion access. Type the exact player username or group name to confirm. Deleting a player removes their sign-in access and contact details, signs out their devices, and transfers group leadership to another eligible member when needed. Deleting a group removes it from active lists, releases its members to join another group, and cancels invitations and unfinished uploads. Existing submissions, evidence, and review history are retained. Administrator accounts cannot be deleted here. Apply the additive migration `0026_admin_deletion.sql` before deploying this feature; existing accounts and groups are unchanged until an explicit deletion.

**Settings** shows account details and registered group members. Each group has exactly one leader. The leader (or an admin) can enter a player's email to send an invitation, create a replacement email/link, cancel an invitation, or transfer leadership. A private link and QR code remain available to share. The player first confirms the inviter and team name, then signs in and chooses whether to join. Password, email code, authenticator, and Google sign-in all work. Invitations expire after seven days and reserve one of twelve player-account places. Admins can manage any group's members on **Groups**. The original game roster is shown separately from registered accounts.

When device notifications are enabled, **Send test notification** sends a short message only to the current device. The first two taps choose from `boop`, `beep`, `hi`, and `hiii`; the third and later taps within a continuous burst choose `stop pressing me :(` or `that tickles!`. A pause of two seconds resets the sequence. Test notifications do not create inbox items or send emails. The existing test endpoint also continues to accept requests without a message.

Users can add, edit, remove, and choose a primary contact email (up to five), and change their password. Google sign-in automatically supplies a verified primary email. Adding or editing another email automatically sends a six-digit verification code through the configured sender. Enter the code beside that address in Settings to mark it **Verified**. Codes expire after ten minutes and permit five attempts; **Resend code** has a cooldown and shared send limits. Failed delivery leaves the address saved as unverified and shows a retry message. Editing or removing an address invalidates its older verification codes.

Verifying an additional contact address does not add a password or recovery login identity. Email-code sign-in is limited to the verified original registration address or linked Google email. Contact edits never change other group members' accounts. Review updates are emailed to a verified contact, and group invitations are emailed to the invited address, using the configured Gmail or Resend sender. If an invitation email cannot be delivered, the leader can share its link or QR code.

Password changes require the current password. Google-created accounts can set a first password within five minutes of a Google sign-in, then use their verified linked Google email with that password. Password and authenticator changes sign out other devices while keeping the device making the change signed in.

**Authenticator sign-in is an alternative to a password.** Password and Google sign-ins open the account directly without an extra code prompt. To enroll an authenticator, use a sign-in from the last five minutes or confirm your current website password, scan the QR code or enter the setup key, then enter a valid six-digit code. Save the ten backup codes shown once; each works once. Each member can configure their own authenticator.

Use **Use authenticator or backup code** on the sign-in page with your username or verified Google email. Setup expires after ten minutes. Proof attempts are rate limited, and an authenticator code already used in its 30-second time step cannot be reused; wait for a new code or use a backup code.

**Forgot password?** offers an authenticator code, a backup code, or an emailed reset code. A successful reset invalidates existing sessions so you sign in again. Email reset codes are sent only to a verified linked Google email, expire after ten minutes, allow five attempts, and must be entered in the browser that requested them. Password or authenticator changes invalidate previously issued email codes. Responses do not reveal whether an email belongs to an account.

For sending from a Gmail account without owning a domain, follow [the Gmail sender setup guide](docs/setup/gmail-setup.md). Set `EMAIL_PROVIDER="gmail"`, configure a separate Desktop OAuth client under `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`, and run `npm run gmail:setup` to authorise the sender privately. `GMAIL_REFRESH_TOKEN` is saved only in ignored `.dev.vars`; configure the equivalent Worker secrets before production. The sender grants only identity and send-mail permissions, while players' Google sign-in keeps its existing identity-only scopes. Run `npm run email:check` and, when ready to send one message, `npm run email:test -- --to your-address@example.com`.

Alternatively, use Resend with a verified domain. Follow [the Resend setup guide](docs/setup/resend-setup.md) and privately fill these values in the existing `.dev.vars`, preserving your Google settings and authenticator key:

```dotenv
RESEND_API_KEY="your-resend-api-key"
EMAIL_PROVIDER="resend"
EMAIL_FROM="Manhunt IX <no-reply@your-domain.example>"
```

Run `npm run email:check` for a check that sends no mail, then `npm run email:test -- --to your-address@example.com` to send one delivery test to an address you control. Restart the local server after changing configuration. The [guide](docs/setup/resend-setup.md) also covers DNS, Resend's default-sender restrictions, recovery eligibility, and Cloudflare secrets.

The sender must be allowed by your Resend account. Without valid configuration, the email recovery option explains that it is unavailable; authenticator, backup codes, and Google sign-in still work. Google sign-in alone does not grant permission to send Gmail. Automated tests use a mock provider and send no real messages; the explicit `email:test` command sends a real delivery test.

Authenticator secrets are AES-GCM encrypted using `TOTP_ENCRYPTION_KEY`, a private 32-byte base64 key generated by `npm run dev` when missing. Preserve it alongside local data: replacing it makes existing secrets unreadable. Configure it as a Worker secret before launch. Backup and email reset codes are stored as hashes. QR codes are generated inside the browser; no external image service receives their secrets.

## Player and admin flow

1. Sign in and choose one of nine main tasks or the bonus hill task.
2. Add original evidence as files using the same file picker or camera input for every task. Add an optional comment to each upload to identify or explain that file. Required file counts and each task's evidence rules still apply.
3. Submit the completed draft for review. Server receipt and admin review are recorded separately.
4. An admin checks requirements, visible group members, evidence, and metadata, then approves or denies with feedback.
5. Approval credits the group once. Resubmissions keep earlier attempts as history. Progress shows approved tasks out of ten, including the bonus; organisers determine the game result.

In **All submissions**, admins can edit reviewed feedback without changing its original review time. On the latest reviewed attempt, clicking the approval-status button swaps Approved/Denied and updates shared progress while preserving feedback. Older attempts remain historical after a replacement starts. Stale edits cannot overwrite a newer decision or feedback.

Evidence is visible only to the group and admins. Shared progress refreshes periodically and can be refreshed manually. Admins can select individual registered players on **Overview** and mark them caught (dead/hunter), or restore them. Dead players can read tasks but cannot start, edit, upload, or submit them; disabled controls explain **you are currently dead!**. Uncaught teammates can continue. Catching an immune player is blocked. Each new catch queues the caught player's verified-contact email and enabled device alerts. Delivery requires the configured email sender and Web Push keys/device permission; retries run on the existing minute cron.

Only the head administrator sees **Revive event setup** on **Overview**. Set an event password there to unlock the correct location and setup form. Use **Lock setup** to hide the location again. The head administrator can set the Google Maps dropped pin and optional photo URL before 1:30 p.m. on 13 November 2026. Setup locks when the event opens. Apply migration `0033_game_event_password.sql` before deploying password protection.

Gareth can also post the photo in Announcements. Between **1:30 and 2:00 p.m. Singapore time**, all teams, including uncaught players, share **two valid pin submissions per team**. The server resolves supported Google Maps pin links and checks the 200 m radius. Invalid links do not consume a guess; valid incorrect pins do. The first correct player globally receives the reward chosen with that guess: revive as a survivor plus five minutes of immunity, or `(90 − 3 × elapsed minutes)` of immunity. A hunter choosing immunity remains a hunter. A correct guess at 1:45 p.m. receives 45 minutes, expiring at 2:30 p.m. The deadline and winner/attempt limits are enforced atomically on the server.

On game day, final task submissions pause from **12:30 p.m. until 1:30 p.m. Singapore time**. The review button is greyed out with **go get your lunch >:(**; draft evidence can still be prepared by living players. Apply migrations `0030_game_event.sql` and `0031_caught_notifications.sql` before deploying this update. Live location tracking and final game-winner selection remain with organisers.

## Evidence uploads and date checks

Uploads accept **all file types**, up to **2 GiB per file** (2,147,483,648 bytes). A submission supports ten files, including active uploads. Recognised image/video types preview where supported; other formats are private downloads. HEIC/HEIF preview support depends on the browser. Admins decide whether files meet task requirements.

Files larger than 8 MiB use sequential **8 MiB chunks** and R2 multipart uploads; each failed chunk retries independently without buffering the entire file. Smaller files use the direct endpoint. Limits are defined in `shared/evidence/uploads.ts`. Original downloads stream and support byte ranges for video seeking.

Players can select multiple files and add more while uploads run. Each file can have its own optional comment. Two files transfer at a time, with extra jobs queued and separate progress/cancellation. Tasks use the same file input flow, while their required file counts and evidence requirements remain in effect. After refresh, fully received unfinished uploads can be completed; incomplete ones can be cancelled and reselected. Submission waits for queued/active transfers to finish or be cancelled. Incomplete upload sessions expire after 24 hours; API activity and an hourly scheduled cleanup reclaim abandoned storage.

Players see their uploaded files and server receipt time without image metadata, date checks, or metadata warnings. Capture metadata is omitted from player API responses. Missing, malformed, or out-of-date metadata does not prevent uploading or submitting evidence.

Admins use **View metadata** beside an image to read its original metadata on demand, including images uploaded before this feature. Camera time and offset, GPS coordinates, phone or camera model, and GPS altitude appear first. Other readable EXIF, GPS, XMP, IPTC, color-profile, and image-format fields appear under **Additional metadata**. Missing values are labelled **Not recorded**. No date-check errors are shown, and loading metadata does not alter the original file.

**Take a photo** also records when the camera picker opened and returned, plus the browser's file time when it falls within that window. This small report follows direct and chunked uploads, including retries and recovered completion, without changing the original image. Admins can view these separately labelled, unverified device values under additional metadata. They do not replace EXIF time. Ordinary file selection does not attach a camera report, and existing photos without timestamps cannot be backfilled from upload receipt time.

Metadata reads are bounded for large files, with a neutral notice when only part of the metadata can be shown. Opaque camera-specific binary data is listed with its size. Metadata may be missing or edited and is information for manual review, not proof of when a photo was taken. Video capture-time extraction is not implemented. Task-related immunity decisions remain with organisers; the Geoguessr event awards its own immunity automatically.

## Development checks

```sh
npm run build
npm test
```

With a local Worker running:

```sh
npm run test:integration
npm run test:auth
npm run test:uploads
npm run test:uploads:large
```

`npm run test:features` verifies invitation links, private previews, unchanged originals, and review updates. It requires an explicit `TEST_URL` pointing at an isolated localhost Worker, so it cannot accidentally add test groups to the default preview.

Set `TEST_URL` to use a separate preview. Checks create temporary groups/submissions and should run against an isolated database. Unit tests use SQLite and mocked Google responses; they do not contact Google or send messages. They cover account privacy, password changes, Google token/callback validation, standalone authenticator sign-in, password recovery, one-use backup codes, group membership permissions, and removed phone sign-in. Integration checks cover uploads, shared accounts, admin reviews, and private files.

The large-upload check temporarily stores a generated **1.4 GB** file in local R2, verifies its size and final bytes, then removes that test evidence. Its result is recorded in `test-results/large-upload.json`.

## Cloudflare structure

The React frontend uses Vite. The API is a Cloudflare Worker, with D1 for records and R2 for original private evidence. Wrangler emulates both locally. Historical migrations are retained; removed SMS tables do not enable SMS authentication.

`wrangler.jsonc` binds the production D1 database as `DB` and its private R2 bucket as `EVIDENCE`. Local migration commands also use the `DB` binding and affect local storage only. Apply production migrations explicitly:

```sh
npx wrangler d1 migrations apply DB --remote
```

This applies all pending migrations, including the Web Push subscription and delivery tables. Apply migration `0021_admin_submission_order.sql` before deploying the indexed admin queue. `npm run db:migrate` applies migrations to the local database only. Configure Google, email sender, authenticator, and [Web Push secrets](docs/setup/push-notifications.md), and keep **DEMO_MODE off** in production. The configured `ADMIN_GOOGLE_EMAIL` account signs in through Google to establish the default organiser. Device notifications require the HTTPS launch origin, user permission, and configured scheduled delivery retries. Event deadlines and final participation rules still need launch configuration. See [deployment and verification](docs/operations/deployment.md) for the production origin and Google callback.
