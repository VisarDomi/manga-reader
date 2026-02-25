// Shared IntersectionObserver pattern: a single observer instance is reused for all
// elements in the reader session. This avoids creating one observer per page/chapter,
// which would degrade performance with 100+ elements. The observer is recreated only
// when the root element changes (new session).

interface ChapterBoundaryParams {
    getRoot: () => HTMLElement | null;
    onChapterChange: (chapterId: number) => void;
}

let sharedObserver: IntersectionObserver | null = null;
let sharedCallback: ((chapterId: number) => void) | null = null;
let sharedRoot: HTMLElement | null = null;
let observedNodes: Set<HTMLElement> = new Set();

function ensureObserver(params: ChapterBoundaryParams): void {
    const root = params.getRoot();
    // If root hasn't changed (including both null), keep current observer
    if (sharedObserver && root === sharedRoot) return;

    // Root changed (null→element or element→different element): recreate
    if (sharedObserver) {
        sharedObserver.disconnect();
    }

    sharedRoot = root;
    sharedCallback = params.onChapterChange;

    if (!root) {
        sharedObserver = null;
        return;
    }

    sharedObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                    const chId = Number((entry.target as HTMLElement).dataset.chapterId);
                    if (chId) sharedCallback?.(chId);
                }
            }
        },
        { threshold: 0.5, root },
    );

    // Re-observe all tracked nodes
    for (const node of observedNodes) {
        sharedObserver.observe(node);
    }
}

export function observeChapterBoundary(
    node: HTMLElement,
    params: ChapterBoundaryParams,
) {
    observedNodes.add(node);
    ensureObserver(params);
    sharedObserver?.observe(node);

    return {
        destroy() {
            observedNodes.delete(node);
            sharedObserver?.unobserve(node);
        },
    };
}

export function disconnectChapterObserver() {
    sharedObserver?.disconnect();
    sharedObserver = null;
    sharedCallback = null;
    sharedRoot = null;
    observedNodes.clear();
}
