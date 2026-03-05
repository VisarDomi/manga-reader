<script lang="ts">
    let {
        label,
        active = false,
        included = false,
        excluded = false,
        onclick,
        onlongpress,
    }: {
        label: string;
        active?: boolean;
        included?: boolean;
        excluded?: boolean;
        onclick: () => void;
        onlongpress?: () => void;
    } = $props();

    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let didLongPress = false;

    function handleTouchStart() {
        if (!onlongpress) return;
        didLongPress = false;
        longPressTimer = setTimeout(() => {
            didLongPress = true;
            onlongpress!();
        }, 500);
    }

    function clearTimer() {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    function handleClick(e: MouseEvent) {
        if (didLongPress) {
            didLongPress = false;
            e.preventDefault();
            return;
        }
        onclick();
    }
</script>

<button
    class="filter-chip"
    class:active
    class:include={included}
    class:exclude={excluded}
    onclick={handleClick}
    ontouchstart={handleTouchStart}
    ontouchend={clearTimer}
    ontouchcancel={clearTimer}
    ontouchmove={clearTimer}
>{label}</button>

<style>
.filter-chip {
    padding: 5px 12px;
    border-radius: 16px;
    font-size: 16px;
    background: #1a1a1a;
    color: #999;
    border: 1px solid transparent;
    white-space: nowrap;
}

.filter-chip:active {
    background: #444;
}

.filter-chip.active {
    background: #333;
    color: #fff;
    border-color: #555;
}

.filter-chip.include {
    background: #1a3a1a;
    color: #4ade80;
    border-color: #2d5a2d;
}

.filter-chip.exclude {
    background: #3a1a1a;
    color: #f87171;
    border-color: #5a2d2d;
}
</style>
