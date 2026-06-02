<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import SearchBar from '$lib/components/SearchBar.svelte';

    const providers = [
        { id: 'comix', name: 'Comix' },
        { id: 'mangadotnet', name: 'Mangadotnet' },
    ];
</script>

<div class="providers-view">
    <SearchBar providersMode />

    <div class="content-wrapper">
        {#each providers as provider (provider.id)}
            <button
                class="provider-row"
                class:active={appState.activeProviderId === provider.id}
                onclick={() => void appState.selectProvider(provider.id)}
            >
                <span>{provider.name}</span>
                <span class="provider-id">{provider.id}</span>
            </button>
        {/each}
    </div>
</div>

<style>
.providers-view {
    min-height: 100%;
}

.content-wrapper {
    padding: 10px 10px max(20px, env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.provider-row {
    width: 100%;
    border: 1px solid #333;
    background: #111;
    color: #fff;
    border-radius: 6px;
    padding: 14px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 16px;
}

.provider-row.active {
    border-color: #4af626;
}

.provider-id {
    color: #888;
    font-size: 13px;
    font-family: monospace;
}
</style>
