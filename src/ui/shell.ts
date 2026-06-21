import {render as renderSavedSearch} from "./saved-searches";
import {preloadFavs} from "../storage/db";
import {initProvider, providerName, searchUrl} from "../provider";
import cssContent from '../css/style.css?inline';
import { setupDebug } from '../debug';
import {loadSearches} from "../storage/localstorage";

export function cleanDocument() {
    document.open();
    document.close();
    const style = document.createElement('style');
    style.textContent = cssContent;
    document.head.appendChild(style);
}

function buildSearch(): void {
    const header = document.createElement('div');
    header.id = 'hs-wrap';

    // search.js toggles .active on #query-input's parent — this div
    const searchWrap = document.createElement('div');
    searchWrap.className = 'hs-search-input';

    const input = document.createElement('textarea');
    input.rows = 1;
    input.id = 'query-input';
    input.placeholder = 'Search...';
    input.autocomplete = 'off';
    searchWrap.appendChild(input);

    const button = document.createElement('button');
    button.id = 'search-button';
    button.type = 'button';
    button.textContent = 'Search';

    header.appendChild(searchWrap);
    header.appendChild(button);

    const submit = () => {
        const val = input.value.trim();
        const query = val || 'language:japanese';
        const saved = loadSearches(providerName()).find(s => s.query === query);
        window.location.href = searchUrl(query, saved?.page);
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    button.addEventListener('click', submit);

    document.body.appendChild(header);

    const savedSearches = document.createElement('div');
    savedSearches.className = 'hs-saved-searches';
    header.insertAdjacentElement('afterend', savedSearches);
}

function buildGridPlaceholder(): void {
    const grid = document.createElement('div');
    grid.id = 'hs-grid';
    document.body.appendChild(grid);
}

export function startAdBlocker(): void {
    new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                const tag = node.tagName;
                const cls = (node as Element).className;
                if (tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'INS') {
                    node.remove();
                } else if (tag === 'DIV' && cls.length > 0 && !cls.startsWith('hs-')) {
                    node.remove();
                }
            }
        }
    }).observe(document.body, { childList: true });
}

export async function initShell(): Promise<void> {
    cleanDocument();
    buildSearch();
    renderSavedSearch();
    buildGridPlaceholder();
    void preloadFavs();
    await initProvider();
    startAdBlocker();
    const debug = false;
    if (debug) setupDebug();
}
