import { readerRestored } from '../core/platform';
import type { ChapterData, ChapterMeta, Provider, RouteMatch } from '../provider';
import { ChapterLoadIntent, ChapterLoadResultKind, Handler } from '../provider';
import { createReaderTracker } from '../core/tracking';
import { ImageRetryRegistry } from '../core/image-retry';
import { onBfcacheRestore } from '../core/lifecycle';
import { onSettledScroll } from '../core/scroll-settle';
import { withNewerChapters } from '../core/chapter-list';

function invalidInitialChapterState(state: never): never {
    throw new Error(`Invalid initial chapter state: ${String(state)}`);
}

function imageLoaded(image: HTMLImageElement): boolean {
    return image.complete && image.naturalWidth > 0;
}

function reconcileImageSize(image: HTMLImageElement): void {
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    if (image.style.height) image.style.removeProperty('height');
    const ratio = image.naturalWidth + '/' + image.naturalHeight;
    if (image.style.aspectRatio.replace(/\s/g, '') !== ratio) image.style.aspectRatio = ratio;
}

function waitForImage(image: HTMLImageElement, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (imageLoaded(image)) {
        // Safari can expose intrinsic dimensions before delivering load. Apply
        // them now, before restore measures the following image's offset.
        reconcileImageSize(image);
        return Promise.resolve(true);
    }

    return new Promise(resolve => {
        const finish = (loaded: boolean) => {
            image.removeEventListener('load', onLoad);
            signal.removeEventListener('abort', onAbort);
            if (loaded) reconcileImageSize(image);
            resolve(loaded);
        };
        const onLoad = () => {
            if (!imageLoaded(image)) return;
            finish(true);
        };
        const onAbort = () => finish(false);
        image.addEventListener('load', onLoad);
        signal.addEventListener('abort', onAbort, { once: true });
        if (imageLoaded(image)) onLoad();
    });
}

async function restoreScroll(
    wrap: HTMLDivElement,
    target: HTMLImageElement,
    signal: AbortSignal,
): Promise<void> {
    const images = Array.from(wrap.querySelectorAll<HTMLImageElement>('.hs-reader-img'));
    const targetIndex = images.indexOf(target);
    const firstImage = images[0];
    if (!firstImage) throw new Error('Cannot restore a chapter with no images');
    if (targetIndex === -1) throw new Error('Scroll target does not belong to the chapter');
    if (signal.aborted || !wrap.isConnected) return;
    // Cached images need no scroll-through loading. Batch their size writes
    // before a single layout read, including cached-but-not-yet-load-dispatched.
    const preceding = images.slice(0, targetIndex + 1);
    for (const image of preceding) if (imageLoaded(image)) reconcileImageSize(image);
    if (preceding.every(imageLoaded)) {
        window.scrollTo(0, target.offsetTop);
        return;
    }
    if (!await waitForImage(firstImage, signal) || signal.aborted || !wrap.isConnected) return;

    for (let index = 1; index <= targetIndex; index++) {
        const image = images[index];
        if (signal.aborted || !wrap.isConnected) return;
        if (imageLoaded(image)) {
            reconcileImageSize(image);
            continue;
        }
        window.scrollTo(0, image.offsetTop);
        if (!await waitForImage(image, signal)) return;
    }

    if (signal.aborted || !wrap.isConnected) return;
    window.scrollTo(0, target.offsetTop);
}

// ── render helpers ───────────────────────────────────────────────────

function createChapterWrapper(chapterId: string): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'hs-chapter';
    wrap.dataset.chapter = chapterId;
    return wrap;
}

function renderChapterImages(
    wrap: HTMLDivElement,
    data: ChapterData,
    imageRetry: ImageRetryRegistry,
): void {
    for (let i = 0; i < data.images.length; i++) {
        const img = document.createElement('img');
        const imgData = data.images[i];
        img.id = `#${i}`;
        img.className = 'hs-reader-img';
        if (imgData.width && imgData.height) {
            img.style.aspectRatio = imgData.width + '/' + imgData.height;
        } else if (!imgData.height) {
            img.style.height = '1000px';
        }
        const reconcileAspectRatio = () => reconcileImageSize(img);
        img.addEventListener('load', reconcileAspectRatio);
        img.loading = 'lazy';
        img.src = imgData.url;
        imageRetry.register(img);
        if (imageLoaded(img)) reconcileAspectRatio();
        wrap.appendChild(img);
    }
}

