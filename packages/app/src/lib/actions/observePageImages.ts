
import type { ReaderMemoryManager } from '$lib/services/ReaderMemoryManager.js';

interface PageImageParams {
    memory: ReaderMemoryManager;
    chapterId: string;
    pageIndex: number;
    url: string;
    candidates: string[];
    criticalCandidates?: string[];
}

export function registerPageImage(
    node: HTMLElement,
    getParams: () => PageImageParams,
) {
    const { memory, chapterId, pageIndex, url, candidates, criticalCandidates } = getParams();
    memory.registerPage(node, chapterId, pageIndex, url, candidates, criticalCandidates);

    return {
        destroy() {
            memory.unregisterPage(node);
        },
    };
}
