import type { ViewMode } from '../types.js';
import type { LogEmit } from '../services/LogService.js';
import { View } from '../logic.js';

export class UIState {
    viewMode = $state<ViewMode>(View.LIST);
    viewStack = $state<ViewMode[]>([]);
    restoreMountedViews = $state<ViewMode[] | null>(null);
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
        this.restoreMountedViews = [active];
    }

    advanceRestoreWork(views: ViewMode[]) {
        const unique: ViewMode[] = [];
        for (const view of views) {
            if (!unique.includes(view)) unique.push(view);
        }
        this.restoreMountedViews = unique;
    }

    finishRestoreWork() {
        this.restoreMountedViews = null;
    }

    canMountView(view: ViewMode): boolean {
        return this.restoreMountedViews == null || this.restoreMountedViews.includes(view);
    }

    get previousViewMode(): ViewMode {
        return this.peekBack();
    }
}
