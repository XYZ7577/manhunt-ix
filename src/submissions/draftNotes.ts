export type DraftSaveState = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';
export type DraftNote = {
    note: string;
    saved: string;
    state: DraftSaveState;
    message: string;
    remote?: string;
    cached: boolean;
};
export class DraftNoteConflict extends Error {
    constructor(
        message: string,
        readonly remote?: string,
    ) {
        super(message);
    }
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Entry = DraftNote & {
    serverSnapshot: string;
    timer?: ReturnType<typeof setTimeout>;
    pending?: Promise<void>;
};

export class DraftNotes {
    private entries = new Map<string, Entry>();
    private listeners = new Set<() => void>();
    private version = 0;
    private disposed = false;
    constructor(
        private accountId: string,
        private save: (id: string, note: string, previousNote: string) => Promise<void>,
        private storage?: StorageLike,
        private delay = 600,
    ) {}
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    getSnapshot = () => this.version;
    private emit() {
        this.version++;
        this.listeners.forEach((listener) => listener());
    }
    private currentState(id: string) {
        return this.entries.get(id)?.state;
    }
    private key(id: string) {
        return `manhunt_draft_note:${this.accountId}:${id}`;
    }
    private cache(id: string, entry: Entry) {
        try {
            if (entry.note === entry.saved && entry.state !== 'conflict') {
                this.storage?.removeItem(this.key(id));
                entry.cached = false;
            } else {
                this.storage?.setItem(this.key(id), JSON.stringify({ note: entry.note, saved: entry.saved }));
                entry.cached = !!this.storage;
            }
        } catch {
            entry.cached = false;
        }
    }
    read(id: string, serverNote: string): DraftNote {
        let entry = this.entries.get(id);
        if (!entry) {
            entry = {
                note: serverNote,
                saved: serverNote,
                serverSnapshot: serverNote,
                state: 'saved',
                message: '',
                cached: false,
            };
            try {
                const cached = JSON.parse(this.storage?.getItem(this.key(id)) || 'null');
                if (
                    cached &&
                    typeof cached.note === 'string' &&
                    cached.note.length <= 2000 &&
                    typeof cached.saved === 'string' &&
                    cached.saved.length <= 2000 &&
                    cached.note !== serverNote
                ) {
                    entry = {
                        note: cached.note,
                        saved: cached.saved,
                        serverSnapshot: serverNote,
                        state: cached.saved === serverNote ? 'unsaved' : 'conflict',
                        message: '',
                        remote: cached.saved === serverNote ? undefined : serverNote,
                        cached: true,
                    };
                }
            } catch {}
            this.entries.set(id, entry);
        }
        return entry;
    }
    sync(id: string, serverNote: string) {
        const entry = this.read(id, serverNote) as Entry;
        if (entry.serverSnapshot === serverNote) {
            if (entry.state === 'unsaved' && !entry.timer && !entry.pending) this.schedule(id, entry);
            return;
        }
        entry.serverSnapshot = serverNote;
        if (entry.state === 'saved') {
            entry.note = entry.saved = serverNote;
            entry.remote = undefined;
            entry.message = '';
            this.cache(id, entry);
            this.emit();
        } else if (entry.state === 'unsaved' || entry.state === 'saving' || entry.state === 'error') {
            if (serverNote === entry.note) {
                entry.note = entry.saved = serverNote;
                entry.state = 'saved';
                entry.remote = undefined;
                entry.message = '';
                this.cache(id, entry);
                this.emit();
            } else if (serverNote !== entry.saved) {
                entry.state = 'conflict';
                entry.remote = serverNote;
                entry.message = 'Another group member changed this note. Choose which version to keep.';
                this.cache(id, entry);
                this.emit();
            }
        } else if (entry.state === 'conflict') {
            if (serverNote === entry.note) {
                entry.note = entry.saved = serverNote;
                entry.state = 'saved';
                entry.remote = undefined;
                entry.message = '';
            } else {
                entry.remote = serverNote;
                entry.message = 'Another group member changed this note. Choose which version to keep.';
            }
            this.cache(id, entry);
            this.emit();
        }
    }
    edit(id: string, serverNote: string, note: string) {
        const entry = this.read(id, serverNote) as Entry;
        entry.note = note;
        if (entry.state !== 'conflict')
            entry.state = note === entry.saved && !entry.pending ? 'saved' : 'unsaved';
        entry.message = '';
        this.cache(id, entry);
        this.emit();
        if (entry.state !== 'conflict') this.schedule(id, entry);
    }
    private schedule(id: string, entry: Entry) {
        if (entry.timer) clearTimeout(entry.timer);
        if (!this.disposed && entry.state !== 'saved')
            entry.timer = setTimeout(() => {
                entry.timer = undefined;
                void this.flush(id).catch(() => {});
            }, this.delay);
    }
    async flush(id: string): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry || this.disposed) return;
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
        }
        if (entry.pending) {
            await entry.pending;
            return this.flush(id);
        }
        if (entry.state === 'conflict') throw new Error('Choose which draft note to keep before submitting.');
        if (entry.note === entry.saved) {
            entry.state = 'saved';
            this.cache(id, entry);
            this.emit();
            return;
        }
        const note = entry.note,
            previous = entry.saved;
        entry.state = 'saving';
        this.emit();
        entry.pending = this.save(id, note, previous)
            .then(() => {
                entry.saved = note;
                if (entry.state !== 'conflict') {
                    entry.state = entry.note === note ? 'saved' : 'unsaved';
                    entry.message = '';
                    entry.remote = undefined;
                }
                this.cache(id, entry);
            })
            .catch((error: unknown) => {
                entry.state = error instanceof DraftNoteConflict ? 'conflict' : 'error';
                entry.message = error instanceof Error ? error.message : 'Could not save your draft note.';
                if (error instanceof DraftNoteConflict) entry.remote = error.remote;
                this.cache(id, entry);
                throw error;
            })
            .finally(() => {
                entry.pending = undefined;
                this.emit();
            });
        await entry.pending;
        if (this.currentState(id) === 'conflict')
            throw new DraftNoteConflict(
                entry.message || 'Choose which draft note to keep before submitting.',
                entry.remote,
            );
        if (this.entries.get(id)?.state === 'unsaved') await this.flush(id);
    }
    resolve(id: string, keepMine: boolean) {
        const entry = this.entries.get(id);
        if (!entry || entry.remote === undefined) return;
        if (entry.pending) {
            void entry.pending.then(
                () => this.resolve(id, keepMine),
                () => this.resolve(id, keepMine),
            );
            return;
        }
        entry.saved = entry.remote;
        if (!keepMine) entry.note = entry.remote;
        entry.remote = undefined;
        entry.message = '';
        entry.state = entry.note === entry.saved ? 'saved' : 'unsaved';
        this.cache(id, entry);
        this.emit();
        if (keepMine) void this.flush(id).catch(() => {});
    }
    hasUnsaved() {
        return [...this.entries.values()].some(
            (entry) => entry.note !== entry.saved || !!entry.pending || entry.state === 'conflict',
        );
    }
    retry() {
        for (const [id, entry] of this.entries)
            if (entry.state === 'error' || entry.state === 'unsaved') void this.flush(id).catch(() => {});
    }
    activate() {
        this.disposed = false;
        this.retry();
    }
    clear(id: string) {
        const entry = this.entries.get(id);
        if (entry?.timer) clearTimeout(entry.timer);
        this.entries.delete(id);
        try {
            this.storage?.removeItem(this.key(id));
        } catch {}
        this.emit();
    }
    dispose() {
        this.disposed = true;
        for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    }
}
