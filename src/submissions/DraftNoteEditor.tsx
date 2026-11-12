import { useEffect, useSyncExternalStore } from 'react';
import { ActionButton } from '../ui/ActionButton';
import { DraftNotes } from './draftNotes';
import './draftNotes.css';

export function useDraftNote(notes: DraftNotes, id: string, serverNote: string, enabled = true) {
    useSyncExternalStore(notes.subscribe, notes.getSnapshot, notes.getSnapshot);
    const draft = enabled
        ? notes.read(id, serverNote)
        : { note: serverNote, saved: serverNote, state: 'saved' as const, message: '', cached: false };
    useEffect(() => {
        if (enabled) notes.sync(id, serverNote);
        else notes.clear(id);
    }, [notes, id, serverNote, enabled]);
    return draft;
}

export function DraftNoteEditor({
    notes,
    id,
    note,
    serverNote,
    disabled,
}: {
    notes: DraftNotes;
    id: string;
    note: ReturnType<DraftNotes['read']>;
    serverNote: string;
    disabled: boolean;
}) {
    return (
        <div className="draft-note-editor">
            <label className="submission-note-input">
                Note for organisers (optional)
                <textarea
                    rows={2}
                    maxLength={2000}
                    value={note.note}
                    disabled={disabled}
                    onChange={(event) => notes.edit(id, serverNote, event.target.value)}
                    placeholder="Anything the organisers should know about this evidence?"
                />
            </label>
            <p className={`draft-save-status draft-save-${note.state}`} role="status">
                {note.state === 'saved'
                    ? 'Saved'
                    : note.state === 'saving'
                      ? 'Saving…'
                      : note.state === 'unsaved'
                        ? 'Unsaved changes…'
                        : note.state === 'conflict'
                          ? note.message ||
                            'Another group member changed this note. Choose which version to keep.'
                          : `${note.message || 'Could not save yet.'} ${note.cached ? 'Your note is kept in this tab.' : 'Keep this page open until it saves.'}`}
            </p>
            {note.state === 'error' && (
                <button
                    type="button"
                    className="text-button"
                    onClick={() => void notes.flush(id).catch(() => {})}
                >
                    Retry saving
                </button>
            )}
            {note.state === 'conflict' && note.remote !== undefined && (
                <div className="draft-conflict">
                    <p>
                        <strong>Currently saved note:</strong>
                    </p>
                    <p className="draft-remote-note">{note.remote || '(Empty note)'}</p>
                    <div>
                        <ActionButton
                            type="button"
                            className="button secondary small-button"
                            disabled={disabled}
                            onClick={() => notes.resolve(id, false)}
                        >
                            Use saved note
                        </ActionButton>
                        <ActionButton
                            type="button"
                            className="button secondary small-button"
                            disabled={disabled}
                            onClick={() => notes.resolve(id, true)}
                        >
                            Save my note
                        </ActionButton>
                    </div>
                </div>
            )}
        </div>
    );
}
