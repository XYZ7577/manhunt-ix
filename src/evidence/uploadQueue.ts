type QueueEntry = {
    key: string;
    run: () => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
    started: boolean;
};

export class UploadQueue {
    readonly #concurrency: number;
    readonly #entries: QueueEntry[] = [];
    readonly #byKey = new Map<string, QueueEntry>();
    #active = 0;
    #scheduled = false;

    constructor(concurrency: number) {
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new RangeError('Upload concurrency must be a positive integer.');
        }
        this.#concurrency = Math.min(2, concurrency);
    }

    enqueue(key: string, run: () => Promise<void>): Promise<void> {
        if (this.#byKey.has(key)) {
            return Promise.reject(new Error(`An upload with key "${key}" is already queued or running.`));
        }

        return new Promise<void>((resolve, reject) => {
            const entry: QueueEntry = { key, run, resolve, reject, started: false };
            this.#byKey.set(key, entry);
            this.#entries.push(entry);
            this.#schedule();
        });
    }

    cancelQueued(key: string): boolean {
        const entry = this.#byKey.get(key);
        if (!entry || entry.started) return false;

        const index = this.#entries.indexOf(entry);
        if (index === -1) return false;
        this.#entries.splice(index, 1);
        this.#byKey.delete(key);
        entry.reject(new Error('Upload cancelled.'));
        this.#schedule();
        return true;
    }

    #schedule(): void {
        if (this.#scheduled) return;
        this.#scheduled = true;
        queueMicrotask(() => {
            this.#scheduled = false;
            while (this.#active < this.#concurrency && this.#entries.length > 0) {
                const entry = this.#entries.shift()!;
                entry.started = true;
                this.#active += 1;
                void this.#run(entry);
            }
        });
    }

    async #run(entry: QueueEntry): Promise<void> {
        try {
            await entry.run();
            entry.resolve();
        } catch (error) {
            entry.reject(error);
        } finally {
            this.#active -= 1;
            if (this.#byKey.get(entry.key) === entry) this.#byKey.delete(entry.key);
            this.#schedule();
        }
    }
}
