
import type { ReaderMemoryManager } from '$lib/services/ReaderMemoryManager.js';

interface PageImageParams {
    memory: ReaderMemoryManager;
    chapterId: string;
    pageIndex: number;
    url: string;
    candidates: string[];
}

export function registerPageImage(
    node: HTMLElement,
    getParams: () => PageImageParams,
) {
    const { memory, chapterId, pageIndex, url, candidates } = getParams();
    memory.registerPage(node, chapterId, pageIndex, url, candidates);

    return {
        destroy() {
            memory.unregisterPage(node);
        },
    };
}
