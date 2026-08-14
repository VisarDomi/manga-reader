import css from '../style.css?inline';

const FIRST_IMAGE_RETRY_MS = 1_000;
const MAX_IMAGE_RETRY_MS = 2_147_483_647;

function retryBrokenImages(selector: ".hs-reader-img" | ".hs-home-cover img"): void {
    let delay = FIRST_IMAGE_RETRY_MS;
    const retrying = new WeakSet<HTMLImageElement>();

    const retry = () => {
        let retried = false;
        let retryPending = false;
        const imgs = document.querySelectorAll<HTMLImageElement>(selector);
        for (const img of imgs) {
            if (img.naturalWidth > 0) {
                retrying.delete(img);
                continue;
            }
            if (!img.complete) {
                retryPending ||= retrying.has(img);
                continue;
            }
            // Safari iOS doesn't execute img.onerror on 429s, so failed images need polling.
            retried = true;
            retryPending = true;
            retrying.add(img);
            const src = new URL(img.src);
            if (src.origin === location.origin) src.searchParams.set('retry', Date.now().toString());
            img.src = ''; // safari ios needs its source cleared first so that it can register the new (same) source
            img.src = src.href;
        }

        if (retried) delay = Math.min(delay * 2, MAX_IMAGE_RETRY_MS);
        else if (!retryPending) delay = FIRST_IMAGE_RETRY_MS;
        window.setTimeout(retry, delay);
    };

    window.setTimeout(retry, delay);
}


export function startInit(documentTitle: string): void {
    window.stop();
    document.open();
    document.close();
    document.title = documentTitle;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    retryBrokenImages(".hs-reader-img");
    retryBrokenImages(".hs-home-cover img");
}
