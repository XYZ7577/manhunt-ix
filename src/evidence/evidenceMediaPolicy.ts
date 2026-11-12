const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const GIBIBYTE = MEBIBYTE * KIBIBYTE;

export function formatEvidenceSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'Size unavailable';
    if (bytes < KIBIBYTE) return `${Math.round(bytes)} B`;
    if (bytes < MEBIBYTE) return `${(bytes / KIBIBYTE).toFixed(1)} KB`;
    if (bytes < GIBIBYTE) return `${(bytes / MEBIBYTE).toFixed(1)} MB`;
    return `${(bytes / GIBIBYTE).toFixed(1)} GB`;
}

export function isValidEvidenceSize(bytes: number): boolean {
    return Number.isFinite(bytes) && bytes >= 0;
}

const ORIGINAL_IMAGE_DEFER_THRESHOLD = 32 * MEBIBYTE;

export function shouldDeferOriginalImage(src: string, originalUrl: string, size: number): boolean {
    return src === originalUrl && Number.isFinite(size) && size > ORIGINAL_IMAGE_DEFER_THRESHOLD;
}
