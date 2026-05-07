<script lang="ts">
    import CommentThread from '$lib/components/CommentThread.svelte';
    import type { MangaComment } from '$lib/types.js';

    let {
        title,
        comments,
        count,
        isLoading,
        error,
    }: {
        title: string;
        comments: MangaComment[];
        count: number;
        isLoading: boolean;
        error: string | null;
    } = $props();
</script>

<section class="comments-section">
    <h2>{title}{count > 0 ? ` (${count})` : ''}</h2>
    {#if isLoading}
        <div class="comments-empty">Loading comments...</div>
    {:else if error}
        <div class="comments-empty error">Failed to load comments</div>
    {:else if comments.length === 0}
        <div class="comments-empty">No comments</div>
    {:else}
        <div class="comments-list">
            {#each comments as comment (comment.id)}
                <CommentThread {comment} />
            {/each}
        </div>
    {/if}
</section>

<style>
.comments-section {
    padding: 18px 16px max(24px, env(safe-area-inset-bottom));
    border-top: 1px solid #222;
}

.comments-section h2 {
    margin: 0 0 12px;
    color: #f5f5f5;
    font-size: 16px;
}

.comments-empty {
    padding: 14px 0;
    color: #888;
    font-size: 14px;
}

.comments-empty.error {
    color: #ff6b6b;
}

.comments-list {
    display: grid;
    gap: 10px;
}
</style>
