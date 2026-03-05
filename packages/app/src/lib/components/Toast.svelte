<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
</script>

{#if appState.toast.items.length > 0}
    <div class="toast-container">
        {#each appState.toast.items as toast (toast.id)}
            {#if toast.onClick}
                <button
                    class="toast toast-clickable"
                    onclick={() => { toast.onClick?.(); appState.toast.dismiss(toast.id); }}
                >{toast.message} ▸</button>
            {:else}
                <div class="toast">{toast.message}</div>
            {/if}
        {/each}
    </div>
{/if}

<style>
.toast-container {
    position: fixed;
    top: max(15px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    z-index: 3000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
}

.toast {
    background: #333;
    color: #fff;
    padding: 8px 20px;
    border-radius: 20px;
    font-size: 14px;
    animation: toast-in 0.3s ease-out;
    pointer-events: auto;
}

.toast-clickable {
    cursor: pointer;
    border: 1px solid #4af626;
    font: inherit;
}

.toast-clickable:active {
    background: #444;
}

@keyframes toast-in {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
}
</style>
