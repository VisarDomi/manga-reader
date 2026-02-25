export interface SentinelParams {
    getRoot: () => HTMLElement | null;
    rootMargin: string;
    onIntersect: () => void;
    disabled?: boolean;
    generation?: number;
}

export function sentinel(node: HTMLElement, params: SentinelParams) {
    let observer: IntersectionObserver | null = null;
    let currentGeneration = params.generation ?? 0;
    let firedSinceCreate = false;

    function create() {
        observer?.disconnect();
        firedSinceCreate = false;
        const root = params.getRoot();
        if (!root) return;
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        firedSinceCreate = true;
                        params.onIntersect();
                    }
                }
            },
            { rootMargin: params.rootMargin, root },
        );
        observer.observe(node);
    }

    /** After creation, verify the IO actually fires if the sentinel is in the zone. */
    function scheduleHealthCheck() {
        requestAnimationFrame(() => {
            if (!observer || params.disabled || firedSinceCreate) return;
            const root = params.getRoot();
            if (!root || !node.isConnected) return;

            const rootRect = root.getBoundingClientRect();
            const nodeRect = node.getBoundingClientRect();
            const parts = params.rootMargin.trim().split(/\s+/);
            const bottomMarginStr = parts.length >= 3 ? parts[2] : parts[0];
            let extensionPx = 0;
            if (bottomMarginStr.endsWith('%')) {
                extensionPx = (parseFloat(bottomMarginStr) / 100) * rootRect.height;
            } else {
                extensionPx = parseFloat(bottomMarginStr) || 0;
            }

            if (nodeRect.top <= rootRect.bottom + extensionPx) {
                firedSinceCreate = true;
                params.onIntersect();
            }
        });
    }

    if (!params.disabled) {
        create();
        scheduleHealthCheck();
    }

    return {
        update(next: SentinelParams) {
            const prevGeneration = currentGeneration;
            params = next;
            currentGeneration = next.generation ?? 0;
            const generationChanged = currentGeneration !== prevGeneration;

            if (next.disabled) {
                if (observer) {
                    observer.disconnect();
                    observer = null;
                }
            } else if (!observer || generationChanged) {
                create();
                scheduleHealthCheck();
            }
        },
        destroy() {
            observer?.disconnect();
        },
    };
}
