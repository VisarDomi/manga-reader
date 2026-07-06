import css from '../style.css?inline';
import {ChapterData, fetchChapter, seriesUrl} from '../provider';

const prevSVG = '<svg viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7"/></svg>';
const nextSVG = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';

function navBar(data: ChapterData): HTMLDivElement {
    const bar = document.createElement('div');
    bar.id = 'mr-nav';
    if (data.prevUrl) {
        const prev = document.createElement('a');
        prev.className = 'asura-btn';
        prev.href = data.prevUrl;
        prev.innerHTML = `${prevSVG}<span style="line-height:1">Prev</span>`;
        bar.appendChild(prev);
    }
    if (data.nextUrl) {
        const next = document.createElement('a');
        next.className = 'asura-btn';
        next.href = data.nextUrl;
        next.innerHTML = `<span style="line-height:1">Next</span>${nextSVG}`;
        bar.appendChild(next);
    }
    return bar;
}

export async function open(slug: string, chapter: number): Promise<void> {
    document.open();
    document.close();

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    let data: ChapterData;
    try {
        data = await fetchChapter(slug, chapter);
    } catch {
        window.location.href = seriesUrl(slug);
        throw new Error('No such chapter');
    }

    document.title = `${data.number} ${data.series.title}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'hs-reader-body';

    wrapper.appendChild(navBar(data));

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
        wrapper.appendChild(img);
    }

    wrapper.appendChild(navBar(data));
    document.body.appendChild(wrapper);

    const restoreImg = document.getElementById(location.hash) as HTMLImageElement | null;
    if (restoreImg) window.scrollTo(0, restoreImg.offsetTop - window.innerHeight / 2);

    window.addEventListener('scrollend', () => {
        setTimeout(() => {
            const saveImg = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2 + 1) as HTMLImageElement | null;
            if (saveImg) history.replaceState(null, '', saveImg.id);
        }, 100);
    });
}
