import { createAngularProvider } from './angular';

export const qiscans = createAngularProvider({
    name: 'qiscans',
    apiBase: 'https://api.qimanga.com/api/v1',
    siteDomain: 'qimanga.com',
});
