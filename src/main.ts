import { matchRoute, selectProvider } from './provider';
import { open } from './routes/reader';

const { pathname, hostname } = window.location;
selectProvider(hostname);
const match = matchRoute(pathname);
if (match) {
    void open(match.slug, match.chapter);
}
