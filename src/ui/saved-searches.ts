import { loadSearches, removeSearch } from "../storage/localstorage";
import { searchUrl, providerName } from "../provider";

const VISIBLE_DEFAULT = 3;

export function render(): void {
    const container = document.querySelector('.hs-saved-searches') as HTMLElement;
    const input = document.getElementById('query-input') as HTMLTextAreaElement;

    container.innerHTML = '';
    const searches = loadSearches(providerName());
    if (searches.length === 0) return;

    const expanded = container.dataset.expanded === 'true';
    const visible = expanded ? searches : searches.slice(0, VISIBLE_DEFAULT);

    for (let i = 0; i < visible.length; i++) {
        const s = visible[i];
        const chip = document.createElement('span');
        chip.className = 'hs-saved-chip';
        const text = document.createElement('span');
        text.textContent = s.query;
        chip.appendChild(text);
        const x = document.createElement('span');
        x.className = 'hs-saved-x';
        x.textContent = '\u00D7';
        x.onclick = (e) => {
            e.stopPropagation();
            removeSearch(s.query, providerName(), render);
        };
        chip.appendChild(x);
        chip.onclick = () => {
            input.value = s.query;
            window.location.href = searchUrl(s.query, s.page);
        };
        container.appendChild(chip);
    }

    if (!expanded && searches.length > VISIBLE_DEFAULT) {
        const remaining = searches.length - VISIBLE_DEFAULT;
        const btn = document.createElement('button');
        btn.className = 'hs-saved-show-more';
        btn.textContent = `Show ${remaining} more`;
        btn.onclick = () => {
            container.dataset.expanded = 'true';
            render();
        };
        container.appendChild(btn);
    }
}
