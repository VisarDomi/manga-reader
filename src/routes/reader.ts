import { cleanDocument } from '../ui/shell';
import { renderComments } from '../ui/comments';
import { fetchChapter, fetchComments, seriesUrl } from '../provider';

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

export async function open(slug: string, chapter: number): Promise<void> {
    cleanDocument();

    let data;
    try {
        data = await fetchChapter(slug, chapter);
    } catch {
        window.location.href = seriesUrl(slug);
        throw new Error('No such chapter');
    }

    document.title = `${data.number} ${data.series.title}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'hs-reader-body';

    wrapper.appendChild(navBar(slug, data.number));

    for (let i = 0; i < data.images.length; i++) {
        const img = document.createElement('img');
        const imgData = data.images[i];
        img.id = `#${i}`;
        img.className = 'hs-reader-img';
        img.style.aspectRatio = imgData.width + '/' + imgData.height;
        img.loading = 'lazy';
        img.src = imgData.url;
        wrapper.appendChild(img);
    }

    wrapper.appendChild(navBar(slug, data.number));
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
    document.body.appendChild(commentsContainer);

    try {
        const comments = await fetchComments(data.id);
        renderComments(commentsContainer, comments);
    } catch {
        renderComments(commentsContainer, []);
    }
}
