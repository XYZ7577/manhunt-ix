# Manhunt IX project summary

Updated 27 October 2026.

## Purpose

Manhunt IX is a private group challenge portal for the Singapore event on **13 November 2026**. It gives players one place to track tasks, submit original evidence, and follow organiser feedback. Organisers use it to review evidence consistently and credit a group only after approval. The portal supports the real-world game; organisers continue to manage live game decisions separately.

## Player experience

Players sign in and arrive at an event overview with the official logo, event date, Singapore-calendar status, Tasks approved n/10, and a suggested next step. The checklist distinguishes tasks that are untouched, saved as drafts, awaiting review, approved, or needing replacement evidence. Current progress uses the latest attempt, so old denials do not incorrectly remain action items. The nine main tasks and the bonus hill task all count toward the ten-task total.

Each task has detailed requirements. Players can collect evidence over time using the same file picker or camera input for every task, then submit the completed draft when the group is ready. Each uploaded file can have its own optional comment to identify or explain the evidence. Required file counts and task evidence requirements still apply. The group shares progress across its members and devices.

Review updates report approvals, replacement requests, and feedback changes inside the site. Members have individual read state. A replacement request includes the organiser's explanation and a route back to uploading new evidence. Previous attempts remain available as history. Players also receive email alerts at a verified contact address, using the verified primary address first. Players can add Manhunt IX to their home screen and tap Enable notifications to receive generic device alerts even with the app closed. The signed-in inbox holds the private details.

## The nine main tasks and bonus task

| Task | Evidence and objective |
| --- | --- |
| The Flow of Music 🎶 | Photograph a musical theatre or concert hall while standing across a lake, river, canal, or reservoir. Keep the venue and visible water in the photo. |
| 2 for 2 🏬 | Record one video of yourself running from one 7-Eleven to another within two minutes, with both stores visible. Retries are allowed. |
| Geography Dash 🧭 | Take photos at three or more listed MRT/LRT stations with a cardinal direction in their name. Be stationary at each station and off the train. Only one station from each listed station family counts. |
| Small, Medium, Large 🌊 | Photograph open-air water bodies: a pond, lake, river, or canal for small; a reservoir for medium; and a strait or sea for large. |
| Damn, that’s a Dam 🎥 | Record yourself commending an accepted dam while standing on it. Your voice, the dam, and part of your body must be visible/audible. Tidal gates, drainage gates, flap gates, weirs, and the Johor Causeway do not qualify. |
| National Pride 🇸🇬 | Photograph three places whose names each begin with “National”. Separate each place from the next by at least one public road. |
| History Spree 📜 | Photograph the National Gallery of Singapore, Old Hill Street Police Station, and the Sir Stamford Raffles Statue. |
| Get High 🏙️ | Take a photo of yourself at least 150 m above sea level or 45 floors up. Bukit Timah summit also qualifies. |
| Is it a Bird? Is it a Plane? ✈️ | Record an airplane for one minute. It must move at least once and remain in frame throughout. Do not record a plane shown on another screen or video. |
| **Bonus: Insurmountable 🏔️** | Climb one of the listed publicly accessible Singapore hills and photograph yourself at its summit. Send the summit photo as soon as possible to receive immunity: Bukit Timah Hill (164 m), 45 minutes; Mount Faber (106 m), 45 minutes; Bukit Batok (100 m), 30 minutes; Bukit Kallang (100 m), 120 minutes. Organisers manage the immunity decision. |

Progress counts approved tasks out of ten, including the bonus. The retired Rapid Order task is not in the active task list, while existing Rapid Order submissions remain available as historical evidence. Organisers determine the final game winner and task-related immunity. The Geoguessr event awards its own revival or immunity automatically.

## Evidence and uploads

The system accepts all file types, up to **2 GiB per file**, with up to ten files per submission. Every task uses the same raw file picker or camera input; each upload can include its own optional comment. Required file counts and task evidence requirements still apply. Two files transfer at a time; additional selections queue. Files over 8 MiB use bounded chunks with independent retries. Players can cancel queued/active transfers, retry failed selections while the tab retains them, and finish fully received uploads after returning to the site. Incomplete transfers after a refresh need the original file selected again.

Original files remain unchanged. Compatible images can have an additional small browser-generated preview to reduce player browsing data. These previews are optional and their failure does not invalidate a received original. **Admins inspect originals for review**, since a player-generated preview cannot itself prove what the original contains.

Image capture metadata, server receipt time, and admin review time are distinct. Date flags help organisers inspect evidence but do not automatically prove cheating or reject a task. Video capture-time extraction is not implemented. Unsupported media remains available as a private original download.

## Organiser experience

Admins have an event overview, group progress, and a review workspace. They can filter by group/task, search, sort oldest or newest first, and work one submission at a time or use list view. Larger original-evidence displays sit alongside requirements, roster information, metadata, and group notes.

An admin approves a submission or requests replacement evidence with a reason. Reviews create a group update atomically with the decision. Later feedback edits and decision changes also generate updates. Existing safeguards prevent stale changes from silently overwriting newer review state. Each task counts once toward shared progress.

## Groups and accounts

