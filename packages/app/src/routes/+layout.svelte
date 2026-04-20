<script lang="ts">
    import '$lib/styles.css';
    import { onMount } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';

    let { children } = $props();

    onMount(() => {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js');
        }
    });
</script>

<svelte:head>
    <title>{appState.documentTitle}</title>
</svelte:head>

<div class="safe-area">
    {@render children()}
</div>

<style>
    .safe-area {
        padding-top: env(safe-area-inset-top, 0px);
    }
</style>
