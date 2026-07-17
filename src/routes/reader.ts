import css from '../style.css?inline';
import {
    type ChapterData,
    type ChapterMeta,
    fetchChapter,
    fetchChapterList,
    seriesUrl,
} from '../provider';

// ── helpers ──────────────────────────────────────────────────────────

function chapterPath(chapterStr: string, imgIdx: number): string {
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
    const sorted = [...metas].sort((a, b) => a.number - b.number);
    const idx = sorted.findIndex(m => m.slug.replace(/^chapter-/, '') === current);
    if (idx === -1 || idx === sorted.length - 1) return null;
    return sorted[idx + 1].slug.replace(/^chapter-/, '');
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
    let chapterList: ChapterMeta[] = [];
    let isLoadingNext = false;
    let loadedChapters = new Set<string>([chapterStr]);

    fetchChapterList(slug).then(list => {
        chapterList = list;
    }).catch(() => { /* chapter list is optional for infinite loading */ });

    // 4. Scroll handler: edge detection + progress save
    window.addEventListener('scrollend', () => {
        setTimeout(() => {
            // Determine which image is at viewport center
            const saveImg = document.elementFromPoint(window.innerWidth / 2,window.innerHeight / 2 + 1) as HTMLImageElement;
            const chapterWrap = saveImg.closest('.hs-chapter') as HTMLDivElement;
            const imgChapter = chapterWrap.dataset.chapter as string;
            if (!window.location.pathname.includes(`chapter-${imgChapter}`)) {
                // why is there parseInt!!
                history.replaceState(null, '', chapterPath(imgChapter, parseInt(saveImg.id.slice(1), 10)));
            } else {
                history.replaceState(null, '', saveImg.id);
            }

            // Edge detection for next chapter
            if (isLoadingNext || chapterList.length === 0) return;

            const nearBottom = window.scrollY + window.innerHeight >=
                document.documentElement.scrollHeight - window.innerHeight;

            if (!nearBottom) return;

            // Find the last loaded chapter
            const lastWrap = wrapper.lastElementChild as HTMLDivElement | null;
            if (!lastWrap?.dataset.chapter) return;

            const nextStr = nextChapterStr(chapterList, lastWrap.dataset.chapter);
            if (!nextStr || loadedChapters.has(nextStr)) return;

            isLoadingNext = true;
            fetchChapter(slug, nextStr)
                .then(nextData => {
                    loadedChapters.add(nextStr);
                    const wrapEl = createChapterWrapper(nextStr);
                    renderChapterImages(wrapEl, nextData);
                    wrapper.appendChild(wrapEl);
                })
                .catch(err => { console.warn('Failed to load next chapter:', err); })
                .finally(() => { isLoadingNext = false; });
        }, 100);
    });
}
