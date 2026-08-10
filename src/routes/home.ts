import css from '../style.css?inline';
import {
    asura,
    fetchAsuraHome,
    fetchAsuraReadHistory,
    type AsuraHomeChapter,
    type AsuraHomeData,
    type AsuraHomeSeries,
} from '../provider/asura';

function createLink(className: string, href: string, text?: string): HTMLAnchorElement {
    const link = document.createElement('a');
    link.className = className;
    link.href = href;
    if (text !== undefined) link.textContent = text;
    return link;
}

function lockIcon(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('hs-home-lock');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-label', 'Early access');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z');
    svg.appendChild(path);
    return svg;
}

function unlockCountdown(unlockAt: string): string {
    const remaining = new Date(unlockAt).getTime() - Date.now();
    if (remaining <= 0) return '0m';
    const hours = Math.floor(remaining / 3_600_000);
    const minutes = Math.floor((remaining % 3_600_000) / 60_000);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderChapter(series: AsuraHomeSeries, chapter: AsuraHomeChapter): HTMLAnchorElement {
    const classes = ['hs-home-chapter'];
    if (chapter.locked) classes.push('hs-home-chapter-locked');
    if (chapter.read) classes.push('hs-home-chapter-read');
    const link = createLink(classes.join(' '), asura.readerUrl(series.slug, chapter.chapterId));
    link.dataset.chapterNumber = String(chapter.chapterNumber);

    const label = document.createElement('span');
    label.className = 'hs-home-chapter-label';
    const labelText = document.createElement('span');
    labelText.textContent = chapter.label;
    label.appendChild(labelText);
    if (chapter.locked) label.appendChild(lockIcon());

    const uploadedAt = document.createElement('time');
    if (chapter.locked) {
        uploadedAt.className = 'hs-home-unlock';
        if (chapter.unlockAt !== null) {
            uploadedAt.dataset.unlockAt = chapter.unlockAt;
            uploadedAt.textContent = unlockCountdown(chapter.unlockAt);
        } else {
            uploadedAt.textContent = 'Locked';
        }
    } else {
        uploadedAt.textContent = chapter.uploadedAt;
    }
    link.append(label, uploadedAt);
    return link;
}

function renderSeries(series: AsuraHomeSeries): HTMLElement {
    const card = document.createElement('article');
    card.className = 'hs-home-card';
    card.dataset.historySlug = series.historySlug;

    const coverLink = createLink('hs-home-cover', asura.seriesUrl(series.slug));
    const cover = document.createElement('img');
    cover.src = series.coverUrl;
    cover.alt = series.title;
    cover.loading = 'lazy';
    coverLink.appendChild(cover);

    const details = document.createElement('div');
    details.className = 'hs-home-details';
    const title = createLink('hs-home-series-title', asura.seriesUrl(series.slug), series.title);
    const chapters = document.createElement('div');
    chapters.className = 'hs-home-chapters';
    chapters.append(...series.chapters.map(chapter => renderChapter(series, chapter)));
    details.append(title, chapters);

    card.append(coverLink, details);
    return card;
}

function updateUnlockCountdowns(root: ParentNode): void {
    for (const time of root.querySelectorAll<HTMLElement>('.hs-home-unlock[data-unlock-at]')) {
        const unlockAt = time.dataset.unlockAt;
        if (unlockAt === undefined) throw new Error('Rendered Asura unlock time is missing');
        time.textContent = unlockCountdown(unlockAt);
    }
}

function applyReadHistory(root: ParentNode, history: ReadonlyMap<string, number>): void {
    for (const card of root.querySelectorAll<HTMLElement>('.hs-home-card')) {
        const historySlug = card.dataset.historySlug;
        if (historySlug === undefined) throw new Error('Rendered Asura series is missing its history slug');
        const highestRead = history.get(historySlug);
        for (const chapter of card.querySelectorAll<HTMLElement>('.hs-home-chapter')) {
            const rawNumber = chapter.dataset.chapterNumber;
            if (rawNumber === undefined) throw new Error(`Rendered Asura chapter in ${historySlug} is missing its number`);
            const chapterNumber = Number(rawNumber);
            if (!Number.isFinite(chapterNumber)) {
                throw new Error(`Rendered Asura chapter in ${historySlug} has an invalid number`);
            }
            chapter.classList.toggle('hs-home-chapter-read', highestRead !== undefined && chapterNumber <= highestRead);
        }
    }
}

function renderHistoryError(section: HTMLElement, error: unknown): void {
    const message = document.createElement('p');
    message.className = 'hs-home-history-error';
    message.textContent = `Reading history unavailable: ${error instanceof Error ? error.message : String(error)}`;
    section.querySelector('.hs-home-heading')?.after(message);
}

async function reconcileReadHistory(section: HTMLElement): Promise<void> {
    try {
        applyReadHistory(section, await fetchAsuraReadHistory());
    } catch (error) {
        renderHistoryError(section, error);
    }
}

function renderHome(data: AsuraHomeData): void {
    document.title = `${data.title} — Manga Reader`;
    const main = document.createElement('main');
    main.className = 'hs-home';
    const section = document.createElement('section');
    section.className = 'hs-home-section';
    const heading = document.createElement('h1');
    heading.className = 'hs-home-heading';
    heading.textContent = data.title;
    const list = document.createElement('div');
    list.className = 'hs-home-list';
    list.append(...data.series.map(renderSeries));
    section.append(heading, list);
    main.appendChild(section);
    document.body.appendChild(main);

    window.setInterval(() => updateUnlockCountdowns(section), 60_000);
    void reconcileReadHistory(section);
}

function renderError(error: unknown): void {
    const message = document.createElement('div');
    message.className = 'hs-home-error';
    message.textContent = error instanceof Error ? error.message : String(error);
    document.body.replaceChildren(message);
}

export async function open(): Promise<void> {
    window.stop();
    document.open();
    document.close();

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const loading = document.createElement('div');
    loading.className = 'hs-home-loading';
    loading.textContent = 'Loading latest updates…';
    document.body.appendChild(loading);

    try {
        const data = await fetchAsuraHome();
        document.body.replaceChildren();
        renderHome(data);
    } catch (error) {
        renderError(error);
    }
}
