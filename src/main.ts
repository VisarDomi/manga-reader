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

const info = CHAPTER_RE.exec(window.location.pathname);
if (info) {
    const slug = info[1];
    const chapter = parseInt(info[2]);

    void waitFor('.r-page-img').then(() => {
        const style = document.createElement('style');
        style.textContent = cssContent;
        document.head.appendChild(style);

        const keep = new Set<Element>();
        const targets = new Set<Element>();
        for (const sel of ['.r-strip', 'app-comment-section']) {
            const target = document.querySelector(sel);
            if (target) targets.add(target);
            let el: Element | null = target;
            while (el && el !== document.documentElement) {
                keep.add(el);
                el = el.parentElement;
            }
        }
        function prune(node: Element) {
            for (const child of Array.from(node.children)) {
                if (!keep.has(child)) {
                    (child as HTMLElement).style.display = 'none';
                } else if (!targets.has(child)) {
                    prune(child);
                }
            }
        }
        prune(document.body);

        const strip = document.querySelector<HTMLElement>('.r-strip');
        if (strip) {
            strip.addEventListener('click', (e: MouseEvent) => {
                const rect = strip.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const x = e.clientX - rect.left;
                const navHeight = 60;
                const isLeft = x < rect.width / 2;
                if (y < navHeight) {
                    window.location.href = isLeft
                        ? `/series/${slug}/chapter-${chapter - 1}`
                        : `/series/${slug}/chapter-${chapter + 1}`;
                } else if (y > rect.height - navHeight) {
                    window.location.href = isLeft
                        ? `/series/${slug}/chapter-${chapter - 1}`
                        : `/series/${slug}/chapter-${chapter + 1}`;
                }
            });
        }
    });
}
