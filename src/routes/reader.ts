import type { ChapterData, ChapterMeta, Provider, RouteMatch } from '../provider';
import { Handler } from '../provider';
import { createReaderTracker } from '../core/tracking';
import { registerImage } from '../core/image-retry';

function imageLoaded(image: HTMLImageElement): boolean {
    return image.complete && image.naturalWidth > 0;
}

function waitForImage(image: HTMLImageElement): Promise<void> {
    if (imageLoaded(image)) return Promise.resolve();

    return new Promise(resolve => {
        const onLoad = () => {
            if (!imageLoaded(image)) return;
            image.removeEventListener('load', onLoad);
            resolve();
        };
        image.addEventListener('load', onLoad);
        if (imageLoaded(image)) onLoad();
    });
}

async function restoreScroll(
    wrap: HTMLDivElement,
    target: HTMLImageElement,
): Promise<void> {
    const images = Array.from(wrap.querySelectorAll<HTMLImageElement>('.hs-reader-img'));
    const targetIndex = images.indexOf(target);
    const firstImage = images[0];
    if (!firstImage) throw new Error('Cannot restore a chapter with no images');
    if (targetIndex === -1) throw new Error('Scroll target does not belong to the chapter');
    await waitForImage(firstImage);
    window.scrollTo(0, firstImage.offsetTop);

    for (let index = 1; index <= targetIndex; index++) {
        const image = images[index];
        window.scrollTo(0, image.offsetTop);
        await waitForImage(image);
    }

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
        const reconcileAspectRatio = () => {
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                img.style.removeProperty('height');
                img.style.aspectRatio = img.naturalWidth + '/' + img.naturalHeight;
            }
        };
        img.addEventListener('load', reconcileAspectRatio);
        img.loading = 'lazy';
        img.src = imgData.url;
        registerImage(img);
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

function findNewerChapter(chaptersNewestFirst: ChapterMeta[], currentChapterId: string): ChapterMeta | null {
    const currentIdx = chaptersNewestFirst.findIndex(chapter => chapter.chapterId === currentChapterId);
    if (currentIdx === -1) throw new Error(`Chapter list does not contain ${currentChapterId}`);
    if (currentIdx === 0) return null;
    const chapter = chaptersNewestFirst[currentIdx - 1];
    if (chapter === undefined) throw new Error('Chapter ordering invariant failed');
    return chapter;
}

type ChapterListState =
    | { kind: 'loading'; pendingScrollEnd: boolean }
    | { kind: 'ready'; chapters: ChapterMeta[] }
    | { kind: 'failed' };

type ChapterLoadState = 'loading' | 'loaded' | 'unavailable' | 'failed';

// ── main ─────────────────────────────────────────────────────────────

