<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
</script>

<div class="providers-view">
    <SearchBar providersMode />

    <div class="content-wrapper">
        {#each appState.providers as provider (provider.id)}
            <div
                class="provider-row"
                class:active={appState.activeProviderId === provider.id}
                class:disabled={!provider.enabled}
            >
                <label class="provider-toggle">
                    <input
                        type="checkbox"
                        checked={provider.enabled}
                        onchange={(event) => void appState.setProviderEnabled(provider.id, event.currentTarget.checked)}
                    />
                </label>
                <button
                    class="provider-select"
                    disabled={!provider.enabled}
                    onclick={() => void appState.selectProvider(provider.id)}
                >
                    <span>{provider.name}</span>
                    <span class="provider-id">{provider.id}</span>
                </button>
                <span class="provider-state" class:ready={provider.ready}>
                    {provider.enabled ? (provider.ready ? 'ready' : 'warming') : 'disabled'}
                </span>
            </div>
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
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 16px;
}

.provider-row.active {
    border-color: #4af626;
}

.provider-row.disabled {
    color: #777;
}

.provider-toggle {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
}

.provider-toggle input {
    width: 20px;
    height: 20px;
}

.provider-select {
    min-width: 0;
    flex: 1;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 4px 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    font: inherit;
    text-align: left;
}

.provider-select:disabled {
    color: #777;
}

.provider-id {
    color: #888;
    font-size: 13px;
    font-family: monospace;
}

.provider-state {
    color: #888;
    font-size: 12px;
}

.provider-state.ready {
    color: #4af626;
}
</style>
