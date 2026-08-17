import { describe, expect, it } from 'vitest';
import { Handler, providerForSite } from '../../src/provider';

describe('provider registry', () => {
    it('resolves every provider name to a working provider with a home route', () => {
        const providers: Array<[string, string]> = [
            ['asura', 'asurascans'],
            ['valir', 'valirscans'],
            ['lua', 'luacomic'],
            ['scythe', 'scythescans'],
            ['violet', 'violetscans'],
            ['yaksha', 'yakshacomics'],
            ['ezmanga', 'ezmanga'],
            ['qiscans', 'qimanga'],
        ];
        for (const [name, key] of providers) {
            const provider = providerForSite(name);
            expect(provider, name).toBeDefined();
            expect(provider?.key).toBe(key);
            expect(provider?.matchRoute('/', '')).toEqual({ handler: Handler.Home });
        }
        expect(providerForSite('does-not-exist')).toBeUndefined();
    });
});
