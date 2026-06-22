import { matchRoute, Handler, selectProvider } from './provider';
import { open } from './routes/reader';

const { pathname, search, hash, hostname } = window.location;
selectProvider(hostname);
const match = matchRoute(pathname, search, hash);
if (match) {
    switch (match.handler) {
        case Handler.Reader:
            void open(match.slug, match.chapter);
            break;
    }
}
