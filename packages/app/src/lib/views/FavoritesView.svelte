<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import MangaList from '$lib/components/MangaList.svelte';
    import type { FavoritesBackupSummary } from '$lib/state/favorites.svelte.js';

    const favsItems = $derived(appState.favorites.items);
    const favsLoading = $derived(appState.favorites.isLoading);
    let mountedAt = 0;
    let updateCount = 0;
    let backupModal = $state<{
        mode: 'backup' | 'restore';
        summary: FavoritesBackupSummary | null;
        error: string | null;
        busy: boolean;
    } | null>(null);

    async function openBackupModal() {
        backupModal = { mode: 'backup', summary: null, error: null, busy: true };
        try {
            backupModal.summary = await appState.favorites.localBackupSummary();
        } catch (e) {
            backupModal.error = String((e as Error)?.message ?? e);
        } finally {
            backupModal.busy = false;
        }
    }

    async function openRestoreModal() {
        backupModal = { mode: 'restore', summary: null, error: null, busy: true };
        try {
            backupModal.summary = await appState.favorites.serverBackupSummary();
            if (!backupModal.summary) backupModal.error = 'No backup found on server';
        } catch (e) {
            backupModal.error = String((e as Error)?.message ?? e);
        } finally {
            backupModal.busy = false;
        }
    }

    async function confirmBackupModal() {
        if (!backupModal) return;
        backupModal.busy = true;
        backupModal.error = null;
        try {
            backupModal.summary = backupModal.mode === 'backup'
                ? await appState.favorites.backupToServer()
                : await appState.favorites.restoreFromServer();
            backupModal = null;
        } catch (e) {
            if (backupModal) backupModal.error = String((e as Error)?.message ?? e);
        } finally {
            if (backupModal) backupModal.busy = false;
        }
    }

    onMount(() => {
        mountedAt = performance.now();
        appState.log.emit('favorites-view-lifecycle', {
            phase: 'mount',
            items: favsItems.length,
            isLoading: favsLoading,
            updateCount,
            dtMs: 0,
        });
        return () => {
            appState.log.emit('favorites-view-lifecycle', {
                phase: 'unmount',
                items: favsItems.length,
                isLoading: favsLoading,
                updateCount,
                dtMs: Math.round(performance.now() - mountedAt),
            });
        };
    });

    $effect(() => {
        const items = favsItems.length;
        const isLoading = favsLoading;
        if (mountedAt === 0) return;
        updateCount++;
        appState.log.emit('favorites-view-lifecycle', {
            phase: 'update',
            items,
            isLoading,
            updateCount,
            dtMs: Math.round(performance.now() - mountedAt),
        });
    });
</script>

<div class="favorites-view">
    <SearchBar favoritesMode />

    <div class="content-wrapper">
        <div class="results-info">
            <span class="count">{favsItems.length}</span> favorites
        </div>

        <div class="backup-actions">
            <button onclick={openBackupModal}>Backup to server</button>
            <button onclick={openRestoreModal}>Restore from backup</button>
        </div>

        {#if favsLoading}
            <div class="empty">Loading...</div>
        {:else if favsItems.length === 0}
            <div class="empty">No favorites yet</div>
        {:else}
            <MangaList manga={favsItems} trackVisible source="favorites" />
        {/if}
    </div>
</div>

{#if backupModal}
    <div class="modal-backdrop" role="presentation" onclick={() => { if (!backupModal?.busy) backupModal = null; }}>
        <div
            class="backup-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Favorites backup"
            tabindex="-1"
            onclick={(event) => event.stopPropagation()}
            onkeydown={(event) => event.stopPropagation()}
        >
            <h2>{backupModal.mode === 'backup' ? 'Backup Favorites' : 'Restore Favorites'}</h2>
            {#if backupModal.busy && !backupModal.summary && !backupModal.error}
                <p class="modal-muted">Reading favorites...</p>
            {:else if backupModal.error}
                <p class="modal-error">{backupModal.error}</p>
            {:else if backupModal.summary}
                {#if backupModal.summary.savedAt}
                    <p class="modal-muted">Saved {new Date(backupModal.summary.savedAt).toLocaleString()}</p>
                {/if}
                <div class="provider-counts">
                    {#each backupModal.summary.providerCounts as item (item.providerId)}
                        <span>{item.providerId}: {item.count}</span>
                    {/each}
                </div>
                <div class="backup-list">
                    {#each backupModal.summary.rows.slice(0, 60) as row (`${row.providerId}:${row.id}`)}
                        <div class="backup-row">
                            <span>{row.snapshot?.title ?? row.id}</span>
                            <small>{row.providerId}</small>
                        </div>
                    {/each}
                    {#if backupModal.summary.rows.length > 60}
                        <div class="modal-muted">+{backupModal.summary.rows.length - 60} more</div>
                    {/if}
                </div>
                {#if backupModal.mode === 'restore'}
                    <p class="modal-warning">Restore replaces the local favorites list with this server backup.</p>
                {/if}
            {/if}
            <div class="modal-actions">
                <button disabled={backupModal.busy} onclick={() => backupModal = null}>Cancel</button>
                <button
                    class="primary"
                    disabled={backupModal.busy || !backupModal.summary || backupModal.summary.rows.length === 0}
                    onclick={confirmBackupModal}
                >{backupModal.mode === 'backup' ? 'Backup' : 'Restore'}</button>
            </div>
        </div>
    </div>
{/if}

<style>
.favorites-view {
    min-height: 100%;
}

.content-wrapper {
    padding-bottom: max(20px, env(safe-area-inset-bottom));
}

.results-info {
    background: #111;
    border: 1px solid #333;
    padding: 10px;
    margin: 0 10px 15px 10px;
    border-radius: 4px;
    color: #aaa;
    font-size: 14px;
    display: flex;
    gap: 15px;
    align-items: center;
}

.results-info .count {
    color: #fff;
    font-weight: bold;
}

.backup-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 0 10px 15px;
}

.backup-actions button,
.modal-actions button {
    background: #222;
    border: 1px solid #444;
    color: #ddd;
    border-radius: 6px;
    padding: 9px 8px;
    font-size: 14px;
}

.modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 5000;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px;
}

.backup-modal {
    width: min(460px, 100%);
    max-height: min(680px, 88vh);
    background: #101010;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 16px;
    overflow-y: auto;
}

.backup-modal h2 {
    margin: 0 0 10px;
    font-size: 18px;
}

.modal-muted {
    color: #888;
    font-size: 13px;
}

.modal-error,
.modal-warning {
    color: #f87171;
    font-size: 13px;
}

.provider-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 10px 0;
}

.provider-counts span {
    background: #1c1c1c;
    border: 1px solid #333;
    border-radius: 999px;
    padding: 4px 9px;
    color: #ccc;
    font-size: 12px;
}

.backup-list {
    border: 1px solid #242424;
    border-radius: 6px;
    overflow: hidden;
}

.backup-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 9px;
    border-bottom: 1px solid #202020;
}

.backup-row:last-child {
    border-bottom: none;
}

.backup-row span {
    color: #ddd;
    font-size: 13px;
}

.backup-row small {
    color: #777;
    font-size: 12px;
    flex: 0 0 auto;
}

.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
}

.modal-actions .primary {
    background: #124f1e;
    border-color: #2f8f3a;
    color: #fff;
}

.modal-actions button:disabled {
    opacity: 0.5;
}
</style>
