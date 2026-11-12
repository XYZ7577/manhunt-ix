import { useState } from 'react';
import type { Evidence, Submission, Task } from '../../shared/types';
import type { UploadSession } from '../../shared/evidence/uploads';
import { ActionButton } from '../ui/ActionButton';
import { EvidencePicker } from '../evidence/EvidencePicker';
import { EvidenceView } from '../evidence/EvidenceView';
import { DraftNoteEditor, useDraftNote } from './DraftNoteEditor';
import type { DraftNotes } from './draftNotes';
import type { UploadProgress } from '../app/types';
import { formatDate, submissionStatusClass, submissionStatusLabel } from '../app/presentation';

export function SubmissionCard({
    submission,
    editable,
    submissionsEnabled,
    blockedReason,
    submitBlockedReason,
    dead,
    draftNotes,
    task,
    uploadProgress,
    serverUploads,
    onUpload,
    onCancelUpload,
    onRemove,
    onSubmit,
    onCommentSaved,
    busy,
}: {
    submission: Submission;
    editable: boolean;
    submissionsEnabled: boolean;
    blockedReason?: string;
    submitBlockedReason?: string;
    dead: boolean;
    draftNotes: DraftNotes;
    task: Task;
    uploadProgress: Record<string, UploadProgress>;
    serverUploads: UploadSession[];
    onUpload: (files: FileList) => void;
    onCancelUpload: (uploadKey: string) => void;
    onRemove: (evidenceId: string) => void;
    onSubmit: () => void;
    onCommentSaved: (evidence: Evidence) => void;
    busy: boolean;
}) {
    const [commentEdits, setCommentEdits] = useState<Record<string, string | undefined>>({});
    const hasUnsavedComments = submission.evidence.some((file) => {
        const value = commentEdits[file.id];
        return value !== undefined && value.trim() !== (file.comment || '');
    });
    const legacyNote = useDraftNote(draftNotes, submission.id, submission.note, editable);
    const uploads = Object.entries(uploadProgress).filter(
        ([, upload]) => upload.submissionId === submission.id,
    );
    const hasUploads = uploads.length > 0 || serverUploads.length > 0;
    return (
        <div className="submission-card">
            <div className="submission-head">
                <div>
                    <strong>Attempt {submission.attempt}</strong>
                    <small>
                        {submission.submittedAt
                            ? `Submitted ${formatDate(submission.submittedAt)}`
                            : `Started ${formatDate(submission.createdAt)}`}
                    </small>
                </div>
                <span className={submissionStatusClass(submission.status)}>
                    {submissionStatusLabel(submission.status)}
                </span>
            </div>
            {submission.reviewNote && (
                <p className="review-reason">
                    <strong>Admin feedback:</strong> {submission.reviewNote}
                </p>
            )}
            {submission.evidence.length > 0 ? (
                <div className="evidence-list">
                    {submission.evidence.map((evidence) => (
                        <EvidenceView
                            key={evidence.id}
                            evidence={evidence}
                            editable={editable && !dead}
                            busy={busy}
                            onRemove={onRemove}
                            onCommentSaved={onCommentSaved}
                            editedComment={commentEdits[evidence.id]}
                            onEditComment={(evidenceId, value) =>
                                setCommentEdits((edits) => ({ ...edits, [evidenceId]: value }))
                            }
                        />
                    ))}
                </div>
            ) : (
                <p className="muted">No evidence uploaded yet.</p>
            )}
            {editable && (
                <div className="upload-controls">
                    <EvidencePicker
                        media={task.media}
                        multiple
                        disabled={busy || !submissionsEnabled}
                        disabledReason={
                            !submissionsEnabled
                                ? blockedReason || 'Submissions are paused.'
                                : 'Please wait for the current action to finish before adding evidence.'
                        }
                        queued={uploads.length > 0}
                        heading="Add evidence"
                        onSelect={onUpload}
                    />
                    {uploads.length > 0 && (
                        <p className="hint upload-queue-hint">
                            Two files upload at a time. You can keep adding files while they upload.
                        </p>
                    )}
                    {uploads.map(([uploadKey, upload]) => (
                        <div key={uploadKey} className="upload-progress">
                            <span title={upload.filename}>{upload.filename}</span>
                            <progress
                                aria-label={`Upload progress for ${upload.filename}`}
                                value={upload.percent}
                                max="100"
                            />
                            <small>
                                {upload.queued
                                    ? 'Queued'
                                    : upload.percent >= 99
                                      ? 'Finishing'
                                      : `${upload.percent}%`}
                            </small>
                            <ActionButton
                                type="button"
                                className="cancel-upload"
                                disabled={!upload.queued && upload.percent >= 99}
                                unavailableReason="This upload is finishing and can no longer be cancelled. Please wait for it to complete."
                                onClick={() => onCancelUpload(uploadKey)}
                                aria-label={`Cancel upload of ${upload.filename}`}
                            >
                                Cancel
                            </ActionButton>
                        </div>
                    ))}
                    {legacyNote.state !== 'saved' && (
                        <DraftNoteEditor
                            notes={draftNotes}
                            id={submission.id}
                            note={legacyNote}
                            serverNote={submission.note}
                            disabled={busy || dead}
                        />
                    )}
                    <ActionButton
                        className="button primary"
                        disabled={
                            busy ||
                            !!submitBlockedReason ||
                            !submissionsEnabled ||
                            hasUploads ||
                            hasUnsavedComments ||
                            legacyNote.state === 'conflict' ||
                            submission.evidence.length < task.minFiles
                        }
                        unavailableReason={
                            submitBlockedReason ||
                            (!submissionsEnabled
                                ? blockedReason || 'Submissions are paused.'
                                : busy
                                  ? 'Please wait for the current action to finish.'
                                  : hasUploads
                                    ? 'Wait for all uploads to finish, or cancel them, before sending for review.'
                                    : hasUnsavedComments
                                      ? 'Save or clear each upload comment before sending for review.'
                                      : legacyNote.state === 'conflict'
                                        ? 'Resolve the group note conflict before sending for review.'
                                        : `Add at least ${task.minFiles} evidence ${task.minFiles === 1 ? 'file' : 'files'} before sending for review.`)
                        }
                        onClick={onSubmit}
                    >
                        Send for admin review
                    </ActionButton>
                </div>
            )}
            {legacyNote.saved && (
                <p className="submission-note">
                    <strong>Group note</strong> {legacyNote.saved}
                </p>
            )}
        </div>
    );
}