The portal now runs in normal mode with sample accounts disabled. The Sign Up button offers Google or username/password registration, with a required phone number for account verification and optional email. Unknown Google users go to registration to provide their number; unknown native usernames also require a number before an account request can be created. Phone numbers are visible only to approved admins reviewing registrations or viewing **Groups > Group members**, never to players or group leaders. Members without a saved number show **Phone: Not provided** to admins; collection does not send SMS codes or verify phone ownership. All new players, including invited Google players, need administrator approval before accessing event data. Admins approve or decline requests and can inspect persistent approval-email delivery history. An email notice is sent when an address is provided, but delivery and email confirmation are not conditions for access after approval. Username accounts work without email.

The configured Manhunt Google account, `noreply.manhunt@gmail.com`, becomes the default approved administrator after Google verifies its first sign-in. It starts without a website password and can add one later in Settings after a recent Google sign-in. The old administrator setup page has been removed. Existing non-demo accounts retain access during the upgrade; original sample records are preserved but cannot sign in in normal mode.

Public sign-in has a single Sign Up action under Google sign-in. Further admin creation and user invitations are inside admin Settings. Approved admins can add another administrator with a chosen username/password and optional email, or share signup/group invitation links and QR codes. Admin creation never emails or returns password material.

Usernames have no special format requirements. New passwords are 3–16 characters and include at least one uppercase letter and one number across signup, admin creation, settings, and recovery. Existing credentials remain usable for sign-in.

Users and admins can edit their own username in Settings > Account. Available names save immediately and work for username sign-in, while the same account retains its group, approval, and evidence. Linked Google and verified original registration-email sign-in remain available independently of the editable username.

Groups have a leader and up to twelve player accounts. Leaders and admins can invite players by email and transfer leadership. Each invitation includes a private link and a QR code generated locally in the browser for sharing if email delivery fails. Opening a link shows the inviter and team name and asks the player to confirm **Join team** before saving the invite and opening sign-in. Sign-in alone does not accept the invitation. Any available sign-in method works; new accounts still await organiser approval. An existing player can switch to the invited group if their current group has at most one registered player; the invitation is rejected if it has more than one. Submissions and evidence remain with the previous group. Invitations expire after seven days. Replacing a link invalidates its predecessor; cancelling an invitation stops it working. The main administrator can pause all invitation joins, including existing links, while sign-in, registration, and invitation creation remain available. Apply migrations `0028_group_merging_settings.sql` and `0029_invitation_email_delivery.sql` before deploying these features.

The account system implements password, Google, email-code, authenticator, backup-code, and recovery flows, with provider configuration required for external services. Members can manage contact addresses and their own sign-in settings. An authenticator is an alternative sign-in method, not a mandatory second factor after password or Google sign-in.

Evidence and group progress are accessible to their group and admins. Review inbox read state is private to each account. The portal has no public evidence feed.

## Design and accessibility

The design uses the supplied Manhunt IX logo with purple, pink, and gold accents, readable cards, progress bars, and distinct status badges. Desktop task navigation becomes a compact selector on phones. Camera/file controls have visible keyboard focus, and forms and updates include accessible labels and announcements.

## How the project is built

Admins can send or schedule announcements from Overview. Everyone with approved access can read them in the site. Players with notifications enabled also get an alert, and admins can choose to email verified contacts. Times use Singapore time. Scheduled posts run without an open browser, can be cancelled before they go out, and keep their history and delivery counts.

The frontend uses React, TypeScript, and Vite. A Cloudflare Worker supplies the API; D1 stores accounts, groups, submissions, invitations, notifications, and upload records; R2 stores private originals and optional image previews. Local development emulates these services and preserves data between restarts. Database migrations upgrade existing local data without recreating groups or deleting evidence.

Automated tests cover account flows, group permissions, invitation links, upload rules, review notifications, event progress, and navigation. API integration checks exercise the running local service. Google and email provider tests use controlled responses; they do not establish that real production credentials are configured correctly.

## Current status and remaining work

The project runs locally and is deployed on [Cloudflare Workers](https://manhunt.xyz2011a.workers.dev/). Demo mode is off. Production database/storage resources, migrations, the live origin, and external sign-in settings are configured. The default organiser signs in with the configured Manhunt Google account to establish administrator access. Confirm the event's final participation and deadline rules, operational contacts, and backup arrangements.

Admins can select individual players to mark caught (dead/hunter) or restore. Dead players cannot work on tasks, while living teammates can continue. The Geoguessr event runs 1:30–2:00 p.m. Singapore time on 13 November, gives each team two Google Maps pin guesses including uncaught players, and awards the first correct player a chosen revival plus five minutes of immunity or 90 minus three times elapsed minutes of immunity. Head-admin setup keeps the original pin private. Final task submission pauses 12:30–1:30 p.m. with “go get your lunch >:(”. New catches queue a targeted email and enabled device notification. Live location tracking and final game winner selection remain with organisers. Review alerts support the private inbox, verified-contact email, and optional Web Push, with HTTPS hosting, server keys, and device permission required for live mobile delivery. Review and invitation emails use the configured Gmail or Resend sender. Other task-submission deadlines remain organiser-controlled.
