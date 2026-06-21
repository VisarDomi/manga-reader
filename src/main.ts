import cssContent from './css/style.css?inline';

const CHAPTER_RE = /^\/series\/([^/]+)\/chapter-(\d+)/;

function waitFor(selector: string): Promise<Element> {
    const { promise, resolve } = Promise.withResolvers<Element>();
    function check(): boolean {
        const el = document.querySelector(selector);
        if (el) { resolve(el); return true; }
        return false;
    }
    if (!check()) {
        const obs = new MutationObserver(() => { if (check()) obs.disconnect(); });
        obs.observe(document.documentElement!, { childList: true, subtree: true });
    }
    return promise;
}

function navBar(slug: string, chapter: number): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 'hs-chapter-bar';
    if (chapter > 1) {
        const a = document.createElement('a');
        a.className = 'hs-chapter-nav';
        a.href = `/series/${slug}/chapter-${chapter - 1}`;
        a.textContent = '← Prev';
        bar.appendChild(a);
    }
    const next = document.createElement('a');
    next.className = 'hs-chapter-nav';
    next.href = `/series/${slug}/chapter-${chapter + 1}`;
    next.textContent = 'Next →';
    bar.appendChild(next);
    return bar;
}

const info = CHAPTER_RE.exec(window.location.pathname);
if (info) {
    const slug = info[1];
    const chapter = parseInt(info[2]);

    void waitFor('.r-page-img').then(() => {
        // Scrape image srcs
        const srcs = Array.from(document.querySelectorAll('.r-page-img'))
            .map(img => (img as HTMLImageElement).src)
            .filter(Boolean);

        // Title: "11 Looking for the Villainess's Contract Husband"
        const seriesTitle = document.title.split(' – ')[0] || slug;

        // Wipe
        document.open();
        document.close();

        // Styles
        document.title = `${chapter} ${seriesTitle}`;
        const style = document.createElement('style');
        style.textContent = cssContent;
        document.head.appendChild(style);

        // Build
        const wrap = document.createElement('div');
        wrap.className = 'hs-reader-body';
        wrap.appendChild(navBar(slug, chapter));
        for (const src of srcs) {
            const img = document.createElement('img');
            img.className = 'hs-reader-img';
            img.loading = 'lazy';
            img.src = src;
            wrap.appendChild(img);
        }
        wrap.appendChild(navBar(slug, chapter));
        document.body.appendChild(wrap);
        window.scrollTo(0, 0);
    });
}
