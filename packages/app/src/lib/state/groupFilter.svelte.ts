import * as storage from '../services/storage.js';

const STORAGE_KEY = 'globalGroupFilter';

export class GroupFilterState {
    groups = $state<{ groupId: string; groupName: string }[]>([]);
    private onChange: (() => void) | null = null;

    constructor() {
        this.groups = storage.getJson<{ groupId: string; groupName: string }[]>(STORAGE_KEY, []);
    }

    private persist() {
        storage.setJson(STORAGE_KEY, this.groups);
    }

    setOnChange(fn: () => void): void {
        this.onChange = fn;
    }

    private changed(): void {
        this.persist();
        this.onChange?.();
    }

    add(groupId: string, groupName: string) {
        if (this.isFiltered(groupId)) return;
        this.groups = [...this.groups, { groupId, groupName }];
        this.changed();
    }

    remove(groupId: string) {
        this.groups = this.groups.filter(g => g.groupId !== groupId);
        this.changed();
    }

    clear() {
        this.groups = [];
        this.changed();
    }

    isFiltered(groupId: string): boolean {
        return this.groups.some(g => g.groupId === groupId);
    }

    get key(): string {
        return this.groups.map(g => g.groupId).sort().join(',');
    }

    get count(): number {
        return this.groups.length;
    }
}
