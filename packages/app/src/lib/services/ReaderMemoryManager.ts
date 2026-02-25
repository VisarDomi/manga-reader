import type { LoadedChapter, ReaderPageData } from '$lib/types.js';
import { MAX_CHAPTER_DISTANCE } from '$lib/constants.js';

export class ReaderMemoryManager {
    private blobUrls = new Map<string, string>();
    private loadingKeys = new Set<string>();
    private abortController: AbortController | undefined;
    readonly pageDataMap = new Map<HTMLElement, ReaderPageData>();
    root: HTMLElement | null = null;

    private pageKey(chapterId: string, pageIndex: number): string {
        return `${chapterId}-${pageIndex}`;
    }

    /** Start a new session (creates a fresh AbortController). */
    startSession(): void {
        this.abortController = new AbortController();
    }

    /** Ensure an AbortController exists (idempotent). */
    ensureAbortController(): void {
        if (!this.abortController) {
            this.abortController = new AbortController();
        }
    }

    /** Get the current abort signal, or undefined if no session is active. */
    get signal(): AbortSignal | undefined {
        return this.abortController?.signal;
    }

    registerPage(node: HTMLElement, chapterId: string, pageIndex: number, url: string): void {
        this.pageDataMap.set(node, { key: this.pageKey(chapterId, pageIndex), url });
    }

    unregisterPage(node: HTMLElement): void {
        this.pageDataMap.delete(node);
    }

    /**
     * Fetch an image as a blob and set it on the given `<img>` element.
     * No-ops if the key is already loaded or currently loading.
     */
    loadImage(url: string, key: string, img: HTMLImageElement): void {
        if (!this.abortController) return;
        if (this.blobUrls.has(key) || this.loadingKeys.has(key)) return;
        this.loadingKeys.add(key);

        const signal = this.abortController.signal;

        fetch(url, { signal })
            .then(r => r.blob())
            .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                this.blobUrls.set(key, blobUrl);
                img.src = blobUrl;
            })
            .catch(() => {})
            .finally(() => this.loadingKeys.delete(key));
    }

    /**
     * Revoke blob URLs for chapters whose distance from the current chapter
     * exceeds MAX_CHAPTER_DISTANCE. Clears `src` on the provided page elements.
     */
    cleanupDistantChapters(
        currentChapterId: string,
        chapters: LoadedChapter[],
        pageElements: Iterable<HTMLElement>,
    ): void {
        const currentIndex = chapters.findIndex(c => c.id === currentChapterId);
        if (currentIndex < 0) return;

        // Collect chapter IDs that should be unloaded
        const unloadIds = new Set<string>();
        for (let i = 0; i < chapters.length; i++) {
            if (Math.abs(i - currentIndex) > MAX_CHAPTER_DISTANCE) {
                const ch = chapters[i];
                // Revoke blob URLs for every page in this chapter
                for (let p = 0; p < ch.pages.length; p++) {
                    const key = this.pageKey(ch.id, p);
                    const blobUrl = this.blobUrls.get(key);
                    if (blobUrl) {
                        URL.revokeObjectURL(blobUrl);
                        this.blobUrls.delete(key);
                    }
                }
                unloadIds.add(ch.id);
            }
        }

        if (unloadIds.size === 0) return;

        // Clear src on affected <img> elements
        for (const wrapper of pageElements) {
            const data = this.pageDataMap.get(wrapper);
            if (!data) continue;
            const chId = data.key.split('-')[0];
            if (unloadIds.has(chId)) {
                const img = wrapper.querySelector('img');
                if (img && img.src) {
                    img.removeAttribute('src');
                }
            }
        }
    }

    /**
     * Reload images for a previously-unloaded chapter.
     * Caller passes the page wrapper elements so the manager doesn't query the DOM.
     */
    reloadChapterImages(
        chapterId: string,
        pageElements: Iterable<HTMLElement>,
    ): void {
        if (!this.abortController) return;

        for (const wrapper of pageElements) {
            const data = this.pageDataMap.get(wrapper);
            if (!data) continue;
            if (!data.key.startsWith(`${chapterId}-`)) continue;
            const img = wrapper.querySelector('img');
            if (img && !img.src) {
                this.loadImage(data.url, data.key, img);
            }
        }
    }

    /** Revoke all blob URLs and abort pending fetches. Full cleanup. */
    revokeAll(): void {
        this.abortController?.abort();
        this.abortController = undefined;
        for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
        this.blobUrls.clear();
        this.loadingKeys.clear();
        this.pageDataMap.clear();
    }
}
