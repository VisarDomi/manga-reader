import { selected } from '@selected-provider';
import { ChapterLoadIntent, ChapterLoadResultKind, type Provider, type ChapterLoadRequest, type ChapterData } from '../../../src/provider/types';
import { chapterLoader, homeDestinationResolver } from '../../../src/provider/actions';
import { metadata, prioritizeMetadata } from './metadata-queue';
import { imageURL, localURL, native } from './native';
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
const lists=new Map<string,ReturnType<Provider['fetchChaptersNewestFirst']>>();
export function chapterList(slug:string, urgent=true) {
    const key="list:"+identity(slug);
    if(urgent)prioritizeMetadata(key);
    let task=lists.get(slug);
    if(!task) { task=metadata(()=>selected.fetchChaptersNewestFirst(slug),urgent,key);lists.set(slug,task);void task.catch(()=>lists.delete(slug)); }
    return task;
}
export function refreshLists() { lists.clear(); }
export const provider: Provider = {
    ...selected,
    async fetchHome(cursor) {
        const page=await selected.fetchHome(cursor);
        for(const series of page.series) routes.set(series.historyId??identity(series.slug),series.slug);
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
        fetchChaptersNewestFirst: chapterList,
        readerUrl:(...args)=>localURL(selected.readerUrl(...args)),
        seriesUrl:(...args)=>localURL(selected.seriesUrl(...args)),
    }),
    fetchChaptersNewestFirst:chapterList,
    readerUrl: (...args)=>localURL(selected.readerUrl(...args)),
    seriesUrl: (...args)=>localURL(selected.seriesUrl(...args)),
};
