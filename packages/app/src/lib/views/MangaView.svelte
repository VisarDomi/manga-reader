<script lang="ts">
    import { tick } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { loadErrorMessage } from '$lib/state/errors.js';
    import { View } from '$lib/logic.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import ChapterList from '$lib/components/ChapterList.svelte';
    import CommentsSection from '$lib/components/CommentsSection.svelte';
    import MangaCoverImage from '$lib/components/MangaCoverImage.svelte';
    import MangaList from '$lib/components/MangaList.svelte';
    import type { MangaEntry } from '$lib/state/manga.svelte.js';

    const entries = $derived(appState.manga.entries);
    const mangaState = appState.manga;
    const isSwiping = $derived(appState.ui.isSwiping);
    const swipeAnimating = $derived(appState.ui.swipeAnimating);
    const nestedBack = $derived(appState.ui.viewMode === View.MANGA && appState.ui.peekBack() === View.MANGA && entries.length > 1);
    const restoreTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const restoreWaitingLogged = new Set<string>();
    const restoreAttempts = new Map<string, number>();

    function isActive(index: number) {
        return index === entries.length - 1;
    }

    function handleClose() {
        appState.manga.closeManga();
    }

    $effect(() => {
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (entry.scrollRestore) {
                scheduleScrollRestore(entry);
            }
        }
    });

    function handleMangaScroll(entry: MangaEntry, index: number, active: boolean, event: Event) {
        const el = event.currentTarget as HTMLElement | null;
        if (!el) return;
        if (entry.scrollRestore && event.isTrusted) {
            appState.log.emit('manga-scroll-restore', {
                action: 'aborted',
                mangaId: entry.manga.id,
                scrollTop: entry.scrollRestore.scrollTop,
                currentScrollTop: Math.round(el.scrollTop),
                scrollHeight: Math.round(el.scrollHeight),
                clientHeight: Math.round(el.clientHeight),
                reason: 'user-scroll',
            });
            appState.manga.consumeScrollRestore(entry.key);
            clearRestoreTimer(entry.key);
            return;
        }
        if (entry.scrollTarget?.source === 'history' && event.isTrusted) {
            appState.log.emit('manga-history-scroll', {
                action: 'aborted',
                mangaId: entry.manga.id,
                chapterId: entry.scrollTarget.kind === 'chapter' ? entry.scrollTarget.chapterId : '',
                reason: 'user-scroll',
            });
            appState.manga.consumeScrollTarget(entry.key, 'history');
            return;
        }
        if (entry.scrollTarget?.source === 'reader-recommendation' && event.isTrusted) {
            appState.log.emit('manga-recommendation-scroll', {
                action: 'aborted',
                mangaId: entry.manga.id,
                reason: 'user-scroll',
            });
            appState.manga.consumeScrollTarget(entry.key, 'reader-recommendation');
            return;
        }
        if (active) {
            appState.trackMangaDetailScroll(entry.manga.id, index, el.scrollTop, el.scrollHeight, el.clientHeight);
        }
    }

    function clearRestoreTimer(entryKey: string) {
        const timer = restoreTimers.get(entryKey);
        if (timer) clearTimeout(timer);
        restoreTimers.delete(entryKey);
        restoreWaitingLogged.delete(entryKey);
        restoreAttempts.delete(entryKey);
    }

    function scheduleScrollRestore(entry: MangaEntry) {
        if (!entry.scrollRestore || restoreTimers.has(entry.key)) return;
        appState.log.emit('manga-scroll-restore', {
            action: 'pending',
            mangaId: entry.manga.id,
            scrollTop: entry.scrollRestore.scrollTop,
            currentScrollTop: 0,
            scrollHeight: 0,
            clientHeight: 0,
        });
        const attempt = async () => {
            await tick();
            const target = entry.scrollRestore;
            const el = document.getElementById(`view-manga-entry-${entry.key}`);
            if (!target || !el) {
                clearRestoreTimer(entry.key);
                return;
            }
            const attempts = (restoreAttempts.get(entry.key) ?? 0) + 1;
            restoreAttempts.set(entry.key, attempts);
            const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
            if (maxScrollTop >= target.scrollTop) {
                const from = el.scrollTop;
                el.scrollTop = target.scrollTop;
                appState.log.emit('manga-scroll-restore', {
                    action: 'applied',
                    mangaId: entry.manga.id,
                    scrollTop: Math.round(target.scrollTop),
                    currentScrollTop: Math.round(from),
                    scrollHeight: Math.round(el.scrollHeight),
                    clientHeight: Math.round(el.clientHeight),
                });
                appState.manga.consumeScrollRestore(entry.key);
                clearRestoreTimer(entry.key);
                return;
            }
            if (!restoreWaitingLogged.has(entry.key)) {
                restoreWaitingLogged.add(entry.key);
                appState.log.emit('manga-scroll-restore', {
                    action: 'waiting',
                    mangaId: entry.manga.id,
                    scrollTop: Math.round(target.scrollTop),
                    currentScrollTop: Math.round(el.scrollTop),
                    scrollHeight: Math.round(el.scrollHeight),
                    clientHeight: Math.round(el.clientHeight),
                    reason: 'target-out-of-range',
                });
            }
            if (attempts >= 150) {
                appState.log.emit('manga-scroll-restore', {
                    action: 'skipped',
                    mangaId: entry.manga.id,
                    scrollTop: Math.round(target.scrollTop),
                    currentScrollTop: Math.round(el.scrollTop),
                    scrollHeight: Math.round(el.scrollHeight),
                    clientHeight: Math.round(el.clientHeight),
                    reason: 'target-never-reachable',
                });
                appState.manga.consumeScrollRestore(entry.key);
                clearRestoreTimer(entry.key);
                return;
            }
            restoreTimers.set(entry.key, setTimeout(attempt, 100));
        };
        restoreTimers.set(entry.key, setTimeout(attempt, 0));
    }

    $effect(() => {
        for (const entry of entries) {
            const target = entry.scrollTarget;
            if (!target || target.kind !== 'section' || target.section !== 'recommendations') continue;
            const container = document.getElementById(`view-manga-entry-${entry.key}`);
            const section = container?.querySelector<HTMLElement>('[data-manga-section="recommendations"]');
            if (!container || !section) continue;
            const from = container.scrollTop;
            container.scrollTop = Math.max(0, section.offsetTop - 12);
            appState.log.emit('manga-recommendation-scroll', {
                action: 'applied',
                mangaId: entry.manga.id,
                from: Math.round(from),
                to: Math.round(container.scrollTop),
            });
            appState.manga.consumeScrollTarget(entry.key, 'reader-recommendation');
        }
    });
