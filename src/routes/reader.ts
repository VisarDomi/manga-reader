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

function restoreScroll(wrap: HTMLDivElement, target: HTMLImageElement) {
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    window.addEventListener('touchstart', cancel, { once: true, passive: true });
    window.addEventListener('pointerdown', cancel, { once: true, passive: true });
    window.addEventListener('wheel', cancel, { once: true, passive: true });
    window.addEventListener('keydown', cancel, { once: true });

    const images = Array.from(wrap.querySelectorAll('img'));
    const targetIdx = images.indexOf(target);
    let ready = true;

    function scrollToContiguous() {
        let end = -1;
        for (let i = 0; i <= targetIdx && images[i].complete; i++) {
            end = i;
        }
        if (end >= 0 && !cancelled) {
            const img = images[end];
            window.scrollTo(0, img.offsetTop + img.offsetHeight - window.innerHeight / 2);
        }
    }

    for (let i = 0; i <= targetIdx; i++) {
        const img = images[i];
        if (img.complete && img.naturalHeight > 0) continue;
        ready = false;
        img.addEventListener('load', scrollToContiguous, { once: true });
        img.addEventListener('error', scrollToContiguous, { once: true });
    }

    if (ready) window.scrollTo(0, target.offsetTop - window.innerHeight / 2);
}

// ── render helpers ───────────────────────────────────────────────────

function createChapterWrapper(chapterId: string): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'hs-chapter';
    wrap.dataset.chapter = chapterId;
    return wrap;
}

function renderChapterImages(wrap: HTMLDivElement, data: ChapterData): void {
    for (let i = 0; i < data.images.length; i++) {
        const img = document.createElement('img');
        const imgData = data.images[i];
        img.id = `#${i}`;
        img.className = 'hs-reader-img';
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
    renderChapterImages(firstWrap, data);
    wrapper.appendChild(firstWrap);

    const chapterData: Record<string, ChapterData> = { [chapterId]: data };

    // 2. Restore scroll position
    const imageIndex = route.imageIndex ?? location.hash.slice(1);
    const target = imageIndex
        ? document.getElementById(`#${imageIndex}`) as HTMLImageElement | null
        : null;
    if (target) restoreScroll(firstWrap, target);

    // 3. Async: fetch chapter list
    let chaptersNewestFirst: ChapterMeta[] = [];
    const loaded = new Set<string>();
    loaded.add(chapterId);
    let loading = true;
    let pendingScrollEnd = false;

    const chaptersLoadingStatus = createStatus('Loading chapters...', 'hs-loading');
    wrapper.appendChild(chaptersLoadingStatus);
    provider.fetchChaptersNewestFirst(slug)
        .then(chapters => { chaptersNewestFirst = chapters; })
        .catch(() => { wrapper.appendChild(createStatus('Failed to load chapter list', 'hs-error')); })
        .finally(() => {
            chaptersLoadingStatus.remove();
            loading = false;
            if (pendingScrollEnd) {
                pendingScrollEnd = false;
                scrollEndOneHundred();
            }
        });

    // 4. Scroll handler
    const seenImages = new Set<string>();
    function scrollEndOneHundred() {
        setTimeout(() => {
            if (loading) {
                pendingScrollEnd = true;
                return;
            }

            const saveImg = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2 + 1) as HTMLImageElement;
            const chapterWrap = saveImg.closest('.hs-chapter') as HTMLDivElement;
            const visibleChapter = chapterWrap.dataset.chapter as string;

            const imageIndex = saveImg.id.split('#')[1];
            const imageKey = `${visibleChapter}:${imageIndex}`;
            if (seenImages.has(imageKey)) return;
            seenImages.add(imageKey);

            history.replaceState(null, '', provider.readerUrl(slug, visibleChapter, imageIndex));

            const visibleData = chapterData[visibleChapter];
            document.title = `${visibleData.chapterId} ${visibleData.seriesTitle}`;
            void provider.trackChapter?.(visibleData, imageIndex, chaptersNewestFirst);

            const lastLoaded = wrapper.lastElementChild as HTMLDivElement;
            if (chapterWrap !== lastLoaded) return;

            const newerChapter = findNewerChapter(chaptersNewestFirst, visibleChapter);
            if (!newerChapter || loaded.has(newerChapter.chapterId)) return;

            loaded.add(newerChapter.chapterId);
            loading = true;
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
                    renderChapterImages(wrapEl, newerChapterData);
                    wrapper.appendChild(wrapEl);
                })
                .catch(() => { wrapper.appendChild(createStatus('Failed to load chapter', 'hs-error')); })
                .finally(() => {
                    newerChapterLoadingStatus.remove();
                    loading = false;
                });
        }, 100);
    }
    window.addEventListener('scrollend', scrollEndOneHundred);
}
