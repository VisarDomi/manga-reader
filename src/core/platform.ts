import type { ChapterData, HomeSeries, Provider } from '../provider/types';
// Native builds supply the explicitly requested app additions at these seams.
export function seriesRendered(_card: HTMLElement, _series: HomeSeries, _provider: Provider): void {}
export function readerRestored(_image: HTMLImageElement | null, _data: ChapterData): void {}
