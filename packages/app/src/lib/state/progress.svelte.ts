import * as db from '../services/db.js';
import type { ProgressData } from '../services/db.js';

export type { ProgressData };

export class ProgressState {
    all = $state<Record<string, ProgressData>>({});
    private listeners = new Map<string, Set<(value: ProgressData | null) => void>>();

    async init() {
        this.all = await db.getAllProgress();
    }

    get(slug: string): ProgressData | null {
        return this.all[slug] ?? null;
    }

    update(slug: string, data: ProgressData) {
        this.all[slug] = data;
        this.notify(slug);
    }

    subscribe(slug: string, callback: (value: ProgressData | null) => void): () => void {
        let listeners = this.listeners.get(slug);
        if (!listeners) {
            listeners = new Set();
            this.listeners.set(slug, listeners);
        }
        listeners.add(callback);
        callback(this.get(slug));
        return () => {
            listeners?.delete(callback);
            if (listeners?.size === 0) this.listeners.delete(slug);
        };
    }

    private notify(slug: string): void {
        const listeners = this.listeners.get(slug);
        if (!listeners) return;
        const value = this.get(slug);
        for (const listener of listeners) listener(value);
    }
}
