import type { ViewMode } from '../types.js';

export class UIState {
    viewMode = $state<ViewMode>('list');
    previousViewMode = $state<ViewMode>('list');
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

    setView(mode: ViewMode) {
        this.previousViewMode = this.viewMode;
        this.viewMode = mode;
        if (mode === 'list') this.listViewGeneration++;
    }
}
