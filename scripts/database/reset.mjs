#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { connectRemoteR2, runRemoteReset } from './reset-remote.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const configPath = join(root, 'wrangler.jsonc');
const resetSql = fileURLToPath(new URL('./reset-data.sql', import.meta.url));

const argv = process.argv.slice(2);
const scope = argv.find((arg) => !arg.startsWith('-'));
const flags = new Set(argv.filter((arg) => arg.startsWith('-')));
const confirmed = flags.has('--yes') || flags.has('-y');

function printHelp() {
    console.log(`Reset Manhunt IX data.

Usage:
  npm run reset:local   [-- --yes]
  npm run reset:remote  [-- --yes] [-- --recreate-db] [-- --keep-r2]

Local reset deletes .wrangler/state, which holds the local D1 database,
local R2 evidence, and caches. Run "npm run dev" afterwards.

Remote reset checks R2 access, backs up D1, aborts tracked unfinished uploads,
and empties R2 before clearing D1. The bucket and its settings are preserved.
Run while nobody is using the site; uploaded files are not backed up.

Options:
  --yes           Skip the typed confirmation (for automation).
  --recreate-db   Delete and recreate the production D1 database, update
                  database_id in wrangler.jsonc, apply migrations, and redeploy.
  --keep-r2       Leave R2 objects untouched and only reset D1.

Examples:
  npm run reset:remote -- --yes
  npm run reset:remote -- --recreate-db
`);
}

function readConfig(key) {
    const text = readFileSync(configPath, 'utf8');
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
    return match?.[1];
}

