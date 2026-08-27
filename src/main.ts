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
            await openHome(match.provider);
            return;
        case Handler.Reader:
            await openReader(match.provider, match.route);
            return;
    }
}

void main()