<script lang="ts">
    import type { Manga } from '$lib/types.js';
    import MangaCoverCard from './MangaCoverCard.svelte';

    let { manga }: { manga: Manga[] } = $props();
</script>

<div class="manga-grid">
    {#each manga as m (m.id)}
        <MangaCoverCard manga={m} />
    {/each}
</div>

<style>
.manga-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    padding: 0;
}

@media (min-width: 480px) {
    .manga-grid {
        grid-template-columns: repeat(4, 1fr);
    }
}

@media (min-width: 768px) {
    .manga-grid {
        grid-template-columns: repeat(5, 1fr);
    }
}
</style>
