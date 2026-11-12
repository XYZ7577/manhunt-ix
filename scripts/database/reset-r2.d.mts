export type R2ListingPage = {
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
};

export type R2ResetBucket = {
    list(options: { limit: number; cursor?: string }): Promise<R2ListingPage>;
    delete(keys: string[]): Promise<unknown>;
    resumeMultipartUpload(objectKey: string, uploadId: string): { abort(): Promise<unknown> };
};

export type MultipartUpload = {
    object_key: string;
    multipart_upload_id: string;
};

export type ResetProgress = {
    stage: 'objects-deleted' | 'multipart-uploads-aborted' | 'empty';
    count: number;
};

export function preflightR2Bucket(
    bucket: R2ResetBucket,
): Promise<{ objectCount: number; truncated: boolean }>;

export function emptyR2Bucket(
    bucket: R2ResetBucket,
    options?: {
        multipartUploads?: MultipartUpload[];
        onProgress?: (progress: ResetProgress) => void;
    },
): Promise<void>;