function patchDatabaseId(uuid) {
    const text = readFileSync(configPath, 'utf8');
    const names = [...text.matchAll(/"database_name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
    if (!names.length) throw new Error('Could not find database_name in wrangler.jsonc.');
    if (new Set(names).size !== 1) {
        throw new Error('wrangler.jsonc defines multiple D1 database names. Update database_id manually.');
    }
    const updated = text.replace(/("database_id"\s*:\s*")[^"]+(")/g, `$1${uuid}$2`);
    if (updated === text) throw new Error('Could not update database_id in wrangler.jsonc.');
    writeFileSync(configPath, updated);
}

function run(args, { capture = false, allowFailure = false, env = {} } = {}) {
    const result = spawnSync(process.execPath, [wrangler, ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: { ...process.env, CI: 'true', ...env },
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure) {
        const detail = capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
        throw new Error(`wrangler ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
    }
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseJson(text) {
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
    const start = clean.search(/[\[{]/);
    const end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));
    if (start < 0 || end < start) throw new Error('Could not read JSON from wrangler output.');
    return JSON.parse(clean.slice(start, end + 1));
}

function jsonRun(args) {
    return parseJson(run([...args, '--json'], { capture: true }).stdout);
}

function listDatabases() {
    const list = jsonRun(['d1', 'list']);
    return Array.isArray(list) ? list : [];
}

async function confirmReset(target) {
    if (confirmed) return;
    if (!process.stdin.isTTY) throw new Error('Refusing to reset without confirmation. Re-run with "--yes".');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`This permanently deletes ${target}.\nType "reset" to continue: `);
    rl.close();
    if (answer.trim().toLowerCase() !== 'reset') {
        console.log('Aborted.');
        process.exit(1);
    }
}

function backupDatabase(name) {
    const directory = join(root, '.wrangler', 'backups');
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(directory, `manhunt-${stamp}.sql`);
    run(['d1', 'export', name, '--remote', '--output', file, '--skip-confirmation']);
    console.log(`Backup saved to ${file}`);
}

function verifyEmpty(name) {
    const output = jsonRun([
        'd1',
        'execute',
        name,
        '--remote',
        '--command',
        'SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM groups) AS groups, (SELECT COUNT(*) FROM submissions) AS submissions, (SELECT COUNT(*) FROM evidence) AS evidence, (SELECT COUNT(*) FROM sessions) AS sessions',
    ]);
    const row = Array.isArray(output) ? output[0]?.results?.[0] : output?.results?.[0];
    if (!row) throw new Error('Could not read row counts after the reset.');
    const remaining = Object.entries(row).filter(([, value]) => Number(value) !== 0);
    if (remaining.length) {
        throw new Error(`Reset incomplete: ${remaining.map(([key, value]) => `${key}=${value}`).join(', ')}`);
    }
    console.log('Verified: accounts, groups, submissions, evidence, and sessions are empty.');
}

function applyMigrations() {
    run(['d1', 'migrations', 'apply', 'DB', '--remote']);
}

function deployWorker() {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const build = spawnSync(npm, ['run', 'build'], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: process.env,
    });
    if (build.status !== 0) throw new Error('npm run build failed. Fix the build and run the command again.');
    try {
        run(['deploy']);
    } catch (error) {
        throw new Error(
            `The database changes are applied, but the Worker deploy failed. Fix the error and run "npx wrangler deploy".\n${error.message}`,
        );
    }
}

async function createDatabase(name) {
    let lastError;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
        const result = run(['d1', 'create', name, '--location', process.env.D1_LOCATION || 'apac'], {
            capture: true,
            allowFailure: true,
        });
        if (result.status === 0) return;
        lastError = result.stderr.trim() || result.stdout.trim();
        await new Promise((done) => setTimeout(done, 2000));
    }
    throw new Error(`Could not create D1 database ${name}: ${lastError}`);
}

async function resetLocal() {
    const state = join(root, '.wrangler', 'state');
    await confirmReset(`local data in ${state}`);
    if (existsSync(state)) {
        try {
            rmSync(state, { recursive: true, force: true });
        } catch (error) {
            throw new Error(`Could not delete ${state}. Stop "npm run dev" and try again. ${error.message}`);
        }
    }
    console.log('Local data cleared. Run npm run dev to rebuild the local database.');
}

async function resetRemote() {
    const databaseName = readConfig('database_name');
    const bucketName = readConfig('bucket_name');
    const configuredId = readConfig('database_id');
    if (!databaseName || !bucketName || !configuredId) {
        throw new Error('Could not read database_name, database_id, and bucket_name from wrangler.jsonc.');
    }

    const recreate = flags.has('--recreate-db');
    const keepR2 = flags.has('--keep-r2');
    const databases = listDatabases();
    const current = databases.find((database) => database.uuid === configuredId);
    const exists = databases.some(
        (database) => database.uuid === configuredId || database.name === databaseName,
    );
    if (current && current.name !== databaseName)
        throw new Error(
            'The configured D1 name and ID refer to different databases. Fix wrangler.jsonc before resetting.',
        );
    if (!recreate && !current) {
        throw new Error(
            `Database ${databaseName} (${configuredId}) was not found in this account. Run "npm run reset:remote -- --recreate-db" to create a fresh one.`,
        );
    }

    console.log(
        keepR2
            ? 'Close the site on all devices before continuing. R2 files will be kept.'
            : 'Close the site on all devices before continuing. R2 files are permanently removed and are not backed up.',
    );
    await confirmReset(
        `${recreate ? 'and recreate' : 'all data in'} the production database ${databaseName}${keepR2 ? '' : ` and all files in R2 bucket ${bucketName}`}`,
    );

    await runRemoteReset({
        keepR2,
        connectBucket: () =>
            connectRemoteR2({
                root,
                bucketName,
                accountId: readConfig('account_id'),
                compatibilityDate: readConfig('compatibility_date'),
                jurisdiction: readConfig('jurisdiction'),
            }),
        backup: () => {
            if (exists) backupDatabase(databaseName);
        },
        loadMultipartUploads: () => {
            if (!exists) return [];
            const output = jsonRun([
                'd1',
                'execute',
                databaseName,
                '--remote',
                '--command',
                "SELECT object_key,multipart_upload_id FROM upload_sessions WHERE multipart_upload_id IS NOT NULL AND multipart_upload_id!='' AND state!='completed'",
            ]);
            const rows = Array.isArray(output) ? output[0]?.results : output?.results;
            if (!Array.isArray(rows))
                throw new Error('Could not read unfinished upload records before resetting D1.');
            return rows;
        },
        resetDatabase: async () => {
            if (recreate) {
                if (exists) run(['d1', 'delete', databaseName, '--skip-confirmation']);
                await createDatabase(databaseName);
                const created = listDatabases().find((database) => database.name === databaseName);
                if (!created) throw new Error(`Database ${databaseName} was created but could not be found.`);
                patchDatabaseId(created.uuid);
                applyMigrations();
                deployWorker();
                console.log(`Recreated and redeployed ${databaseName} (${created.uuid}).`);
            } else {
                run(['d1', 'execute', databaseName, '--remote', '--file', resetSql, '--yes']);
            }
        },
        verifyDatabase: () => verifyEmpty(databaseName),
        onProgress: ({ stage, count }) => {
            if (stage === 'objects-deleted') console.log(`Removed ${count} R2 object(s).`);
            if (stage === 'multipart-uploads-aborted')
                console.log(`Cleared ${count} tracked unfinished upload(s).`);
            if (stage === 'empty')
                console.log(
                    `Verified: R2 bucket ${bucketName} contains no listed objects. Its settings are unchanged.`,
                );
        },
    });
    if (keepR2) console.log(`R2 bucket ${bucketName} was left untouched (--keep-r2).`);

    console.log(
        'Remote reset complete. Sign in with the configured ADMIN_GOOGLE_EMAIL to recreate the organiser account.',
    );
}

async function main() {
    if (flags.has('--help') || flags.has('-h') || (scope !== 'local' && scope !== 'remote')) {
        printHelp();
        return;
    }
    if (scope === 'local') await resetLocal();
    else await resetRemote();
}

try {
    await main();
} catch (error) {
    console.error(`\nReset failed: ${error.message}`);
    process.exit(1);
}
