import css from '../style.css?inline';
import type { Provider } from '../provider/types';
import { computeRequest, onComputeNotification, resetWorkerState } from './compute/transport';
import { trapUncaughtErrors } from './fatal';

export async function startInit(
    documentTitle: string,
    provider: Pick<Provider, 'waitForTakeover' | 'key'>,
): Promise<void> {
    if (provider.waitForTakeover) await provider.waitForTakeover();

    window.stop();
    document.open();
    document.close();
    document.title = documentTitle;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // The compute worker owns the token managers (asura/valir). Feed it the
    // pieces it cannot reach: cookies, the page path, and visibility.
    // Cookie write-backs flow back as notifications; the main thread applies
    // them without deciding anything.
    onComputeNotification(notification => {
        if (notification.name === 'cookie-write') {
            document.cookie = notification.value;
        }
    });
    const syncContext = (): void => {
        void computeRequest('cookie-snapshot', {
            cookies: document.cookie,
            pathname: location.pathname,
            href: location.href,
        });
    };
    syncContext();
    window.addEventListener('pageshow', syncContext);
    // bfcache is specific: pagereveal fires ONLY on a bfcache/prerender
    // restore (never on a fresh load). The revived blob worker is dead —
    // drop it so the next op respawns a live one (gallery-reader pattern).
    window.addEventListener('pagereveal', () => {
        resetWorkerState();
        syncContext();
    });
    document.addEventListener('visibilitychange', () => {
        void computeRequest('lifecycle', { hidden: document.hidden });
    });
    window.addEventListener('pagehide', () => {
        void computeRequest('lifecycle', { hidden: true });
    });

    trapUncaughtErrors();
}
