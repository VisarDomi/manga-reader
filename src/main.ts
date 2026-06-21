import cssContent from './css/style.css?inline';

const CHAPTER_RE = /^\/series\/([^/]+)\/chapter-(\d+)/;

function scrape(): Promise<{ srcs: string[]; comments: Element; styles: Element[] }> {
    const { promise, resolve } = Promise.withResolvers<{ srcs: string[]; comments: Element; styles: Element[] }>();

    function check(): boolean {
        const imgs = document.querySelectorAll('.r-page-img');
        const comments = document.querySelector('app-comment-section');
        if (imgs.length > 0 && comments) {
            resolve({
                srcs: Array.from(imgs).map(i => (i as HTMLImageElement).src).filter(Boolean),
                comments,
                styles: Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style')),
            });
            return true;
        }
        return false;
    }

    if (!check()) {
        const obs = new MutationObserver(() => { if (check()) obs.disconnect(); });
        obs.observe(document.documentElement!, { childList: true, subtree: true });
    }

    return promise;
}

const info = CHAPTER_RE.exec(window.location.pathname);
if (info) {
    const slug = info[1];
    const chapter = parseInt(info[2]);

    void scrape().then(({ srcs, comments, styles }) => {
        document.open();
        document.close();

        // Reattach original site styles (so comments look right)
        for (const el of styles) document.head.appendChild(el.cloneNode(true));
        // Our styles
        const style = document.createElement('style');
        style.textContent = cssContent;
        document.head.appendChild(style);

        function navBar(): HTMLDivElement {
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

        const wrap = document.createElement('div');
        wrap.className = 'hs-reader-body';

        // Top nav
        wrap.appendChild(navBar());

        // Images
        for (const src of srcs) {
            const img = document.createElement('img');
            img.className = 'hs-reader-img';
            img.loading = 'lazy';
            img.src = src;
            wrap.appendChild(img);
        }

        // Bottom nav
        wrap.appendChild(navBar());

        // Comments (cloned — Angular bindings won't survive the wipe)
        wrap.appendChild(comments.cloneNode(true));

        document.body.appendChild(wrap);
        window.scrollTo(0, 0);
    });

}
