<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import Reader from '$lib/components/Reader.svelte';

    const chapters = $derived(appState.reader.loadedChapters);

    function handleClose() {
        appState.reader.closeReader();
    }
</script>

<Reader {chapters} onClose={handleClose} />
