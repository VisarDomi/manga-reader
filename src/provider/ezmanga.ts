import { createAngularProvider } from './angular';

export const ezmanga = createAngularProvider({
    name: 'ezmanga',
    apiBase: 'https://vapi.ezmanga.org/api/v1',
    siteDomain: 'ezmanga.org',
});
