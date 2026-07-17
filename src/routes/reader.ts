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

/** Map each chapter to the next one, preserving API order. Keys are the raw number string (e.g. "7", "1.7"). */
function buildNextMap(list: ChapterMeta[]): Map<string, string> {
    const map = new Map<string, string>();
    for (let i = 0; i < list.length - 1; i++) {
        const a = list[i].slug.replace(/^chapter-/, '');
        const b = list[i + 1].slug.replace(/^chapter-/, '');
        map.set(a, b);
    }
    return map;
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

// ── loading / error indicator ────────────────────────────────────────

function createStatus(text: string, className: string): HTMLDivElement {
    const div = document.createElement('div');
    div.className = `hs-status ${className}`;
    div.textContent = text;
    return div;
}

function clearStatus(): void {
    document.querySelector('.hs-status')?.remove();
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
    let nextMap = new Map<string, string>();
    let loadedChapters = new Set<string>([chapterStr]);

    let isLoadingNext = true;
    wrapper.appendChild(createStatus('Loading chapters...', 'hs-loading'));
    fetchChapterList(slug)
        .then(list => { nextMap = buildNextMap(list); })
        .catch(() => { wrapper.appendChild(createStatus('Failed to load chapter list', 'hs-error')); })
        .finally(() => { clearStatus(); isLoadingNext = false; });

    // 4. Scroll handler: edge detection + progress save
    window.addEventListener('scrollend', () => {
        setTimeout(() => {
            // Determine which image is at viewport center
            const saveImg = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2 + 1) as HTMLImageElement;
            const chapterWrap = saveImg.closest('.hs-chapter') as HTMLDivElement;
            const chapter = chapterWrap.dataset.chapter as string;
            if (!window.location.pathname.includes(`chapter-${chapter}`)) {
                history.replaceState(null, '', chapterPath(chapter, saveImg.id.split('#')[1]));
            } else {
                history.replaceState(null, '', saveImg.id);
            }

            // Edge detection for next chapter
            if (isLoadingNext) return;

            const nearBottom = window.scrollY + chapterWrap.clientHeight > document.documentElement.scrollHeight;
            if (!nearBottom) return;

            const lastWrap = wrapper.lastElementChild as HTMLDivElement;
            const nextStr = nextMap.get(lastWrap.dataset.chapter as string);
            if (!nextStr || loadedChapters.has(nextStr)) return;

            isLoadingNext = true;
            wrapper.appendChild(createStatus('Loading next chapter...', 'hs-loading'));
            fetchChapter(slug, nextStr)
                .then(nextData => {
                    loadedChapters.add(nextStr);
                    const wrapEl = createChapterWrapper(nextStr);
                    renderChapterImages(wrapEl, nextData);
                    wrapper.appendChild(wrapEl);
                })
                .catch(() => { wrapper.appendChild(createStatus('Failed to load chapter', 'hs-error')); })
                .finally(() => { clearStatus(); isLoadingNext = false; });
        }, 100);
    });
}
