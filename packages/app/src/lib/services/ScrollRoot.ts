export type ScrollRootMode = 'element' | 'document';

export type ScrollRoot = {
    mode: ScrollRootMode;
    scrollTop(): number;
    setScrollTop(value: number): void;
    scrollHeight(): number;
    clientHeight(): number;
    addScrollListener(listener: (event: Event) => void): () => void;
};

export function documentScrollRoot(): ScrollRoot {
    return {
        mode: 'document',
        scrollTop: () => window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0,
        setScrollTop: (value: number) => window.scrollTo(0, Math.max(0, value)),
        scrollHeight: () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
        clientHeight: () => window.innerHeight,
        addScrollListener: (listener: (event: Event) => void) => {
            window.addEventListener('scroll', listener, { passive: true });
            return () => window.removeEventListener('scroll', listener);
        },
    };
}

export function elementScrollRoot(element: HTMLElement): ScrollRoot {
    return {
        mode: 'element',
        scrollTop: () => element.scrollTop,
        setScrollTop: (value: number) => {
            element.scrollTop = Math.max(0, value);
        },
        scrollHeight: () => element.scrollHeight,
        clientHeight: () => element.clientHeight,
        addScrollListener: (listener: (event: Event) => void) => {
            element.addEventListener('scroll', listener, { passive: true });
            return () => element.removeEventListener('scroll', listener);
        },
    };
}

export function pageOffsetTop(element: HTMLElement, root: ScrollRoot): number {
    if (root.mode === 'document') {
        return element.getBoundingClientRect().top + root.scrollTop();
    }
    return element.offsetTop;
}
