<script lang="ts">
    import type { MangaCommentPart } from '$lib/types.js';
    import * as api from '$lib/services/api.js';

    let {
        content,
        parts,
    }: {
        content: string;
        parts?: MangaCommentPart[];
    } = $props();

    let revealed = $state<Record<number, boolean>>({});
    const displayParts = $derived(parts && parts.length > 0 ? parts : [{ type: 'text' as const, text: content }]);
</script>

<div class="comment-content">
    {#each displayParts as part, i}
        {#if part.type === 'text'}
            <span class="comment-text">{part.text}</span>
        {:else if part.type === 'spoiler'}
            <button
                type="button"
                class="comment-spoiler"
                class:is-revealed={revealed[i]}
                aria-pressed={revealed[i] ? 'true' : 'false'}
                onclick={() => { revealed = { ...revealed, [i]: !revealed[i] }; }}
            >
                {revealed[i] ? part.text : 'Spoiler'}
            </button>
        {:else if part.type === 'image'}
            <a class="comment-image-link" href={part.url} target="_blank" rel="noreferrer">
                <img src={api.coverProxyUrl(part.url)} alt={part.alt} loading="lazy" decoding="async" />
            </a>
        {/if}
    {/each}
</div>

<style>
.comment-content {
    margin-top: 5px;
    color: #cfcfcf;
    font-size: 14px;
    line-height: 1.45;
    white-space: pre-line;
    overflow-wrap: anywhere;
    word-break: break-word;
    max-width: 100%;
}

.comment-text {
    white-space: pre-line;
    overflow-wrap: anywhere;
    word-break: break-word;
}

.comment-spoiler {
    display: inline;
    min-height: 24px;
    margin: 0 2px;
    padding: 1px 8px;
    border-radius: 4px;
    background: #27272a;
    color: transparent;
    text-shadow: 0 0 7px rgba(255, 255, 255, 0.75);
    vertical-align: baseline;
}

.comment-spoiler.is-revealed {
    color: #e5e5e5;
    text-shadow: none;
    background: #3a3121;
}

.comment-image-link {
    display: block;
    margin-top: 8px;
    max-width: min(100%, 360px);
    border-radius: 6px;
    overflow: hidden;
    background: #171717;
}

.comment-image-link img {
    width: 100%;
    height: auto;
    display: block;
}
</style>
