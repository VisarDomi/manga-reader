<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import * as api from '$lib/services/api.js';
    import type { MangaListSource } from '$lib/services/PerfDiagnostics.js';

    let {
        mangaId,
        title,
        sourceUrl,
        variant,
        source,
        loading = 'lazy',
    }: {
        mangaId: string;
        title: string;
        sourceUrl?: string;
        variant: 'card' | 'detail';
        source: MangaListSource | 'detail';
        loading?: 'lazy' | 'eager';
    } = $props();

    const imageUrl = $derived(sourceUrl ? api.coverProxyUrl(mangaId, variant, sourceUrl) : '');
    let mountedAt = 0;
    let failedUrl = $state<string | null>(null);
    const showImage = $derived(imageUrl.length > 0 && failedUrl !== imageUrl);

    $effect(() => {
        if (imageUrl && failedUrl !== imageUrl) return;
        if (!imageUrl) failedUrl = null;
    });

    function emit(phase: 'mount' | 'load' | 'error' | 'missing', img?: HTMLImageElement) {
        appState.log.emit('manga-cover-image', {
            source,
            phase,
            mangaId,
            hasCover: !!imageUrl,
            dtMs: Math.round(performance.now() - mountedAt),
            naturalWidth: img?.naturalWidth,
            naturalHeight: img?.naturalHeight,
        });
    }

    function handleError() {
        failedUrl = imageUrl;
        emit('error');
    }

    $effect(() => {
        mountedAt = performance.now();
        emit(imageUrl ? 'mount' : 'missing');
    });
</script>

{#if showImage}
    <img
        class:card={variant === 'card'}
        class:detail={variant === 'detail'}
        src={imageUrl}
        alt={title}
        {loading}
        decoding="async"
        onload={(event) => emit('load', event.currentTarget)}
        onerror={handleError}
    />
{:else}
    <div class="cover-placeholder" class:card={variant === 'card'} class:detail={variant === 'detail'} aria-label="Poster unavailable">
        <span>Poster unavailable</span>
    </div>
{/if}

<style>
.cover-placeholder {
    width: 100%;
    display: grid;
    place-items: center;
    background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0)),
        #171717;
    color: #777;
    font-size: 11px;
    font-weight: 700;
    text-align: center;
    text-transform: uppercase;
    padding: 12px;
}

.cover-placeholder.card {
    height: 100%;
    min-height: 100%;
}

.cover-placeholder.detail {
    min-height: 320px;
}

.cover-placeholder span {
    max-width: 10ch;
}

img {
    width: 100%;
    display: block;
}

img.card {
    height: 100%;
    object-fit: cover;
}

img.detail {
    height: auto;
}
</style>
