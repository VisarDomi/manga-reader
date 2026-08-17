import type {
    ChapterMeta,
    HomeChapter,
    HomePage,
    HomeSeries,
    Provider,
    RemoteSeriesHistory,
} from '../provider';
import { enqueue } from '../core/update-queue';
import { resolveHistoryAsync } from '../core/compute/history-client';
import { fetchRemoteHistoryAsync } from '../core/compute/remote-history-client';
import { computeRequest } from '../core/compute/transport';
import { registerImage } from '../core/image-retry';
import type { CardResolution, CoverResumeModel } from '../core/compute/history';

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

function historyId(series: HomeSeries): string {
    return series.historyId ?? series.slug;
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

const coverResume = new WeakMap<HTMLAnchorElement, CoverResumeModel>();

function resumeAfterRead(
    chaptersNewestFirst: ChapterMeta[],
    resume: Extract<CoverResumeModel, { kind: 'read' }>,
): ChapterMeta | undefined {
    const firstUnread = [...chaptersNewestFirst].reverse().find(chapter => {
        if (resume.locallyReadChapterIds.includes(chapter.chapterId)) return false;
        return resume.readThroughChapterId === undefined
            || !chapterAtOrBefore(chapter.chapterId, resume.readThroughChapterId);
    });
    if (firstUnread !== undefined) return firstUnread;
    return chaptersNewestFirst[0];
}

function chapterAtOrBefore(chapterId: string, boundaryId: string): boolean {
    const chapter = Number(chapterId);
    const boundary = Number(boundaryId);
    if (Number.isFinite(chapter) && Number.isFinite(boundary)) return chapter <= boundary;
    return chapterId === boundaryId;
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
    registerImage(cover);
    coverLink.appendChild(cover);
    coverLink.addEventListener('click', event => {
        const resume = coverResume.get(coverLink);
        if (resume === undefined) {
            throw new Error(`Cover resume state was not initialized for ${series.slug}`);
        }
        if (resume.kind === 'local-partial') return;
        if (resume.kind === 'remote-partial') {
            event.preventDefault();
            if (coverLink.dataset.loading === 'true') return;
            coverLink.dataset.loading = 'true';
            coverLink.classList.add('hs-home-cover-loading');
            void resumeRemotePage(provider, series.slug, resume.chapterId, resume.percent)
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
                const destination = resume.kind === 'read'
                    ? resumeAfterRead(chapters, resume)
                    : chapters.at(-1);
                coverLink.dataset.loading = 'false';
                coverLink.classList.remove('hs-home-cover-loading');
                window.location.href = destination
                    ? provider.readerUrl(series.slug, destination.chapterId)
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

function applyCardPatch(
    provider: Provider,
    cards: Map<string, { series: HomeSeries; element: HTMLElement }>,
    patch: CardResolution,
): void {
    const entry = cards.get(patch.seriesSlug);
    if (!entry) return; // rendered later; the post-catalog refresh covers it
    const card = entry.element;
    for (const chapter of patch.chapters) {
        const link = card.querySelector<HTMLAnchorElement>(`[data-chapter-id="${chapter.chapterId}"]`);
        if (!link) continue;
        link.classList.toggle('hs-home-chapter-read', chapter.read);
        link.classList.toggle('hs-home-chapter-partial', chapter.partial);
        if (chapter.remoteResumePercent !== undefined) {
            link.dataset.remoteResumePercent = String(chapter.remoteResumePercent);
        } else {
            delete link.dataset.remoteResumePercent;
        }
        if (chapter.localImageIndex !== undefined && !link.classList.contains('hs-home-chapter-locked')) {
            link.href = provider.readerUrl(entry.series.slug, chapter.chapterId, String(chapter.localImageIndex));
        } else {
            link.href = provider.readerUrl(entry.series.slug, chapter.chapterId);
        }
    }

    const cover = card.querySelector<HTMLAnchorElement>('.hs-home-cover');
    if (!cover) return;
    delete cover.dataset.remoteResumeChapterId;
    delete cover.dataset.remoteResumePercent;
    const resume = patch.cover;
    switch (resume.kind) {
        case 'local-partial':
            coverResume.set(cover, {
                kind: 'local-partial',
                chapterId: resume.chapterId,
                imageIndex: resume.imageIndex,
            });
            cover.dataset.resume = 'local';
            cover.href = provider.readerUrl(entry.series.slug, resume.chapterId, String(resume.imageIndex));
            return;
        case 'remote-partial':
            coverResume.set(cover, {
                kind: 'remote-partial',
                chapterId: resume.chapterId,
                percent: resume.percent,
            });
            cover.dataset.resume = 'remote';
            cover.dataset.remoteResumeChapterId = resume.chapterId;
            cover.dataset.remoteResumePercent = String(resume.percent);
            cover.href = provider.readerUrl(entry.series.slug, resume.chapterId);
            return;
        case 'read':
            coverResume.set(cover, {
                kind: 'read',
                readThroughChapterId: resume.readThroughChapterId,
                locallyReadChapterIds: resume.locallyReadChapterIds,
            });
            cover.dataset.resume = 'read';
            cover.href = resume.resumeChapterId !== undefined
                ? provider.readerUrl(entry.series.slug, resume.resumeChapterId)
                : provider.seriesUrl(entry.series.slug);
            return;
        case 'none':
            coverResume.set(cover, { kind: 'none' });
            cover.dataset.resume = 'false';
            cover.href = provider.seriesUrl(entry.series.slug);
            return;
    }
}

type HistoryErrorReporter = (message: string | null) => void;

function queueHistoryRefresh(
    provider: Provider,
    cards: Map<string, { series: HomeSeries; element: HTMLElement }>,
    remoteHistory: RemoteSeriesHistory[],
    reportHistoryError: HistoryErrorReporter,
): void {
    const cardInputs = [...cards.values()].map(({ series }) => ({
        seriesSlug: series.slug,
        historyId: series.historyId ?? series.slug,
        chapterIds: series.chapters.map(chapter => chapter.chapterId),
    }));
    void resolveHistoryAsync({ cards: cardInputs, remoteHistory })
        .then(patches => {
            enqueue('history', patches.map(patch => () => applyCardPatch(provider, cards, patch)));
            reportHistoryError(null);
        })
        .catch(error => {
            console.error('History resolution failed', error);
            reportHistoryError(`History unavailable: ${error instanceof Error ? error.message : String(error)}`);
        });
}

function appendPageDeferred(
    provider: Provider,
    cards: Map<string, { series: HomeSeries; element: HTMLElement }>,
    list: HTMLDivElement,
    remoteHistory: RemoteSeriesHistory[],
    reportHistoryError: HistoryErrorReporter,
    page: HomePage,
    onBatchApplied: () => void,
): void {
    const steps: Array<() => void> = page.series.map(series => () => {
        const current = cards.get(series.slug);
        if (!current) {
            const element = renderSeries(provider, series);
            cards.set(series.slug, { series, element });
            list.appendChild(element);
            return;
        }
        const merged = mergeSeries(current.series, series);
        if (merged.chapters.length === current.series.chapters.length) return;
        const element = renderSeries(provider, merged);
        current.element.replaceWith(element);
        cards.set(series.slug, { series: merged, element });
    });
    // The counter must reflect the batch that actually rendered: refresh it
    // after the deferred steps apply (the loop's own status write shows the
    // pre-batch count).
    steps.push(() => {
        queueHistoryRefresh(provider, cards, remoteHistory, reportHistoryError);
        onBatchApplied();
    });
    enqueue('catalog', steps);
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
    let remoteHistory: RemoteSeriesHistory[] = [];

    function fetchPage(cursor: string | null): Promise<HomePage> {
        if (provider.catalogInWorker) {
            return computeRequest('fetch-home', { provider: provider.key, cursor });
        }
        return provider.fetchHome(cursor);
    }

    let firstPage: HomePage;
    try {
        firstPage = await fetchPage(null);
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

    // One owned notice for history-pipeline failures: replaced on each
    // failure, removed when a later pass succeeds. Never stacks.
    let historyNotice: HTMLDivElement | null = null;
    function reportHistoryError(message: string | null): void {
        historyNotice?.remove();
        historyNotice = null;
        if (message === null) return;
        const notice = document.createElement('div');
        notice.className = 'hs-home-error';
        notice.textContent = message;
        historyNotice = notice;
        list.appendChild(notice);
    }

    // First paint is synchronous by design; the history overlay lands one
    // worker round trip later through the idle queue.
    function appendFirstPage(page: HomePage): void {
        if (page.total !== undefined) total = page.total;
        for (const series of page.series) {
            const element = renderSeries(provider, series);
            cards.set(series.slug, { series, element });
            list.appendChild(element);
        }
        status.textContent = statusText(cards.size, total, page.nextCursor !== null);
    }
    appendFirstPage(firstPage);
    queueHistoryRefresh(provider, cards, remoteHistory, reportHistoryError);

    let historyRequestGeneration = 0;
    let historyRequestLifecycle = -1;
    function reconcileRemoteHistory(): void {
        if (!active || !provider.remoteHistoryInWorker || historyRequestLifecycle === lifecycleVersion) return;
        historyRequestLifecycle = lifecycleVersion;
        const generation = ++historyRequestGeneration;
        void fetchRemoteHistoryAsync({ provider: provider.key })
            .then(history => {
                if (generation !== historyRequestGeneration || !active) return;
                remoteHistory = history;
                queueHistoryRefresh(provider, cards, remoteHistory, reportHistoryError);
            })
            .catch(error => console.error('Provider history sidecar failed', error));
    }
    function reconcilePageShow(): void {
        resetTransientCoverState(list);
        queueHistoryRefresh(provider, cards, remoteHistory, reportHistoryError);
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
            const page = await fetchPage(requestCursor);
            seenCursors.add(requestCursor);
            appendPageDeferred(provider, cards, list, remoteHistory, reportHistoryError, page, () => {
                status.textContent = statusText(cards.size, total, page.nextCursor !== null);
            });
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
