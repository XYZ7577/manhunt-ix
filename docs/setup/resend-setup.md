# Set up Resend for Manhunt IX

The repo can send contact-verification, sign-in, and password-reset codes through Resend from the server. If you want to send from a Gmail account without owning a domain, use [the Gmail setup guide](gmail-setup.md) instead. Password sign-in works without an email provider; email-code sign-in and verification need the sender configured. Invitations and submission notification emails are separate, unimplemented features.

## 1. Add a sending domain in Resend

1. Sign in to [Resend](https://resend.com/domains) and add a domain you own. A sending subdomain such as `auth.example.com` keeps the configuration separate from your existing mail.
2. Add the exact DNS names, types, and values shown by Resend at your domain's DNS provider. For Cloudflare DNS, use the [Resend Cloudflare guide](https://resend.com/docs/guides/dns/cloudflare). Use **DNS only** for any proxyable Resend records.
3. Click **Verify DNS Records** in Resend and wait for the domain to become verified. Use the SPF, DKIM, and sending MX records Resend supplies; preserve your existing mailbox/root-domain records. Receiving mail is not required for this app.
4. Consider adding a [DMARC record](https://resend.com/docs/dashboard/domains/dmarc) after SPF and DKIM are working.

Choose a sender on the domain you verified, for example `Manhunt IX <no-reply@auth.example.com>`. Replace `example.com` with your own domain. Resend does not provide an inbox for this address.

If you do not yet own a domain, Resend's default `onboarding@resend.dev` sender can be used for initial testing **only to the email address associated with your Resend account**. It cannot email your players. See [the resend.dev restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

## 2. Create a sending key

Under [API Keys](https://resend.com/api-keys), create a key with **Sending access**, scoped to the verified domain. Copy it privately when Resend shows it. See [API key permissions](https://resend.com/docs/create-an-api-key).

Keep the key out of frontend code, Git, screenshots, and chat. You do not need Gmail permissions, an SMTP password, or a new npm dependency.

## 3. Configure local development

Edit the **existing** `.dev.vars` in the repo root and fill these entries:

```dotenv
RESEND_API_KEY="re_your_actual_key"
EMAIL_PROVIDER="resend"
EMAIL_FROM="Manhunt IX <no-reply@auth.example.com>"
```

Preserve the existing Google settings and `TOTP_ENCRYPTION_KEY`. The repo ignores `.dev.vars` and its environment variants; `.dev.vars.example` contains safe examples only. The setup leaves missing credentials blank so delivery remains disabled until you enter real values.

Check the configuration without sending mail:

```sh
npm run email:check
```

Then send one delivery test to an address you control:

```sh
npm run email:test -- --to you@example.com
```

The test command sends a real message. Check the recipient inbox and the [Resend email logs](https://resend.com/emails). An accepted API request does not by itself confirm delivery. For a verified custom sender, you can instead use Resend's [test recipient](https://resend.com/changelog/sending-test-emails) `delivered@resend.dev` to exercise delivery events without emailing a person. With the default `resend.dev` sender, use your Resend account address as described above.

Both commands read `.dev.vars`; environment variables with the same names override the file. They keep the API key out of their output. `email:check` checks the local format; `email:test` also checks provider acceptance. The test command does not use or change any app account, password, or database record.

Restart the app after editing its configuration:

```sh
npm run dev
```

## 4. Check password-reset emails

Use **Forgot password? > Email reset code** with a Google email already linked to an account in this app. Added contact emails and native-registration emails are currently unverified and cannot receive reset codes. A Google sign-in or link establishes the verified identity.

Check the inbox, then use the code in the same browser that requested it. Codes expire in ten minutes and allow five attempts. A successful reset signs out existing sessions.

For privacy, the request screen responds the same way for unknown addresses, unverified addresses, rate limits, and delivery failures. If a code does not arrive, use Resend's logs to check whether a send was accepted, inspect spam, and confirm the address is a linked Google identity. Do not interpret the generic success message as a delivery receipt.

## 5. Configure Cloudflare when deploying

Local `.dev.vars` values are not deployed to Cloudflare. In **Workers & Pages > your Worker > Settings > Variables and Secrets**, add `RESEND_API_KEY` as a **Secret** and `EMAIL_FROM` as a **Text** variable (or Secret). Use the same verified sender. Follow [Cloudflare's secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/).

Save and deploy the configuration when you are ready to update the live Worker. The repo still requires its real D1/R2 resources, migrations, Google credentials, authenticator key, production origin, and demo-mode setting before launch; configuring Resend does not deploy those resources.

If using Wrangler, `npx wrangler secret put RESEND_API_KEY` prompts privately for the key. Treat that command as a live Worker change; run it only when you are ready to update production. Do not place the secret in `wrangler.jsonc` or a `VITE_` variable.

## Checks included in the repo

- `npm run email:check`: local format and missing-value checks; never sends a message.
- `npm run email:test -- --to ADDRESS`: sends a separate delivery test only when you invoke it with a recipient.
- `npm test`: uses mocked email delivery; sends no messages.
- `npm run build`: checks TypeScript and builds the frontend.

The reusable delivery helper is `server/email/email.ts`. It validates configuration, trims values, bounds the provider request time, and keeps provider response bodies out of client responses and logs.
