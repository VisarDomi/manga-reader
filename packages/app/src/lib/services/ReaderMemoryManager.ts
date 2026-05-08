import type { LoadedChapter, ReaderPageData } from '$lib/types.js';
import type { LogEmit } from '$lib/services/LogService.js';
import {
    READER_CHAPTER_SEPARATOR_HEIGHT,
    READER_IMAGE_KEEP_RADIUS_VIEWPORTS,
    VISIBLE_PAGE_RATIO,
} from '$lib/constants.js';

export class ReaderMemoryManager {
    private blobUrls = new Map<string, string>();
    private loadingKeys = new Set<string>();
    private abortController: AbortController | undefined;
    private emit: LogEmit;
    private pageElementsByKey = new Map<string, HTMLElement>();
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
        const data = { key: this.pageKey(chapterId, pageIndex), url };
        this.pageDataMap.set(node, data);
        this.pageElementsByKey.set(data.key, node);
    }

    unregisterPage(node: HTMLElement): void {
        const data = this.pageDataMap.get(node);
        if (data) this.pageElementsByKey.delete(data.key);
        this.pageDataMap.delete(node);
    }

    loadVirtualWindow(
        chapters: LoadedChapter[],
        scrollTop: number,
        clientHeight: number,
        clientWidth: number,
    ): void {
        if (!this.abortController || clientHeight <= 0 || clientWidth <= 0) return;

        const radiusPx = clientHeight * READER_IMAGE_KEEP_RADIUS_VIEWPORTS;
        const jobs: Array<{ key: string; url: string; priority: number }> = [];
        const keepKeys = new Set<string>();

        if (this.root) {
            const rootRect = this.root.getBoundingClientRect();
            const rangeTop = rootRect.top - radiusPx;
            const rangeBottom = rootRect.bottom + radiusPx;
            const viewportProbe = rootRect.top + clientHeight * VISIBLE_PAGE_RATIO;
            for (const [node, data] of this.pageDataMap) {
                const rect = node.getBoundingClientRect();
                if (rect.bottom < rangeTop || rect.top > rangeBottom) continue;
                const center = rect.top + rect.height / 2;
                keepKeys.add(data.key);
                jobs.push({ key: data.key, url: data.url, priority: Math.abs(center - viewportProbe) });
            }
        } else {
            const rangeStart = scrollTop - radiusPx;
            const rangeEnd = scrollTop + clientHeight + radiusPx;
            const viewportProbe = scrollTop + clientHeight * VISIBLE_PAGE_RATIO;
            for (const chapter of chapters) {
                if (chapter.pages.length === 0) continue;
                const chapterTop = chapter.virtualTop ?? 0;
                let pageTop = chapterTop + READER_CHAPTER_SEPARATOR_HEIGHT;
                for (let pageIndex = 0; pageIndex < chapter.pages.length; pageIndex++) {
                    const page = chapter.pages[pageIndex];
                    const pageHeight = page.width && page.height
                        ? clientWidth * page.height / page.width
                        : clientWidth * 1.5;
                    const pageBottom = pageTop + pageHeight;
                    if (pageBottom >= rangeStart && pageTop <= rangeEnd) {
                        const key = this.pageKey(chapter.id, pageIndex);
                        const center = pageTop + pageHeight / 2;
                        keepKeys.add(key);
                        jobs.push({ key, url: page.url, priority: Math.abs(center - viewportProbe) });
                    }
                    pageTop = pageBottom;
                }
            }
        }

        jobs.sort((a, b) => a.priority - b.priority);
        let started = 0;
        for (const job of jobs) {
            const wrapper = this.pageElementsByKey.get(job.key);
            if (!wrapper) continue;
            const img = wrapper.querySelector('img');
            if (!img || img.src) continue;
            this.loadImage(job.url, job.key, img);
            started++;
        }
        const revoked = this.cleanupOutsideVirtualWindow(keepKeys);

        this.emit('reader-image-schedule', {
            wanted: jobs.length,
            mounted: jobs.filter(job => this.pageElementsByKey.has(job.key)).length,
            started,
            revoked,
            scrollTop: Math.round(scrollTop),
            clientHeight: Math.round(clientHeight),
        });
    }

    loadImage(url: string, key: string, img: HTMLImageElement): void {
        if (!this.abortController) return;
        if (this.blobUrls.has(key) || this.loadingKeys.has(key)) return;
        this.loadingKeys.add(key);

        const signal = this.abortController.signal;
        const t0 = performance.now();

        fetch(url, { signal })
            .then(r => r.blob())
            .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                this.blobUrls.set(key, blobUrl);
                img.src = blobUrl;
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

    private cleanupOutsideVirtualWindow(keepKeys: Set<string>): number {
        let revoked = 0;
        for (const [key, blobUrl] of this.blobUrls) {
            if (keepKeys.has(key)) continue;
            URL.revokeObjectURL(blobUrl);
            this.blobUrls.delete(key);
            revoked++;

            const wrapper = this.pageElementsByKey.get(key);
            const img = wrapper?.querySelector('img');
            if (img?.src === blobUrl) {
                img.removeAttribute('src');
            }
        }
        return revoked;
    }

    revokeAll(): void {
        this.abortController?.abort();
        this.abortController = undefined;
        for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
        this.blobUrls.clear();
        this.loadingKeys.clear();
        this.pageElementsByKey.clear();
        this.pageDataMap.clear();
    }
}
