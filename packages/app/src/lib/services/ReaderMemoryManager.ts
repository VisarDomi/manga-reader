import type { LoadedChapter, ReaderPageData } from '$lib/types.js';
import type { LogEmit } from '$lib/services/LogService.js';
import { MAX_CHAPTER_DISTANCE } from '$lib/constants.js';

export class ReaderMemoryManager {
    private blobUrls = new Map<string, string>();
    private loadingKeys = new Set<string>();
    private abortController: AbortController | undefined;
    private emit: LogEmit;
    readonly pageDataMap = new Map<HTMLElement, ReaderPageData>();
    root: HTMLElement | null = null;
    onLoadFailure: ((key: string) => void) | undefined;

    constructor(emit: LogEmit) {
        this.emit = emit;
    }

    private pageKey(chapterId: string, pageIndex: number): string {
        return `${chapterId}-${pageIndex}`;
    }

    startSession(): void {
        this.abortController = new AbortController();
    }

    ensureAbortController(): void {
        if (!this.abortController) {
            this.abortController = new AbortController();
        }
    }

    get signal(): AbortSignal | undefined {
        return this.abortController?.signal;
    }

    registerPage(node: HTMLElement, chapterId: string, pageIndex: number, url: string): void {
        this.pageDataMap.set(node, { key: this.pageKey(chapterId, pageIndex), url });
    }

    unregisterPage(node: HTMLElement): void {
        this.pageDataMap.delete(node);
    }

    loadImage(url: string, key: string, img: HTMLImageElement): void {
        if (!this.abortController) return;
        if (this.blobUrls.has(key) || this.loadingKeys.has(key)) return;
        this.loadingKeys.add(key);

        const signal = this.abortController.signal;
        const t0 = performance.now();
        let tResponse = 0;

        fetch(url, { signal })
            .then(r => {
                tResponse = performance.now();
                return r.blob();
            })
            .then(blob => {
                const tDone = performance.now();
                const blobUrl = URL.createObjectURL(blob);
                this.blobUrls.set(key, blobUrl);
                img.src = blobUrl;
                this.emit('img-ok', {
                    key,
                    fetchMs: Math.round(tResponse - t0),
                    blobMs: Math.round(tDone - tResponse),
                    totalMs: Math.round(tDone - t0),
                    sizeKB: Math.round(blob.size / 1024),
                    pending: this.loadingKeys.size,
                });
            })
            .catch((err) => {
                if (err?.name !== 'AbortError') {
                    const tFail = performance.now();
                    this.emit('img-fail', {
                        key,
                        totalMs: Math.round(tFail - t0),
                        error: err?.message ?? String(err),
                        pending: this.loadingKeys.size,
                    });
                    this.onLoadFailure?.(key);
                }
            })
            .finally(() => this.loadingKeys.delete(key));
    }

    cleanupDistantChapters(
        currentChapterId: string,
        chapters: LoadedChapter[],
        pageElements: Iterable<HTMLElement>,
    ): void {
        const currentIndex = chapters.findIndex(c => c.id === currentChapterId);
        if (currentIndex < 0) return;

        const unloadIds = new Set<string>();
        for (let i = 0; i < chapters.length; i++) {
            if (Math.abs(i - currentIndex) > MAX_CHAPTER_DISTANCE) {
                const ch = chapters[i];
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

    revokeAll(): void {
        this.abortController?.abort();
        this.abortController = undefined;
        for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
        this.blobUrls.clear();
        this.loadingKeys.clear();
        this.pageDataMap.clear();
    }
}
