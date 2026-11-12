export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const DIRECT_UPLOAD_MAX_BYTES = UPLOAD_PART_BYTES;
export const MAX_FILES_PER_SUBMISSION = 10;
export const EVIDENCE_COMMENT_MAX_LENGTH = 1000;

export interface UploadSession {
    id: string;
    submissionId: string;
    filename: string;
    comment?: string;
    size: number;
    slot?: string | null;
    partSize: number;
    partCount: number;
    state: 'creating' | 'uploading' | 'completing' | 'completed' | 'aborted' | 'expired';
    parts: { partNumber: number; etag: string; size: number; sha256: string }[];
    evidenceId: string | null;
    expiresAt: string;
}
