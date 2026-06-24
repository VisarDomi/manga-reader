import { cleanDocument } from '../ui/shell';
import { renderComments } from '../ui/comments';
import { fetchChapter, fetchComments, seriesUrl } from '../provider';
import type { ChapterData } from '../provider';

function navBar(data: ChapterData): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 'hs-chapter-bar';
    if (data.prevUrl) {
        const a = document.createElement('a');
        a.className = 'hs-chapter-nav';
        a.href = data.prevUrl;
        a.textContent = '← Prev';
        bar.appendChild(a);
    }
    const next = document.createElement('a');
    next.className = 'hs-chapter-nav';
    next.href = data.nextUrl;
    next.textContent = 'Next →';
    bar.appendChild(next);
    return bar;
}

export async function open(slug: string, chapter: number): Promise<void> {
    cleanDocument();

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

    const commentsContainer = document.createElement('div');
    wrapper.appendChild(commentsContainer);

    try {
        const comments = await fetchComments(data);
        renderComments(commentsContainer, comments);
    } catch {
        renderComments(commentsContainer, []);
    }
}
