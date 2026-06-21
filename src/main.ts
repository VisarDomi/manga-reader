import cssContent from './css/style.css?inline';

const CHAPTER_RE = /^\/series\/([^/]+)\/chapter-(\d+)/;

interface ChapterImage {
    url: string;
    order: number;
    width: number;
    height: number;
}

interface ChapterData {
    images: ChapterImage[];
    series: { title: string };
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

    void fetch(`https://vapi.ezmanga.org/api/v1/series/${slug}/chapters/chapter-${chapter}`)
        .then(r => r.json() as Promise<ChapterData>)
        .then(data => {
            const seriesTitle = data.series.title;

            document.open();
            document.close();

            document.title = `${chapter} ${seriesTitle}`;
            const style = document.createElement('style');
            style.textContent = cssContent;
            document.head.appendChild(style);

            const wrap = document.createElement('div');
            wrap.className = 'hs-reader-body';
            wrap.appendChild(navBar(slug, chapter));
            for (let i = 0; i < data.images.length; i++) {
                const img = document.createElement('img');
                const imgData = data.images[i];
                img.id = '#' + (i + 1);
                img.className = 'hs-reader-img';
                img.style.aspectRatio = imgData.width + '/' + imgData.height;
                img.loading = 'lazy';
                img.src = imgData.url;
                wrap.appendChild(img);
            }
            wrap.appendChild(navBar(slug, chapter));
            document.body.appendChild(wrap);

            const restoreImg = document.getElementById(location.hash) as HTMLImageElement;
            if (restoreImg) {
                window.scrollTo(0, restoreImg.offsetTop - window.innerHeight / 2);
            }

            window.addEventListener('scrollend', () => {
                setTimeout(() => {
                    const saveImg = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2 + 1) as HTMLImageElement;
                    history.replaceState(null, '', saveImg.id);
                }, 100);
            });
        });
}
