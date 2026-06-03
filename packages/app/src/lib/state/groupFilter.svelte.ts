import * as storage from '../services/storage.js';

const LEGACY_STORAGE_KEY = 'globalGroupFilter';
const ACTIVE_PROVIDER_KEY = 'active-provider-id';

function storageKey(providerId: string): string {
    return `globalGroupFilter:${providerId || 'comix'}`;
}

function activeProviderId(): string {
    return storage.getString(ACTIVE_PROVIDER_KEY, 'comix');
}

export class GroupFilterState {
    groups = $state<{ groupId: string; groupName: string }[]>([]);
    private providerId = activeProviderId();
    private onChange: (() => void) | null = null;

    constructor() {
        this.groups = this.load(this.providerId);
    }

    private load(providerId: string): { groupId: string; groupName: string }[] {
        const scoped = storage.getJson<{ groupId: string; groupName: string }[]>(storageKey(providerId), []);
        if (scoped.length > 0 || providerId !== 'comix') return scoped;

        const legacy = storage.getJson<{ groupId: string; groupName: string }[]>(LEGACY_STORAGE_KEY, []);
        if (legacy.length > 0) storage.setJson(storageKey(providerId), legacy);
        return legacy;
    }

    setProvider(providerId: string): void {
        const next = providerId || 'comix';
        if (next === this.providerId) return;
        this.providerId = next;
        this.groups = this.load(next);
        this.onChange?.();
    }

    private persist() {
        storage.setJson(storageKey(this.providerId), this.groups);
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
        return `${this.providerId}:${this.groups.map(g => g.groupId).sort().join(',')}`;
    }

    get count(): number {
        return this.groups.length;
    }
}
