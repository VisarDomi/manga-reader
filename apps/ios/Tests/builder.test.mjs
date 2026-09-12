import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { selectProvider, providerRegistry } from '../../../scripts/build-ios.mjs';
const sites = JSON.parse(readFileSync(new URL('../../../src/core/sites.json', import.meta.url), 'utf8'));
test('requires one implemented provider before any build or remote operation', () => {
    for (const args of [[], ['asura', 'scythe'], ['asura,scythe'], ['-asura'], ['unknown'], ['--prepare-only']])
        assert.throws(() => selectProvider(args, sites));
    for (const name of ['lua', 'yaksha', 'ezmanga', 'qiscans']) assert.equal(selectProvider([name], sites), name);
    assert.equal(selectProvider(['asura'], sites), 'asura');
    assert.equal(selectProvider(['scythe', '--prepare-only'], sites), 'scythe');
});
test('uses userscript registry and preserves independent installed app identities', () => {
    const registry = providerRegistry(sites);
    assert.equal(registry.asura.key, 'asurascans');
    assert.equal(registry.scythe.key, 'scythescans');
    assert.equal(registry.asura.bundleIdentifier, 'com.visar.AsuraReader');
    assert.equal(registry.scythe.bundleIdentifier, 'com.visar.ScytheReader');
    assert.notEqual(registry.asura.source, registry.scythe.source);
    assert.equal(registry.ezmanga.source, registry.qiscans.source, 'Angular providers share their adapter');
    assert.equal(Object.keys(registry).length, 6);
});
