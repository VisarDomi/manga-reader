import css from '../style.css?inline';
import { computeRequest, onComputeNotification } from './compute/transport';
import { onBfcacheRestore } from './lifecycle';
import { ComputeNotificationName } from './compute/messages';

export function startInit(documentTitle: string): void {
    window.stop();
    document.open();
    document.close();
    document.title = documentTitle;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // The compute worker owns authenticated provider requests. Feed it the
    // pieces it cannot reach: cookies and the page URL.
    // Cookie write-backs flow back as notifications; the main thread applies
    // them without deciding anything.
    onComputeNotification(notification => {
        if (notification.name === ComputeNotificationName.CookieWrite) {
            document.cookie = notification.value;
        }
    });
    const syncContext = (): void => {
        void computeRequest('cookie-snapshot', {
            cookies: document.cookie,
            href: location.href,
        });
    };
    syncContext();
    onBfcacheRestore(syncContext);
}
