import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { emptyR2Bucket, preflightR2Bucket } from './reset-r2.mjs';

export async function connectRemoteR2(
    { root, bucketName, accountId, compatibilityDate, jurisdiction },
    platformFactory,
) {
    const parent = resolve(root, '.wrangler');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'reset-r2-'));
    const configPath = join(directory, 'wrangler.json');
    let platform;
    let disposed = false;
    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try {
            await platform?.dispose();
        } finally {
            const inside = relative(parent, resolve(directory));
            if (!inside.startsWith('reset-r2-') || inside.includes(sep) || inside === '..') {
                throw new Error('Refusing to remove a reset configuration outside its temporary directory.');
            }
            await rm(directory, { recursive: true, force: true });
        }
    };
    try {
        if (!bucketName || typeof bucketName !== 'string')
            throw new Error('The reset needs a configured R2 bucket name.');
        const config = {
            name: 'manhunt-storage-reset',
            compatibility_date: compatibilityDate || '2026-10-24',
            ...(accountId ? { account_id: accountId } : {}),
            r2_buckets: [
                {
                    binding: 'EVIDENCE',
                    bucket_name: bucketName,
                    remote: true,
                    ...(jurisdiction ? { jurisdiction } : {}),
                },
            ],
        };
        await writeFile(configPath, JSON.stringify(config));
        const factory = platformFactory ?? (await import('wrangler')).getPlatformProxy;
        platform = await factory({ configPath, persist: false, remoteBindings: true, envFiles: [] });
        const bucket = platform.env.EVIDENCE;
        if (!bucket || typeof bucket.list !== 'function' || typeof bucket.delete !== 'function') {
            throw new Error('Wrangler did not provide the configured remote R2 bucket.');
        }
        return { bucket, dispose };
    } catch (error) {
        await dispose();
        throw error;
    }
}

export async function runRemoteReset({
    keepR2,
    connectBucket,
    backup,
    loadMultipartUploads,
    resetDatabase,
    verifyDatabase,
    onProgress,
}) {
    let connection;
    let dbResetStarted = false;
    try {
        if (!keepR2) {
            connection = await connectBucket();
            await preflightR2Bucket(connection.bucket);
        }
        await backup();
        if (connection) {
            const multipart = await loadMultipartUploads();
            await emptyR2Bucket(connection.bucket, { multipartUploads: multipart, onProgress });
        }
        dbResetStarted = true;
        await resetDatabase();
        if (connection) {
            await emptyR2Bucket(connection.bucket, { onProgress });
        }
        await verifyDatabase();
    } catch (error) {
        const stage = dbResetStarted
            ? 'Reset incomplete. D1 may already have been cleared; fix the error and rerun while nobody is using the site.'
            : 'Stopped before resetting D1. R2 cleanup may be partial; fix the error and rerun while nobody is using the site.';
        throw new Error(`${stage}\n${error instanceof Error ? error.message : 'Storage cleanup failed.'}`);
    } finally {
        await connection?.dispose();
    }
}
