import type { CameraCaptureReport } from '../../shared/types';

const reports = new WeakMap<File, CameraCaptureReport>();
const MAX_CAPTURE_WINDOW_MS = 2 * 60 * 60 * 1000;
const FILE_TIME_TOLERANCE_MS = 2 * 1000;

export function recordCapture(files: Iterable<File>, openedAtMs: number, returnedAtMs = Date.now()): void {
    const selectedFiles = Array.from(files);
    clearCaptures(selectedFiles);

    if (!Number.isFinite(openedAtMs) || !Number.isFinite(returnedAtMs)) return;
    if (returnedAtMs < openedAtMs || returnedAtMs - openedAtMs > MAX_CAPTURE_WINDOW_MS) return;
    const openedAt = new Date(openedAtMs);
    const returnedAt = new Date(returnedAtMs);
    if (!Number.isFinite(openedAt.getTime()) || !Number.isFinite(returnedAt.getTime())) return;

    for (const file of selectedFiles) {
        const modifiedAt = file.lastModified;
        const possibleMs =
            Number.isFinite(modifiedAt) &&
            modifiedAt >= openedAtMs - FILE_TIME_TOLERANCE_MS &&
            modifiedAt <= returnedAtMs + FILE_TIME_TOLERANCE_MS;
        const modifiedDate = possibleMs ? new Date(modifiedAt) : null;
        const fileModifiedAt =
            modifiedDate && Number.isFinite(modifiedDate.getTime()) ? modifiedDate.toISOString() : null;
        reports.set(file, {
            source: 'camera-input',
            openedAt: openedAt.toISOString(),
            returnedAt: returnedAt.toISOString(),
            fileModifiedAt,
        });
    }
}

export function getCapture(file: File): CameraCaptureReport | undefined {
    return reports.get(file);
}

export function clearCaptures(files: Iterable<File>): void {
    for (const file of files) reports.delete(file);
}
