import type {
    HomeChapter,
    HomePage,
    HomeSeries,
    Provider,
    RemoteSeriesHistory,
} from '../provider';
import {
    getProviderProgress,
    isChapterComplete,
    type ChapterProgress,
} from '../storage/progress';

const POLITE_PAGE_DELAY_MS = 1_000;

function createLink(className: string, href: string, text?: string): HTMLAnchorElement {
    const link = document.createElement('a');
    link.className = className;
    link.href = href;
    if (text !== undefined) link.textContent = text;
    return link;
}

function lockIcon(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('hs-home-lock');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-label', 'Unavailable chapter');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z');
    svg.appendChild(path);
    return svg;
}

function formatUploadedAt(value: string | null): string {
    if (value === null || value.trim() === '') return '';
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return value;
    const elapsed = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? 'last week' : `${weeks} weeks ago`;
}

function unlockCountdown(unlockAt: string): string {
    const remaining = new Date(unlockAt).getTime() - Date.now();
    if (remaining <= 0) return '0m';
    const hours = Math.floor(remaining / 3_600_000);
    const minutes = Math.floor((remaining % 3_600_000) / 60_000);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function progressKey(seriesSlug: string, chapterId: string): string {
    return `${seriesSlug}\u0000${chapterId}`;
}

function historyId(series: HomeSeries): string {
    return series.historyId ?? series.slug;
}

function chapterAtOrBefore(chapterId: string, boundaryId: string): boolean {
    const chapter = Number(chapterId);
    const boundary = Number(boundaryId);
    if (Number.isFinite(chapter) && Number.isFinite(boundary)) return chapter <= boundary;
    return chapterId === boundaryId;
}

function remoteImageIndex(percent: number, totalImages: number): number {
    return Math.max(0, Math.min(totalImages - 1, Math.round(percent / 100 * totalImages) - 1));
}

async function resumeRemotePage(
    provider: Provider,
    seriesSlug: string,
    chapterId: string,
    percent: number,
): Promise<void> {
    const chapter = await provider.fetchChapter(seriesSlug, chapterId);
    window.location.href = chapter === null
        ? provider.readerUrl(seriesSlug, chapterId)
        : provider.readerUrl(seriesSlug, chapterId, String(remoteImageIndex(percent, chapter.images.length)));
}

function createProgressIndex(progress: ChapterProgress[]): Map<string, ChapterProgress> {
    return new Map(progress.map(item => [progressKey(item.seriesSlug, item.chapterId), item]));
}

function latestSeriesProgress(
    progress: Iterable<ChapterProgress>,
    seriesSlug: string,
): ChapterProgress | undefined {
    let latest: ChapterProgress | undefined;
    for (const item of progress) {
        if (item.seriesSlug !== seriesSlug) continue;
        if (!latest || item.updatedAt > latest.updatedAt) latest = item;
    }
    return latest;
}

function renderChapter(provider: Provider, series: HomeSeries, chapter: HomeChapter): HTMLAnchorElement {
    const classes = ['hs-home-chapter'];
    if (chapter.locked) classes.push('hs-home-chapter-locked');
    const link = createLink(classes.join(' '), provider.readerUrl(series.slug, chapter.chapterId));
    link.dataset.seriesSlug = series.slug;
    link.dataset.chapterId = chapter.chapterId;
    link.dataset.uploadedAt = chapter.uploadedAt ?? '';
    if (chapter.unlockAt !== null) link.dataset.unlockAt = chapter.unlockAt;

    const label = document.createElement('span');
    label.className = 'hs-home-chapter-label';
    const labelText = document.createElement('span');
    labelText.textContent = chapter.label;
    label.appendChild(labelText);
    if (chapter.locked) label.appendChild(lockIcon());

    const uploadedAt = document.createElement('time');
    if (chapter.locked) {
        uploadedAt.className = 'hs-home-unlock';
        uploadedAt.textContent = chapter.unlockAt ? unlockCountdown(chapter.unlockAt) : 'Locked';
    } else {
        uploadedAt.textContent = formatUploadedAt(chapter.uploadedAt);
    }
    link.append(label, uploadedAt);
    link.addEventListener('click', event => {
        if (link.classList.contains('hs-home-chapter-locked')) {
            event.preventDefault();
            return;
        }
        const remotePercent = link.dataset.remoteResumePercent;
        if (remotePercent === undefined) return;
        event.preventDefault();
        if (link.dataset.loading === 'true') return;
        link.dataset.loading = 'true';
        void resumeRemotePage(provider, series.slug, chapter.chapterId, Number(remotePercent))
            .catch(error => {
                link.title = error instanceof Error ? error.message : String(error);
                link.dataset.loading = 'false';
            });
    });
    return link;
}

function renderSeries(provider: Provider, series: HomeSeries): HTMLElement {
    const card = document.createElement('article');
    card.className = 'hs-home-card';
    card.dataset.seriesSlug = series.slug;
    card.dataset.historyId = historyId(series);

    const coverLink = createLink('hs-home-cover', provider.seriesUrl(series.slug));
    coverLink.dataset.seriesSlug = series.slug;
    const cover = document.createElement('img');
    cover.src = series.coverUrl;
    cover.alt = series.title;
    cover.loading = 'lazy';
    coverLink.appendChild(cover);
    coverLink.addEventListener('click', event => {
        if (coverLink.dataset.resume === 'local') return;
        if (coverLink.dataset.resume === 'remote') {
            const chapterId = coverLink.dataset.remoteResumeChapterId;
            const remotePercent = coverLink.dataset.remoteResumePercent;
            if (chapterId === undefined || remotePercent === undefined) return;
            event.preventDefault();
            if (coverLink.dataset.loading === 'true') return;
            coverLink.dataset.loading = 'true';
            coverLink.classList.add('hs-home-cover-loading');
            void resumeRemotePage(provider, series.slug, chapterId, Number(remotePercent))
                .catch(error => {
                    coverLink.dataset.loading = 'false';
                    coverLink.classList.remove('hs-home-cover-loading');
                    coverLink.title = error instanceof Error ? error.message : String(error);
                });
            return;
        }
        event.preventDefault();
        if (coverLink.dataset.loading === 'true') return;
        coverLink.dataset.loading = 'true';
        coverLink.classList.add('hs-home-cover-loading');
        void provider.fetchChaptersNewestFirst(series.slug)
            .then(chapters => {
                const oldest = chapters.at(-1);
                coverLink.dataset.loading = 'false';
                coverLink.classList.remove('hs-home-cover-loading');
                window.location.href = oldest
                    ? provider.readerUrl(series.slug, oldest.chapterId)
                    : provider.seriesUrl(series.slug);
            })
            .catch(error => {
                coverLink.dataset.loading = 'false';
                coverLink.classList.remove('hs-home-cover-loading');
                coverLink.title = error instanceof Error ? error.message : String(error);
            });
    });

    const details = document.createElement('div');
    details.className = 'hs-home-details';
    const chapters = document.createElement('div');
    chapters.className = 'hs-home-chapters';
    const visibleChapters = series.chapters.slice(0, 5);
    if (visibleChapters.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'hs-home-no-chapters';
        empty.textContent = 'No chapters available';
        chapters.appendChild(empty);
    } else {
        chapters.append(...visibleChapters.map((chapter: HomeChapter) => renderChapter(provider, series, chapter)));
    }
    details.appendChild(chapters);
    card.append(coverLink, details);
    return card;
}

function updateUnlockCountdowns(root: ParentNode): void {
    for (const chapter of root.querySelectorAll<HTMLAnchorElement>('.hs-home-chapter-locked[data-unlock-at]')) {
        const unlockAt = chapter.dataset.unlockAt;
        if (!unlockAt) continue;
        const time = chapter.querySelector('time');
        if (!time) continue;
        if (new Date(unlockAt).getTime() > Date.now()) {
            time.textContent = unlockCountdown(unlockAt);
            continue;
        }
        chapter.classList.remove('hs-home-chapter-locked');
        chapter.querySelector('.hs-home-lock')?.remove();
        time.classList.remove('hs-home-unlock');
        time.textContent = formatUploadedAt(chapter.dataset.uploadedAt ?? null);
    }
}

function applyProgress(
    provider: Provider,
    root: ParentNode,
    progress: ChapterProgress[],
): void {
    const index = createProgressIndex(progress);
    for (const chapter of root.querySelectorAll<HTMLAnchorElement>('.hs-home-chapter')) {
        const seriesSlug = chapter.dataset.seriesSlug;
        const chapterId = chapter.dataset.chapterId;
        if (!seriesSlug || !chapterId) continue;
        const saved = index.get(progressKey(seriesSlug, chapterId));
        if (saved === undefined) continue;
        chapter.classList.toggle('hs-home-chapter-partial', !isChapterComplete(saved));
        chapter.classList.toggle('hs-home-chapter-read', isChapterComplete(saved));
        delete chapter.dataset.remoteResumePercent;
        if (saved && !chapter.classList.contains('hs-home-chapter-locked')) {
            chapter.href = provider.readerUrl(seriesSlug, chapterId, String(saved.imageIndex));
        }
    }

    for (const cover of root.querySelectorAll<HTMLAnchorElement>('.hs-home-cover')) {
        const seriesSlug = cover.dataset.seriesSlug;
        if (!seriesSlug) continue;
        const saved = latestSeriesProgress(progress, seriesSlug);
        if (!saved) continue;
        cover.dataset.resume = 'local';
        delete cover.dataset.remoteResumeChapterId;
        delete cover.dataset.remoteResumePercent;
        cover.href = provider.readerUrl(seriesSlug, saved.chapterId, String(saved.imageIndex));
    }
}

function applyRemoteHistory(
    provider: Provider,
    root: ParentNode,
    history: RemoteSeriesHistory[],
): void {
    const index = new Map(history.map(item => [item.seriesId, item]));
    for (const card of root.querySelectorAll<HTMLElement>('.hs-home-card')) {
        const seriesSlug = card.dataset.seriesSlug;
        const remoteId = card.dataset.historyId;
        if (!seriesSlug || !remoteId) continue;
        const remote = index.get(remoteId);
        for (const chapter of card.querySelectorAll<HTMLAnchorElement>('.hs-home-chapter')) {
            const chapterId = chapter.dataset.chapterId;
            if (!chapterId) continue;
            chapter.classList.remove('hs-home-chapter-read', 'hs-home-chapter-partial');
            delete chapter.dataset.remoteResumePercent;
            chapter.href = provider.readerUrl(seriesSlug, chapterId);
            if (!remote) continue;
            if (
                remote.readThroughChapterId !== undefined
                && chapterAtOrBefore(chapterId, remote.readThroughChapterId)
            ) {
                chapter.classList.add('hs-home-chapter-read');
            }
            if (chapterId === remote.resumeChapterId && remote.resumePercent !== undefined) {
                chapter.classList.toggle('hs-home-chapter-partial', remote.resumePercent < 100);
                chapter.classList.toggle('hs-home-chapter-read', remote.resumePercent >= 100);
                chapter.dataset.remoteResumePercent = String(remote.resumePercent);
            }
        }

        const cover = card.querySelector<HTMLAnchorElement>('.hs-home-cover');
        if (!cover) continue;
        cover.dataset.resume = remote ? 'remote' : 'false';
        delete cover.dataset.remoteResumeChapterId;
        delete cover.dataset.remoteResumePercent;
        cover.href = remote
            ? provider.readerUrl(seriesSlug, remote.resumeChapterId)
            : provider.seriesUrl(seriesSlug);
        if (remote) {
            cover.dataset.remoteResumeChapterId = remote.resumeChapterId;
            if (remote.resumePercent !== undefined) {
                cover.dataset.remoteResumePercent = String(remote.resumePercent);
            }
        }
    }
}

function statusText(loaded: number, total: number | undefined, loading: boolean): string {
    const count = total === undefined ? `${loaded}` : `${loaded} of ${total}`;
    return loading ? `Loaded ${count} series · loading more…` : `Loaded ${count} series`;
}

function renderError(error: unknown): void {
    const message = document.createElement('div');
    message.className = 'hs-home-error';
    message.textContent = error instanceof Error ? error.message : String(error);
    document.body.replaceChildren(message);
}

function mergeSeries(current: HomeSeries, incoming: HomeSeries): HomeSeries {
    const chapterIds = new Set(current.chapters.map(chapter => chapter.chapterId));
    const chapters = [...current.chapters];
    for (const chapter of incoming.chapters) {
        if (chapterIds.has(chapter.chapterId)) continue;
        chapterIds.add(chapter.chapterId);
        chapters.push(chapter);
    }
    return { ...current, chapters: chapters.slice(0, 5) };
}

function resetTransientCoverState(root: ParentNode): void {
    for (const cover of root.querySelectorAll<HTMLAnchorElement>('.hs-home-cover-loading')) {
        cover.dataset.loading = 'false';
        cover.classList.remove('hs-home-cover-loading');
    }
}

export async function open(provider: Provider): Promise<void> {
    let active = !document.hidden;
    let lifecycleVersion = 0;
    let resumeWaiters: Array<() => void> = [];
    function pause(): void {
        if (!active) return;
        active = false;
        lifecycleVersion += 1;
    }
    function resume(): void {
        if (active) return;
        active = true;
        const waiters = resumeWaiters;
        resumeWaiters = [];
        for (const resume of waiters) resume();
    }
    window.addEventListener('pagehide', pause);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) pause();
        else resume();
    });

    async function waitUntilActive(): Promise<void> {
        if (active) return;
        await new Promise<void>(resolve => resumeWaiters.push(resolve));
    }

    async function waitForNextRequest(): Promise<void> {
        await waitUntilActive();
        await new Promise<void>(resolve => window.setTimeout(resolve, POLITE_PAGE_DELAY_MS));
        await waitUntilActive();
    }

    const loading = document.createElement('div');
    loading.className = 'hs-home-loading';
    loading.textContent = 'Loading latest updates…';
    document.body.appendChild(loading);
    let progress = getProviderProgress(provider.key);
    let remoteHistory: RemoteSeriesHistory[] = [];

    let firstPage: HomePage;
    try {
        firstPage = await provider.fetchHome(null);
    } catch (error) {
        renderError(error);
        return;
    }

    const main = document.createElement('main');
    main.className = 'hs-home';
    const section = document.createElement('section');
    section.className = 'hs-home-section';
    const list = document.createElement('div');
    list.className = 'hs-home-list';
    const status = document.createElement('p');
    status.className = 'hs-home-catalog-status';
    section.append(list, status);
    main.appendChild(section);
    document.body.replaceChildren(main);

    const cards = new Map<string, { series: HomeSeries; element: HTMLElement }>();
    let total = firstPage.total;
    function appendPage(page: HomePage): void {
        if (page.total !== undefined) total = page.total;
        for (const series of page.series) {
            const current = cards.get(series.slug);
            if (!current) {
                const element = renderSeries(provider, series);
                cards.set(series.slug, { series, element });
                list.appendChild(element);
                continue;
            }
            const merged = mergeSeries(current.series, series);
            if (merged.chapters.length === current.series.chapters.length) continue;
            const element = renderSeries(provider, merged);
            current.element.replaceWith(element);
            cards.set(series.slug, { series: merged, element });
        }
        applyRemoteHistory(provider, list, remoteHistory);
        applyProgress(provider, list, progress);
    }
    appendPage(firstPage);
    status.textContent = statusText(cards.size, total, firstPage.nextCursor !== null);

    function applyHistoryLayers(): void {
        progress = getProviderProgress(provider.key);
        applyRemoteHistory(provider, list, remoteHistory);
        applyProgress(provider, list, progress);
    }
    function reconcileProgress(): void {
        resetTransientCoverState(list);
        applyHistoryLayers();
    }
    let historyRequestGeneration = 0;
    let historyRequestLifecycle = -1;
    function reconcileRemoteHistory(): void {
        if (!active || !provider.fetchRemoteHistory || historyRequestLifecycle === lifecycleVersion) return;
        historyRequestLifecycle = lifecycleVersion;
        const generation = ++historyRequestGeneration;
        void provider.fetchRemoteHistory()
            .then(history => {
                if (generation !== historyRequestGeneration || !active) return;
                remoteHistory = history;
                applyHistoryLayers();
            })
            .catch(error => console.error('Provider history sidecar failed', error));
    }
    function reconcilePageShow(): void {
        reconcileProgress();
        reconcileRemoteHistory();
    }
    window.addEventListener('pageshow', reconcilePageShow);
    reconcileRemoteHistory();
    window.setInterval(() => updateUnlockCountdowns(section), 60_000);

    const seenCursors = new Set<string>();
    let nextCursor = firstPage.nextCursor;
    while (nextCursor !== null) {
        if (seenCursors.has(nextCursor)) {
            status.classList.add('hs-home-catalog-error');
            status.textContent = `Stopped loading: provider repeated catalog cursor ${nextCursor}`;
            return;
        }
        await waitForNextRequest();
        const requestCursor = nextCursor;
        const requestLifecycle = lifecycleVersion;
        try {
            const page = await provider.fetchHome(requestCursor);
            seenCursors.add(requestCursor);
            appendPage(page);
            nextCursor = page.nextCursor;
            status.textContent = statusText(cards.size, total, nextCursor !== null);
        } catch (error) {
            if (requestLifecycle !== lifecycleVersion) {
                await waitUntilActive();
                continue;
            }
            status.classList.add('hs-home-catalog-error');
            status.textContent = `Loaded ${cards.size} series; more could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
            return;
        }
    }
}
