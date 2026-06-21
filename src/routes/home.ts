import { preloadFavs } from '../storage/db';
import { initShell } from '../ui/shell';
import { renderPaginatedGrid } from "../ui/paginated-grid";
import { getPage, savePage } from "../storage/localstorage";

const COUNT_KEY = ' Favorites';
const HOME_PAGE_SIZE = 25;

function renderPage(ids: number[], page: number): void {
    const start = (page - 1) * HOME_PAGE_SIZE;
    const galleryIds = ids.slice(start, start + HOME_PAGE_SIZE);
    renderPaginatedGrid(
        galleryIds,
        page,
        ids.length,
        HOME_PAGE_SIZE,
        COUNT_KEY,
        (newPage) => renderPage(ids, newPage),
    );

    savePage(page);
}

export async function init(): Promise<void> {
    await initShell();
    const ids = await preloadFavs();
    if (ids.length === 0) return;
    renderPage(ids, getPage());
}