export async function open(
    provider: Provider,
    route: Extract<RouteMatch, { handler: Handler.Reader }>,
): Promise<void> {
    const { slug: routeSlug, chapterId } = route;
    // 1. Load the current chapter
    const initial = await provider.loadChapter({ slug: routeSlug, chapterId, intent: 'open' });
    if (initial.kind === 'navigate') {
        window.location.href = initial.url;
        return; // just for visuals, location.href redirects the page making further execution impossible
    }
    const data = initial.data;
    const slug = data.seriesSlug;

    document.title = `${data.chapterId} ${data.seriesTitle}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'hs-reader-body';
    document.body.appendChild(wrapper);

    const firstWrap = createChapterWrapper(data.chapterId);
    renderChapterImages(firstWrap, data);
    wrapper.appendChild(firstWrap);

    const chapterData = new Map<string, ChapterData>([[data.chapterId, data]]);

    // 2. Restore scroll position
    const target = route.imageIndex
        ? document.getElementById(`#${route.imageIndex}`) as HTMLImageElement | null
        : null;
    let restoring = Boolean(target);

    // 3. Async: fetch chapter list
    let chapterListState: ChapterListState = { kind: 'loading', pendingScrollEnd: false };
    const chapterLoadStates = new Map<string, ChapterLoadState>([[data.chapterId, 'loaded']]);

    const chaptersLoadingStatus = createStatus('Loading chapters...', 'hs-loading');
    wrapper.appendChild(chaptersLoadingStatus);
    void provider.fetchChaptersNewestFirst(slug).then(
        chapters => {
            if (chapterListState.kind !== 'loading') {
                throw new Error(`Cannot finish chapter list from ${chapterListState.kind} state`);
            }
            const chapterIds = new Set<string>();
            for (const chapter of chapters) {
                if (chapterIds.has(chapter.chapterId)) {
                    throw new Error(`Chapter list repeats ${chapter.chapterId}`);
                }
                chapterIds.add(chapter.chapterId);
            }
            if (!chapterIds.has(data.chapterId)) {
                throw new Error(`Chapter list does not contain the loaded chapter ${data.chapterId}`);
            }
            const { pendingScrollEnd } = chapterListState;
            chapterListState = { kind: 'ready', chapters };
            chaptersLoadingStatus.remove();
            if (pendingScrollEnd) {
                scrollEndOneHundred();
            }
        },
        () => {
            chapterListState = { kind: 'failed' };
            setStatus(chaptersLoadingStatus, 'Failed to load chapter list', 'hs-error');
        },
    );

    // 4. Scroll handler
    let lastSavedImage = '';
    let trackingState: 'healthy' | 'failed' = 'healthy';
    const tracker = createReaderTracker(provider, {
        seriesSlug: slug,
        historyId: data.historyId,
        onError() {
            if (trackingState === 'failed') return;
            trackingState = 'failed';
            wrapper.appendChild(createStatus('Progress sync failed', 'hs-error'));
        },
    });
    function scrollEndOneHundred() {
        setTimeout(() => {
            if (restoring) return;

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

            switch (chapterListState.kind) {
                case 'loading':
                    chapterListState = { kind: 'loading', pendingScrollEnd: true };
                    return;
                case 'failed':
                    return;
                case 'ready':
                    break;
            }

            const chapterWraps = wrapper.querySelectorAll<HTMLDivElement>('.hs-chapter');
            if (chapterWrap !== chapterWraps[chapterWraps.length - 1]) return;

            const newerChapter = findNewerChapter(chapterListState.chapters, visibleChapter);
            if (newerChapter === null || chapterLoadStates.has(newerChapter.chapterId)) return;

            chapterLoadStates.set(newerChapter.chapterId, 'loading');
            const newerChapterLoadingStatus = createStatus('Loading newer chapter...', 'hs-loading');
            wrapper.appendChild(newerChapterLoadingStatus);
            void provider.loadChapter({ slug, chapterId: newerChapter.chapterId, intent: 'append' }).then(
                result => {
                    if (result.kind === 'stop') {
                        chapterLoadStates.set(newerChapter.chapterId, 'unavailable');
                        setStatus(newerChapterLoadingStatus, 'Chapter unavailable', 'hs-error');
                        return;
                    }
                    if (result.data.chapterId !== newerChapter.chapterId) {
                        throw new Error(`Loaded chapter ${result.data.chapterId} for ${newerChapter.chapterId}`);
                    }
                    chapterLoadStates.set(newerChapter.chapterId, 'loaded');
                    chapterData.set(newerChapter.chapterId, result.data);
                    const wrapEl = createChapterWrapper(result.data.chapterId);
                    renderChapterImages(wrapEl, result.data);
                    wrapper.appendChild(wrapEl);
                    newerChapterLoadingStatus.remove();
                },
                () => {
                    chapterLoadStates.set(newerChapter.chapterId, 'failed');
                    setStatus(newerChapterLoadingStatus, 'Failed to load chapter', 'hs-error');
                },
            );
        }, 100);
    }
    window.addEventListener('scrollend', scrollEndOneHundred);
    // bfcache-specific: after a swipe-back restore, save the current position.
    window.addEventListener('pagereveal', scrollEndOneHundred);
    window.addEventListener('load', scrollEndOneHundred, { once: true });
    firstWrap.querySelector<HTMLImageElement>('.hs-reader-img')
        ?.addEventListener('load', scrollEndOneHundred, { once: true });
    if (target) {
        void restoreScroll(firstWrap, target).finally(() => {
            restoring = false;
            scrollEndOneHundred();
        });
    } else {
        scrollEndOneHundred();
    }
}
