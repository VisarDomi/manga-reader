import { matchRoute } from './provider';
import { open } from './routes/reader';

const match = matchRoute();
if (match) {
    void open(match.slug, match.chapter);
}
