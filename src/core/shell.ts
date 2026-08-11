import css from '../style.css?inline';

function retryBrokenImages(selector: ".hs-reader-img" | ".hs-home-cover", interval: number): void {
    setInterval(() => {
        const imgs = document.querySelectorAll<HTMLImageElement>(selector);
        for (const img of imgs) {
            if (!img.complete || img.naturalWidth > 0) continue; // safari ios doesn't execute img.onerror on 429s so we have to do hacks
            const src = new URL(img.src);
            if (src.origin === location.origin) src.searchParams.set('retry', Date.now().toString());
            img.src = ''; // safari ios needs its source cleared first so that it can register the new (same) source
            img.src = src.href;
        }
    }, interval);
}


export function startInit(documentTitle: string): void {
    window.stop();
    document.open();
    document.close();
    document.title = documentTitle;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    retryBrokenImages(".hs-reader-img", 2000);
    retryBrokenImages(".hs-home-cover", 2000);
}
