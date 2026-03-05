import * as storage from '../services/storage.js';

const STORAGE_KEY = 'globalGroupFilter';

export class GroupFilterState {
    groups = $state<{ groupId: string; groupName: string }[]>([]);
    showFiltered = $state(false);

    constructor() {
        this.groups = storage.getJson<{ groupId: string; groupName: string }[]>(STORAGE_KEY, []);
    }

    private persist() {
        storage.setJson(STORAGE_KEY, this.groups);
    }

    add(groupId: string, groupName: string) {
        if (this.isFiltered(groupId)) return;
        this.groups = [...this.groups, { groupId, groupName }];
        this.persist();
    }

    remove(groupId: string) {
        this.groups = this.groups.filter(g => g.groupId !== groupId);
        this.persist();
    }

    clear() {
        this.groups = [];
        this.persist();
    }

    isFiltered(groupId: string): boolean {
        return this.groups.some(g => g.groupId === groupId);
    }

    get count(): number {
        return this.groups.length;
    }
}
