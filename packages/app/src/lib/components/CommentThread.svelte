<script lang="ts">
    import type { MangaComment } from '$lib/types.js';
    import * as api from '$lib/services/api.js';
    import CommentThread from './CommentThread.svelte';

    interface Props {
        comment: MangaComment;
        depth?: number;
    }

    const { comment, depth = 1 }: Props = $props();
    const initial = $derived(comment.author.slice(0, 1).toUpperCase());
</script>

<article class="comment-thread" class:comment-reply={depth > 1} style:--comment-depth={Math.min(depth, 6)}>
    <div class="comment-main">
        <div class="comment-avatar">
            {#if comment.avatar}
                <img src={api.coverProxyUrl(comment.avatar)} alt="" loading="lazy" />
            {:else}
                <span>{initial}</span>
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
        <div class="comment-children">
            {#each comment.replies as reply (reply.id)}
                <CommentThread comment={reply} depth={depth + 1} />
            {/each}
        </div>
    {/if}
</article>

<style>
.comment-thread {
    padding: 10px 0;
    border-bottom: 1px solid #202020;
}

.comment-thread.comment-reply {
    padding: 8px 0 0 10px;
    border-bottom: 0;
    border-left: 2px solid hsl(calc(150 + var(--comment-depth) * 20) 30% 30%);
}

.comment-main {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 10px;
}

.comment-reply .comment-main {
    grid-template-columns: 26px minmax(0, 1fr);
    gap: 8px;
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

.comment-reply .comment-avatar {
    width: 26px;
    height: 26px;
    font-size: 11px;
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
    overflow-wrap: anywhere;
}

.comment-reply .comment-body p {
    color: #bdbdbd;
    font-size: 13px;
}

.comment-children {
    margin: 8px 0 0 42px;
    display: grid;
    gap: 8px;
}

.comment-reply .comment-children {
    margin-left: 18px;
}
</style>
