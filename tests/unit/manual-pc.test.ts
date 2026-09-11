import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), restore: vi.fn(), load: vi.fn() }));
vi.mock('../../src/core/compute/store', () => ({ databaseBackup: mocks.snapshot, restoreDatabaseBackup: mocks.restore }));
vi.mock('../../src/core/compute/migrations', () => ({ loadProgress: mocks.load }));
import { manualPC } from '../../src/core/compute/manual-pc';
const snapshot = (updatedAt = 1) => ({version:1,indexedDB:{progress:[{id:'asurascans\0fixture',provider:'asurascans',seriesSlug:'fixture',chapterId:'2',imageIndex:1,totalImages:4,updatedAt}],tokens:[],metadata:[{key:'progress-schema-version',value:3},{key:'asura-ios-v1',value:{history:{fixture:{'1':9}}}}]}});
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('__READER_BACKUP_URL__','https://pc.test'); vi.stubGlobal('__READER_BACKUP_KEY__','test'); mocks.snapshot.mockResolvedValue(snapshot(100)); });
it('discovery only probes status and never touches reading state', async () => {
 const fetcher=vi.fn().mockResolvedValue(new Response('{}'));vi.stubGlobal('fetch',fetcher);
 expect(await manualPC({action:'available',provider:'asurascans'})).toBe(true);
 expect(fetcher.mock.calls[0][0]).toMatch(/\/status$/);expect(mocks.snapshot).not.toHaveBeenCalled();expect(mocks.restore).not.toHaveBeenCalled();
});
it('Load replaces even older progress and preserves native metadata', async () => {
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot(1)))));
 await manualPC({action:'load',provider:'asurascans'});
 expect(mocks.restore.mock.calls[0][0].indexedDB.progress[0].updatedAt).toBe(1);
 expect(mocks.restore.mock.calls[0][0].indexedDB.metadata[1].value.history.fixture['1']).toBe(9);
});
it('Save sends exactly one explicit snapshot PUT', async () => {
 const fetcher=vi.fn().mockResolvedValue(new Response('{}'));vi.stubGlobal('fetch',fetcher);
 await manualPC({action:'save',provider:'asurascans'});
 expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1].method).toBe('PUT');expect(mocks.restore).not.toHaveBeenCalled();
});
it('offline discovery is silent and failed Load preserves local state', async () => {
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
 expect(await manualPC({action:'available',provider:'asurascans'})).toBe(false);
 await expect(manualPC({action:'load',provider:'asurascans'})).rejects.toThrow('offline');expect(mocks.restore).not.toHaveBeenCalled();
});
