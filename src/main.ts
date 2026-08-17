import { Handler, initializeProviderRoute } from './provider';
import { open as openHome } from './routes/home';
import { open as openReader } from './routes/reader';
import { startInit } from './core/shell';
import { showFatalError } from './core/fatal';

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

// Fail loudly: an unhandled startup rejection must be visible on the page,
// never a silent blank takeover.
void main().catch(error => {
    console.error('manga-reader failed to start', error);
    showFatalError(error instanceof Error ? error.message : String(error));
});
