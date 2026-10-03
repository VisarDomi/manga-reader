import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests run the app's code with Asura as the build-selected provider.
export default defineConfig({
    resolve: { alias: {
        '@worker-code': fileURLToPath(new URL('tests/unit/stubs/worker-code.ts', import.meta.url)),
        '@selected-provider': fileURLToPath(new URL('tests/unit/stubs/selected-provider.ts', import.meta.url)),
    } },
    define: { __IOS_PROVIDER__: '"asura"', __IOS_ORIGIN__: '"https://asurascans.com/"', __READER_BACKUP_URL__: '""', __READER_BACKUP_KEY__: '""' },
    test: { include: ['tests/unit/**/*.test.ts'], environment: 'jsdom', setupFiles: ['tests/unit/stubs/setup.ts'] },
});
