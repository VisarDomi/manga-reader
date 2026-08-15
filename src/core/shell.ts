import css from '../style.css?inline';

const FIRST_IMAGE_RETRY_MS = 1_000;
const MAX_IMAGE_RETRY_MS = 2_147_483_647;

interface ImageRetryState {
    source: string;
    delay: number;
    retryAt: number;
}

function retryBrokenImages(selector: ".hs-reader-img" | ".hs-home-cover img"): void {
    const retryStates = new WeakMap<HTMLImageElement, ImageRetryState>();

    const retry = () => {
        const now = Date.now();
        const imgs = document.querySelectorAll<HTMLImageElement>(selector);
        for (const img of imgs) {
            if (!img.getAttribute('src')?.trim()) {
                retryStates.delete(img);
                continue;
            }
            if (img.naturalWidth > 0) {
                retryStates.delete(img);
                continue;
            }

            const source = img.src;
            let state = retryStates.get(img);
            if (!state || state.source !== source) {
                state = {source, delay: FIRST_IMAGE_RETRY_MS, retryAt: now};
                retryStates.set(img, state);
            }
            if (!img.complete || now < state.retryAt) continue;

            // Safari iOS doesn't execute img.onerror on 429s, so failed images need polling.
            const src = new URL(source);
            if (src.origin === location.origin) src.searchParams.set('retry', Date.now().toString());
            img.src = ''; // safari ios needs its source cleared first so that it can register the new (same) source
            img.src = src.href;

            state.delay = Math.min(state.delay * 2, MAX_IMAGE_RETRY_MS);
            state.retryAt = now + state.delay;
            state.source = img.src;
        }

        window.setTimeout(retry, FIRST_IMAGE_RETRY_MS);
    };

    window.setTimeout(retry, FIRST_IMAGE_RETRY_MS);
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
