import { Handler, matchProviderRoute } from './provider';
import { open as openHome } from './routes/home';
import { open as openReader } from './routes/reader';

const match = matchProviderRoute();
if (match) {
    const stopTokenManager = match.provider.tokenManager.start();
    window.addEventListener('pagehide', event => {
        if (!event.persisted) stopTokenManager();
    }, { once: true });

    switch (match.route.handler) {
        case Handler.Home:
            void openHome();
            break;
        case Handler.Reader:
            void openReader(match.provider, match.route);
            break;
    }
}
