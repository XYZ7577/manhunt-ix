import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('./../', import.meta.url));
const localState = resolve(root, '.wrangler/state');
let active;
let stopping = false;
const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: resolve(root, '.wrangler/logs'),
};

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        stopping = true;
        active?.kill(signal);
    });
}

function run(script, args = [], { nonInteractive = false } = {}) {
    return new Promise((resolvePromise, reject) => {
        active = spawn(process.execPath, [resolve(root, script), ...args], {
            cwd: root,
            env: nonInteractive ? { ...env, CI: 'true' } : env,
            stdio: nonInteractive ? ['ignore', 'inherit', 'inherit'] : 'inherit',
            windowsHide: true,
        });
        active.on('error', reject);
        active.on('exit', (code, signal) => {
            if (code === 0 || stopping) resolvePromise();
            else reject(new Error(`Process exited with ${code ?? signal}.`));
        });
    });
}

try {
    const secretsPath = resolve(root, '.dev.vars');
    const secrets = await readFile(secretsPath, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
    });
    const keyLine = /^TOTP_ENCRYPTION_KEY\s*=\s*(.*?)\s*$/m;
    const keyValue = secrets.match(keyLine)?.[1]?.replace(/^["']|["']$/g, '');
    if (!keyValue) {
        const generated = `TOTP_ENCRYPTION_KEY="${randomBytes(32).toString('base64')}"`;
        await writeFile(
            secretsPath,
            keyLine.test(secrets)
                ? secrets.replace(keyLine, generated)
                : `${secrets}${secrets && !secrets.endsWith('\n') ? '\n' : ''}${generated}\n`,
            { mode: 0o600 },
        );
        console.log('Prepared the private local authenticator encryption key.');
    }
    console.log('Preparing the local database…');
    await run(
        'node_modules/wrangler/bin/wrangler.js',
        ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', localState],
        { nonInteractive: true },
    );
    if (!stopping) {
        console.log('Building the website into .wrangler/dev-assets…');
        await run('node_modules/vite/bin/vite.js', ['build', '--outDir', '.wrangler/dev-assets']);
    }
    if (!stopping) {
        console.log('Starting Manhunt IX at http://127.0.0.1:8787');
        console.log(
            'For frontend hot reload, run npm run dev:ui in another terminal and open http://127.0.0.1:5173.',
        );
        console.log(
            'Production builds write to dist and will not replace the assets served here. Worker source edits can still reload the local Worker.',
        );
        await run('node_modules/wrangler/bin/wrangler.js', [
            'dev',
            '--local',
            '--persist-to',
            localState,
            '--ip',
            '127.0.0.1',
            '--port',
            '8787',
            '--assets',
            '.wrangler/dev-assets',
        ]);
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
