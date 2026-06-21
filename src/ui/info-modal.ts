import {fetchMeta, tagSearchUrl} from '../provider';

function link(ns: string, val: string, display: string, lang: string, className = 'hs-modal-value-link'): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = display;
    el.onclick = () => {
        if (ns === 'language') {
            window.location.href = tagSearchUrl(ns, val, '');
        } else {
            window.location.href = tagSearchUrl(ns, val, lang);
        }
    };
    return el;
}

function row(label: string): { div: HTMLDivElement; val: HTMLSpanElement } {
    const div = document.createElement('div');
    div.className = 'hs-modal-row';
    const lbl = document.createElement('span');
    lbl.className = 'hs-modal-label';
    lbl.textContent = label;
    div.appendChild(lbl);
    const val = document.createElement('span');
    val.className = 'hs-modal-value';
    div.appendChild(val);
    return { div, val };
}

function linkRow(label: string, ns: string, items: string[], lang: string): HTMLDivElement {
    const { div, val } = row(label);
    for (let i = 0; i < items.length; i++) {
        if (i > 0) val.append(', ');
        val.appendChild(link(ns, items[i], items[i], lang));
    }
    return div;
}

function textRow(label: string, text: string): HTMLDivElement {
    const { div, val } = row(label);
    val.textContent = text;
    return div;
}

export async function show(gid: number): Promise<void> {
    const overlay = document.createElement('div');
    overlay.className = 'hs-modal-backdrop';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'hs-modal-content';
    content.innerHTML = '<div class="hs-modal-body hs-modal-body-loading">Loading...</div>';
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    let meta;
    try {
        meta = await fetchMeta(gid);
    } catch {
        content.innerHTML = '<div class="hs-modal-body hs-modal-body-error">Failed to load gallery info</div>';
        return;
    }

    const lang = meta.language;

    const header = document.createElement('div');
    header.className = 'hs-modal-header';
    if (meta.title_jpn) {
        const h = document.createElement('h2');
        h.textContent = meta.title_jpn;
        header.appendChild(h);
    }
    const h2 = document.createElement('h2');
    h2.textContent = meta.title;
    header.appendChild(h2);

    const body = document.createElement('div');
    body.className = 'hs-modal-body';

    if (meta.artists.length) body.appendChild(linkRow('Artist', 'artist', meta.artists, lang));
    if (meta.groups.length) body.appendChild(linkRow('Group', 'group', meta.groups, lang));
    if (meta.parody.length) body.appendChild(linkRow('Series', 'series', meta.parody, lang));
    if (meta.type) body.appendChild(linkRow('Type', 'type', [meta.type], lang));
    if (meta.characters.length) body.appendChild(linkRow('Characters', 'character', meta.characters, lang));
    if (meta.language) body.appendChild(linkRow('Language', 'language', [meta.language], lang));
    body.appendChild(textRow('Pages', String(meta.files.length)));
    if (meta.date) body.appendChild(textRow('Date', meta.date));

    if (meta.tags.length) {
        const tagsRow = document.createElement('div');
        tagsRow.className = 'hs-modal-row hs-modal-row-tags';
        const tagsLabel = document.createElement('div');
        tagsLabel.className = 'hs-modal-label hs-modal-label-tags';
        tagsLabel.textContent = 'Tags';
        tagsRow.appendChild(tagsLabel);
        const cloud = document.createElement('div');
        cloud.className = 'hs-tag-cloud';
        for (const t of meta.tags) {
            const display = (t.female ? 'female:' : t.male ? 'male:' : '') + t.tag;
            cloud.appendChild(link(t.female ? 'female' : t.male ? 'male' : 'tag', t.tag, display, lang, 'hs-tag-chip'));
        }
        tagsRow.appendChild(cloud);
        body.appendChild(tagsRow);
    }

    const footer = document.createElement('div');
    footer.className = 'hs-modal-footer';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'hs-modal-ok-btn';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = () => overlay.remove();
    footer.appendChild(closeBtn);

    content.innerHTML = '';
    content.appendChild(header);
    content.appendChild(body);
    content.appendChild(footer);
}
