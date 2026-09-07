import type {
    HomeChapter,
    HomePage,
    HomeSeries,
    Provider,
    RemoteSeriesHistory,
} from '../provider';
import { HomeDestinationKind } from '../provider';
import { UpdateKind, UpdateQueue } from '../core/update-queue';
import { computeRequest } from '../core/compute/transport';
import { ImageRetryRegistry } from '../core/image-retry';
import { CoverResumeKind } from '../core/compute/history';
import type { CardResolution, CoverResumeModel } from '../core/compute/history';
import { onBfcacheRestore } from '../core/lifecycle';
import { backupMangaHome } from '../core/home-backup';

const POLITE_PAGE_DELAY_MS = 1_000;

enum PauseOutcomeKind {
    Complete,
    Paused,
}

type PauseOutcome<T> =
    | { kind: PauseOutcomeKind.Complete; value: T }
    | { kind: PauseOutcomeKind.Paused };

function settleBeforePause<T>(
    start: () => Promise<T>,
    signal: AbortSignal,
): Promise<PauseOutcome<T>> {
    if (signal.aborted) return Promise.resolve({ kind: PauseOutcomeKind.Paused });
    const operation = start();
    return new Promise((resolve, reject) => {
        let settled = false;
        const onPause = (): void => {
            if (settled) return;
            settled = true;
            resolve({ kind: PauseOutcomeKind.Paused });
        };
        signal.addEventListener('abort', onPause, { once: true });
        operation.then(
            value => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onPause);
                resolve({ kind: PauseOutcomeKind.Complete, value });
            },
            error => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onPause);
                reject(error);
            },
        );
    });
}

function createLink(className: string, href: string, text?: string): HTMLAnchorElement {
    const link = document.createElement('a');
    link.className = className;
    link.href = href;
    link.dataset.requestState = LinkRequestState.Idle;
    if (text !== undefined) link.textContent = text;
    return link;
}

enum LinkRequestState {
    Idle = 'idle',
    Loading = 'loading',
    Failed = 'failed',
}

function beginLinkRequest(link: HTMLAnchorElement): boolean {
    const state = link.dataset.requestState;
    if (state === LinkRequestState.Loading) return false;
    if (state !== LinkRequestState.Idle && state !== LinkRequestState.Failed) {
        throw new Error(`Invalid link request state: ${String(state)}`);
    }
    setLinkRequestState(link, LinkRequestState.Loading);
    return true;
}

function setLinkRequestState(
    link: HTMLAnchorElement,
    state: LinkRequestState,
    failureTitle?: string,
): void {
    link.dataset.requestState = state;
    link.classList.toggle('hs-home-link-loading', state === LinkRequestState.Loading);
    link.classList.toggle(
        'hs-home-cover-loading',
        state === LinkRequestState.Loading && link.classList.contains('hs-home-cover'),
    );
    link.classList.toggle('hs-home-link-failed', state === LinkRequestState.Failed);
    if (state === LinkRequestState.Failed) {
        if (failureTitle === undefined) throw new Error('Failed link state requires a title');
        link.title = failureTitle;
    } else {
        link.removeAttribute('title');
    }
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

const coverResume = new WeakMap<HTMLAnchorElement, CoverResumeModel>();

function renderChapter(provider: Provider, series: HomeSeries, chapter: HomeChapter): HTMLAnchorElement {
    const classes = ['hs-home-chapter'];
    if (chapter.locked) classes.push('hs-home-chapter-locked');
    const link = createLink(classes.join(' '), provider.readerUrl(series.slug, chapter.chapterId));
    link.dataset.chapterId = chapter.chapterId;
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
        if (
            link.classList.contains('hs-home-chapter-read')
            && link.hash === ''
        ) {
            // Server-read without a local page: jump to the last image.
            event.preventDefault();
            if (!beginLinkRequest(link)) return;
            void provider.resolveHomeDestination({
                kind: HomeDestinationKind.Resume,
                seriesSlug: series.slug,
                chapterId: chapter.chapterId,
            })
                .then(url => {
                    window.location.href = url;
                })
                .catch(() => {
                    setLinkRequestState(link, LinkRequestState.Failed, 'Failed to open chapter');
                });
        }
    });
    return link;
}