// ── loading / error indicator ────────────────────────────────────────

function createStatus(text: string, className: string): HTMLDivElement {
    const div = document.createElement('div');
    div.className = `hs-status ${className}`;
    div.textContent = text;
    return div;
}

function setStatus(status: HTMLDivElement, text: string, className: string): void {
    status.className = `hs-status ${className}`;
    status.textContent = text;
}

// A reader can stay open for days (a suspended app, Back/Forward cache), so the
// list it fetched can predate the next release. While the newest listed chapter
// is being read, the list is fetched again once it is this old.
const CHAPTER_LIST_REFRESH_MS = 5 * 60_000;
// A failed chapter list or newer chapter is requested again on a later settled
// position, no sooner than this.
const RETRY_MS = 15_000;

function validChapterList(chapters: ChapterMeta[], loadedChapterId: string): ChapterMeta[] {
    const chapterIds = new Set<string>();
    for (const chapter of chapters) {
        if (chapterIds.has(chapter.chapterId)) {
            throw new Error(`Chapter list repeats ${chapter.chapterId}`);
        }
        chapterIds.add(chapter.chapterId);
    }
    if (!chapterIds.has(loadedChapterId)) {
        throw new Error(`Chapter list does not contain the loaded chapter ${loadedChapterId}`);
    }
    return chapters;
}

function findNewerChapter(chaptersNewestFirst: ChapterMeta[], currentChapterId: string): ChapterMeta | null {
    const currentIdx = chaptersNewestFirst.findIndex(chapter => chapter.chapterId === currentChapterId);
    // Not listed (a refreshed list dropped it) or newest: nothing newer is known.
    if (currentIdx <= 0) return null;
    const chapter = chaptersNewestFirst[currentIdx - 1];
    if (chapter === undefined) throw new Error('Chapter ordering invariant failed');
    return chapter;
}

interface ChapterListState {
    /** Latest valid list; kept while a refresh is pending or after one fails. */
    chapters: ChapterMeta[] | null;
    loading: boolean;
    /** Earliest time the list may be fetched again. */
    dueAt: number;
}

enum ChapterLoadState {
    Loading,
    Loaded,
    Unavailable,
    Failed,
}

type ChapterLoad =
    | { state: ChapterLoadState.Loading }
    | { state: ChapterLoadState.Loaded }
    | { state: ChapterLoadState.Unavailable; retryAt: number }
    | { state: ChapterLoadState.Failed; retryAt: number };

enum TrackingState {
    Healthy,
    Failed,
}

// ── main ─────────────────────────────────────────────────────────────

