<script lang="ts">
    let {
        label,
        active = false,
        included = false,
        excluded = false,
        onclick,
    }: {
        label: string;
        active?: boolean;
        included?: boolean;
        excluded?: boolean;
        onclick: () => void;
    } = $props();
</script>

<button
    class="filter-chip"
    class:active
    class:include={included}
    class:exclude={excluded}
    {onclick}
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
