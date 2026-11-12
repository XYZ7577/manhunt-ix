# Send Manhunt IX emails through Gmail

The app can send contact-verification, sign-in, and password-reset codes from a Gmail account without owning a domain. This is a separate sender connection; players keep the existing Google sign-in flow and do not grant access to their inboxes.

## Google Cloud setup

1. In your existing Google Cloud project, open **APIs & Services > Library**, find **Gmail API**, and enable it.
2. Open **Google Auth Platform > Clients** and create a separate **Desktop app** OAuth client, named for example `Manhunt IX Gmail sender`. Keep the existing website sign-in client unchanged. A Desktop client supports the setup command's loopback redirect `http://127.0.0.1:8976/callback` without a dashboard redirect entry. See [Google's Desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app).
3. Copy the new client ID and client secret privately into `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in the existing `.dev.vars`. Do not paste them into chat or a frontend variable.
4. Under **Audience**, if the app is in **Testing**, add the sender Gmail account as a test user. Under **Data Access**, declare `https://www.googleapis.com/auth/gmail.send` for the sender flow if Google requires it. The setup requests that narrow send permission plus `openid email` to verify which sender authorised it.

The sender needs to approve the Google consent screen personally. If Google requires sign-in, reauthentication, or displays an unverified-app warning, complete or review those steps yourself. Do not grant broad read/delete mailbox access: this setup only needs `gmail.send` and basic account identity.

## Connect the sender locally

Fill these entries in the **existing** `.dev.vars`, preserving Google sign-in credentials, `TOTP_ENCRYPTION_KEY`, and any other settings:

```dotenv
EMAIL_PROVIDER="gmail"
EMAIL_FROM="Manhunt IX <your-sender@gmail.com>"
GMAIL_CLIENT_ID="your-desktop-client-id.apps.googleusercontent.com"
GMAIL_CLIENT_SECRET="your-desktop-client-secret"
GMAIL_REFRESH_TOKEN=""
```

Run:

```sh
npm run gmail:setup
```

Open the printed Google authorisation URL in your normal browser. Choose the exact Gmail account in `EMAIL_FROM` and approve sending mail. The local callback checks the state, PKCE exchange, signed Google ID token, verified sender address, nonce, and granted send scope. After approval it saves `GMAIL_REFRESH_TOKEN` into ignored `.dev.vars` and closes the callback listener. It does not print or show the token and does not send an email.

If the chosen Google account differs from `EMAIL_FROM`, setup refuses to save its token. If the listener expires or Google declines access, rerun the command to start again. Keep the setup terminal running until the browser displays success.

Then check the sender settings and optionally send one real test message to an address you control:

```sh
npm run email:check
npm run email:test -- --to you@example.com
```

Restart `npm run dev` after configuration changes. The email recovery option becomes available only after the selected provider's required settings are complete. Gmail failures never fall back to the old Resend test sender.

## Token lifetime and production

An external Google OAuth app left in **Testing** issues Gmail refresh tokens that expire after seven days. Do not rely on such a token for a later event without reconnecting. Before long-running use, review publishing and verification requirements for your specific sender-only app; do not make a public launch or change your existing app's audience solely to silence a warning. See [Google's refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration) and [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

For a deployed Cloudflare Worker, set `EMAIL_PROVIDER=gmail` and the matching `EMAIL_FROM`. Add `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` as private Worker configuration/secrets. These values are separate from `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for player sign-in. Local `.dev.vars` does not get uploaded automatically. Follow [Cloudflare's secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/).

Gmail has account sending limits; personal Gmail may block sending above about 500 messages/day, and account restrictions can be lower. Use the dedicated sender account for this app's modest event volume. See [Gmail sending limits](https://support.google.com/mail/answer/22839).

## What this enables

The sender delivers codes automatically when contact emails are added or edited, on request for **Email code** sign-in, and for eligible password resets. Contact codes are entered in Settings. Email-code sign-in uses the verified original registration email or linked Google email; additional contact aliases do not grant account access. Password-reset email eligibility remains limited to established Google-verified identities. Invitations and submission notifications are separate, unimplemented flows.

The selected provider is handled by `server/email/email.ts`; code generation, eligibility checks, expiry, rate limits, and password changes remain in the existing recovery flow. Tests mock OAuth and email delivery and send no real messages.
