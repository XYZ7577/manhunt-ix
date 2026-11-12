import exifr from 'exifr';
import type { Account } from '../../shared/types';
import type { ImageMetadataAltitudeReference, ImageMetadataResponse } from '../../shared/evidence/imageMetadata';

const MAX_IMAGE_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_ENTRIES = 800;
const MAX_VALUE_LENGTH = 400;

export interface ImageMetadataEnv {
    DB: D1Database;
    EVIDENCE: R2Bucket;
}

export interface ImageMetadataDeps {
    currentAccount(request: Request, env: ImageMetadataEnv): Promise<Account | null>;
}

type EvidenceRow = {
    id: string;
    object_key: string;
    filename: string;
    media_type: string;
    size: number;
    metadata_json?: string | null;
};
type Tags = Record<string, unknown>;

function json(body: unknown, status = 200) {
    return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const sectionNames: Record<string, string> = {
    ifd0: 'Image details (EXIF)',
    ifd1: 'Thumbnail details (EXIF)',
    exif: 'Camera details (EXIF)',
    gps: 'Location (GPS)',
    interop: 'Interoperability details',
    xmp: 'Additional image details (XMP)',
    iptc: 'Caption and rights (IPTC)',
    icc: 'Color profile (ICC)',
    jfif: 'JPEG details (JFIF)',
    ihdr: 'Image format details',
    makerNote: 'Camera-specific details',
    userComment: 'User comment',
};

function text(
    value: unknown,
    maxLength = MAX_VALUE_LENGTH,
    depth = 0,
    seen = new WeakSet<object>(),
): string | null {
    if (value == null) return null;
    let result: string;
    if (typeof value === 'string') result = value;
    else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        result = String(value);
    } else if (typeof value === 'bigint') result = value.toString();
    else if (typeof value === 'boolean') result = value ? 'Yes' : 'No';
    else if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) return null;
        result = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const length = value.byteLength;
        return `[Binary data: ${length} bytes]`;
    } else if (Array.isArray(value)) {
        if (depth >= 4 || seen.has(value)) return '[Nested value omitted]';
        seen.add(value);
        result = value
            .slice(0, 32)
            .map((item) => text(item, 80, depth + 1, seen) ?? '')
            .filter(Boolean)
            .join(', ');
        seen.delete(value);
        if (value.length > 32) result += ', …';
    } else if (typeof value === 'object') {
        if (depth >= 4 || seen.has(value)) return '[Nested value omitted]';
        seen.add(value);
        const pairs = Object.entries(value as Record<string, unknown>)
            .filter(([key]) => !forbiddenKeys.has(key))
            .slice(0, 24);
        result = pairs
            .map(([key, item]) => `${safeLabel(key)}: ${text(item, 80, depth + 1, seen) ?? ''}`)
            .filter((pair) => !pair.endsWith(': '))
            .join('; ');
        seen.delete(value);
        if (Object.keys(value).length > 24) result += '; …';
    } else return null;
    result = result
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!result) return null;
    return result.length <= maxLength ? result : `${result.slice(0, maxLength - 1)}…`;
}

function safeLabel(value: string): string {
    return value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
}

function plainObject(value: unknown): value is Record<string, unknown> {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof Date ||
        ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer
    )
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function addEntries(
    entries: Array<{ name: string; value: string }>,
    value: unknown,
    prefix = '',
    depth = 0,
    budget: { remaining: number; truncated?: boolean } = { remaining: MAX_METADATA_ENTRIES },
) {
    if (depth > 3 || budget.remaining <= 0) {
        budget.truncated = true;
        return;
    }
    if (!plainObject(value)) {
        const valueText = text(value);
        if (valueText && budget.remaining > 0) {
            entries.push({ name: prefix || 'Value', value: valueText });
            budget.remaining--;
            if (valueText.endsWith('…')) budget.truncated = true;
        }
        return;
    }
    for (const [rawKey, item] of Object.entries(value)) {
        if (budget.remaining <= 0) {
            budget.truncated = true;
            return;
        }
        if (forbiddenKeys.has(rawKey)) continue;
        const key = safeLabel(rawKey);
        if (!key) continue;
        const label = prefix ? `${prefix}.${key}` : key;
        if (plainObject(item)) {
            addEntries(entries, item, label, depth + 1, budget);
            continue;
        }
        const valueText = text(item);
        if (!valueText) continue;
        entries.push({ name: label, value: valueText });
        if (valueText.endsWith('…')) budget.truncated = true;
        budget.remaining--;
    }
}

function number(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function pad(value: number) {
    return String(value).padStart(2, '0');
}

function localDateText(value: unknown): string | null {
    if (value instanceof Date) return text(value);
    return text(value);
}

function offsetText(value: unknown): string | null {
    const raw = text(value, 24);
    if (!raw) return null;
    if (raw === 'Z' || raw.toUpperCase() === 'UTC') return '+00:00';
    const match = raw.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!match || Number(match[2]) > 14 || Number(match[3]) > 59) return null;
    return `${match[1]}${match[2]}:${match[3]}`;
}

