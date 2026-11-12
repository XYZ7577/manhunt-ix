import type { Evidence, SubmissionStatus } from '../../shared/types';

export function formatDate(value?: string | null) {
    if (!value) return '—';
    const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
    const parsedDate = new Date(!hasZone ? `${value}Z` : value);
    return Number.isNaN(parsedDate.getTime())
        ? value
        : `${parsedDate.toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'medium' })} SGT`;
}
export function submissionStatusLabel(status: SubmissionStatus) {
    return {
        draft: 'Draft',
        pending: 'Waiting for review',
        approved: 'Approved',
        changes_requested: 'Denied',
    }[status];
}
export function submissionStatusClass(status: SubmissionStatus) {
    return `status status-${status.replace('_', '-')}`;
}
export function isPreviewableImage(evidence: Evidence) {
    return evidence.mediaType.startsWith('image/') && !/heic|heif/i.test(evidence.mediaType);
}
