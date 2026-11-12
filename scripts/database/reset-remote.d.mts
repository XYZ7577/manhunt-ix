import type { R2ResetBucket, MultipartUpload, ResetProgress } from './reset-r2.mjs';

export type RemoteResetConnection = {
    bucket: R2ResetBucket;
    dispose(): Promise<void>;
};

export function connectRemoteR2(
    options: {
        root: string;
        bucketName: string;
        accountId?: string;
        compatibilityDate?: string;
        jurisdiction?: string;
    },
    platformFactory?: (options: Record<string, unknown>) => Promise<{
        env: { EVIDENCE: R2ResetBucket };
        dispose(): Promise<void>;
    }>,
): Promise<RemoteResetConnection>;

export function runRemoteReset(options: {
    keepR2?: boolean;
    connectBucket(): Promise<RemoteResetConnection>;
    backup(): Promise<void>;
    loadMultipartUploads(): Promise<MultipartUpload[]>;
    resetDatabase(): Promise<void>;
    verifyDatabase(): Promise<void>;
    onProgress?: (progress: ResetProgress) => void;
}): Promise<void>;
