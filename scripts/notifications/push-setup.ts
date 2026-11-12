import { webcrypto } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const usage = 'Usage: npm run push:setup -- --subject mailto:your-address@example.com';
function base64url(value: Uint8Array) {
    return Buffer.from(value).toString('base64url');
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--help') {
        console.log(usage);
        return;
    }
    if (
        args.length !== 2 ||
        args[0] !== '--subject' ||
        !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S{1,190})$/.test(args[1])
    )
        throw new Error(usage);
    const file = new URL('../../.dev.vars', import.meta.url);
    let current = '';
    try {
        current = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('Could not read the local .dev.vars file.');
    }
    const existing = parseEnv(current);
    const hasPublic = !!existing.PUSH_VAPID_PUBLIC_KEY?.trim();
    const hasPrivate = !!existing.PUSH_VAPID_PRIVATE_KEY?.trim();
    if (hasPublic !== hasPrivate)
        throw new Error(
            'Only one VAPID key is configured in .dev.vars. No values were changed; restore its matching key before setup.',
        );
    if (
        hasPublic &&
        (!/^[A-Za-z0-9_-]{87}$/.test(existing.PUSH_VAPID_PUBLIC_KEY!) ||
            !/^[A-Za-z0-9_-]{43}$/.test(existing.PUSH_VAPID_PRIVATE_KEY!))
    ) {
        throw new Error('The existing VAPID key pair is malformed. No values were changed.');
    }
    if (hasPublic && existing.PUSH_VAPID_SUBJECT?.trim()) {
        console.log('Web Push keys already exist in .dev.vars. They were left unchanged.');
        return;
    }
    const replacement: Record<string, string> = {};
    if (!hasPublic) {
        const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
            'sign',
            'verify',
        ]);
        const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
        if (!jwk.d || !jwk.x || !jwk.y) throw new Error('Could not generate Web Push keys.');
        const publicBytes = Buffer.concat([
            Buffer.from([4]),
            Buffer.from(jwk.x, 'base64url'),
            Buffer.from(jwk.y, 'base64url'),
        ]);
        replacement.PUSH_VAPID_PUBLIC_KEY = publicBytes.toString('base64url');
        replacement.PUSH_VAPID_PRIVATE_KEY = Buffer.from(jwk.d, 'base64url').toString('base64url');
    }
    if (!existing.PUSH_VAPID_SUBJECT?.trim()) replacement.PUSH_VAPID_SUBJECT = args[1];
    let output = current;
    for (const [name, value] of Object.entries(replacement)) {
        const line = new RegExp(`^${name}\\s*=.*$`, 'm');
        output = line.test(output)
            ? output.replace(line, `${name}="${value}"`)
            : `${output}${output && !output.endsWith('\n') ? '\n' : ''}${name}="${value}"\n`;
    }
    await writeFile(file, output, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => undefined);
    console.log(
        `${hasPublic ? 'Saved the missing Web Push subject' : 'Generated Web Push keys'} in .dev.vars. The private key was not displayed.`,
    );
    console.log(
        'Restart the local server after setup. Configure the same three values as Worker secrets before deployment.',
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Push setup failed.');
    process.exitCode = 1;
});
