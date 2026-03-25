
interface ChapterBoundaryParams {
    getRoot: () => HTMLElement | null;
    onChapterChange: (chapterId: string) => void;
}

let sharedObserver: IntersectionObserver | null = null;
let sharedCallback: ((chapterId: string) => void) | null = null;
let sharedRoot: HTMLElement | null = null;
let observedNodes: Set<HTMLElement> = new Set();

function ensureObserver(params: ChapterBoundaryParams): void {
    const root = params.getRoot();
    if (sharedObserver && root === sharedRoot) return;

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
                    const chId = (entry.target as HTMLElement).dataset.chapterId;
                    if (chId) sharedCallback?.(chId);
                }
            }
        },
        { threshold: 0.5, root },
    );

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
