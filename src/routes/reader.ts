import css from '../style.css?inline';
import {
    type ChapterData,
    type ChapterMeta,
    fetchChapter,
    fetchChapterList,
    readerUrl,
    seriesUrl,
    getNextChapter
} from '../provider';

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

// ── main ─────────────────────────────────────────────────────────────

export async function open(slug: string, chapterId: string): Promise<void> {
    document.open();
    document.close();

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // 1. Load the current chapter
    let data: ChapterData;
    try {
        data = await fetchChapter(slug, chapterId);
    } catch {
        window.location.href = seriesUrl(slug);
        throw new Error('No such chapter');
    }

    document.title = `${data.number} ${data.series.title}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'hs-reader-body';
    document.body.appendChild(wrapper);

    const firstWrap = createChapterWrapper(chapterId);
    renderChapterImages(firstWrap, data);
    wrapper.appendChild(firstWrap);

    // 2. Restore scroll position
    const hash = location.hash;
    const el = document.getElementById(hash) as HTMLImageElement;
    if (el) window.scrollTo(0, el.offsetTop - window.innerHeight / 2);

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

    // 4. Scroll handler: edge detection + URL update
    window.addEventListener('scrollend', () => {
        setTimeout(() => {
            const saveImg = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2 + 1) as HTMLImageElement;
            const chapterWrap = saveImg.closest('.hs-chapter') as HTMLDivElement;
            const visibleChapter = chapterWrap.dataset.chapter as string;

            history.replaceState(null, '', readerUrl(slug, visibleChapter, saveImg.id.split("#")[1]));

            // Edge detection for next chapter
            if (loading) return;

            const nearBottom = window.scrollY + chapterWrap.clientHeight > document.documentElement.scrollHeight;
            if (!nearBottom) return;

            const lastWrap = wrapper.lastElementChild as HTMLDivElement;
            const lastChapter = lastWrap.dataset.chapter as string;
            const next = getNextChapter(chapterList, lastChapter);
            if (!next || loaded.has(next.slug)) return;

            loaded.add(next.slug);
            loading = true;
            wrapper.appendChild(createStatus('Loading next chapter...', 'hs-loading'));
            fetchChapter(slug, next.slug)
                .then(nextData => {
                    const wrapEl = createChapterWrapper(next.slug);
                    renderChapterImages(wrapEl, nextData);
                    wrapper.appendChild(wrapEl);
                })
                .catch(() => { wrapper.appendChild(createStatus('Failed to load chapter', 'hs-error')); })
                .finally(() => { clearStatus(); loading = false; });
        }, 100);
    });
}
