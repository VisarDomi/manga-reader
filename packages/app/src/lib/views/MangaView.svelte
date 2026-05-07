<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { loadErrorMessage } from '$lib/state/errors.js';
    import * as api from '$lib/services/api.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import ChapterList from '$lib/components/ChapterList.svelte';
    import MangaList from '$lib/components/MangaList.svelte';

    const manga = $derived(appState.manga.activeManga);
    const chapters = $derived(appState.manga.chapters);
    const isLoading = $derived(appState.manga.isLoading);
    const error = $derived(appState.manga.error);
    const isFav = $derived(manga ? appState.favorites.isFavorited(manga.id) : false);
    const coverUrl = $derived(manga?.cover ? api.coverProxyUrl(manga.cover) : '');
    const mangaState = appState.manga;
    const gf = appState.groupFilter;
    const recommendations = $derived(manga?.recommendations ?? []);
    const comments = $derived(mangaState.comments);
    const commentsCount = $derived(mangaState.commentsCount);
    const isCommentsLoading = $derived(mangaState.isCommentsLoading);
    const commentsError = $derived(mangaState.commentsError);

    const allFiltered = $derived(
        !isLoading && chapters.length > 0 &&
        chapters.every(ch => gf.isFiltered(ch.groupId ?? ''))
    );

    $effect(() => {
        if (isLoading) {
            const view = document.getElementById('view-manga');
            if (view) view.scrollTop = 0;
        }
    });

    function handleClose() {
        appState.manga.closeManga();
    }
</script>

