import css from '../style.css?inline';
import {
    type ChapterData,
    type ChapterMeta,
    fetchChapter,
    fetchChapterList,
    trackChapter,
    readerUrl,
    seriesUrl
} from '../provider';

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
    window.addEventListener('scroll', () => { cancelled = true; }, { once: true });

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

function clearStatus(): void {
    (document.querySelector('.hs-status') as HTMLDivElement).remove();
}

function findNewerChapter(chapterList: ChapterMeta[], currentChapterId: string): ChapterMeta | undefined {
    const currentIdx = chapterList.findIndex(chapter => chapter.chapterId === currentChapterId);
    if (currentIdx === -1) return undefined;
    return chapterList[currentIdx - 1];
}

// ── main ─────────────────────────────────────────────────────────────

export async function open(slug: string, chapterId: string): Promise<void> {
    document.open();
    document.close();

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    retryBrokenImages(".hs-reader-img", 2000);

    // 1. Load the current chapter
    const data = await fetchChapter(slug, chapterId);
    if (!data) {
        window.location.href = seriesUrl(slug);
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
    const hash = location.hash;
    const target = document.getElementById(hash) as HTMLImageElement | null;
    if (target) restoreScroll(firstWrap, target);

    // 3. Async: fetch chapter list
    let chapterList: ChapterMeta[] = [];
    const loaded = new Set<string>();
    loaded.add(chapterId);
    let loading = true;

    wrapper.appendChild(createStatus('Loading chapters...', 'hs-loading'));
    fetchChapterList(slug)
        .then(list => { chapterList = list; })
        .catch(() => { wrapper.appendChild(createStatus('Failed to load chapter list', 'hs-error')); })
        .finally(() => { clearStatus(); loading = false; });

    // 4. Scroll handler
    const seenImages = new Set<string>();
    function scrollEndOneHundred() {
        setTimeout(() => {
            if (loading) return;

            const saveImg = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2 + 1) as HTMLImageElement;
            const chapterWrap = saveImg.closest('.hs-chapter') as HTMLDivElement;
            const visibleChapter = chapterWrap.dataset.chapter as string;

            const image = saveImg.id.split('#')[1];
            const imageKey = `${visibleChapter}:${image}`;
            if (seenImages.has(imageKey)) return;
            seenImages.add(imageKey);

            history.replaceState(null, '', readerUrl(slug, visibleChapter, image));

            const visibleData = chapterData[visibleChapter];
            document.title = `${visibleData.chapterId} ${visibleData.seriesTitle}`;
            trackChapter(visibleData, image, chapterList);

            const lastLoaded = wrapper.lastElementChild as HTMLDivElement;
            if (chapterWrap !== lastLoaded) return;

            const newerChapter = findNewerChapter(chapterList, visibleChapter);
            if (!newerChapter || loaded.has(newerChapter.chapterId)) return;

            loaded.add(newerChapter.chapterId);
            loading = true;
            wrapper.appendChild(createStatus('Loading newer chapter...', 'hs-loading'));
            fetchChapter(slug, newerChapter.chapterId)
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
                .finally(() => { clearStatus(); loading = false; });
        }, 100);
    }
    window.addEventListener('scrollend', scrollEndOneHundred);
}
