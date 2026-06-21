import {DOMAIN} from "./constants";

export function loadScript(filename: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const script = document.createElement('script');
    script.src = `https://ltn.${DOMAIN}/${filename}`;
    script.onload = () => resolve();
    document.head.appendChild(script);
    return promise;
}

export function detachJQueryFromSuggestionLinks(): void {
    const jq = (window as unknown as { jQuery?: { fn: { on: (...args: unknown[]) => unknown } } }).jQuery;
    if (!jq) return;
    const origOn = jq.fn.on;
    jq.fn.on = function (this: unknown, types: string, selector: unknown, handler: unknown) {
        if (typeof selector === 'function') { handler = selector; }
        const isFunction = types === 'click' && typeof handler === 'function';
        const isSuggestion = (this as { is: (s: string) => boolean }).is('.search-suggestion_string');
        if (isFunction && isSuggestion) return this;
        return origOn.apply(this, arguments as unknown as Parameters<typeof origOn>);
    } as typeof origOn;
}

export function setupDropdownHandler(): void {
    const sugg = document.getElementById('search-suggestions') as HTMLElement;
    sugg.addEventListener('click', (e) => {
        const a = (e.target as Element).closest<HTMLAnchorElement>('a.search-suggestion_string');
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();

        const resultSpan = a.querySelector('.search-result');
        const nsSpan = a.querySelector('.search-ns');
        if (!resultSpan) return;

        const name = resultSpan.textContent?.trim() ?? '';
        const nsText = nsSpan?.textContent?.trim() ?? '';
        const ns = nsText.replace(/^\(|\)$/g, '').trim();

        const underscored = name.replace(/\s/g, '_');
        const term = ns ? `${ns}:${underscored}` : underscored;

        const input = document.getElementById('query-input') as HTMLInputElement;
        const val = input.value;
        const lastSpace = val.lastIndexOf(' ');
        const prefix = lastSpace >= 0 ? val.substring(0, lastSpace + 1) : '';
        const lastWord = val.substring(lastSpace + 1);
        const dash = lastWord.startsWith('-') ? '-' : '';
        input.value = prefix + dash + term + ' ';
        input.focus();

        const origClear = (window as unknown as { clear_page?: () => void }).clear_page;
        if (origClear) origClear();
    }, { capture: true });
}