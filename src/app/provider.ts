import { selected } from '@selected-provider';
import { ChapterLoadIntent, ChapterLoadResultKind, type Provider, type ChapterLoadRequest, type ChapterData, type ChapterMeta, type HomePage } from '../provider/types';
import { chapterLoader, homeDestinationResolver } from '../provider/actions';
import { metadata, prioritizeMetadata } from './metadata-queue';
import { imageURL, localURL, native } from './native';
import { withNewerChapters } from '../core/chapter-list';
export { selected };
export const identity = (slug: string) => selected.historyId?.(slug) ?? slug;
export const chapterKey = (slug: string, chapter: string) => JSON.stringify([identity(slug),chapter]);
const urgentChapters = new Set<string>();
const pending = new Map<string,Promise<any>>();
export const routes = new Map<string,string>();
export async function originalChapter(request: ChapterLoadRequest, urgent=false): Promise<any> {
    const key=chapterKey(request.slug,request.chapterId);
    if(urgent) { urgentChapters.add(key);prioritizeMetadata(key); }
    let task=pending.get(key);
    if(!task) {
        task=(async()=>{
            const saved=await native('chapter-read',{key});
            if(saved) return {kind:ChapterLoadResultKind.Chapter,data:saved};
            const result=await metadata(()=>selected.loadChapter(request as any),urgentChapters.has(key),key);
            if(result.kind===ChapterLoadResultKind.Chapter) await native('chapter-write',{key,value:result.data});
            return result;
        })();
        pending.set(key,task);
        void task.finally(()=>{pending.delete(key);urgentChapters.delete(key);}).catch(()=>{});
    }
    const result=await task;
    if(result.kind!==ChapterLoadResultKind.Chapter)return chapterLoader(async()=>null,selected.seriesUrl)(request as any);
    const data=result.data as ChapterData;
    routes.set(data.historyId??identity(data.seriesSlug),request.slug);
    return {...result,data:{...data,seriesSlug:identity(data.seriesSlug)===identity(request.slug)?request.slug:data.seriesSlug}};
}
type ChapterList=ReturnType<Provider['fetchChaptersNewestFirst']>;
const lists=new Map<string,ChapterList>(), listRequests=new Map<string,ChapterList>(), listSignatures=new Map<string,string>();
const listChanges=new Set<(series:string)=>void>();
const listSignature=(chapters:ChapterMeta[])=>JSON.stringify(chapters.map(chapter=>chapter.chapterId));
// Every fetched list is kept beside the prepared chapters, so resuming never
// waits for the network to know the next chapter.
const savedListKey=(slug:string)=>JSON.stringify(['chapters',identity(slug)]);
const savedSignatures=new Map<string,string>();
export async function savedChapterList(slug:string):Promise<ChapterMeta[]|null> {
    const saved=await native('chapter-read',{key:savedListKey(slug)});
    return Array.isArray(saved)?saved:null;
}
function keepList(slug:string, chapters:ChapterMeta[]) {
    const signature=listSignature(chapters);
    if(savedSignatures.get(identity(slug))===signature)return;
    savedSignatures.set(identity(slug),signature);
    void native('chapter-write',{key:savedListKey(slug),value:chapters}).catch(console.error);
}
// Home rows show each series' newest chapters and are current; a list can be
// behind (a slow source, or a chapter released since it was kept).
const latestRows=new Map<string,ChapterMeta[]>();
function withLatestRow(slug:string, chapters:ChapterMeta[]) {
    const row=latestRows.get(identity(slug));
    return row?withNewerChapters(chapters,row):chapters;
}
function listChanged(slug:string) { for(const listener of listChanges)listener(identity(slug)); }
function fetchChapterList(slug:string, urgent:boolean):ChapterList {
    const task=metadata(()=>selected.fetchChaptersNewestFirst(slug),urgent,"list:"+identity(slug));
    listRequests.set(slug,task);
    void task.then(chapters=>{
        lists.set(slug,task);
        const signature=listSignature(chapters), previous=listSignatures.get(slug);
        listSignatures.set(slug,signature);
        if(previous===signature)return;
        keepList(slug,chapters);
        if(previous!==undefined)listChanged(slug);
    },()=>{}).finally(()=>{if(listRequests.get(slug)===task)listRequests.delete(slug);});
    return task;
}
// Background preparation starts from the latest known list (the saved one first,
// extended by its Home row) and is told when that changes. A reader always asks
// the source again (sharing a pending request): its list may predate a new chapter.
export function chapterList(slug:string, urgent=true):ChapterList {
    if(urgent)prioritizeMetadata("list:"+identity(slug));
    const pending=listRequests.get(slug);
    if(urgent)return pending??fetchChapterList(slug,true);
    let known=lists.get(slug);
    if(!known) {
        const network=pending??fetchChapterList(slug,false);
        const task=savedChapterList(slug).catch(()=>null).then(saved=>{
            if(saved===null)return network;
            if(!listSignatures.has(slug))listSignatures.set(slug,listSignature(saved));
            if(!savedSignatures.has(identity(slug)))savedSignatures.set(identity(slug),listSignature(saved));
            return saved;
        });
        lists.set(slug,task);
        void task.catch(()=>{if(lists.get(slug)===task)lists.delete(slug);});
        known=task;
    }
    return known.then(chapters=>{
        const latest=withLatestRow(slug,chapters);
        if(latest!==chapters)keepList(slug,latest);
        return latest;
    });
}
export function onChapterListChange(listener:(series:string)=>void) { listChanges.add(listener); }
export function refreshLists() { lists.clear(); }
function recordLatestRows(page:HomePage) {
    const updated=new Set<string>();
    for(const series of page.series) {
        const id=series.historyId??identity(series.slug);
        latestRows.set(id,series.chapters.map(({chapterId})=>({chapterId})));
        updated.add(id);
    }
    // A row that now shows a newer chapter moves that series' download window.
    for(const [slug,known] of lists) if(updated.has(identity(slug))) {
        void known.then(chapters=>{if(withLatestRow(slug,chapters)!==chapters)listChanged(slug);},()=>{});
    }
}
export const provider: Provider = {
    ...selected,
    async fetchHome(cursor) {
        const page=await selected.fetchHome(cursor);
        for(const series of page.series) routes.set(series.historyId??identity(series.slug),series.slug);
        recordLatestRows(page);
        void native('write',{key:'routes',value:Object.fromEntries(routes)}).catch(console.error);
        void native('prepare-covers',{urls:page.series.map(series=>series.coverUrl)}).catch(console.error);
        return {...page,series:page.series.map(series=>({...series,coverUrl:imageURL(series.coverUrl,true)}))};
    },
    loadChapter: (async(request: ChapterLoadRequest)=>{
        const key=chapterKey(request.slug,request.chapterId);
        await native('window-current',{series:identity(request.slug),key});
        const result=await originalChapter(request,true);
        if(result.kind!==ChapterLoadResultKind.Chapter) return {...result,...('url' in result?{url:localURL(result.url)}:{})};
        await native('prepare',{key,urls:result.data.images.map((image: any)=>image.url)});
        return {...result,data:{...result.data,images:result.data.images.map((image: any)=>({...image,url:imageURL(image.url)}))}};
    }) as Provider['loadChapter'],
    resolveHomeDestination: homeDestinationResolver({
        async fetchChapter(slug,chapterId) { const result=await originalChapter({slug,chapterId,intent:ChapterLoadIntent.Open},true); return result.kind===ChapterLoadResultKind.Chapter?result.data:null; },
        // The first chapter rarely changes: a saved list answers at once.
        fetchChaptersNewestFirst: async slug=>(await savedChapterList(slug).catch(()=>null))??chapterList(slug),
        readerUrl:(...args)=>localURL(selected.readerUrl(...args)),
        seriesUrl:(...args)=>localURL(selected.seriesUrl(...args)),
    }),
    fetchChaptersNewestFirst:chapterList,
    savedChaptersNewestFirst:savedChapterList,
    readerUrl: (...args)=>localURL(selected.readerUrl(...args)),
    seriesUrl: (...args)=>localURL(selected.seriesUrl(...args)),
};
