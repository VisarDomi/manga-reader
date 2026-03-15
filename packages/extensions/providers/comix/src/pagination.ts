export function computeHasMore(pagination: { current_page: number; last_page: number }): boolean {
  return pagination.current_page < pagination.last_page;
}
