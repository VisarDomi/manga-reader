import css from '../style.css?inline';
import {
    type ChapterData,
    type ChapterMeta,
    fetchChapter,
    fetchChapterList,
    seriesUrl,
} from '../provider';

// ── helpers ──────────────────────────────────────────────────────────

function chapterPath(chapterStr: string, imgIdx: string): string {
    const currentPath = window.location.pathname;
    if (currentPath.includes('/manga/')) {
        const base = currentPath.replace(/\/chapter-[^/]+\/.*$/, '');
        return `${base}/chapter-${chapterStr}/#${imgIdx}`;
    }
    const base = currentPath.replace(/\/chapter-[^/]+.*$/, '');
    return `${base}/chapter-${chapterStr}#${imgIdx}`;
}

// ── chapter index helpers ────────────────────────────────────────────

/** Get the next chapter slug from the sorted metas */
function nextChapterStr(metas: ChapterMeta[], current: string): string | null {
    const nextIdx = metas.get(current);
    return metas[nextIdx];
}

// ── render helpers ───────────────────────────────────────────────────

function createChapterWrapper(chapterStr: string): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'hs-chapter';
    wrap.dataset.chapter = chapterStr;
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

// ── main ─────────────────────────────────────────────────────────────

export async function open(slug: string, chapterStr: string): Promise<void> {
    document.open();
    document.close();

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // 1. Load the current chapter
    let data: ChapterData;
    try {
        data = await fetchChapter(slug, chapterStr);
    } catch {
        window.location.href = seriesUrl(slug);
        throw new Error('No such chapter');
    }

    document.title = `${data.number} ${data.series.title}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'hs-reader-body';
    document.body.appendChild(wrapper);

    // Append the current chapter
    const firstWrap = createChapterWrapper(chapterStr);
    renderChapterImages(firstWrap, data);
    wrapper.appendChild(firstWrap);

    // 2. Restore scroll position
    const hash = location.hash;
    const el = document.getElementById(hash) as HTMLImageElement;
    if (el) window.scrollTo(0, el.offsetTop - window.innerHeight / 2);

    // 3. Async: fetch chapter list and start infinite loading
    let chapterList: ChapterMeta[];
    let loadedChapters = new Set<string>([chapterStr]);

    // TODO:i need a state machine for loading/error/success
    /* TODO:add a div at the bottom of the document that says this is loading */
    let isLoadingNext = true;
    fetchChapterList(slug)
        .then(list => {
            chapterList = list;
        })
        .catch(err => { /* TODO:add a div at the bottom of the document that says this failed */ })
        /* TODO:remove loading div */
        .finally(() => { isLoadingNext = false; });
    // 4. Scroll handler: edge detection + progress save
    window.addEventListener('scrollend', () => {
        setTimeout(() => {
            // Determine which image is at viewport center
            const saveImg = document.elementFromPoint(window.innerWidth / 2,window.innerHeight / 2 + 1) as HTMLImageElement;
            const chapterWrap = saveImg.closest('.hs-chapter') as HTMLDivElement;
            const chapter = chapterWrap.dataset.chapter as string;
            if (!window.location.pathname.includes(`chapter-${chapter}`)) {
                history.replaceState(null, '', chapterPath(chapter, saveImg.id.split("#")[1]));
            } else {
                history.replaceState(null, '', saveImg.id);
            }

            // Edge detection for next chapter
            if (isLoadingNext) return;

            const nearBottom = window.scrollY + chapterWrap.clientHeight > document.documentElement.scrollHeight;
            if (!nearBottom) return;

            // Find the last loaded chapter
            const lastWrap = wrapper.lastElementChild as HTMLDivElement;
            if (!lastWrap.dataset.chapter) return;

            const nextStr = nextChapterStr(chapterList, lastWrap.dataset.chapter);
            if (!nextStr || loadedChapters.has(nextStr)) return;

            /* TODO:add a div at the bottom of the document that says this is loading */
            isLoadingNext = true;
            fetchChapter(slug, nextStr)
                .then(nextData => {
                    loadedChapters.add(nextStr);
                    const wrapEl = createChapterWrapper(nextStr);
                    renderChapterImages(wrapEl, nextData);
                    wrapper.appendChild(wrapEl);
                })
                .catch(err => { /* TODO:add a div at the bottom of the document that says this failed */ })
                /* TODO:remove loading div */
                .finally(() => { isLoadingNext = false; });
        }, 100);
    });
}
