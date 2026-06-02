import type { LoadedChapter, ReaderPageData, ReaderPageGeometry } from '$lib/types.js';
import type { LogEmit } from '$lib/services/LogService.js';
import {
    READER_CHAPTER_SEPARATOR_HEIGHT,
    READER_IMAGE_KEEP_RADIUS_VIEWPORTS,
    VISIBLE_PAGE_RATIO,
} from '$lib/constants.js';
import { getProviderId } from '$lib/services/provider.js';

const IMAGE_STORE_SESSION_ID = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
type ImageLoadPolicy = 'critical' | 'preload';

export class ReaderMemoryManager {
    private imageSources = new Map<string, string>();
    private loadingKeys = new Set<string>();
    private loadingPolicyByKey = new Map<string, ImageLoadPolicy>();
    private loadingControllersByKey = new Map<string, AbortController>();
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
        return this.imageSources.size;
    }

    get loadingCount(): number {
        return this.loadingKeys.size;
    }

    get registeredPageCount(): number {
        return this.pageDataMap.size;
    }

    registerPage(node: HTMLElement, chapterId: string, pageIndex: number, url: string, candidates: string[], criticalCandidates?: string[]): void {
        const data = {
            key: this.pageKey(chapterId, pageIndex),
            url,
            candidates: candidates.length > 0 ? candidates : [url],
            criticalCandidates: criticalCandidates && criticalCandidates.length > 0 ? criticalCandidates : undefined,
        };
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
        const radiusPx = clientHeight * READER_IMAGE_KEEP_RADIUS_VIEWPORTS;
        const jobs: Array<{ key: string; url: string; candidates: string[]; criticalCandidates?: string[]; priority: number; policy: ImageLoadPolicy }> = [];
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
                const policy: ImageLoadPolicy = page.bottom >= scrollTop && page.top <= scrollTop + clientHeight ? 'critical' : 'preload';
                keepKeys.add(page.key);
                jobs.push({ key: page.key, url: page.url, candidates: page.candidates, criticalCandidates: page.criticalCandidates, priority: Math.abs(center - viewportProbe), policy });
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
                        const policy: ImageLoadPolicy = pageBottom >= scrollTop && pageTop <= scrollTop + clientHeight ? 'critical' : 'preload';
                        keepKeys.add(key);
                        jobs.push({ key, url: page.url, candidates: page.candidates, criticalCandidates: page.criticalCandidates, priority: Math.abs(center - viewportProbe), policy });
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
            const existingSource = this.imageSources.get(job.key);
            if (existingSource) {
                img.src = existingSource;
                continue;
            }
            this.loadImage(job.url, job.candidates, job.criticalCandidates, job.key, img, job.policy);
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

    loadImage(url: string, candidates: string[], criticalCandidates: string[] | undefined, key: string, img: HTMLImageElement, policy: ImageLoadPolicy): void {
        if (!this.abortController) return;
        if (this.imageSources.has(key)) return;
        if (this.loadingKeys.has(key)) {
            if (policy !== 'critical' || this.loadingPolicyByKey.get(key) === 'critical') return;
            this.loadingControllersByKey.get(key)?.abort();
        }
        this.retiredAtByKey.delete(key);
        this.loadingKeys.add(key);
        this.loadingPolicyByKey.set(key, policy);

        const loadController = new AbortController();
        const abortLoad = () => loadController.abort();
        this.abortController.signal.addEventListener('abort', abortLoad, { once: true });
        this.loadingControllersByKey.set(key, loadController);
        const signal = loadController.signal;
        const t0 = performance.now();
        const selectedCandidates = policy === 'critical' && criticalCandidates && criticalCandidates.length > 0
            ? criticalCandidates
            : candidates;
        const candidateList = selectedCandidates.length > 0 ? selectedCandidates : [url];
        let index = 0;

        const finish = () => {
            this.abortController?.signal.removeEventListener('abort', abortLoad);
            if (this.loadingControllersByKey.get(key) === loadController) {
                this.loadingControllersByKey.delete(key);
                this.loadingKeys.delete(key);
                this.loadingPolicyByKey.delete(key);
            }
        };
        const clearHandlers = () => {
            img.onload = null;
            img.onerror = null;
        };
        const tryNext = () => {
            if (signal.aborted) return;
            if (index >= candidateList.length) {
                const tFail = performance.now();
                clearHandlers();
                img.removeAttribute('src');
                finish();
                this.emit('img-fail', {
                    key,
                    totalMs: Math.round(tFail - t0),
                    error: 'all image candidates failed',
                    pending: this.loadingKeys.size,
                });
                this.onLoadFailure?.(key);
                return;
            }

            const candidateIndex = index;
            const candidateUrl = candidateList[candidateIndex];
            const startedAt = performance.now();
            const host = this.hostFromCandidate(candidateUrl);
            img.onload = () => {
                if (signal.aborted) return;
                const totalMs = Math.round(performance.now() - startedAt);
                this.imageSources.set(key, candidateUrl);
                this.recordImageCandidate(url, candidateUrl, key, candidateIndex, candidateList.length, 200, true, totalMs, policy);
                this.emit('reader-image-loaded', {
                    key,
                    totalMs: Math.round(performance.now() - t0),
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                });
                clearHandlers();
                finish();
            };
            img.onerror = () => {
                if (signal.aborted) return;
                const totalMs = Math.round(performance.now() - startedAt);
                this.emit('reader-image-decode-failed', {
                    key,
                    index: candidateIndex,
                    total: candidateList.length,
                    totalMs,
                    host,
                    bytes: 0,
                    type: 'native-image',
                    policy,
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                });
                this.recordImageCandidate(url, candidateUrl, key, candidateIndex, candidateList.length, 0, false, totalMs, policy, 'Image failed');
                index++;
                tryNext();
            };
            img.src = candidateUrl;
        };
        loadController.signal.addEventListener('abort', () => {
            clearHandlers();
            if (this.loadingControllersByKey.get(key) === loadController) {
                img.removeAttribute('src');
                finish();
            }
        }, { once: true });
        tryNext();
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
        policy: ImageLoadPolicy,
        error?: string,
    ): void {
        const localDecoded = candidateUrl.startsWith('/api/cache/');
        const host = this.hostFromCandidate(candidateUrl);
        this.emit('reader-image-candidate', { key, index, total, ok, status, totalMs, host, sessionId: IMAGE_STORE_SESSION_ID, policy, error });
        if (localDecoded) return;
        void fetch('/api/cache/image-store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerId: getProviderId(), imageUrl: canonicalUrl, storeUrl: candidateUrl, status, ok, totalMs, sessionId: IMAGE_STORE_SESSION_ID }),
            keepalive: true,
        }).catch(error => {
            this.emit('reader-image-store-report-failed', {
                key,
                host,
                error: String((error as Error)?.message ?? error),
            });
        });
    }

    private hostFromCandidate(candidateUrl: string): string {
        if (candidateUrl.startsWith('/api/cache/')) return 'local-decoder';
        try {
            return new URL(candidateUrl, globalThis.location?.origin).hostname;
        } catch {
            return 'invalid';
        }
    }

    private cleanupOutsideVirtualWindow(keepKeys: Set<string>): number {
        const now = performance.now();
        let revoked = 0;
        for (const [key, source] of this.imageSources) {
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
            if (source.startsWith('blob:')) URL.revokeObjectURL(source);
            this.imageSources.delete(key);
            this.retiredAtByKey.delete(key);
            revoked++;

            const wrapper = this.pageElementsByKey.get(key);
            const img = wrapper?.querySelector('img');
            if (img?.src === source) {
                img.removeAttribute('src');
            }
        }
        return revoked;
    }

    revokeAll(): void {
        this.abortController?.abort();
        this.abortController = undefined;
        for (const controller of this.loadingControllersByKey.values()) controller.abort();
        for (const url of this.imageSources.values()) {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        }
        this.imageSources.clear();
        this.loadingKeys.clear();
        this.loadingPolicyByKey.clear();
        this.loadingControllersByKey.clear();
        this.retiredAtByKey.clear();
        this.pageElementsByKey.clear();
        this.pageDataMap.clear();
        this.lastScheduleLogAt = 0;
        this.lastScheduleLogSignature = '';
        this.lastSchedulePerfLogAt = 0;
    }
}
