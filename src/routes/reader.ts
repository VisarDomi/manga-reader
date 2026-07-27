import css from '../style.css?inline';
import type { ChapterData, ChapterMeta, Provider, RouteMatch } from '../provider';

function retryBrokenImages(selector: ".hs-reader-img" | ".hs-thumb", interval: number): void {
    setInterval(() => {
        const imgs = document.querySelectorAll<HTMLImageElement>(selector);
        for (const img of imgs) {
            if (!img.complete || img.naturalWidth > 0) continue; // safari ios doesn't execute img.onerror on 429s so we have to do hacks
            const src = img.src;
            img.src = ''; // safari ios needs its source cleared first so that it can register the new (same) source
            img.src = src;
        }
    }, interval);
}

function imageLoaded(image: HTMLImageElement): boolean {
    return image.complete && image.naturalWidth > 0;
}

function waitForImage(image: HTMLImageElement, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (imageLoaded(image)) return Promise.resolve(true);

    return new Promise(resolve => {
        const finish = (loaded: boolean) => {
            image.removeEventListener('load', onLoad);
            signal.removeEventListener('abort', onAbort);
            resolve(loaded);
        };
        const onLoad = () => {
            if (imageLoaded(image)) finish(true);
        };
        const onAbort = () => finish(false);
        image.addEventListener('load', onLoad);
        signal.addEventListener('abort', onAbort, { once: true });
        if (imageLoaded(image)) finish(true);
    });
}

function nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function waitForFinalProgrammaticScroll(): Promise<void> {
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            window.removeEventListener('scrollend', onScrollEnd);
            setTimeout(resolve, 110);
        };
        const onScrollEnd = () => finish();
        window.addEventListener('scrollend', onScrollEnd, { once: true });
        setTimeout(finish, 250);
    });
}