{#if manga}
    <div class="manga-view" use:swipeBack={{ onClose: handleClose, ui: appState.ui }}>
        <div class="manga-view-header">
            <div class="manga-view-title-row">
                <h1>{manga.title}</h1>
                <button class="fav-btn" class:fav-active={isFav} onclick={() => manga && appState.favorites.toggle(manga)}>
                    {isFav ? '❤' : '♡'}
                </button>
            </div>
            {#if coverUrl}
                <div class="manga-view-cover">
                    <img src={coverUrl} alt={manga.title} />
                </div>
            {/if}
            {#if manga.altTitles?.length}
                <div class="manga-view-alt-titles">
                    {#each manga.altTitles as title}
                        <p>{title}</p>
                    {/each}
                </div>
            {/if}
            {#if manga.author}
                <p class="manga-view-author">{manga.author}</p>
            {/if}
            {#if manga.description}
                <p class="manga-view-description">{manga.description}</p>
            {/if}
            {#if manga.genres?.length}
                <section class="manga-meta-section">
                    <h2>Genres</h2>
                    <div class="manga-view-tags">
                        {#each manga.genres as genre}
                            <span class="manga-tag">{genre}</span>
                        {/each}
                    </div>
                </section>
            {/if}
            {#if manga.tags?.length}
                <section class="manga-meta-section">
                    <h2>Tags</h2>
                    <div class="manga-view-tags">
                        {#each manga.tags as tag}
                            <span class="manga-tag">{tag}</span>
                        {/each}
                    </div>
                </section>
            {/if}
            {#if manga.demographics?.length}
                <section class="manga-meta-section">
                    <h2>Demographics</h2>
                    <div class="manga-view-tags">
                        {#each manga.demographics as demographic}
                            <span class="manga-tag">{demographic}</span>
                        {/each}
                    </div>
                </section>
            {/if}
        </div>

        {#if isLoading}
            <div class="empty">Loading chapters...</div>
        {:else if error}
            <div class="empty error">{loadErrorMessage(error)}</div>
        {:else if chapters.length === 0}
            <div class="empty">No chapters found</div>
        {:else if allFiltered && !mangaState.isShowingBlockedChapters}
            <div class="empty">
                <p>All chapters hidden by group filter</p>
                <button class="show-filtered-action" onclick={() => mangaState.showBlockedChapters()}>Show filtered chapters</button>
            </div>
        {:else}
            <ChapterList {chapters} />
        {/if}

        {#if recommendations.length > 0}
            <section class="manga-recommendations">
                <h2>Recommendations</h2>
                <MangaList manga={recommendations} />
            </section>
        {/if}

        <section class="manga-comments">
            <h2>Comments{commentsCount > 0 ? ` (${commentsCount})` : ''}</h2>
            {#if isCommentsLoading}
                <div class="comments-empty">Loading comments...</div>
            {:else if commentsError}
                <div class="comments-empty error">Failed to load comments</div>
            {:else if comments.length === 0}
                <div class="comments-empty">No comments</div>
            {:else}
                <div class="comments-list">
                    {#each comments as comment (comment.id)}
                        <article class="comment-item">
                            <div class="comment-main">
                                <div class="comment-avatar">
                                    {#if comment.avatar}
                                        <img src={api.coverProxyUrl(comment.avatar)} alt="" loading="lazy" />
                                    {:else}
                                        <span>{comment.author.slice(0, 1)}</span>
                                    {/if}
                                </div>
                                <div class="comment-body">
                                    <div class="comment-meta">
                                        <span class="comment-author">{comment.author}</span>
                                        {#if comment.createdAt}
                                            <span>{comment.createdAt}</span>
                                        {/if}
                                        {#if comment.likeCount > 0}
                                            <span>+{comment.likeCount}</span>
                                        {/if}
                                    </div>
                                    <p>{comment.content}</p>
                                </div>
                            </div>
                            {#if comment.replies.length > 0}
                                <div class="comment-replies">
                                    {#each comment.replies.slice(0, 2) as reply (reply.id)}
                                        <div class="comment-reply">
                                            <span class="comment-author">{reply.author}</span>
                                            <span>{reply.content}</span>
                                        </div>
                                    {/each}
                                    {#if comment.replies.length > 2}
                                        <div class="comment-reply-more">{comment.replies.length - 2} more replies</div>
                                    {/if}
                                </div>
                            {/if}
                        </article>
                    {/each}
                </div>
            {/if}
        </section>
    </div>
{/if}

<style>
.manga-view {
    padding: max(15px, env(safe-area-inset-top)) 0 0;
    min-height: 100%;
}

.manga-view-header {
    padding: 0 16px 12px;
    border-bottom: 1px solid #222;
}

.manga-view-title-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}

.manga-view-header h1 {
    margin: 0;
    font-size: 1.3rem;
    line-height: 1.3;
    color: #fff;
    flex: 1;
}

.fav-btn {
    flex-shrink: 0;
    font-size: 1.5rem;
    line-height: 1;
    padding: 4px;
    color: #666;
    transition: color 0.15s;
}

.fav-btn.fav-active {
    color: #f87171;
}

.manga-view-author {
    margin: 10px 0 0;
    font-size: 14px;
    color: #888;
}

.manga-view-cover {
    margin-top: 12px;
    width: 100%;
    max-height: 70vh;
    overflow: hidden;
    background: #171717;
}

.manga-view-cover img {
    width: 100%;
    display: block;
    object-fit: cover;
}

.manga-view-alt-titles {
    margin-top: 12px;
    display: grid;
    gap: 4px;
}

.manga-view-alt-titles p {
    margin: 0;
    color: #aaa;
    font-size: 14px;
    line-height: 1.35;
}

.manga-view-description {
    margin: 14px 0 0;
    color: #ddd;
    font-size: 15px;
    line-height: 1.55;
    white-space: pre-line;
}

.manga-meta-section {
    margin-top: 16px;
}

.manga-meta-section h2 {
    margin: 0;
    color: #f5f5f5;
    font-size: 15px;
    font-weight: 700;
}

.manga-view-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 7px;
}

.manga-tag {
    font-size: 13px;
    padding: 2px 8px;
    background: #2a2a2a;
    color: #aaa;
    border-radius: 4px;
}

.error {
    color: #ff6b6b;
}

.show-filtered-action {
    margin-top: 12px;
    padding: 8px 16px;
    background: #2a1a2a;
    color: #c084fc;
    border: 1px solid #5a2d5a;
    border-radius: 8px;
    font-size: 14px;
}

.manga-recommendations {
    padding: 18px 0 max(24px, env(safe-area-inset-bottom));
    border-top: 1px solid #222;
}

.manga-recommendations h2 {
    margin: 0 16px 12px;
    color: #f5f5f5;
    font-size: 16px;
}

.manga-comments {
    padding: 18px 16px max(24px, env(safe-area-inset-bottom));
    border-top: 1px solid #222;
}

.manga-comments h2 {
    margin: 0 0 12px;
    color: #f5f5f5;
    font-size: 16px;
}

.comments-empty {
    padding: 14px 0;
    color: #888;
    font-size: 14px;
}

.comments-list {
    display: grid;
    gap: 10px;
}

.comment-item {
    padding: 10px 0;
    border-bottom: 1px solid #202020;
}

.comment-main {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 10px;
}

.comment-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    background: #262626;
    display: grid;
    place-items: center;
    color: #aaa;
    font-size: 13px;
    font-weight: 700;
}

.comment-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.comment-body {
    min-width: 0;
}

.comment-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    color: #777;
    font-size: 12px;
}

.comment-author {
    color: #ddd;
    font-weight: 700;
}

.comment-body p {
    margin: 5px 0 0;
    color: #cfcfcf;
    font-size: 14px;
    line-height: 1.45;
    white-space: pre-line;
}

.comment-replies {
    margin: 8px 0 0 42px;
    display: grid;
    gap: 6px;
}

.comment-reply {
    padding-left: 8px;
    border-left: 2px solid #2a2a2a;
    color: #aaa;
    font-size: 13px;
    line-height: 1.35;
    display: grid;
    gap: 2px;
}

.comment-reply-more {
    color: #777;
    font-size: 12px;
}
</style>
