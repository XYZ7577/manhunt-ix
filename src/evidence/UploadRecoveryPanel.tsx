import type { UploadSession } from '../../shared/evidence/uploads';
import { ActionButton } from '../ui/ActionButton';

export function UploadRecoveryPanel({
    uploads,
    busy,
    submissionsEnabled,
    blockedReason,
    onFinish,
    onResume,
    onCancel,
}: {
    uploads: UploadSession[];
    busy: boolean;
    submissionsEnabled: boolean;
    blockedReason?: string;
    onFinish: (upload: UploadSession) => void;
    onResume: (upload: UploadSession, file: File) => void;
    onCancel: (upload: UploadSession) => void;
}) {
    if (uploads.length === 0) return null;
    return (
        <section className="upload-recovery" aria-label="Unfinished uploads">
            <h3>Unfinished uploads</h3>
            <p>
                Reselect the original file to continue from its received parts. If every part has arrived,
                finish the upload directly.
            </p>
            {uploads.map((upload) => {
                const received = upload.parts.reduce((sum, part) => sum + part.size, 0);
                const progress = Math.min(100, Math.round((received / Math.max(upload.size, 1)) * 100));
                const ready =
                    upload.state === 'completing' ||
                    upload.state === 'completed' ||
                    (upload.state === 'uploading' && upload.parts.length >= upload.partCount);
                const status = ready
                    ? 'All parts received · ready to finish.'
                    : `${upload.parts.length} of ${upload.partCount} parts received · select the original file to resume.`;
                return (
                    <div className="recovery-upload" key={upload.id}>
                        <div className="recovery-file">
                            <strong title={upload.filename}>{upload.filename}</strong>
                            <small>
                                {(upload.size / (1024 * 1024)).toFixed(1)} MB · {status}
                            </small>
                        </div>
                        <progress value={progress} max="100" />
                        <div className="recovery-actions">
                            {!ready && upload.state === 'uploading' && (
                                <label className="button secondary small-button resume-upload-picker">
                                    <input
                                        type="file"
                                        aria-label={`Select original file to resume ${upload.filename}`}
                                        disabled={busy || !submissionsEnabled}
                                        onChange={(event) => {
                                            const file = event.currentTarget.files?.[0];
                                            if (file) onResume(upload, file);
                                            event.currentTarget.value = '';
                                        }}
                                    />
                                    Resume upload
                                </label>
                            )}
                            {ready && (
                                <ActionButton
                                    className="button primary small-button"
                                    disabled={busy || !submissionsEnabled}
                                    unavailableReason={
                                        !submissionsEnabled
                                            ? blockedReason || 'Submissions are paused.'
                                            : 'Please wait for the current action to finish.'
                                    }
                                    onClick={() => onFinish(upload)}
                                >
                                    Finish upload
                                </ActionButton>
                            )}
                            <ActionButton
                                className="button secondary small-button"
                                disabled={busy}
                                unavailableReason="Please wait for the current action to finish."
                                onClick={() => onCancel(upload)}
                            >
                                Cancel upload
                            </ActionButton>
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
