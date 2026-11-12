import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { getEmailConfiguration, sendEmail, type EmailEnv } from '../../server/email/email';
import { withEmailFooter } from '../../server/email/emailTemplates';

const usage = 'Usage: npm run email:check\n       npm run email:test -- --to recipient@example.com';

async function main() {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === '--help' || args.includes('--help')) {
        console.log(usage);
        return;
    }
    if (
        !['check', 'test'].includes(mode) ||
        (mode === 'check' && args.length) ||
        (mode === 'test' && (args.length !== 2 || args[0] !== '--to'))
    ) {
        throw new Error(usage);
    }
    const recipient = mode === 'test' ? args[1].trim() : '';
    if (mode === 'test' && (recipient.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient))) {
        throw new Error('Provide one valid recipient address using --to.');
    }

    let local: Record<string, string | undefined> = {};
    try {
        local = parseEnv(await readFile(new URL('../../.dev.vars', import.meta.url), 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('Could not read the local .dev.vars file.');
    }
    const keys = [
        'EMAIL_PROVIDER',
        'EMAIL_FROM',
        'RESEND_API_KEY',
        'GMAIL_CLIENT_ID',
        'GMAIL_CLIENT_SECRET',
        'GMAIL_REFRESH_TOKEN',
    ] as const;
    const env: EmailEnv = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? local[key]]));
    const provider = env.EMAIL_PROVIDER?.trim().toLowerCase() || 'resend';
    if (!['gmail', 'resend'].includes(provider)) throw new Error('EMAIL_PROVIDER must be gmail or resend.');
    const required =
        provider === 'gmail'
            ? ['EMAIL_FROM', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']
            : ['EMAIL_FROM', 'RESEND_API_KEY'];
    const missing = required.filter((key) => !env[key as keyof EmailEnv]?.trim());
    const guide = provider === 'gmail' ? 'docs/setup/gmail-setup.md' : 'docs/setup/resend-setup.md';
    if (missing.length)
        throw new Error(`Missing ${missing.join(', ')}. Add them privately to .dev.vars. See ${guide}.`);
    const config = getEmailConfiguration(env);
    if (!config) throw new Error(`Email configuration is invalid. Check your sender and ${guide}.`);
    if (config.provider === 'resend' && !config.apiKey.startsWith('re_'))
        throw new Error(
            'RESEND_API_KEY should be your Resend key beginning with re_. The key has not been printed.',
        );
    const providerName = config.provider === 'gmail' ? 'Gmail' : 'Resend';

    if (mode === 'check') {
        console.log(`${providerName} configuration format is valid. No email was sent.`);
        console.log(
            'Run email:test with --to to check the key, sender permissions, and provider acceptance.',
        );
        return;
    }

    const accepted = await sendEmail(env, {
        to: recipient,
        subject: 'Manhunt IX email delivery test',
        text: withEmailFooter(
            'This is a Manhunt IX email delivery test. Your email sender is connected. This message does not change any account or password.',
        ),
    });
    if (!accepted)
        throw new Error(
            `${providerName} did not accept the test message. Check your sender credentials and ${guide}.`,
        );
    console.log(`${providerName} accepted the test message. Check the recipient inbox.`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'The email check failed.');
    process.exitCode = 1;
});
