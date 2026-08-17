import { createAngularProvider } from './angular';
import type { Provider } from './types';

export function createEzmangaProvider(): Provider {
    return createAngularProvider('ezmanga');
}