async function restoreScroll(
    body: HTMLDivElement,
    wrap: HTMLDivElement,
    target: HTMLImageElement,
): Promise<void> {
    const controller = new AbortController();
    const cancel = () => {
        if (controller.signal.aborted) return;
        controller.abort();
        body.dataset.restoreState = 'cancelled';
    };
    const cancellationEvents = ['touchstart', 'pointerdown', 'wheel', 'keydown'] as const;
    for (const event of cancellationEvents) {
        window.addEventListener(event, cancel, { once: true, passive: event !== 'keydown' });
    }

    body.dataset.restoreState = 'restoring';
    window.dispatchEvent(new Event('manga-reader:restore-start'));

    const images = Array.from(wrap.querySelectorAll<HTMLImageElement>('.hs-reader-img'));
    const targetIndex = images.indexOf(target);
    const firstImage = images[0];
    if (!firstImage || !await waitForImage(firstImage, controller.signal)) return;
    window.scrollTo(0, firstImage.offsetTop);
    await nextFrame();

    for (let index = 1; index <= targetIndex; index++) {
        if (controller.signal.aborted) return;
        const image = images[index];
        window.scrollTo(0, image.offsetTop);
        await nextFrame();
        if (!await waitForImage(image, controller.signal)) return;
    }

    window.scrollTo(0, target.offsetTop);
    await waitForFinalProgrammaticScroll();
    if (!controller.signal.aborted) body.dataset.restoreState = 'complete';
    for (const event of cancellationEvents) window.removeEventListener(event, cancel);
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
    provider: Provider,
    slug: string,
): void {
    for (let i = 0; i < data.images.length; i++) {
        const img = document.createElement('img');
        const imgData = data.images[i];
        img.id = `#${i}`;
        img.className = 'hs-reader-img';
        img.dataset.readerUrl = provider.readerUrl(slug, data.chapterId, String(i));
        if (imgData.width && imgData.height) {
            img.style.aspectRatio = imgData.width + '/' + imgData.height;
        }
        img.loading = 'lazy';
        img.src = imgData.url;
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

function findNewerChapter(chaptersNewestFirst: ChapterMeta[], currentChapterId: string): ChapterMeta | undefined {
    const currentIdx = chaptersNewestFirst.findIndex(chapter => chapter.chapterId === currentChapterId);
    if (currentIdx === -1) return undefined;
    return chaptersNewestFirst[currentIdx - 1];
}

// ── main ─────────────────────────────────────────────────────────────

export async function open(provider: Provider, route: RouteMatch): Promise<void> {
    const { slug, chapterId } = route;

    window.stop();
    document.open();
    document.close();

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    retryBrokenImages(".hs-reader-img", 2000);

    // 1. Load the current chapter
    const data = await provider.fetchChapter(slug, chapterId);
    if (!data) {
        window.location.href = provider.seriesUrl(slug);
        return; // just for visuals, location.href redirects the page making further execution impossible
    }

    document.title = `${data.chapterId} ${data.seriesTitle}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'hs-reader-body';
    document.body.appendChild(wrapper);

    const firstWrap = createChapterWrapper(chapterId);
    renderChapterImages(firstWrap, data, provider, slug);
    wrapper.appendChild(firstWrap);

    const chapterData: Record<string, ChapterData> = { [chapterId]: data };

    // 2. Restore scroll position
    const target = route.imageIndex
        ? document.getElementById(`#${route.imageIndex}`) as HTMLImageElement | null
        : null;
    if (target) target.dataset.restoreTarget = 'true';
    wrapper.dataset.restoreState = target ? 'restoring' : 'complete';

    // 3. Async: fetch chapter list
    let chaptersNewestFirst: ChapterMeta[] = [];
    const loaded = new Set<string>();
    loaded.add(chapterId);
    let chapterListLoading = true;
    let pendingScrollEnd = false;

    const chaptersLoadingStatus = createStatus('Loading chapters...', 'hs-loading');
    wrapper.appendChild(chaptersLoadingStatus);
    provider.fetchChaptersNewestFirst(slug)
        .then(chapters => { chaptersNewestFirst = chapters; })
        .catch(() => { wrapper.appendChild(createStatus('Failed to load chapter list', 'hs-error')); })
        .finally(() => {
            chaptersLoadingStatus.remove();
            chapterListLoading = false;
            if (pendingScrollEnd) {
                pendingScrollEnd = false;
                scrollEndOneHundred();
            }
        });

    // 4. Scroll handler
    const seenImages = new Set<string>();
    function scrollEndOneHundred() {
        setTimeout(() => {
            if (wrapper.dataset.restoreState === 'restoring') return;

            const midpoint = window.innerHeight / 2;
            const saveImg = Array.from(wrapper.querySelectorAll<HTMLImageElement>('.hs-reader-img'))
                .filter(image => imageLoaded(image))
                .map(image => ({ image, top: image.getBoundingClientRect().top }))
                .filter(item => item.top <= midpoint)
                .sort((a, b) => b.top - a.top)[0]?.image;
            if (!saveImg) return;
            const chapterWrap = saveImg.closest<HTMLDivElement>('.hs-chapter');
            if (!chapterWrap) return;
            const visibleChapter = chapterWrap.dataset.chapter as string;

            const imageIndex = saveImg.id.split('#')[1];
            const imageKey = `${visibleChapter}:${imageIndex}`;
            if (!seenImages.has(imageKey)) {
                seenImages.add(imageKey);
                history.replaceState(null, '', saveImg.dataset.readerUrl as string);
                const visibleData = chapterData[visibleChapter];
                document.title = `${visibleData.chapterId} ${visibleData.seriesTitle}`;
                void provider.trackChapter?.(visibleData, imageIndex, chaptersNewestFirst);
            }

            if (chapterListLoading) {
                pendingScrollEnd = true;
                return;
            }

            const chapterWraps = wrapper.querySelectorAll<HTMLDivElement>('.hs-chapter');
            if (chapterWrap !== chapterWraps[chapterWraps.length - 1]) return;

            const newerChapter = findNewerChapter(chaptersNewestFirst, visibleChapter);
            if (!newerChapter || loaded.has(newerChapter.chapterId)) return;

            loaded.add(newerChapter.chapterId);
            const newerChapterLoadingStatus = createStatus('Loading newer chapter...', 'hs-loading');
            wrapper.appendChild(newerChapterLoadingStatus);
            provider.fetchChapter(slug, newerChapter.chapterId)
                .then(newerChapterData => {
                    if (!newerChapterData) {
                        wrapper.appendChild(createStatus('Chapter unavailable', 'hs-error'));
                        return;
                    }
                    chapterData[newerChapter.chapterId] = newerChapterData;
                    const wrapEl = createChapterWrapper(newerChapter.chapterId);
                    renderChapterImages(wrapEl, newerChapterData, provider, slug);
                    wrapper.appendChild(wrapEl);
                })
                .catch(() => { wrapper.appendChild(createStatus('Failed to load chapter', 'hs-error')); })
                .finally(() => {
                    newerChapterLoadingStatus.remove();
                });
        }, 100);
    }
    window.addEventListener('scrollend', scrollEndOneHundred);
    if (target) void restoreScroll(wrapper, firstWrap, target);
}
