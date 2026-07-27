import { Handler, matchProviderRoute } from './provider';
import { open as openHome } from './routes/home';
import { open as openReader } from './routes/reader';

const match = matchProviderRoute();
if (match) {
    switch (match.route.handler) {
        case Handler.Home:
            void openHome(match.provider);
            break;
        case Handler.Reader:
            void openReader(match.provider, match.route);
            break;
    }
}
