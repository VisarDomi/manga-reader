// App-only download policy; provider extraction and chapter order remain shared.
import type { ChapterProgress } from '../../../src/core/compute/progress';
import { ChapterLoadIntent, ChapterLoadResultKind } from '../../../src/provider/types';
import { originalChapter, chapterKey, routes, chapterList, refreshLists } from './provider';
import { native } from './native';
let retainedSeries="";
let active=false, positions: ChapterProgress[]=[], currentSeries: string|null=null;
const generations=new Map<string,number>();
const running=new Map<string,string>();
export function preparationContext(home: boolean, series: string|null=null) { currentSeries=home?null:series; }
export function pauseDownloads() { active=false;running.clear();for(const [key,value] of generations)generations.set(key,value+1); }
export function resumeDownloads() { if(active)return;active=true;refreshLists();void native('downloads-active',{active:true});for(const p of positions) schedule(p); }
export function updateProgress(progress: ChapterProgress[]) {
    positions=progress;
    const series=progress.map(p=>p.seriesSlug).sort(), signature=JSON.stringify(series);
    if(signature!==retainedSeries) {
        for(const key of running.keys())if(!series.includes(key)) { running.delete(key);generations.set(key,(generations.get(key)??0)+1); }
        retainedSeries=signature;void native('windows-retain',{series});
    }
    if(active)for(const p of progress)schedule(p);
}
export function seriesAvailable(series:string) {
    const position=positions.find(p=>p.seriesSlug===series);
    if(active&&position)schedule(position);
}
function schedule(position: ChapterProgress) {
    if(currentSeries!==null&&currentSeries!==position.seriesSlug)return;
    const slug=routes.get(position.seriesSlug)??position.seriesSlug;
    const signature=JSON.stringify([slug,position.chapterId]);
    if(running.get(position.seriesSlug)===signature)return;
    running.set(position.seriesSlug,signature);
    const generation=(generations.get(position.seriesSlug)??0)+1;generations.set(position.seriesSlug,generation);
    void prepare(position,slug,generation).catch(error=>{
        if(generations.get(position.seriesSlug)===generation)running.delete(position.seriesSlug);
        console.error(error);
    });
}
async function prepare(position: ChapterProgress,slug: string,generation: number) {
    const valid=()=>active&&generations.get(position.seriesSlug)===generation;
    // Current metadata does not wait for the chapter list (or any other series).
    const current=originalChapter({slug,chapterId:position.chapterId,intent:ChapterLoadIntent.Open});
    const list=chapterList(slug,false);
    await native('window-current',{series:position.seriesSlug,key:chapterKey(slug,position.chapterId)});
    const prepareChapter=async(chapterId: string,task=originalChapter({slug,chapterId,intent:ChapterLoadIntent.Append}))=>{
        const result=await task;if(!valid()||result.kind!==ChapterLoadResultKind.Chapter)return;
        await native('prepare',{series:position.seriesSlug,key:chapterKey(slug,chapterId),urls:result.data.images.map((image: any)=>image.url)});
    };
    const currentTask=prepareChapter(position.chapterId,current);
    // Each neighbor begins independently; downloading current never gates them.
    const neighborsTask=(async()=>{
        const chapters=await list;if(!valid())return;
        const i=chapters.findIndex(ch=>ch.chapterId===position.chapterId);
        const neighbors=i<0?[]:[chapters[i-1],chapters[i+1]].filter(Boolean).map(ch=>ch.chapterId);
        await native('window',{series:position.seriesSlug,keys:[position.chapterId,...neighbors].map(ch=>chapterKey(slug,ch))});
        await Promise.allSettled(neighbors.map(ch=>prepareChapter(ch)));
    })();
    const results=await Promise.allSettled([currentTask,neighborsTask]);
    for(const result of results)if(result.status==='rejected')throw result.reason;
}
