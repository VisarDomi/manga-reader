export const SWIPE_THRESHOLD = 0.15;      // fraction of screen width to complete gesture
export const DEADZONE_RATIO = 0.013;      // fraction of screen width for swipe deadzone
export const EDGE_ZONE_RATIO = 0.077;     // fraction of screen width for edge detection

export const RESUME_RECOVERY_MS = 5_000;        // background time before full view refresh
export const DEEP_SLEEP_MS = 10 * 60 * 1000;    // background time before "Session restored" toast

export const SEARCH_DEBOUNCE_MS = 500;            // debounce for search inputs (text + filters)

export const VISIBLE_MANGA_DEBOUNCE_MS = 1_000;   // debounce for visible manga card tracking

export const VISIBLE_PAGE_RATIO = 1 / 3;        // fraction down viewport to probe for current page
export const CHAPTER_WARM_PREV = 1;              // signed chapter metadata warm window behind current
export const CHAPTER_WARM_NEXT = 2;              // signed chapter metadata warm window ahead of current
export const SCROLL_DEBOUNCE_MS = 500;           // debounce for scroll-based page tracking
export const HISTORY_SYNC_MS = 500;              // debounce for progress sync to DB + API

export const SENTINEL_ROOT_MARGIN = '500% 0px'; // preload trigger zone for infinite scroll
export const READER_WINDOW_RADIUS_VIEWPORTS = 10;
export const READER_DOM_KEEP_RADIUS_VIEWPORTS = 12;
export const READER_IMAGE_KEEP_RADIUS_VIEWPORTS = 14;
export const READER_IMAGE_ROOT_MARGIN = '1000% 0px';
export const READER_CHAPTER_SEPARATOR_HEIGHT = 52;
export const READER_FALLBACK_PAGE_ASPECT_RATIO = 1.5;

export const LOADING_TIMEOUT_MS = 15_000;       // max time isLoading can stay true before force-reset
