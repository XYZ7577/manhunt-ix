import type { UploadSession } from '../../shared/evidence/uploads';

const RECOVERY_ERROR =
    'This upload has incomplete file verification data. Cancel it and select the original file again to restart.';

export function missingParts(upload: UploadSession): number[] {
    if (upload.state !== 'uploading' || !Number.isSafeInteger(upload.partCount) || upload.partCount < 1)
        return [];
    const stored = new Set<number>();
    for (const part of upload.parts) {
        if (
            !Number.isInteger(part.partNumber) ||
            part.partNumber < 1 ||
            part.partNumber > upload.partCount ||
            stored.has(part.partNumber)
        ) {
            throw new Error(RECOVERY_ERROR);
        }
        stored.add(part.partNumber);
    }
    return Array.from({ length: upload.partCount }, (_, index) => index + 1).filter(
        (number) => !stored.has(number),
    );
}

function bytesToHex(bytes: ArrayBuffer): string {
    return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyUploadFile(
    file: Pick<File, 'name' | 'size' | 'slice'>,
    upload: UploadSession,
    signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (upload.state !== 'uploading')
        return {
            ok: false,
            reason: 'This upload changed while you were selecting the file. Refresh and try again.',
        };
    if (file.name !== upload.filename || file.size !== upload.size) {
        return {
            ok: false,
            reason: 'That is a different file. Select the original file that was used to start this upload.',
        };
    }
    if (
        !Number.isSafeInteger(upload.partSize) ||
        upload.partSize <= 0 ||
        !Number.isSafeInteger(upload.partCount) ||
        upload.partCount !== Math.ceil(file.size / upload.partSize)
    ) {
        return { ok: false, reason: RECOVERY_ERROR };
    }
    if (signal?.aborted)
        throw signal.reason ?? new DOMException('Upload verification cancelled.', 'AbortError');
    let missing: number[];
    try {
        missing = missingParts(upload);
    } catch {
        return { ok: false, reason: RECOVERY_ERROR };
    }
    if (missing.length + upload.parts.length !== upload.partCount)
        return { ok: false, reason: RECOVERY_ERROR };
    const seen = new Set<number>();
    for (const part of upload.parts) {
        if (
            !Number.isInteger(part.partNumber) ||
            part.partNumber < 1 ||
            part.partNumber > upload.partCount ||
            !/^[a-f\d]{64}$/i.test(part.sha256)
        ) {
            return { ok: false, reason: RECOVERY_ERROR };
        }
        if (seen.has(part.partNumber)) return { ok: false, reason: RECOVERY_ERROR };
        seen.add(part.partNumber);
        const start = (part.partNumber - 1) * upload.partSize;
        const expectedLength = Math.min(upload.partSize, file.size - start);
        if (part.size !== expectedLength) {
            return { ok: false, reason: RECOVERY_ERROR };
        }
        const data = await file.slice(start, start + expectedLength).arrayBuffer();
        if (signal?.aborted)
            throw signal.reason ?? new DOMException('Upload verification cancelled.', 'AbortError');
        const hash = bytesToHex(await crypto.subtle.digest('SHA-256', data));
        if (signal?.aborted)
            throw signal.reason ?? new DOMException('Upload verification cancelled.', 'AbortError');
        if (hash.toLowerCase() !== part.sha256.toLowerCase()) {
            return {
                ok: false,
                reason: 'The selected file does not match the content already uploaded. Cancel this upload and select the original file to start again.',
            };
        }
    }
    return { ok: true };
}