</script>

<div class="manga-stack">
{#each entries as entry, index (entry.key)}
    {@const manga = entry.manga}
    {@const active = isActive(index)}
    <div
        id={`view-manga-entry-${entry.key}`}
        class="manga-entry-layer"
        class:view-hidden={!active && !(nestedBack && index === entries.length - 2)}
        class:swipe-back={nestedBack && index === entries.length - 2}
        class:swipe-active={active && nestedBack && isSwiping}
        class:swipe-animating={active && nestedBack && swipeAnimating}
        style="{active && nestedBack && isSwiping ? 'transform:translateX(var(--swipe-progress, 0%))' : ''}"
        onscroll={(event) => handleMangaScroll(entry, index, active, event)}
        use:swipeBack={{ onClose: handleClose, ui: appState.ui }}
    >
    <div class="manga-view">
        <div class="manga-view-header">
            <div class="manga-view-title-row">
                <h1>{manga.title}</h1>
                <button class="fav-btn" class:fav-active={appState.favorites.isFavorited(manga.id)} onclick={() => appState.favorites.toggle(manga)}>
                    {appState.favorites.isFavorited(manga.id) ? '❤' : '♡'}
                </button>
            </div>
            <div class="manga-view-cover">
                <MangaCoverImage mangaId={manga.id} title={manga.title} sourceUrl={manga.cover || undefined} variant="detail" source="detail" loading="eager" />
            </div>
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

        {#if entry.isLoading}
            <div class="empty">Loading chapters...</div>
        {:else if entry.error}
            <div class="empty error">{loadErrorMessage(entry.error)}</div>
        {:else if entry.chapters.length === 0}
            <div class="empty">No chapters found</div>
        {:else}
            {#if entry.isUpdatingChapters}
                <div class="empty updating">Loading more chapters...</div>
            {/if}
            <ChapterList {entry} />
        {/if}

        {#if (manga.recommendations ?? []).length > 0}
            <section class="manga-recommendations" data-manga-section="recommendations">
                <h2>Recommendations</h2>
                <MangaList manga={manga.recommendations ?? []} source="recommendations" />
            </section>
        {/if}

        <CommentsSection title="Comments" comments={entry.comments} count={entry.commentsCount} isLoading={entry.isCommentsLoading} error={entry.commentsError} />
    </div>
    </div>
{/each}
</div>

<style>
.manga-stack {
    position: relative;
    min-height: 100%;
}

.manga-entry-layer {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    width: 100%;
    max-width: 100%;
    -webkit-overflow-scrolling: touch;
    background: #000;
}

.manga-entry-layer.view-hidden {
    visibility: hidden;
    pointer-events: none;
}

.manga-entry-layer.swipe-active {
    z-index: 4;
    box-shadow: -10px 0 30px rgba(0, 0, 0, 0.3);
}

.manga-entry-layer.swipe-back {
    visibility: visible;
    pointer-events: none;
}

.manga-entry-layer.swipe-animating {
    transition: transform 250ms ease-out, opacity 250ms ease-out;
}

.manga-view {
    padding: max(15px, env(safe-area-inset-top)) 0 0;
    min-height: 100%;
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
}

.manga-view-header {
    padding: 0 16px 12px;
    border-bottom: 1px solid #222;
}

.manga-view-title-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
}

.manga-view-header h1 {
    margin: 0;
    font-size: 1.3rem;
    line-height: 1.3;
    color: #fff;
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
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
    overflow-wrap: anywhere;
    word-break: break-word;
}

.manga-view-cover {
    margin-top: 12px;
    width: 100%;
    max-height: 70vh;
    overflow: hidden;
    background: #171717;
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
    overflow-wrap: anywhere;
    word-break: break-word;
}

.manga-view-description {
    margin: 14px 0 0;
    color: #ddd;
    font-size: 15px;
    line-height: 1.55;
    white-space: pre-line;
    overflow-wrap: anywhere;
    word-break: break-word;
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
    max-width: 100%;
}

.manga-tag {
    font-size: 13px;
    padding: 2px 8px;
    background: #2a2a2a;
    color: #aaa;
    border-radius: 4px;
    max-width: 100%;
    overflow-wrap: anywhere;
    word-break: break-word;
}

.error {
    color: #ff6b6b;
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

</style>
