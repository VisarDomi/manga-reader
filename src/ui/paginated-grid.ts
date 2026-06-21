import { createSkeletonRow, populateRow } from "./gallery-row";
import { fetchMeta } from "../provider";

interface PageInfo {
    totalCount: string;
    currentPage: number;
    totalPages: number;
}

export function renderPaginatedGrid(
    galleryIds: number[],
    currentPage: number,
    totalResults: number,
    pageSize: number,
    countLabel: string,
    onPageChange: (page: number) => void,
): PageInfo {
    const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
    const pageInfo: PageInfo = {
        totalCount: `~${totalResults}${countLabel}`,
        currentPage,
        totalPages,
    };

    document.querySelectorAll('.hs-page-bar').forEach(el => el.remove());
    const grid = document.getElementById('hs-grid') as HTMLDivElement;
    const el = document.createElement('div');
    el.className = 'hs-page-bar';
    el.textContent = pageInfo.totalCount;
    if (grid.parentNode) grid.parentNode.insertBefore(el, grid);
    grid.innerHTML = '';
    for (const gid of galleryIds) {
        const skeleton = createSkeletonRow();
        grid.appendChild(skeleton);
        void fetchMeta(gid).then(meta => populateRow(skeleton, gid, meta.files));
    }
    renderPaginationBar(pageInfo, onPageChange, grid);
    grid.scrollIntoView();

    return pageInfo;
}

function renderPaginationBar(
    info: PageInfo,
    onPage: (page: number) => void,
    grid: HTMLElement,
): void {
    const pag = document.createElement('div');
    pag.className = 'hs-page-bar hs-page-bar-pag';

    // Favs link at position 0
    const favs = document.createElement('a');
    favs.href = '/';
    favs.textContent = 'Favs';
    favs.className = 'hs-page-favs';
    pag.appendChild(favs);

    for (let pageNum = 1; pageNum <= info.totalPages; pageNum++) {
        if (pageNum === info.currentPage) {
            const cur = document.createElement('span');
            cur.textContent = String(pageNum);
            cur.className = 'hs-page-active';
            pag.appendChild(cur);
        } else {
            const pageLink = document.createElement('span');
            pageLink.textContent = String(pageNum);
            pageLink.className = 'hs-page-link';
            pageLink.onclick = () => { onPage(pageNum); };
            pag.appendChild(pageLink);
        }
    }

    if (grid.parentNode) grid.parentNode.insertBefore(pag, grid.nextSibling);
}
