import { seriesAvailable } from './downloads';
import type { ChapterData, HomeSeries, Provider } from '../../../src/provider/types';
import { HomeDestinationKind } from '../../../src/provider/types';
export interface View {path:string;home:boolean;series?:string;chapter?:string;index?:number;fraction:number;y:number}
export let restored: View|null=null, cancelled=false, ready=false;
let anchor: HTMLElement|undefined, fraction=0;
export function setRestore(view: View|null) {restored=view;}
for(const type of ['touchstart','pointerdown','wheel','keydown'])addEventListener(type,()=>{cancelled=true;anchor=undefined;},{passive:true,capture:true});
function align() {
    if(!anchor?.isConnected||cancelled)return;
    const rect=anchor.getBoundingClientRect();const y=scrollY+rect.top+rect.height*fraction;
    if(Math.abs(scrollY-y)>.5)scrollTo(0,Math.max(0,y));
}
const resize=new ResizeObserver(()=>requestAnimationFrame(align));
resize.observe(document.body);
export function seriesRendered(card: HTMLElement,series: HomeSeries,provider: Provider) {
    if (!restored || restored.home) ready=true;
    card.dataset.series=series.historyId??series.slug;
    seriesAvailable(card.dataset.series);
    const first=document.createElement('a');first.className='hs-home-chapter';first.href=provider.seriesUrl(series.slug);first.textContent='First chapter';
    first.onclick=event=>{event.preventDefault();void provider.resolveHomeDestination({kind:HomeDestinationKind.Start,seriesSlug:series.slug}).then(url=>location.assign(url)).catch(()=>{first.title='Failed to open series';});};
    card.querySelector('.hs-home-chapters')!.append(first);
    if(restored?.home&&!cancelled&&restored.series===card.dataset.series) {
        anchor=card;fraction=restored.fraction;requestAnimationFrame(()=>{align();ready=true;});
    }
}
export function readerRestored(image: HTMLImageElement|null,_data: ChapterData) {
    if(restored&&!restored.home&&image&&!cancelled) {anchor=image;fraction=restored.fraction;align();}
    ready=true;
}
export function viewReady() {ready=true;}
