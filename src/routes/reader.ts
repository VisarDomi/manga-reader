import css from '../style.css?inline';
import {
    type ChapterData,
    type ChapterMeta,
    fetchChapter,
    fetchChapterList,
    seriesUrl,
} from '../provider';

// ── helpers ──────────────────────────────────────────────────────────

function imgIdxFromHash(hash: string): number | null {
    if (!hash || hash === '#') return null;
    const n = parseInt(hash.replace(/^#/, ''), 10);
    return Number.isNaN(n) ? null : n;
}

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

// ── progress persistence ─────────────────────────────────────────────

const PROGRESS_KEY = 'mr-progress';

function saveProgress(slug: string, chapterStr: string, imgIdx: number): void {
    try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify({ slug, chapter: chapterStr, img: imgIdx }));
    } catch { /* ignore */ }
}

function loadProgress(): { slug: string; chapter: string; img: number } | null {
    try {
        const raw = localStorage.getItem(PROGRESS_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
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
    const imgIdx = imgIdxFromHash(location.hash);
    if (imgIdx != null) {
        const el = document.getElementById(`#${imgIdx}`) as HTMLImageElement | null;
        if (el) {
            window.scrollTo(0, el.offsetTop - window.innerHeight / 2);
        }
    } else {
        // fallback to localStorage
        const saved = loadProgress();
        if (saved && saved.slug === slug && saved.chapter === chapterStr && saved.img != null) {
            const el = document.getElementById(`#${saved.img}`) as HTMLImageElement | null;
            if (el) {
                window.scrollTo(0, el.offsetTop - window.innerHeight / 2);
            }
        }
    }

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
            const saveImg = document.elementFromPoint(
                window.innerWidth / 2,
                window.innerHeight / 2 + 1,
            ) as HTMLImageElement | null;

            if (saveImg) {
                const imgIdx2 = imgIdxFromHash(saveImg.id);
                if (imgIdx2 != null) {
                    const chapterWrap = saveImg.closest('.hs-chapter') as HTMLDivElement | null;
                    const imgChapter = chapterWrap?.dataset.chapter;
                    saveProgress(slug, imgChapter || chapterStr, imgIdx2);
                    if (imgChapter && !window.location.pathname.includes(`chapter-${imgChapter}`)) {
                        history.replaceState(null, '', chapterPath(imgChapter, imgIdx2));
                    } else {
                        history.replaceState(null, '', `#${imgIdx2}`);
                    }
                }
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
                .catch(() => { /* silently skip failed chapters */ })
                .finally(() => { isLoadingNext = false; });
        }, 100);
    });
}
