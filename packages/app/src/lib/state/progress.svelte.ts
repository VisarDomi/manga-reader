import * as db from '../services/db.js';
import type { ProgressData } from '../services/db.js';

export type { ProgressData };

export class ProgressState {
    all = $state<Record<string, ProgressData>>({});

    async init() {
        this.all = await db.getAllProgress();
    }

    get(slug: string): ProgressData | null {
        return this.all[slug] ?? null;
    }

    update(slug: string, data: ProgressData) {
        this.all[slug] = data;
    }
}
