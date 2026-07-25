import { matchProviderRoute } from './provider';
import { open } from './routes/reader';

const match = matchProviderRoute();
if (match) {
    void open(match.provider, match.route);
}
