import { Handler, initializeProviderRoute } from '../src/provider';
import { open as openHome } from '../src/routes/home';
import { open as openReader } from '../src/routes/reader';
import { startInit } from '../src/core/shell';

type Boot = { entries: number; startedAt: number; shellAt?: number; readyAt?: number; error?: string };
const scope = window as typeof window & { __mangaExtensionBoot?: Boot };
const match = initializeProviderRoute(new URL(location.href));

// Decide route ownership before takeover, storage or worker activity.
if (match) {
    if (scope.__mangaExtensionBoot) {
        scope.__mangaExtensionBoot.entries++;
    } else {
        const boot: Boot = { entries: 1, startedAt: performance.now() };
        Object.defineProperty(scope, '__mangaExtensionBoot', { value: boot });
        startInit(document.title.trim() || match.documentTitle);
        boot.shellAt = performance.now();
        const task = match.route.handler === Handler.Home
            ? openHome(match.provider)
            : openReader(match.provider, match.route);
        void task.then(() => { boot.readyAt = performance.now(); }, error => {
            boot.error = String(error);
            console.error(error);
        });
    }
}
