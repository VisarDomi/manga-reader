import { Handler, initializeProviderRoute } from './provider';
import { open as openHome } from './routes/home';
import { open as openReader } from './routes/reader';
import { startInit } from './core/shell';

async function main(): Promise<void> {
    const match = initializeProviderRoute();
    if (!match) return;

    await startInit(match.documentTitle, match.provider);
    switch (match.route.handler) {
        case Handler.Home:
            void openHome(match.provider);
            break;
        case Handler.Reader:
            void openReader(match.provider, match.route);
            break;
    }
}

void main();