function firstTag(tags: Tags, groups: string[], names: string[]): unknown {
    for (const groupName of groups) {
        const group = plainObject(tags[groupName]) ? (tags[groupName] as Tags) : null;
        if (!group) continue;
        for (const name of names) if (group[name] != null) return group[name];
    }
    for (const name of names) if (tags[name] != null) return tags[name];
    return null;
}

function coordinate(value: unknown, max: number): number | null {
    const n = number(value);
    return n !== null && Math.abs(n) <= max ? n : null;
}

function altitudeReference(value: unknown): ImageMetadataAltitudeReference | null {
    if (ArrayBuffer.isView(value) && value.byteLength === 1)
        value = new Uint8Array(value.buffer, value.byteOffset, 1)[0];
    else if (value instanceof ArrayBuffer && value.byteLength === 1) value = new Uint8Array(value)[0];
    else if (Array.isArray(value) && value.length === 1) value = value[0];
    const raw = text(value, 64)?.trim().toLowerCase();
    if (!raw) return null;
    if (raw === '1' || raw === 'below sea level' || raw === 'belowsealevel') return 'below sea level';
    if (raw === '0' || raw === 'above sea level' || raw === 'abovesealevel') return 'above sea level';
    return null;
}

export function imageMetadataResponse(
    evidence: Pick<ImageMetadataResponse['evidence'], 'id' | 'filename' | 'mediaType' | 'size'>,
    parsedTags: unknown,
    notice: string | null = null,
): ImageMetadataResponse {
    const tags = plainObject(parsedTags) ? parsedTags : {};
    const gps = plainObject(tags.gps) ? tags.gps : {};
    const dateOptions = [
        ['DateTimeOriginal', ['exif', 'ifd0', 'xmp']],
        ['CreateDate', ['exif', 'xmp']],
        ['DateTimeDigitized', ['exif', 'xmp']],
    ] as const;
    let dateName = '';
    let dateValue: unknown = null;
    for (const [name, groups] of dateOptions) {
        const candidate = firstTag(tags, [...groups], [name]);
        if (candidate != null) {
            dateName = name;
            dateValue = candidate;
            break;
        }
    }
    const offsetNames =
        dateName === 'DateTimeOriginal'
            ? ['OffsetTimeOriginal']
            : dateName === 'CreateDate' || dateName === 'DateTimeDigitized'
              ? ['OffsetTimeDigitized']
              : [];
    const inlineOffset =
        typeof dateValue === 'string'
            ? dateValue
                  .trim()
                  .match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i)?.[1]
            : undefined;
    const capturedOffset =
        offsetText(inlineOffset) ?? offsetText(firstTag(tags, ['exif', 'xmp'], offsetNames));
    const capturedLocal =
        inlineOffset && capturedOffset && typeof dateValue === 'string'
            ? dateValue.trim().slice(0, -inlineOffset.length)
            : localDateText(dateValue);
    const sections: ImageMetadataResponse['sections'] = [];
    const budget = { remaining: MAX_METADATA_ENTRIES, truncated: false };
    for (const [key, value] of Object.entries(tags)) {
        if (key === 'errors' || forbiddenKeys.has(key)) continue;
        const entries: Array<{ name: string; value: string }> = [];
        addEntries(entries, value, '', 0, budget);
        if (entries.length)
            sections.push({ name: sectionNames[key] ?? (safeLabel(key) || 'Image details'), entries });
        if (budget.remaining <= 0) {
            budget.truncated = true;
            break;
        }
    }
    const latitude = coordinate(gps.latitude ?? tags.latitude, 90);
    const longitude = coordinate(gps.longitude ?? tags.longitude, 180);
    const rawAltitude = number(gps.GPSAltitude ?? tags.GPSAltitude);
    const reference = altitudeReference(gps.GPSAltitudeRef ?? tags.GPSAltitudeRef);
    const altitudeMeters = rawAltitude === null ? null : reference ? Math.abs(rawAltitude) : rawAltitude;
    const make = text(firstTag(tags, ['ifd0', 'exif', 'xmp'], ['Make']), 160);
    const model = text(firstTag(tags, ['ifd0', 'exif', 'xmp'], ['Model']), 160);
    return {
        evidence: { ...evidence },
        summary: {
            capturedAtLocal: capturedLocal,
            capturedAtOffset: capturedOffset,
            latitude,
            longitude,
            altitudeMeters,
            altitudeReference: reference,
            make,
            model,
        },
        sections,
        notice: budget.truncated
            ? [notice, 'Some values were shortened to keep this view manageable.'].filter(Boolean).join(' ')
            : notice,
    };
}