export async function open(
    provider: Provider,
    route: Extract<RouteMatch, { handler: Handler.Reader }>,
): Promise<void> {
    const { slug: routeSlug, chapterId } = route;
    const restoreController = new AbortController();
    const cancelRestore = () => restoreController.abort();
    if (route.imageIndex) {
        // Register before the chapter fetch so input during loading also wins.
        for (const event of ['touchstart', 'pointerdown', 'wheel', 'keydown', 'pagehide']) {
            window.addEventListener(event, cancelRestore, { passive: true, signal: restoreController.signal });
        }
    }
    // 1. Load the current chapter
    const initialState = await provider.loadChapter({
        slug: routeSlug,
        chapterId,
        intent: ChapterLoadIntent.Open,
    }).catch(error => { cancelRestore(); throw error; });
    let data: ChapterData;
    switch (initialState.kind) {
        case ChapterLoadResultKind.Chapter:
            data = initialState.data;
            break;
        case ChapterLoadResultKind.Navigate:
            cancelRestore();
            window.location.href = initialState.url;
            return;
        default:
            cancelRestore();
            return invalidInitialChapterState(initialState);
    }
    const slug = data.seriesSlug;
    const imageRetry = new ImageRetryRegistry();

    document.title = `${data.chapterId} ${data.seriesTitle}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'hs-reader-body';
    document.body.appendChild(wrapper);

    const firstWrap = createChapterWrapper(data.chapterId);
    renderChapterImages(firstWrap, data, imageRetry);
    wrapper.appendChild(firstWrap);

    const chapterData = new Map<string, ChapterData>([[data.chapterId, data]]);

    // 2. Restore scroll position
    const target = route.imageIndex
        ? document.getElementById(`#${route.imageIndex}`) as HTMLImageElement | null
        : null;
    let restoring = Boolean(target) && !restoreController.signal.aborted;
    if (!target) cancelRestore();

    // 3. Async: fetch chapter list
    const chapterList: ChapterListState = { chapters: null, loading: false, dueAt: 0 };
    const chapterLoads = new Map<string, ChapterLoad>([[data.chapterId, { state: ChapterLoadState.Loaded }]]);
    const chapterStatuses = new Map<string, HTMLDivElement>();

    // Statuses describe a reader with no list at all; refreshing a usable list
    // (saved or fetched earlier) happens silently.
    const chapterListStatus = createStatus('Loading chapters...', 'hs-loading');
    function fetchChapterList(): void {
        if (chapterList.loading) return;
        chapterList.loading = true;
        if (chapterList.chapters === null) {
            setStatus(chapterListStatus, 'Loading chapters...', 'hs-loading');
            wrapper.appendChild(chapterListStatus);
        }
        void provider.fetchChaptersNewestFirst(slug)
            .then(chapters => {
                const fresh = validChapterList(chapters, data.chapterId);
                // A source answering from an older cache must not drop a newer
                // chapter already known from the saved list or an earlier answer.
                chapterList.chapters = chapterList.chapters === null
                    ? fresh
                    : withNewerChapters(fresh, chapterList.chapters);
                chapterList.dueAt = Date.now() + CHAPTER_LIST_REFRESH_MS;
                chapterListStatus.remove();
            })
            .catch(() => {
                chapterList.dueAt = Date.now() + RETRY_MS;
                if (chapterList.chapters === null) {
                    setStatus(chapterListStatus, 'Failed to load chapter list', 'hs-error');
                    wrapper.appendChild(chapterListStatus);
                }
            })
            .finally(() => {
                chapterList.loading = false;
                // Continue from wherever the reader settled while this was pending.
                schedulePositionUpdate();
            });
    }
    // A resumed chapter continues at once from the list prepared with it, while
    // the provider is asked for a current one.
    void provider.savedChaptersNewestFirst?.(slug)
        .then(saved => {
            if (saved === null || chapterList.chapters !== null) return;
            chapterList.chapters = validChapterList(saved, data.chapterId);
            chapterListStatus.remove();
            schedulePositionUpdate();
        })
        // A saved list that lacks this chapter is ignored; the provider's answer decides.
        .catch(() => {});
    fetchChapterList();

    function loadNewerChapter(newerChapter: ChapterMeta): void {
        const previous = chapterLoads.get(newerChapter.chapterId);
        if (previous !== undefined) {
            if (previous.state === ChapterLoadState.Loading || previous.state === ChapterLoadState.Loaded) return;
            if (Date.now() < previous.retryAt) return;
        }
        chapterLoads.set(newerChapter.chapterId, { state: ChapterLoadState.Loading });
        const status = chapterStatuses.get(newerChapter.chapterId)
            ?? createStatus('Loading newer chapter...', 'hs-loading');
        chapterStatuses.set(newerChapter.chapterId, status);
        setStatus(status, 'Loading newer chapter...', 'hs-loading');
        wrapper.appendChild(status);
        void provider.loadChapter({
            slug,
            chapterId: newerChapter.chapterId,
            intent: ChapterLoadIntent.Append,
        }).then(result => {
            if (result.kind === ChapterLoadResultKind.Stop) {
                chapterLoads.set(newerChapter.chapterId, {
                    state: ChapterLoadState.Unavailable,
                    retryAt: Date.now() + RETRY_MS,
                });
                setStatus(status, 'Chapter unavailable', 'hs-error');
                return;
            }
            if (result.data.chapterId !== newerChapter.chapterId) {
                throw new Error(`Loaded chapter ${result.data.chapterId} for ${newerChapter.chapterId}`);
            }
            chapterLoads.set(newerChapter.chapterId, { state: ChapterLoadState.Loaded });
            chapterData.set(newerChapter.chapterId, result.data);
            const wrapEl = createChapterWrapper(result.data.chapterId);
            renderChapterImages(wrapEl, result.data, imageRetry);
            status.replaceWith(wrapEl);
            chapterStatuses.delete(newerChapter.chapterId);
        }).catch(() => {
            chapterLoads.set(newerChapter.chapterId, {
                state: ChapterLoadState.Failed,
                retryAt: Date.now() + RETRY_MS,
            });
            setStatus(status, 'Failed to load chapter', 'hs-error');
        });
    }

    // Reading the last appended chapter: append the next listed one, or, when
    // none is known, check the provider's list again once it is due.
    function continueAfter(chapterId: string): void {
        const newerChapter = chapterList.chapters === null
            ? null
            : findNewerChapter(chapterList.chapters, chapterId);
        if (newerChapter !== null) {
            loadNewerChapter(newerChapter);
        } else if (Date.now() >= chapterList.dueAt) {
            fetchChapterList();
        }
    }

    // 4. Scroll handler
    let lastSavedImage = '';
    let trackingState = TrackingState.Healthy;
    const tracker = createReaderTracker(provider, {
        seriesSlug: slug,
        historyId: data.historyId,
        onError() {
            if (trackingState === TrackingState.Failed) return;
            trackingState = TrackingState.Failed;
            wrapper.appendChild(createStatus('Progress sync failed', 'hs-error'));
        },
    });
    function updateSettledPosition() {
        if (restoring || !wrapper.isConnected) return;

        const midpoint = window.innerHeight / 2;
        const saveImg = Array.from(wrapper.querySelectorAll<HTMLImageElement>('.hs-reader-img'))
            .filter(image => imageLoaded(image))
            .map(image => ({ image, top: image.getBoundingClientRect().top }))
            .filter(item => item.top <= midpoint)
            .sort((a, b) => b.top - a.top)[0]?.image;
        if (!saveImg) return;
        const chapterWrap = saveImg.closest<HTMLDivElement>('.hs-chapter');
        if (!chapterWrap) throw new Error('Reader image is outside a chapter wrapper');
        const visibleChapter = chapterWrap.dataset.chapter;
        if (visibleChapter === undefined) throw new Error('Chapter wrapper has no chapter identity');

        const imageIndex = /^#(\d+)$/.exec(saveImg.id)?.[1];
        if (imageIndex === undefined) throw new Error(`Invalid reader image identity: ${saveImg.id}`);
        const visibleData = chapterData.get(visibleChapter);
        if (visibleData === undefined) throw new Error(`Missing data for visible chapter ${visibleChapter}`);
        const imageKey = `${visibleChapter}:${imageIndex}`;
        if (lastSavedImage !== imageKey) {
            lastSavedImage = imageKey;
            history.replaceState(null, '', provider.readerUrl(slug, visibleChapter, imageIndex));
            document.title = `${visibleData.chapterId} ${visibleData.seriesTitle}`;
        }

        tracker.track(visibleData, imageIndex);

        const chapterWraps = wrapper.querySelectorAll<HTMLDivElement>('.hs-chapter');
        if (chapterWrap !== chapterWraps[chapterWraps.length - 1]) return;
        continueAfter(visibleChapter);
    }
    const schedulePositionUpdate = onSettledScroll(updateSettledPosition);
    onBfcacheRestore(schedulePositionUpdate);
    // Returning to a suspended app re-checks a list that may now be stale.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) schedulePositionUpdate();
    });
    window.addEventListener('load', schedulePositionUpdate, { once: true });
    firstWrap.querySelector<HTMLImageElement>('.hs-reader-img')
        ?.addEventListener('load', schedulePositionUpdate, { once: true });
    if (target) {
        void restoreScroll(firstWrap, target, restoreController.signal).finally(() => {
            readerRestored(target, data);
            restoring = false;
            cancelRestore();
            schedulePositionUpdate();
        });
    } else {
        readerRestored(null, data);
        schedulePositionUpdate();
    }
}
