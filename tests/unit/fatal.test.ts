// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { trapUncaughtErrors } from '../../src/core/fatal';

afterEach(() => {
    document.body.replaceChildren();
});

describe('fatal trap', () => {
    it('banners window errors with their full identity', () => {
        trapUncaughtErrors();
        window.dispatchEvent(new ErrorEvent('error', {
            message: 'boom',
            filename: 'manga-reader.user.js',
            error: new Error('boom'),
        }));
        const banner = document.getElementById('hs-fatal-error');
        expect(banner?.textContent).toContain('window error:');
        expect(banner?.textContent).toContain('boom');
        expect(banner?.textContent).toContain('manga-reader.user.js');
    });

    it('ignores foreign rejections (the site’s nuke casualties)', () => {
        trapUncaughtErrors();
        const foreign = new Error('Importing a module script failed.');
        foreign.stack = 'TypeError: Importing a module script failed.\n@https://asurascans.com/:188:3328';
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
            promise: Promise.reject(foreign),
            reason: foreign,
        }));
        expect(document.getElementById('hs-fatal-error')).toBeNull();
    });

    it('banners OUR rejections with the marker in the stack', () => {
        trapUncaughtErrors();
        const ours = new Error('async boom');
        ours.stack = 'Error: async boom\n@manga-reader.user.js:42';
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
            promise: Promise.reject(ours),
            reason: ours,
        }));
        const banner = document.getElementById('hs-fatal-error');
        expect(banner?.textContent).toContain('unhandled rejection:');
        expect(banner?.textContent).toContain('async boom');
    });
});