async function readImagePrefix(bucket: R2Bucket, key: string, size: number) {
    const limit = Math.min(size, MAX_IMAGE_METADATA_BYTES);
    const object = await bucket.get(key, { range: { offset: 0, length: limit } });
    if (!object) return null;
    const reader = object.body.getReader();
    const bytes = new Uint8Array(limit);
    let length = 0;
    try {
        while (length < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            const take = Math.min(value.byteLength, limit - length);
            bytes.set(value.subarray(0, take), length);
            length += take;
            if (take < value.byteLength) break;
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    return { bytes: bytes.subarray(0, length), partial: size > length };
}

function noMetadataNotice(partial: boolean) {
    return partial
        ? `Only the first ${Math.floor(MAX_IMAGE_METADATA_BYTES / (1024 * 1024))} MB were read. No readable metadata was found in the part of this image that was checked.`
        : 'No readable image metadata was found.';
}

function appendCameraInputReport(response: ImageMetadataResponse, metadataJson: unknown) {
    let metadata = metadataJson;
    if (typeof metadataJson === 'string') {
        try {
            metadata = JSON.parse(metadataJson);
        } catch {
            return;
        }
    }
    if (!plainObject(metadata) || !plainObject(metadata.cameraCapture)) return;
    const report = metadata.cameraCapture;
    if (report.source !== 'camera-input') return;
    const entries: Array<{ name: string; value: string }> = [];
    const openedAt = text(report.openedAt, 80);
    const returnedAt = text(report.returnedAt, 80);
    const fileModifiedAt = text(report.fileModifiedAt, 80);
    if (openedAt) entries.push({ name: 'Camera picker opened (device-reported)', value: openedAt });
    if (returnedAt)
        entries.push({
            name: 'Photo returned from camera picker (unverified device time)',
            value: returnedAt,
        });
    if (fileModifiedAt) entries.push({ name: 'Device file time (unverified)', value: fileModifiedAt });
    if (entries.length) response.sections.push({ name: 'Camera input timing (unverified)', entries });
}

export async function handleImageMetadata(
    request: Request,
    env: ImageMetadataEnv,
    deps: ImageMetadataDeps,
): Promise<Response | null> {
    const match = new URL(request.url).pathname.match(/^\/api\/evidence\/([^/]+)\/metadata$/);
    if (!match) return null;
    if (request.method !== 'GET') return json({ error: 'This image metadata view only supports GET.' }, 405);

    const account = await deps.currentAccount(request, env);
    if (!account) return json({ error: 'Sign in to view image metadata.' }, 401);
    if (account.role !== 'admin')
        return json({ error: 'Administrator access is required to view image metadata.' }, 403);

    let evidenceId: string;
    try {
        evidenceId = decodeURIComponent(match[1]);
    } catch {
        return json({ error: 'Evidence not found.' }, 404);
    }
    const evidence = await env.DB.prepare(
        'SELECT id,object_key,filename,media_type,size,metadata_json FROM evidence WHERE id=?',
    )
        .bind(evidenceId)
        .first<EvidenceRow>();
    if (!evidence) return json({ error: 'Evidence not found.' }, 404);

    const publicEvidence = {
        id: evidence.id,
        filename: String(evidence.filename).slice(0, 255),
        mediaType: String(evidence.media_type).slice(0, 120),
        size: Math.max(0, Number(evidence.size) || 0),
    };
    if (!publicEvidence.mediaType.startsWith('image/')) {
        return json(
            imageMetadataResponse(publicEvidence, {}, 'No image metadata is available for this file.'),
        );
    }

    const file = await readImagePrefix(env.EVIDENCE, evidence.object_key, publicEvidence.size);
    if (!file) return json({ error: 'Evidence file not found.' }, 404);
    const notice = file.partial
        ? `Only the first ${Math.floor(MAX_IMAGE_METADATA_BYTES / (1024 * 1024))} MB were read. Metadata stored later in the file may not be shown.`
        : null;
    let tags: unknown = {};
    try {
        const parserOptions = {
            tiff: true,
            ifd1: true,
            exif: true,
            gps: true,
            interop: true,
            xmp: true,
            iptc: true,
            icc: true,
            jfif: true,
            ihdr: true,
            makerNote: true,
            userComment: true,
            multiSegment: true,
            mergeOutput: false,
            reviveValues: false,
            silentErrors: true,
            firstChunkSize: MAX_IMAGE_METADATA_BYTES,
            chunked: false,
        };
        tags = (await exifr.parse(file.bytes, parserOptions as Parameters<typeof exifr.parse>[1])) ?? {};
    } catch {
        const fallback = imageMetadataResponse(publicEvidence, {}, noMetadataNotice(file.partial));
        appendCameraInputReport(fallback, evidence.metadata_json);
        return json(fallback);
    }
    const parseNotice =
        plainObject(tags) && Array.isArray(tags.errors) && tags.errors.length > 0
            ? 'Some image metadata could not be read.'
            : null;
    const partialNotice = [parseNotice, notice].filter(Boolean).join(' ') || null;
    const response = imageMetadataResponse(publicEvidence, tags, partialNotice);
    appendCameraInputReport(response, evidence.metadata_json);
    if (
        !response.sections.length &&
        !response.summary.capturedAtLocal &&
        response.summary.latitude === null &&
        response.summary.longitude === null &&
        response.summary.make === null &&
        response.summary.model === null
    ) {
        response.notice = file.partial
            ? `${notice} No readable metadata was found in the part of this image that was checked.`
            : noMetadataNotice(false);
    }
    return json(response);
}
