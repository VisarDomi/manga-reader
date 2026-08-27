import { describe, expect, it } from 'vitest';
import { SITE_CONFIG } from '../../src/core/sites';
import { Handler, initializeProviderRoute } from '../../src/provider';

const readerUrls = [
    'https://asurascans.com/comics/chronicles-of-the-lazy-sovereign-f886a8af/chapter/50#3',
    'https://scythescans.com/magic-emperor-chapter-1/#5',
    'https://luacomic.org/series/im-tired-of-novel-transmigration/chapter-70#4',
    'https://violetscans.org/the-abandoned-lady-wants-to-love-your-secret-chapter-1/#17',
    'https://ezmanga.org/series/apocalypse-villainess-surviving-with-corporate-slave-skills/chapter-2#3',
    'https://qimanga.com/series/genius-magic-swordsman-returns/chapter-1#5',
    'https://yakshacomics.com/manga/who-allowed-him-to-cultivate-immortality/chapter-16/#3',
];

describe('test.txt URLs', () => {
    it('recognizes every reader URL and its saved image', () => {
        for (const href of readerUrls) {
            const url = new URL(href);
            const route = initializeProviderRoute(url)?.route;
            expect(route?.handler, href).toBe(Handler.Reader);
            if (route?.handler === Handler.Reader) {
                expect(route.imageIndex, href).toBe(url.hash.slice(1));
            }
        }
    });

    it('recognizes every provider root as Home', () => {
        for (const config of Object.values(SITE_CONFIG)) {
            const route = initializeProviderRoute(new URL(`https://${config.domain}/`))?.route;
            expect(route, config.domain).toEqual({ handler: Handler.Home });
        }
    });
});
