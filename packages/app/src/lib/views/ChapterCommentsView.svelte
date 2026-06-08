<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import CommentsSection from '$lib/components/CommentsSection.svelte';

    const reader = appState.reader;
    const context = $derived(reader.chapterCommentsContext);
    const comments = $derived(reader.chapterComments);
    const count = $derived(reader.chapterCommentsCount);
    const isLoading = $derived(reader.isChapterCommentsLoading);
    const error = $derived(reader.chapterCommentsError);

</script>

<div class="chapter-comments-view">
    <header class="chapter-comments-header">
        <p>{context?.mangaTitle ?? 'Manga'}</p>
        <h1>Chapter {context?.chapterNumber ?? ''} Comments</h1>
        {#if context?.groupName}
            <p>{context.groupName}</p>
        {/if}
    </header>

    <CommentsSection title="Comments" {comments} {count} {isLoading} {error} />
</div>

<style>
.chapter-comments-view {
    min-height: 100%;
    padding: max(15px, env(safe-area-inset-top)) 0 0;
    background: #000;
}

.chapter-comments-header {
    padding: 0 16px 14px;
    border-bottom: 1px solid #222;
}

.chapter-comments-header h1 {
    margin: 4px 0 0;
    color: #fff;
    font-size: 1.25rem;
    line-height: 1.3;
}

.chapter-comments-header p {
    margin: 0;
    color: #888;
    font-size: 14px;
    line-height: 1.4;
}
</style>
