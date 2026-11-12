const PAGE_LIMIT = 1000;
const MAX_SWEEPS = 3;
const MAX_PAGES_PER_SCAN = 10_000;

function isMissingMultipartUpload(error) {
    const code = error?.code ?? error?.name;
    if (code === 'NoSuchUpload' || code === 10024 || code === '10024') return true;
    return (
        typeof error?.message === 'string' &&
        (/\(10024\)\s*$/.test(error.message) ||
            /^(?:NoSuchUpload(?::|\s)|The specified (?:multipart )?upload does not exist\.?$)/i.test(
                error.message.trim(),
            ))
    );
}

function validatePage(page) {
    if (!page || !Array.isArray(page.objects) || typeof page.truncated !== 'boolean') {
        throw new Error('R2 bucket listing returned an invalid response.');
    }
    if (page.truncated && (typeof page.cursor !== 'string' || page.cursor.length === 0)) {
        throw new Error('R2 bucket listing was truncated without a usable cursor.');
    }
}

async function listPage(bucket, cursor) {
    let page;
    try {
        page = await bucket.list({ limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
    } catch {
        throw new Error('Could not list objects in the R2 bucket.');
    }
    validatePage(page);
    return page;
}

export async function preflightR2Bucket(bucket) {
    if (
        !bucket ||
        typeof bucket.list !== 'function' ||
        typeof bucket.delete !== 'function' ||
        typeof bucket.resumeMultipartUpload !== 'function'
    ) {
        throw new Error('A valid R2 bucket binding is required.');
    }
    let page;
    try {
        page = await bucket.list({ limit: 1 });
    } catch {
        throw new Error('Could not access the R2 bucket.');
    }
    validatePage(page);
    return { objectCount: page.objects.length, truncated: page.truncated };
}

async function deleteObjects(bucket, objects, onProgress) {
    const allKeys = objects.map((object) => object?.key);
    if (allKeys.some((key) => typeof key !== 'string' || key.length === 0)) {
        throw new Error('R2 bucket listing contained an invalid object.');
    }
    for (let offset = 0; offset < objects.length; offset += PAGE_LIMIT) {
        const keys = allKeys.slice(offset, offset + PAGE_LIMIT);
        try {
            await bucket.delete(keys);
        } catch {
            throw new Error('Could not delete objects from the R2 bucket.');
        }
        onProgress?.({ stage: 'objects-deleted', count: keys.length });
    }
}

async function sweep(bucket, onProgress) {
    let cursor;
    let pages = 0;
    const seenCursors = new Set();
    do {
        if (pages >= MAX_PAGES_PER_SCAN) {
            throw new Error('R2 bucket listing exceeded the safe pagination limit.');
        }
        const page = await listPage(bucket, cursor);
        pages += 1;
        if (page.truncated && seenCursors.has(page.cursor)) {
            throw new Error('R2 bucket listing repeated a pagination cursor.');
        }
        await deleteObjects(bucket, page.objects, onProgress);
        if (!page.truncated) return;
        cursor = page.cursor;
        seenCursors.add(cursor);
    } while (true);
}

async function hasAnyObject(bucket) {
    let cursor;
    let pages = 0;
    const seenCursors = new Set();
    do {
        if (pages >= MAX_PAGES_PER_SCAN) {
            throw new Error('R2 bucket listing exceeded the safe pagination limit.');
        }
        const page = await listPage(bucket, cursor);
        pages += 1;
        if (page.objects.length > 0) return true;
        if (!page.truncated) return false;
        cursor = page.cursor;
        if (seenCursors.has(cursor)) {
            throw new Error('R2 bucket listing repeated a pagination cursor.');
        }
        seenCursors.add(cursor);
    } while (true);
}

async function abortMultipartUploads(bucket, uploads, onProgress) {
    if (!Array.isArray(uploads)) throw new Error('Multipart upload records must be an array.');
    let aborted = 0;
    for (const upload of uploads) {
        const objectKey = upload?.object_key;
        const uploadId = upload?.multipart_upload_id;
        if (typeof objectKey !== 'string' || !objectKey || typeof uploadId !== 'string' || !uploadId) {
            throw new Error('A multipart upload record is invalid.');
        }
        try {
            await bucket.resumeMultipartUpload(objectKey, uploadId).abort();
            aborted += 1;
        } catch (error) {
            if (!isMissingMultipartUpload(error)) {
                throw new Error('Could not abort a multipart upload in the R2 bucket.');
            }
        }
    }
    if (aborted) onProgress?.({ stage: 'multipart-uploads-aborted', count: aborted });
}

export async function emptyR2Bucket(bucket, { multipartUploads = [], onProgress } = {}) {
    if (
        !bucket ||
        typeof bucket.list !== 'function' ||
        typeof bucket.delete !== 'function' ||
        typeof bucket.resumeMultipartUpload !== 'function'
    ) {
        throw new Error('A valid R2 bucket binding is required.');
    }
    await abortMultipartUploads(bucket, multipartUploads, onProgress);

    for (let pass = 0; pass < MAX_SWEEPS; pass += 1) {
        await sweep(bucket, onProgress);
        if (!(await hasAnyObject(bucket))) {
            onProgress?.({ stage: 'empty', count: 0 });
            return;
        }
    }
    throw new Error('R2 bucket still contains objects after repeated cleanup passes.');
}
