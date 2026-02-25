// Shared IntersectionObserver pattern: a single observer instance is reused for all
// elements in the reader session. This avoids creating one observer per page/chapter,
// which would degrade performance with 100+ elements. The observer is recreated only
// when the root element changes (new session).

import type { ReaderMemoryManager } from '$lib/services/ReaderMemoryManager.js';

interface PageImageParams {
    memory: ReaderMemoryManager;
    getRoot: () => HTMLElement | null;
    chapterId: number;
    pageIndex: number;
    url: string;
}

let sharedObserver: IntersectionObserver | null = null;
let sharedMemory: ReaderMemoryManager | null = null;
let pendingNodes: HTMLElement[] = [];

function ensureObserver(memory: ReaderMemoryManager, getRoot: () => HTMLElement | null): boolean {
    if (sharedObserver && sharedMemory === memory) return true;

    const root = getRoot();
    if (!root) return false;

    sharedObserver?.disconnect();
    sharedMemory = memory;
    sharedObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const data = sharedMemory?.pageDataMap.get(entry.target as HTMLElement);
                    if (data) {
                        const img = entry.target.querySelector('img');
                        if (img && !img.src) {
                            sharedMemory?.loadImage(data.url, data.key, img);
                        }
                    }
                }
            }
        },
        { rootMargin: '500% 0px', root },
    );

    // Observe any nodes that registered before root was ready
    for (const pending of pendingNodes) {
        sharedObserver.observe(pending);
    }
    pendingNodes = [];

    return true;
}

export function observePageImages(
    node: HTMLElement,
    getParams: () => PageImageParams,
) {
    const { memory, getRoot, chapterId, pageIndex, url } = getParams();
    memory.registerPage(node, chapterId, pageIndex, url);

    if (ensureObserver(memory, getRoot)) {
        sharedObserver!.observe(node);
    } else {
        // Root not ready yet — queue for later
        pendingNodes.push(node);
    }

    return {
        destroy() {
            sharedObserver?.unobserve(node);
            const idx = pendingNodes.indexOf(node);
            if (idx >= 0) pendingNodes.splice(idx, 1);
            memory.unregisterPage(node);
        },
    };
}

/** Flush pending nodes — call after root is guaranteed to exist. */
export function flushPageObserver(memory: ReaderMemoryManager, getRoot: () => HTMLElement | null) {
    if (pendingNodes.length > 0) {
        ensureObserver(memory, getRoot);
    }
}

export function disconnectPageObserver() {
    sharedObserver?.disconnect();
    sharedObserver = null;
    sharedMemory = null;
    pendingNodes = [];
}
