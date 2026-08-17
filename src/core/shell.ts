import css from '../style.css?inline';
import type { Provider } from '../provider/types';

export async function startInit(
    documentTitle: string,
    provider: Pick<Provider, 'waitForTakeover' | 'tokenManager'>,
): Promise<void> {
    if (provider.waitForTakeover) await provider.waitForTakeover();

    window.stop();
    document.open();
    document.close();
    document.title = documentTitle;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const stopProviderServices = provider.tokenManager?.start();
    if (stopProviderServices) {
        const stopOnPageHide = (event: PageTransitionEvent) => {
            if (event.persisted) return;
            stopProviderServices();
            window.removeEventListener('pagehide', stopOnPageHide);
        };
        window.addEventListener('pagehide', stopOnPageHide);
    }
}
