<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import * as storage from '$lib/services/storage.js';
    import type { ChapterMeta } from '$lib/types.js';
    import FilterChip from './FilterChip.svelte';

    let { chapters }: { chapters: ChapterMeta[] } = $props();

    const mangaId = $derived(appState.manga.activeManga?.id ?? '');

    // Restore saved group selections for this manga
    let selectedGroups = $state<Set<string>>(new Set());
    $effect(() => {
        selectedGroups = new Set(storage.getJson<string[]>(`group:${mangaId}`, []));
    });

    function toggleGroup(id: string) {
        const next = new Set(selectedGroups);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        selectedGroups = next;
        if (next.size === 0) {
            storage.remove(`group:${mangaId}`);
        } else {
            storage.setJson(`group:${mangaId}`, [...next]);
        }
    }

    function selectAll() {
        selectedGroups = new Set();
        storage.remove(`group:${mangaId}`);
    }

    // Collect unique groups sorted by chapter count (most chapters first)
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

    // Filter by group, deduplicate only when a group is selected, sort descending
    const filtered = $derived.by(() => {
        if (selectedGroups.size === 0) {
            return [...chapters].sort((a, b) => b.number - a.number);
        }
        const byGroup = chapters.filter(ch => selectedGroups.has(ch.groupId ?? ''));
        const best = new Map<number, ChapterMeta>();
        for (const ch of byGroup) {
            const existing = best.get(ch.number);
            if (!existing || (ch.uploadedAt ?? 0) > (existing.uploadedAt ?? 0)) {
                best.set(ch.number, ch);
            }
        }
        return [...best.values()].sort((a, b) => b.number - a.number);
    });

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
        appState.reader.openReader(manga, chapter, filtered);
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
</script>

{#if groups.length > 1}
    <div class="chapter-filter">
        <FilterChip
            label={`All (${chapters.length})`}
            active={selectedGroups.size === 0}
            onclick={selectAll}
        />
        {#each groups as group (group.id)}
            <FilterChip
                label={`${group.name} (${group.count})`}
                active={selectedGroups.has(group.id)}
                onclick={() => toggleGroup(group.id)}
            />
        {/each}
    </div>
{/if}

<div class="chapter-list">
    {#each listItems as item (item.type === 'chapter' ? item.chapter.id : `gap-${item.from}-${item.to}`)}
        {#if item.type === 'gap'}
            <div class="chapter-gap">
                {item.missing} chapter{item.missing > 1 ? 's' : ''} missing (Ch. {item.from}{item.from !== item.to ? ` – ${item.to}` : ''})
            </div>
        {:else}
            {@const chapter = item.chapter}
            <button class="chapter-item" class:chapter-current={chapter.id === currentChapterId} use:scrollIfCurrent={chapter.id === currentChapterId} onclick={() => handleClick(chapter)}>
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
</style>
