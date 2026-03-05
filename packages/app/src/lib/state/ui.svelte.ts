import type { ViewMode } from '../types.js';

export class UIState {
    viewMode = $state<ViewMode>('list');
    viewStack = $state<ViewMode[]>([]);
    // Bumped each time viewMode transitions to 'list', so consumers can
    // detect re-entry (e.g. force-recreate IntersectionObservers on iOS).
    listViewGeneration = $state(0);
    // Manga slug → scroll position in manga list
    mangaListScrolls: Record<string, number> = {};
    // Swipe-to-go-back gesture state
    swipeProgress = $state(0);
    isSwiping = $state(false);
    swipeAnimating = $state(false);
    // Filter panel toggle (UI concern, not search logic)
    filtersExpanded = $state(false);

    pushView(mode: ViewMode) {
        this.viewStack = [...this.viewStack, this.viewMode];
        this.viewMode = mode;
        if (mode === 'list') this.listViewGeneration++;
    }

    popView() {
        const stack = this.viewStack;
        if (stack.length === 0) return;
        const prev = stack[stack.length - 1];
        this.viewStack = stack.slice(0, -1);
        this.viewMode = prev;
        if (prev === 'list') this.listViewGeneration++;
    }

    peekBack(): ViewMode {
        return this.viewStack[this.viewStack.length - 1] ?? 'list';
    }

    canGoBack(): boolean {
        return this.viewStack.length > 0;
    }

    resetTo(mode: ViewMode) {
        this.viewStack = [];
        this.viewMode = mode;
        if (mode === 'list') this.listViewGeneration++;
    }

    get previousViewMode(): ViewMode {
        return this.peekBack();
    }
}
