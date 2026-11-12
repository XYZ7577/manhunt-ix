import { useState } from 'react';
import type { Evidence } from '../../shared/types';
import { EVIDENCE_COMMENT_MAX_LENGTH } from '../../shared/evidence/uploads';
import { ActionButton } from '../ui/ActionButton';
import { EvidencePreview } from './EvidencePicker';
import { ImageMetadata } from './ImageMetadata';
import { EvidenceVideo } from './EvidenceVideo';
import { formatEvidenceSize } from './evidenceMediaPolicy';
import { api } from '../app/api';
import { formatDate, isPreviewableImage } from '../app/presentation';
import './evidenceMedia.css';

export function EvidenceView({
    evidence,
    editable,
    onRemove,
    onCommentSaved,
    editedComment,
    onEditComment,
    verifyOriginal = false,
    busy = false,
}: {
    evidence: Evidence;
    editable: boolean;
    onRemove: (evidenceId: string) => void;
    onCommentSaved?: (evidence: Evidence) => void;
    editedComment?: string;
    onEditComment?: (evidenceId: string, value?: string) => void;
    verifyOriginal?: boolean;
    busy?: boolean;
}) {
    const [savingComment, setSavingComment] = useState(false);
    const [commentError, setCommentError] = useState('');
    const savedComment = evidence.comment || '';
    const comment = editedComment ?? savedComment;

    async function saveComment() {
        setSavingComment(true);
        setCommentError('');
        try {
            const result = await api<{ evidence: Evidence }>(
                `/api/evidence/${encodeURIComponent(evidence.id)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ comment: comment.trim() }),
                },
            );
            onCommentSaved?.(result.evidence);
            onEditComment?.(evidence.id);
        } catch (error) {
            setCommentError(error instanceof Error ? error.message : 'Could not save this comment.');
        } finally {
            setSavingComment(false);
        }
    }
    const previewUrl = verifyOriginal ? undefined : evidence.previewUrl;
    return (
        <article className="evidence-item">
            <div className="evidence-preview">
                {isPreviewableImage(evidence) ? (
                    <EvidencePreview
                        key={previewUrl || evidence.url}
                        src={previewUrl || evidence.url}
                        originalUrl={evidence.url}
                        size={evidence.size}
                        alt={`Uploaded evidence: ${evidence.filename}`}
                    />
                ) : evidence.mediaType.startsWith('video/') ? (
                    <EvidenceVideo src={evidence.url} filename={evidence.filename} size={evidence.size} />
                ) : (
                    <a className="file-fallback" href={evidence.url} target="_blank" rel="noreferrer">
                        FILE
                    </a>
                )}
            </div>
            <div className="evidence-info">
                <strong title={evidence.filename}>{evidence.filename}</strong>
                <small>
                    {formatEvidenceSize(evidence.size)} · Received {formatDate(evidence.uploadedAt)}
                </small>
                {previewUrl && <small>Small preview · open the original to inspect full detail</small>}
                {evidence.slot && <small>{evidence.slot}</small>}
                {savedComment && !editable && <p className="evidence-comment">{savedComment}</p>}
                {editable && (
                    <div className="evidence-comment-editor">
                        <label>
                            Comment <span>Optional</span>
                            <textarea
                                aria-label={`Optional comment for ${evidence.filename}`}
                                rows={2}
                                maxLength={EVIDENCE_COMMENT_MAX_LENGTH}
                                value={comment}
                                disabled={busy || savingComment}
                                onChange={(event) => onEditComment?.(evidence.id, event.target.value)}
                            />
                        </label>
                        <ActionButton
                            type="button"
                            className="button secondary small-button"
                            disabled={busy || savingComment || comment.trim() === savedComment}
                            unavailableReason={
                                savingComment
                                    ? 'Saving this comment.'
                                    : busy
                                      ? 'Please wait for the current action to finish.'
                                      : 'There are no comment changes to save.'
                            }
                            onClick={() => void saveComment()}
                        >
                            {savingComment ? 'Saving…' : 'Save comment'}
                        </ActionButton>
                        {commentError && <small role="alert">{commentError}</small>}
                    </div>
                )}
                {evidence.mediaType.startsWith('image/') && (
                    <ImageMetadata key={evidence.id} evidenceId={evidence.id} enabled={verifyOriginal} />
                )}
                <a className="original-link" href={evidence.url} target="_blank" rel="noreferrer">
                    Open or download original
                </a>
            </div>
            {editable && (
                <ActionButton
                    className="icon-button remove-button"
                    disabled={busy || savingComment}
                    onClick={() => onRemove(evidence.id)}
                    aria-label={`Remove ${evidence.filename}`}
                >
                    Remove
                </ActionButton>
            )}
        </article>
    );
}
