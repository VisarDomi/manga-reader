import { createAngularProvider } from './angular';
import type { Provider } from './types';

export function createQiscansProvider(): Provider {
    return createAngularProvider('qimanga');
}
