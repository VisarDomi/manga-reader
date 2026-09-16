import { takeOverDocument } from './takeover';
import css from '../style.css?inline';
import { computeRequest } from './compute/transport';
import { onBfcacheRestore } from './lifecycle';

export function startInit(documentTitle: string): void {
    takeOverDocument();
    if (!document.doctype) document.insertBefore(document.implementation.createDocumentType('html', '', ''), document.documentElement);
    if (!document.documentElement) document.appendChild(document.createElement('html'));
    if (!document.head) document.documentElement.appendChild(document.createElement('head'));
    if (!document.body) document.documentElement.appendChild(document.createElement('body'));
    const viewport = document.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(viewport);
    document.title = documentTitle;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const syncContext = (): void => {
        void computeRequest('page-context', {
            href: location.href,
        });
    };
    syncContext();
    onBfcacheRestore(syncContext);
}
