import { useState } from 'react';
import type { Submission, Task } from '../../shared/types';
import { ActionButton } from '../ui/ActionButton';
import { EvidenceView } from '../evidence/EvidenceView';
import { formatDate, submissionStatusClass, submissionStatusLabel } from '../app/presentation';

export function AdminSubmission({
    submission,
    task,
    group,
    note,
    setNote,
    onReview,
    canEditFeedback,
    canToggleDecision,
    hasNewerAttempt,
    onToggleDecision,
    onSaveFeedback,
    busy,
}: {
    submission: Submission;
    task?: Task;
    group?: { name: string; members: string[] };
    note: string;
    setNote: (value: string) => void;
    onReview: (decision: 'approved' | 'changes_requested') => void;
    canEditFeedback: boolean;
    canToggleDecision: boolean;
    hasNewerAttempt: boolean;
    onToggleDecision: () => void;
    onSaveFeedback: (note: string, previousNote: string | null) => Promise<boolean>;
    busy: boolean;
}) {
    const [editingFeedback, setEditingFeedback] = useState(false);
    const [feedbackDraft, setFeedbackDraft] = useState('');
    const [previousNote, setPreviousNote] = useState<string | null>(null);
    function beginEdit() {
        const snapshot = submission.reviewNote;
        setPreviousNote(snapshot);
        setFeedbackDraft(snapshot || '');
        setEditingFeedback(true);
    }
    async function saveFeedback() {
        if (submission.status === 'changes_requested' && !feedbackDraft.trim()) return;
        if (await onSaveFeedback(feedbackDraft.trim(), previousNote)) setEditingFeedback(false);
    }
    const saving = busy && editingFeedback;
    const nextDecision = submission.status === 'approved' ? 'Denied' : 'Approved';
    return (
        <article className="admin-card">
            <div className="admin-head">
                <div>
                    <h2>
                        {group?.name || 'Group'} <span>·</span> {task?.title || 'Unknown task'}
                    </h2>
                    <p>{group?.members?.join(', ') || 'Group roster unavailable'}</p>
                </div>
                {canToggleDecision ? (
                    <div className="approval-control">
                        <span>Approval status</span>
                        <ActionButton
                            type="button"
                            className={`decision-toggle ${submissionStatusClass(submission.status)}`}
                            disabled={busy || editingFeedback}
                            unavailableReason={
                                busy
                                    ? 'Please wait for the current action to finish.'
                                    : 'Save or cancel your feedback edit before changing the approval status.'
                            }
                            onClick={onToggleDecision}
                            aria-label={`${submissionStatusLabel(submission.status)}. Change to ${nextDecision}`}
                        >
                            <strong>{submissionStatusLabel(submission.status)}</strong>
                            <span>Change to {nextDecision} ↔</span>
                        </ActionButton>
                    </div>
                ) : (
                    <span className={submissionStatusClass(submission.status)}>
                        {submissionStatusLabel(submission.status)}
                    </span>
                )}
            </div>
            {hasNewerAttempt && (
                <p className="decision-history-hint">A newer attempt exists; review the latest attempt.</p>
            )}
            <div className="admin-meta">
                <span>Attempt {submission.attempt}</span>
                <span>Uploaded for review {formatDate(submission.submittedAt)}</span>
                <span>Draft started {formatDate(submission.createdAt)}</span>
            </div>
            {task && (
                <div className="admin-requirements">
                    <strong>Requirements</strong>
                    <ul>
                        {task.requirements.map((requirement) => (
                            <li key={requirement}>{requirement}</li>
                        ))}
                    </ul>
                </div>
            )}
            <div className="evidence-list">
                {submission.evidence.map((evidence) => (
                    <EvidenceView
                        key={evidence.id}
                        evidence={evidence}
                        editable={false}
                        verifyOriginal
                        onRemove={() => {}}
                    />
                ))}
            </div>
            {submission.note && (
                <p className="submission-note">
                    <strong>Group note:</strong> {submission.note}
                </p>
            )}
            {submission.reviewNote && (
                <p className="review-reason">
                    <strong>Reviewed feedback:</strong> {submission.reviewNote}
                </p>
            )}
            {canEditFeedback &&
                (editingFeedback ? (
                    <div className="admin-decision feedback-editor">
                        <label>
                            Feedback for group
                            <textarea
                                rows={3}
                                maxLength={2000}
                                value={feedbackDraft}
                                onChange={(event) => setFeedbackDraft(event.target.value)}
                            />
                        </label>
                        <div className="decision-buttons">
                            <ActionButton
                                className="button primary"
                                disabled={
                                    saving ||
                                    (submission.status === 'changes_requested' && !feedbackDraft.trim())
                                }
                                unavailableReason={
                                    saving
                                        ? 'Feedback is being saved. Please wait.'
                                        : 'Add feedback explaining why the evidence was denied before saving.'
                                }
                                onClick={saveFeedback}
                            >
                                Save feedback
                            </ActionButton>
                            <ActionButton
                                className="button secondary"
                                disabled={saving}
                                unavailableReason="Feedback is being saved. Please wait."
                                onClick={() => setEditingFeedback(false)}
                            >
                                Cancel
                            </ActionButton>
                        </div>
                    </div>
                ) : (
                    <ActionButton className="text-button feedback-edit" onClick={beginEdit}>
                        Edit feedback
                    </ActionButton>
                ))}
            {submission.status === 'pending' && (
                <div className="admin-decision">
                    <label>
                        Feedback
                        <textarea
                            rows={2}
                            maxLength={2000}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder="Explain what needs to change (required to deny)."
                        />
                    </label>
                    <div className="decision-buttons">
                        <ActionButton
                            className="button primary"
                            disabled={busy}
                            unavailableReason="Please wait for the current action to finish."
                            onClick={() => onReview('approved')}
                        >
                            Approve
                        </ActionButton>
                        <ActionButton
                            className="button secondary danger"
                            disabled={busy || !note.trim()}
                            unavailableReason={
                                busy
                                    ? 'Please wait for the current review to finish.'
                                    : 'Add feedback explaining what needs to change before denying this submission.'
                            }
                            onClick={() => onReview('changes_requested')}
                        >
                            Deny
                        </ActionButton>
                    </div>
                </div>
            )}
        </article>
    );
}
