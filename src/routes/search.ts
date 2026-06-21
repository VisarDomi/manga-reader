import { search, searchUrl, goToPage, providerName } from '../provider';
import { initShell } from '../ui/shell';
import { renderPaginatedGrid } from "../ui/paginated-grid";
import { saveSearch } from "../storage/localstorage";
import { render as renderSavedSearch} from "../ui/saved-searches";

const COUNT_KEY = ' Results';

function syncInputFromUrl(query: string): void {
    const input = document.getElementById('query-input') as HTMLInputElement;
    input.value = query;
}

function render(result: { ids: number[]; totalResults: number; pageSize: number }, page: number, query: string): void {
    const pageInfo = renderPaginatedGrid(
        result.ids,
        page,
        result.totalResults,
        result.pageSize,
        COUNT_KEY,
        (newPage) => { goToPage(query, newPage); void init(query, newPage); },
    );

    history.replaceState(null, '', searchUrl(query, pageInfo.currentPage));
    saveSearch(query, pageInfo.currentPage, providerName(), renderSavedSearch);
}

export async function init(query: string, page: number): Promise<void> {
    await initShell();
    syncInputFromUrl(query);
    window.addEventListener('pagereveal', () => syncInputFromUrl(query));
    const result = await search(query, page);
    render(result, page, query);
}