function renderSeries(
    provider: Provider,
    series: HomeSeries,
    imageRetry: ImageRetryRegistry,
): HTMLElement {
    const card = document.createElement('article');
    card.className = 'hs-home-card';

    const coverLink = createLink('hs-home-cover', provider.seriesUrl(series.slug));
    coverResume.set(coverLink, { kind: CoverResumeKind.None });
    const cover = document.createElement('img');
    cover.src = series.coverUrl;
    cover.alt = series.title;
    cover.loading = 'lazy';
    imageRetry.register(cover);
    coverLink.appendChild(cover);
    coverLink.addEventListener('click', event => {
        const resume = coverResume.get(coverLink);
        if (resume === undefined) {
            throw new Error(`Cover resume state was not initialized for ${series.slug}`);
        }
        if (resume.kind === CoverResumeKind.LocalPartial) return;
        event.preventDefault();
        if (!beginLinkRequest(coverLink)) return;
        void (async () => {
                if (resume.kind === CoverResumeKind.Read) {
                    // End of the last-read chapter: the reader then loads the
                    // next one as the user continues.
                    const lastChapterId = resume.latestLocalComplete?.chapterId
                        ?? resume.resumeChapterId;
                    if (lastChapterId === undefined) {
                        return provider.resolveHomeDestination({
                            kind: HomeDestinationKind.Start,
                            seriesSlug: series.slug,
                        });
                    }
                    let imageIndex: string | undefined;
                    if (
                        resume.latestLocalComplete !== undefined
                        && resume.latestLocalComplete.chapterId === lastChapterId
                    ) {
                        imageIndex = String(resume.latestLocalComplete.imageIndex);
                    }
                    return provider.resolveHomeDestination({
                        kind: HomeDestinationKind.Resume,
                        seriesSlug: series.slug,
                        chapterId: lastChapterId,
                        imageIndex,
                    });
                }
                return provider.resolveHomeDestination({
                    kind: HomeDestinationKind.Start,
                    seriesSlug: series.slug,
                });
            })()
            .then(destinationUrl => {
                window.location.href = destinationUrl;
            })
            .catch(() => {
                setLinkRequestState(coverLink, LinkRequestState.Failed, 'Failed to open series');
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
        if (!unlockAt) throw new Error('Locked countdown has no unlock time');
        const time = chapter.querySelector('time');
        if (!time) throw new Error('Locked chapter has no time element');
        if (new Date(unlockAt).getTime() > Date.now()) {
            time.textContent = unlockCountdown(unlockAt);
            continue;
        }
        time.textContent = '0m';
    }
}

function applyCardPatch(
    provider: Provider,
    cards: Map<string, { series: HomeSeries; element: HTMLElement }>,
    patch: CardResolution,
): void {
    const entry = cards.get(patch.seriesSlug);
    if (!entry) throw new Error(`History patch references missing series ${patch.seriesSlug}`);
    const card = entry.element;
    for (const chapter of patch.chapters) {
        const link = card.querySelector<HTMLAnchorElement>(`[data-chapter-id="${chapter.chapterId}"]`);
        if (!link) throw new Error(`History patch references missing chapter ${chapter.chapterId}`);
        link.classList.toggle('hs-home-chapter-read', chapter.read);
        link.classList.toggle('hs-home-chapter-partial', chapter.partial);
        if (chapter.localImageIndex !== undefined && !link.classList.contains('hs-home-chapter-locked')) {
            link.href = provider.readerUrl(entry.series.slug, chapter.chapterId, String(chapter.localImageIndex));
        } else {
            link.href = provider.readerUrl(entry.series.slug, chapter.chapterId);
        }
    }

    const cover = card.querySelector<HTMLAnchorElement>('.hs-home-cover');
    if (!cover) throw new Error(`Series ${patch.seriesSlug} has no cover link`);
    const resume = patch.cover;
    switch (resume.kind) {
        case CoverResumeKind.LocalPartial:
            coverResume.set(cover, {
                kind: CoverResumeKind.LocalPartial,
                chapterId: resume.chapterId,
                imageIndex: resume.imageIndex,
            });
            cover.href = provider.readerUrl(entry.series.slug, resume.chapterId, String(resume.imageIndex));
            return;
        case CoverResumeKind.Read:
            coverResume.set(cover, {
                kind: CoverResumeKind.Read,
                resumeChapterId: resume.resumeChapterId,
                latestLocalComplete: resume.latestLocalComplete,
            });
            cover.href = resume.resumeChapterId !== undefined
                ? provider.readerUrl(entry.series.slug, resume.resumeChapterId)
                : provider.seriesUrl(entry.series.slug);
            return;
        case CoverResumeKind.None:
            coverResume.set(cover, { kind: CoverResumeKind.None });
            cover.href = provider.seriesUrl(entry.series.slug);
            return;
    }
}

function queueHistoryRefresh(
    updates: UpdateQueue,
    provider: Provider,
    cards: Map<string, { series: HomeSeries; element: HTMLElement }>,
    remoteHistory: RemoteSeriesHistory[],
    signal: AbortSignal,
    isCurrent: () => boolean,
): void {
    const cardInputs = [...cards.values()].map(({ series }) => ({
        seriesSlug: series.slug,
        historyId: series.historyId ?? series.slug,
        chapterIds: series.chapters.map(chapter => chapter.chapterId),
    }));
    void settleBeforePause(() => computeRequest('history-resolve', { cards: cardInputs, remoteHistory }), signal)
        .then(outcome => {
            if (outcome.kind === PauseOutcomeKind.Paused || !isCurrent()) return;
            updates.enqueue(UpdateKind.History, outcome.value.map(patch => () => {
                if (!isCurrent()) return;
                applyCardPatch(provider, cards, patch);
            }));
        });
}

function appendPageWhenIdle(
    updates: UpdateQueue,
    imageRetry: ImageRetryRegistry,
    provider: Provider,
    cards: Map<string, { series: HomeSeries; element: HTMLElement }>,
    list: HTMLDivElement,
    page: HomePage,
): Promise<void> {
    // The pagination loop awaits this batch, so catalog pages cannot
    // supersede one another in the latest-wins update queue.
    return new Promise((resolve, reject) => {
        updates.enqueue(UpdateKind.Catalog, [() => {
            try {
                for (const series of page.series) {
                    const current = cards.get(series.slug);
                    if (!current) {
                        const element = renderSeries(provider, series, imageRetry);
                        cards.set(series.slug, { series, element });
                        list.appendChild(element);
                        continue;
                    }
                    const merged = mergeSeries(current.series, series);
                    if (merged.chapters.length === current.series.chapters.length) continue;
                    const element = renderSeries(provider, merged, imageRetry);
                    current.element.replaceWith(element);
                    cards.set(series.slug, { series: merged, element });
                }
                resolve();
            } catch (error) {
                reject(error);
            }
        }]);
    });
}

function statusText(loaded: number, total: number | undefined, loading: boolean): string {
    const count = total === undefined ? `${loaded}` : `${loaded} of ${total}`;
    return loading ? `Loaded ${count} series · loading more…` : `Loaded ${count} series`;
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

function resetTransientLinkState(root: ParentNode): void {
    for (const link of root.querySelectorAll<HTMLAnchorElement>('.hs-home-link-loading')) {
        setLinkRequestState(link, LinkRequestState.Idle);
    }
}

export async function open(provider: Provider): Promise<void> {
    const updates = new UpdateQueue();
    const imageRetry = new ImageRetryRegistry();
    let active = !document.hidden;
    let lifecycleVersion = 0;
    let activePeriod = new AbortController();
    if (!active) activePeriod.abort();
    let resumeWaiters: Array<() => void> = [];
    function pause(): void {
        if (!active) return;
        active = false;
        lifecycleVersion += 1;
        activePeriod.abort();
    }
    function resume(): void {
        if (active) return;
        active = true;
        activePeriod = new AbortController();
        const waiters = resumeWaiters;
        resumeWaiters = [];
        for (const resume of waiters) resume();
    }
    window.addEventListener('pagehide', pause);
    onBfcacheRestore(resume);
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

    async function fetchPageWhileActive(cursor: string | null, politeDelay: boolean): Promise<HomePage> {
        for (;;) {
            if (politeDelay) await waitForNextRequest();
            else await waitUntilActive();
            const outcome = await settleBeforePause(() => provider.fetchHome(cursor), activePeriod.signal);
            if (outcome.kind === PauseOutcomeKind.Complete) return outcome.value;
        }
    }

    const loading = document.createElement('div');
    loading.className = 'hs-home-loading';
    loading.textContent = 'Loading latest updates…';
    document.body.appendChild(loading);
    // Backups also work when the provider catalog is slow or unavailable.
    setTimeout(() => { void backupMangaHome(provider.key); }, 0);
    let remoteHistory: RemoteSeriesHistory[] = [];

    const firstPage = await fetchPageWhileActive(null, false);

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
    let historyResolutionGeneration = 0;
    function refreshHistory(): void {
        const generation = ++historyResolutionGeneration;
        queueHistoryRefresh(
            updates,
            provider,
            cards,
            remoteHistory,
            activePeriod.signal,
            () => generation === historyResolutionGeneration,
        );
    }

    // First paint is synchronous by design; the history overlay lands one
    // worker round trip later through the idle queue.
    function appendFirstPage(page: HomePage): void {
        if (page.total !== undefined) total = page.total;
        for (const series of page.series) {
            if (cards.has(series.slug)) throw new Error(`First home page repeats series ${series.slug}`);
            const element = renderSeries(provider, series, imageRetry);
            cards.set(series.slug, { series, element });
            list.appendChild(element);
        }
        status.textContent = statusText(cards.size, total, page.nextCursor !== null);
    }
    appendFirstPage(firstPage);
    refreshHistory();
    window.addEventListener('reader-data-restored', refreshHistory);

    let historyRequestGeneration = 0;
    let historyRequestLifecycle = -1;
    function reconcileRemoteHistory(): void {
        const fetchRemoteHistory = provider.fetchRemoteHistory;
        if (!active || fetchRemoteHistory === undefined || historyRequestLifecycle === lifecycleVersion) return;
        historyRequestLifecycle = lifecycleVersion;
        const generation = ++historyRequestGeneration;
        void settleBeforePause(() => fetchRemoteHistory(), activePeriod.signal)
            .then(outcome => {
                if (outcome.kind === PauseOutcomeKind.Paused) return;
                if (generation !== historyRequestGeneration || !active) return;
                remoteHistory = outcome.value;
                refreshHistory();
            });
    }
    function reconcilePageShow(): void {
        resetTransientLinkState(list);
        refreshHistory();
        reconcileRemoteHistory();
    }
    // A restored DOM carries the history overlay from before the reader was opened.
    onBfcacheRestore(reconcilePageShow);
    reconcileRemoteHistory();
    window.setInterval(() => updateUnlockCountdowns(section), 60_000);

    const seenCursors = new Set<string>();
    let nextCursor = firstPage.nextCursor;
    while (nextCursor !== null) {
        if (seenCursors.has(nextCursor)) {
            throw new Error(`Provider repeated catalog cursor ${nextCursor}`);
        }
        seenCursors.add(nextCursor);
        const page = await fetchPageWhileActive(nextCursor, true);
        if (page.total !== undefined) total = page.total;
        await appendPageWhenIdle(updates, imageRetry, provider, cards, list, page);
        refreshHistory();
        nextCursor = page.nextCursor;
        status.textContent = statusText(cards.size, total, nextCursor !== null);
    }
}
