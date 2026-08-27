import { Handler, initializeProviderRoute } from './provider';
import { open as openHome } from './routes/home';
import { open as openReader } from './routes/reader';
import { startInit } from './core/shell';

async function main(): Promise<void> {
    const match = initializeProviderRoute(new URL(window.location.href));
    if (!match) return;

    startInit(document.title.trim() || match.documentTitle);
    switch (match.route.handler) {
        case Handler.Home:
            await openHome(match.provider);
            return;
        case Handler.Reader:
            await openReader(match.provider, match.route);
            return;
    }
}

void main()
