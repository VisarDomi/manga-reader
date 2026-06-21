import {fetchMeta, imageUrls, readerUrl} from '../provider';
import {cleanDocument} from "../ui/shell";

export async function open(gid: number, currentIndex: number): Promise<void> {
    cleanDocument();
    const wrapper = document.createElement('div');
    wrapper.className = 'hs-reader-body';
    document.body.appendChild(wrapper);
    const meta = await fetchMeta(gid);
    const files = meta.files;
    for (let i = 0; i < files.length; i++) {
        const img = document.createElement('img');
        img.id = `#${i}`;
        img.className = 'hs-reader-img';
        img.style.aspectRatio = files[i].width + '/' + files[i].height;
        img.loading = 'lazy';
        wrapper.appendChild(img);
    }

    const restoreImg = document.getElementById(`#${currentIndex}`) as HTMLImageElement;
    const maxST = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.max(0, Math.min(maxST, restoreImg.offsetTop - window.innerHeight / 2)));

    const urls = await imageUrls(files);
    urls.forEach((src, i) => {
        const img = document.getElementById(`#${i}`) as HTMLImageElement;
        img.src = src;
    });

    window.addEventListener('scrollend', () => {
        setTimeout(() => {
            const saveImg = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2 + 1) as HTMLImageElement;
            const index = parseInt(saveImg.id.split("#")[1]);
            history.replaceState(null, '', readerUrl(gid, index));
        }, 100);
    });
}
