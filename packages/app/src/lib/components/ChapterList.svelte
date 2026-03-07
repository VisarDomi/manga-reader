<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import type { ChapterMeta } from '$lib/types.js';
    import FilterChip from './FilterChip.svelte';

    let { chapters }: { chapters: ChapterMeta[] } = $props();

    const mangaId = $derived(appState.manga.activeManga?.id ?? '');
    const gf = appState.groupFilter;
    const selectedGroups = $derived(appState.manga.selectedGroups);

    // Reset showFiltered when manga changes
    $effect(() => {
        mangaId;
        gf.showFiltered = false;
    });

    // Whether this manga has chapters hidden by the global filter
    const hasFilteredChapters = $derived(
        gf.count > 0 && chapters.some(ch => gf.isFiltered(ch.groupId ?? ''))
    );

    // Chapters after applying global group filter (used only for "All" count display)
    const effectiveCount = $derived.by(() => {
        if (gf.showFiltered || gf.count === 0) return chapters.length;
        return chapters.filter(ch => !gf.isFiltered(ch.groupId ?? '')).length;
    });

    // Long-press inline confirm state
    let pendingGroup = $state<{ id: string; name: string } | null>(null);

    function handleLongPressGroup(groupId: string, groupName: string) {
        // Toggle off if same group tapped again
        if (pendingGroup?.id === groupId) {
            pendingGroup = null;
        } else {
            pendingGroup = { id: groupId, name: groupName };
        }
    }

    function confirmFilter() {
        if (!pendingGroup) return;
        const { id, name } = pendingGroup;
        if (gf.isFiltered(id)) {
            gf.remove(id);
            appState.toast.show(`Unblocked "${name}"`);
        } else {
            gf.add(id, name);
            appState.toast.show(`Blocked "${name}"`);
        }
        pendingGroup = null;
    }

    // Collect unique groups from ALL chapters (not effectiveChapters) so filtered groups stay visible
    const groups = $derived.by(() => {
        const map = new Map<string, { id: string; name: string; count: number }>();
        for (const ch of chapters) {
            const gid = ch.groupId ?? '';
            const existing = map.get(gid);
            if (existing) {
                existing.count++;
            } else {
                map.set(gid, {
                    id: gid,
                    name: ch.groupName || 'No Group',
                    count: 1,
                });
            }
        }
        return [...map.values()].sort((a, b) => b.count - a.count);
    });

    const filtered = $derived(appState.manga.filteredChapters);

    type GapIndicator = { type: 'gap'; missing: number; from: number; to: number };
    type ListItem = { type: 'chapter'; chapter: ChapterMeta } | GapIndicator;

    const listItems = $derived.by((): ListItem[] => {
        const result: ListItem[] = [];
        for (let i = 0; i < filtered.length; i++) {
            result.push({ type: 'chapter', chapter: filtered[i] });
            if (i < filtered.length - 1) {
                const cur = Math.floor(filtered[i].number);
                const next = Math.floor(filtered[i + 1].number);
                const missing = cur - next - 1;
                if (missing > 0) {
                    result.push({ type: 'gap', missing, from: next + 1, to: cur - 1 });
                }
            }
        }
        // Base case: if the last (lowest) chapter is > 1, show gap from chapter 1
        if (filtered.length > 0) {
            const lowest = Math.floor(filtered[filtered.length - 1].number);
            if (lowest > 1) {
                const missing = lowest - 1;
                result.push({ type: 'gap', missing, from: 1, to: lowest - 1 });
            }
        }
        return result;
    });

    const currentChapterId = $derived(appState.progress.get(mangaId)?.chapterId ?? null);

    function handleClick(chapter: ChapterMeta) {
        const manga = appState.manga.activeManga;
        if (!manga) return;
        appState.reader.openReader(manga, chapter);
    }

    /** Scrolls the current chapter into view on mount. */
    function scrollIfCurrent(node: HTMLElement, isCurrent: boolean) {
        if (isCurrent) {
            requestAnimationFrame(() => {
                node.scrollIntoView({ block: 'center' });
            });
        }
        return {};
    }

    function formatDate(ts?: number): string {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        const now = Date.now();
        const diff = now - d.getTime();
        const hours = Math.floor(diff / 3600000);
        if (hours < 1) return 'just now';
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days}d ago`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months}mo ago`;
        return `${Math.floor(months / 12)}y ago`;
    }

    /** Check if a chapter belongs to a globally filtered group */
    function isChapterFiltered(ch: ChapterMeta): boolean {
        return gf.isFiltered(ch.groupId ?? '');
    }
</script>

