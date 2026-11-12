import type { CameraCaptureReport, MetadataResult } from '../../shared/types';

const MAX_REPORT_LENGTH = 1024;
const MAX_REPORT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CAPTURE_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const FILE_TIME_SKEW_MS = 2 * 1000;
const CANONICAL_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonicalMillis(value: unknown): number | null {
    if (typeof value !== 'string' || !CANONICAL_UTC_MILLIS.test(value)) return null;
    const millis = Date.parse(value);
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) return null;
    return millis;
}

export function parseCameraCapture(value: unknown, receivedAtMs = Date.now()): CameraCaptureReport | null {
    if (typeof value === 'string') {
        if (value.length > MAX_REPORT_LENGTH) return null;
        try {
            value = JSON.parse(value) as unknown;
        } catch {
            return null;
        }
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
        keys.length !== 4 ||
        keys.some((key) => !['source', 'openedAt', 'returnedAt', 'fileModifiedAt'].includes(key))
    )
        return null;
    if (record.source !== 'camera-input') return null;

    const openedMs = canonicalMillis(record.openedAt);
    const returnedMs = canonicalMillis(record.returnedAt);
    if (openedMs === null || returnedMs === null || !Number.isFinite(receivedAtMs)) return null;
    if (openedMs > returnedMs || returnedMs - openedMs > MAX_CAPTURE_WINDOW_MS) return null;
    if (returnedMs > receivedAtMs + MAX_FUTURE_SKEW_MS || returnedMs < receivedAtMs - MAX_REPORT_AGE_MS)
        return null;

    let fileModifiedAt: string | null = null;
    const modifiedMs = canonicalMillis(record.fileModifiedAt);
    if (
        modifiedMs !== null &&
        modifiedMs >= openedMs - FILE_TIME_SKEW_MS &&
        modifiedMs <= returnedMs + FILE_TIME_SKEW_MS
    ) {
        fileModifiedAt = record.fileModifiedAt as string;
    }

    return {
        source: 'camera-input',
        openedAt: record.openedAt as string,
        returnedAt: record.returnedAt as string,
        fileModifiedAt,
    };
}

export function withCameraCapture(
    metadata: MetadataResult,
    capture: CameraCaptureReport | null,
): MetadataResult {
    if (!capture) return metadata;
    const flags = [...metadata.flags];
    if (
        !metadata.capturedAt &&
        !flags.some(
            (flag) =>
                flag ===
                'Camera input timing is device-reported and unverified; it does not prove when the photo was taken.',
        )
    ) {
        flags.push(
            'Camera input timing is device-reported and unverified; it does not prove when the photo was taken.',
        );
    }
    return { ...metadata, flags, cameraCapture: capture };
}
