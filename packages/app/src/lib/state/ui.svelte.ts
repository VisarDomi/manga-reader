import type { ViewMode } from '../types.js';
import { View } from '../logic.js';

export class UIState {
    viewMode = $state<ViewMode>(View.LIST);
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

    /** Callback invoked after every view transition so AppState can persist the session. */
    onViewChange: (() => void) | null = null;

    pushView(mode: ViewMode) {
        this.viewStack = [...this.viewStack, this.viewMode];
        this.viewMode = mode;
        if (mode === View.LIST) this.listViewGeneration++;
        this.onViewChange?.();
    }

    popView() {
        const stack = this.viewStack;
        if (stack.length === 0) return;
        const prev = stack[stack.length - 1];
        this.viewStack = stack.slice(0, -1);
        this.viewMode = prev;
        if (prev === View.LIST) this.listViewGeneration++;
        this.onViewChange?.();
    }

    peekBack(): ViewMode {
        return this.viewStack[this.viewStack.length - 1] ?? View.LIST;
    }

    canGoBack(): boolean {
        return this.viewStack.length > 0;
    }

    resetTo(mode: ViewMode) {
        this.viewStack = [];
        this.viewMode = mode;
        if (mode === View.LIST) this.listViewGeneration++;
        this.onViewChange?.();
    }

    /** Set view state directly without triggering session save (used by restore). */
    setViewDirect(mode: ViewMode, stack: ViewMode[]) {
        this.viewStack = stack;
        this.viewMode = mode;
        if (mode === View.LIST) this.listViewGeneration++;
    }

    get previousViewMode(): ViewMode {
        return this.peekBack();
    }
}
