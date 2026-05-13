import type { LoadedChapter, ReaderPageData, ReaderPageGeometry } from '$lib/types.js';
import type { LogEmit } from '$lib/services/LogService.js';
import {
    READER_CHAPTER_SEPARATOR_HEIGHT,
    READER_IMAGE_KEEP_RADIUS_VIEWPORTS,
    READER_PHYSICAL_AFTER_PX,
    READER_PHYSICAL_BEFORE_PX,
    VISIBLE_PAGE_RATIO,
} from '$lib/constants.js';

const IMAGE_STORE_SESSION_ID = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export class ReaderMemoryManager {
    private blobUrls = new Map<string, string>();
    private loadingKeys = new Set<string>();
    private retiredAtByKey = new Map<string, number>();
    private abortController: AbortController | undefined;
    private emit: LogEmit;
    private pageElementsByKey = new Map<string, HTMLElement>();
    readonly pageDataMap = new Map<HTMLElement, ReaderPageData>();
    root: HTMLElement | null = null;
    onLoadFailure: ((key: string) => void) | undefined;
    private lastScheduleLogAt = 0;
    private lastScheduleLogSignature = '';
    private lastSchedulePerfLogAt = 0;
    private static readonly RETIRE_GRACE_MS = 2_000;

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

    get blobUrlCount(): number {
        return this.blobUrls.size;
    }

    get loadingCount(): number {
        return this.loadingKeys.size;
    }

    get registeredPageCount(): number {
        return this.pageDataMap.size;
    }

    registerPage(node: HTMLElement, chapterId: string, pageIndex: number, url: string, candidates: string[]): void {
        const data = { key: this.pageKey(chapterId, pageIndex), url, candidates: candidates.length > 0 ? candidates : [url] };
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
        geometry?: ReaderPageGeometry[],
        options: { allowCleanup?: boolean } = {},
    ): { totalMs: number; pageCount: number; jobs: number; kept: number; mounted: number; started: number; revoked: number } | null {
        if (!this.abortController || clientHeight <= 0 || clientWidth <= 0) return null;

        const t0 = performance.now();
        const radiusPx = Math.max(clientHeight * READER_IMAGE_KEEP_RADIUS_VIEWPORTS, READER_PHYSICAL_BEFORE_PX, READER_PHYSICAL_AFTER_PX);
        const jobs: Array<{ key: string; url: string; candidates: string[]; priority: number }> = [];
        const keepKeys = new Set<string>();
        let pageCount = 0;
        let scanMs = 0;
        let sortMs = 0;
        let startMs = 0;
        let cleanupMs = 0;

        const scanStart = performance.now();
        if (geometry) {
            const rangeStart = scrollTop - radiusPx;
            const rangeEnd = scrollTop + clientHeight + radiusPx;
            const viewportProbe = scrollTop + clientHeight * VISIBLE_PAGE_RATIO;
            for (const page of geometry) {
                pageCount++;
                if (page.bottom < rangeStart || page.top > rangeEnd) continue;
                const center = page.top + page.height / 2;
                keepKeys.add(page.key);
                jobs.push({ key: page.key, url: page.url, candidates: page.candidates, priority: Math.abs(center - viewportProbe) });
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
                    pageCount++;
                    const pageHeight = page.width && page.height
                        ? clientWidth * page.height / page.width
                        : clientWidth * 1.5;
                    const pageBottom = pageTop + pageHeight;
                    if (pageBottom >= rangeStart && pageTop <= rangeEnd) {
                        const key = this.pageKey(chapter.id, pageIndex);
                        const center = pageTop + pageHeight / 2;
                        keepKeys.add(key);
                        jobs.push({ key, url: page.url, candidates: page.candidates, priority: Math.abs(center - viewportProbe) });
                    }
                    pageTop = pageBottom;
                }
            }
        }
        scanMs = performance.now() - scanStart;

        const sortStart = performance.now();
        jobs.sort((a, b) => a.priority - b.priority);
        sortMs = performance.now() - sortStart;
        let started = 0;
        let mounted = 0;
        const startStart = performance.now();
        for (const job of jobs) {
            const wrapper = this.pageElementsByKey.get(job.key);
            if (!wrapper) continue;
            mounted++;
            this.retiredAtByKey.delete(job.key);
            const img = wrapper.querySelector('img');
            if (!img || img.src) continue;
            const existingBlobUrl = this.blobUrls.get(job.key);
            if (existingBlobUrl) {
                img.src = existingBlobUrl;
                continue;
            }
            this.loadImage(job.url, job.candidates, job.key, img);
            started++;
        }
        startMs = performance.now() - startStart;
        const cleanupStart = performance.now();
        const revoked = options.allowCleanup === false ? 0 : this.cleanupOutsideVirtualWindow(keepKeys);
        cleanupMs = performance.now() - cleanupStart;
        const totalMs = performance.now() - t0;

        this.logSchedule({
            wanted: jobs.length,
            mounted,
            started,
            revoked,
            scrollTop: Math.round(scrollTop),
            clientHeight: Math.round(clientHeight),
        });
        this.logSchedulePerf({
            scrollTop: Math.round(scrollTop),
            pages: pageCount,
            jobs: jobs.length,
            kept: keepKeys.size,
            mounted,
            started,
            revoked,
            totalMs,
            scanMs,
            sortMs,
            startMs,
            cleanupMs,
        });

        return { totalMs, pageCount, jobs: jobs.length, kept: keepKeys.size, mounted, started, revoked };
    }

    private logSchedule(data: { wanted: number; mounted: number; started: number; revoked: number; scrollTop: number; clientHeight: number }): void {
        const signature = `${data.wanted}:${data.mounted}:${data.started}:${data.revoked}`;
        const now = performance.now();
        const changed = signature !== this.lastScheduleLogSignature;
        const active = data.started > 0 || data.revoked > 0;
        if (!active && !changed && now - this.lastScheduleLogAt < 2_000) return;

        this.lastScheduleLogAt = now;
        this.lastScheduleLogSignature = signature;
        this.emit('reader-image-schedule', data);
    }

    private logSchedulePerf(data: {
        scrollTop: number;
        pages: number;
        jobs: number;
        kept: number;
        mounted: number;
        started: number;
        revoked: number;
        totalMs: number;
        scanMs: number;
        sortMs: number;
        startMs: number;
        cleanupMs: number;
    }): void {
        const now = performance.now();
        if (data.totalMs < 8 && now - this.lastSchedulePerfLogAt < 2_000) return;

        this.lastSchedulePerfLogAt = now;
        this.emit('reader-image-schedule-perf', {
            ...data,
            totalMs: Math.round(data.totalMs),
            scanMs: Math.round(data.scanMs),
            sortMs: Math.round(data.sortMs),
            startMs: Math.round(data.startMs),
            cleanupMs: Math.round(data.cleanupMs),
        });
    }

    loadImage(url: string, candidates: string[], key: string, img: HTMLImageElement): void {
        if (!this.abortController) return;
        if (this.blobUrls.has(key) || this.loadingKeys.has(key)) return;
        this.retiredAtByKey.delete(key);
        this.loadingKeys.add(key);

        const signal = this.abortController.signal;
        const t0 = performance.now();

        this.fetchFirstImageCandidate(url, candidates.length > 0 ? candidates : [url], key, signal)
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

    private async fetchFirstImageCandidate(canonicalUrl: string, candidates: string[], key: string, signal: AbortSignal): Promise<Blob> {
        let lastError = 'no candidates';
        for (let index = 0; index < candidates.length; index++) {
            const candidateUrl = candidates[index];
            const startedAt = performance.now();
            try {
                const response = await fetch(candidateUrl, { signal, mode: 'cors', credentials: 'omit' });
                const totalMs = Math.round(performance.now() - startedAt);
                this.recordImageCandidate(canonicalUrl, candidateUrl, key, index, candidates.length, response.status, response.ok, totalMs);
                if (!response.ok) {
                    lastError = `HTTP ${response.status}`;
                    continue;
                }
                return await response.blob();
            } catch (err) {
                if ((err as { name?: string })?.name === 'AbortError') throw err;
                const totalMs = Math.round(performance.now() - startedAt);
                lastError = err instanceof Error ? err.message : String(err);
                this.recordImageCandidate(canonicalUrl, candidateUrl, key, index, candidates.length, 0, false, totalMs, lastError);
            }
        }
        throw new Error(lastError);
    }

    private recordImageCandidate(
        canonicalUrl: string,
        candidateUrl: string,
        key: string,
        index: number,
        total: number,
        status: number,
        ok: boolean,
        totalMs: number,
        error?: string,
    ): void {
        let host = 'invalid';
        try {
            host = new URL(candidateUrl).hostname;
        } catch {
            // Keep the log path alive for malformed candidates.
        }
        this.emit('reader-image-candidate', { key, index, total, ok, status, totalMs, host, sessionId: IMAGE_STORE_SESSION_ID, error });
        void fetch('/api/cache/image-store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageUrl: canonicalUrl, storeUrl: candidateUrl, status, ok, totalMs, sessionId: IMAGE_STORE_SESSION_ID }),
            keepalive: true,
        }).catch(() => {});
    }

    private cleanupOutsideVirtualWindow(keepKeys: Set<string>): number {
        const now = performance.now();
        let revoked = 0;
        for (const [key, blobUrl] of this.blobUrls) {
            if (keepKeys.has(key)) {
                this.retiredAtByKey.delete(key);
                continue;
            }
            const retiredAt = this.retiredAtByKey.get(key);
            if (retiredAt == null) {
                this.retiredAtByKey.set(key, now);
                continue;
            }
            if (now - retiredAt < ReaderMemoryManager.RETIRE_GRACE_MS) continue;
            URL.revokeObjectURL(blobUrl);
            this.blobUrls.delete(key);
            this.retiredAtByKey.delete(key);
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
        this.retiredAtByKey.clear();
        this.pageElementsByKey.clear();
        this.pageDataMap.clear();
        this.lastScheduleLogAt = 0;
        this.lastScheduleLogSignature = '';
        this.lastSchedulePerfLogAt = 0;
    }
}
