import type { ViewMode } from '../types.js';
import type { LogEmit } from '../services/LogService.js';
import { View } from '../logic.js';

export type RestoreLayer =
    | { view: ViewMode; entryKey?: undefined }
    | { view: typeof View.MANGA; entryKey: string };

export class UIState {
    viewMode = $state<ViewMode>(View.LIST);
    viewStack = $state<ViewMode[]>([]);
    restoreMountedLayers = $state<RestoreLayer[] | null>(null);
    listViewGeneration = $state(0);
    mangaListScrolls: Record<string, number> = {};
    swipeProgress = $state(0);
    isSwiping = $state(false);
    swipeAnimating = $state(false);
    forwardSwipeProgress = $state(0);
    isForwardSwiping = $state(false);
    forwardSwipeAnimating = $state(false);
    filtersExpanded = $state(false);

    onViewChange: (() => void) | null = null;
    private emit: LogEmit;

    constructor(emit: LogEmit) {
        this.emit = emit;
    }

    pushView(mode: ViewMode) {
        this.finishRestoreWork();
        const from = this.viewMode;
        this.viewStack = [...this.viewStack, this.viewMode];
        this.viewMode = mode;
        if (mode === View.LIST) this.listViewGeneration++;
        this.emit('view-push', { from, to: mode });
        this.onViewChange?.();
    }

    popView() {
        this.finishRestoreWork();
        const stack = this.viewStack;
        if (stack.length === 0) return;
        const from = this.viewMode;
        const prev = stack[stack.length - 1];
        this.viewStack = stack.slice(0, -1);
        this.viewMode = prev;
        if (prev === View.LIST) this.listViewGeneration++;
        this.emit('view-pop', { from, to: prev });
        this.onViewChange?.();
    }

    peekBack(): ViewMode {
        return this.viewStack[this.viewStack.length - 1] ?? View.LIST;
    }

    canGoBack(): boolean {
        return this.viewStack.length > 0;
    }

    resetTo(mode: ViewMode) {
        this.finishRestoreWork();
        this.viewStack = [];
        this.viewMode = mode;
        if (mode === View.LIST) this.listViewGeneration++;
        this.emit('view-reset', { to: mode });
        this.onViewChange?.();
    }

    setViewDirect(mode: ViewMode, stack: ViewMode[]) {
        this.viewStack = stack;
        this.viewMode = mode;
        if (mode === View.LIST) this.listViewGeneration++;
    }

    beginRestoreWork(active: ViewMode) {
        this.restoreMountedLayers = [{ view: active }];
    }

    advanceRestoreWork(layers: RestoreLayer[]) {
        const unique: RestoreLayer[] = [];
        for (const layer of layers) {
            if (unique.some(item => item.view === layer.view && item.entryKey === layer.entryKey)) continue;
            unique.push(layer);
        }
        this.restoreMountedLayers = unique;
    }

    finishRestoreWork() {
        this.restoreMountedLayers = null;
    }

    canMountView(view: ViewMode): boolean {
        return this.restoreMountedLayers == null || this.restoreMountedLayers.some(layer => layer.view === view);
    }

    canMountMangaEntry(entryKey: string): boolean {
        if (this.restoreMountedLayers == null) return true;
        return this.restoreMountedLayers.some(layer => layer.view === View.MANGA && layer.entryKey === entryKey);
    }

    get previousViewMode(): ViewMode {
        return this.peekBack();
    }
}