<div class="chapter-filter">
    <FilterChip
        label={`All (${effectiveCount})`}
        active={selectedGroups.size === 0}
        onclick={() => appState.manga.selectAllGroups()}
    />
    {#each groups as group (group.id)}
        <FilterChip
            label={`${group.name} (${group.count})`}
            active={selectedGroups.has(group.id)}
            excluded={gf.isFiltered(group.id)}
            onclick={() => appState.manga.toggleGroup(group.id)}
            onlongpress={() => handleLongPressGroup(group.id, group.name)}
        />
    {/each}
    {#if hasFilteredChapters}
        <button
            class="show-filtered-btn"
            class:active={gf.showFiltered}
            onclick={() => gf.showFiltered = !gf.showFiltered}
        >{gf.showFiltered ? 'Hide filtered' : 'Show filtered'}</button>
    {/if}
    {#if pendingGroup}
        <div class="inline-confirm">
            <span class="inline-confirm-name">{pendingGroup.name}</span>
            <button class="inline-confirm-btn cancel" onclick={() => pendingGroup = null}>Cancel</button>
            <button
                class="inline-confirm-btn"
                class:block-btn={!gf.isFiltered(pendingGroup.id)}
                class:unblock-btn={gf.isFiltered(pendingGroup.id)}
                onclick={confirmFilter}
            >{gf.isFiltered(pendingGroup.id) ? 'Unblock' : 'Block'}</button>
        </div>
    {/if}
</div>

<div class="chapter-list">
    {#each listItems as item (item.type === 'chapter' ? item.chapter.id : `gap-${item.from}-${item.to}`)}
        {#if item.type === 'gap'}
            <div class="chapter-gap">
                {item.missing} chapter{item.missing > 1 ? 's' : ''} missing (Ch. {item.from}{item.from !== item.to ? ` – ${item.to}` : ''})
            </div>
        {:else}
            {@const chapter = item.chapter}
            <button
                class="chapter-item"
                class:chapter-current={chapter.id === currentChapterId}
                class:chapter-filtered={gf.showFiltered && isChapterFiltered(chapter)}
                use:scrollIfCurrent={chapter.id === currentChapterId}
                onclick={() => handleClick(chapter)}
            >
                <span class="chapter-number">Ch. {chapter.number}</span>
                <span class="chapter-group">{chapter.groupName || 'No Group'}</span>
                {#if chapter.uploadedAt}
                    <span class="chapter-date">{formatDate(chapter.uploadedAt)}</span>
                {/if}
            </button>
        {/if}
    {/each}
</div>


<style>
.chapter-filter {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid #222;
    align-items: center;
}

.chapter-list {
    padding: 8px;
}

.chapter-item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 12px;
    background: #1a1a1a;
    border-radius: 8px;
    margin-bottom: 4px;
    text-align: left;
}

.chapter-item:active {
    background: #333;
}

.chapter-item.chapter-current {
    border-left: 3px solid #4af626;
}

.chapter-item.chapter-current .chapter-number {
    color: #4af626;
    font-weight: 700;
}

.chapter-item.chapter-filtered {
    opacity: 0.35;
}

.chapter-number {
    font-weight: 600;
    font-size: 14px;
    color: #fff;
    min-width: 60px;
}

.chapter-group {
    flex: 1;
    font-size: 13px;
    color: #888;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}

.chapter-date {
    font-size: 11px;
    color: #666;
    white-space: nowrap;
}

.chapter-gap {
    padding: 8px 12px;
    text-align: center;
    font-size: 16px;
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.08);
    border-radius: 6px;
    margin-bottom: 4px;
}

.show-filtered-btn {
    padding: 5px 12px;
    border-radius: 16px;
    font-size: 14px;
    background: #1a1a1a;
    color: #999;
    border: 1px solid transparent;
    white-space: nowrap;
}

.show-filtered-btn.active {
    background: #2a1a2a;
    color: #c084fc;
    border-color: #5a2d5a;
}

/* Inline confirm */
.inline-confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 0 0;
}

.inline-confirm-name {
    flex: 1;
    font-size: 14px;
    color: #ccc;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.inline-confirm-btn {
    padding: 5px 14px;
    border-radius: 16px;
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
}

.inline-confirm-btn.cancel {
    background: #333;
    color: #999;
    border: 1px solid #444;
}

.inline-confirm-btn.block-btn {
    background: #3a1a1a;
    color: #f87171;
    border: 1px solid #5a2d2d;
}

.inline-confirm-btn.unblock-btn {
    background: #1a3a1a;
    color: #4ade80;
    border: 1px solid #2d5a2d;
}
</style>
