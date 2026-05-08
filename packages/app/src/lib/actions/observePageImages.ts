
import type { ReaderMemoryManager } from '$lib/services/ReaderMemoryManager.js';

interface PageImageParams {
    memory: ReaderMemoryManager;
    chapterId: string;
    pageIndex: number;
    url: string;
}

export function registerPageImage(
    node: HTMLElement,
    getParams: () => PageImageParams,
) {
    const { memory, chapterId, pageIndex, url } = getParams();
    memory.registerPage(node, chapterId, pageIndex, url);

    return {
        destroy() {
            memory.unregisterPage(node);
        },
    };
}
