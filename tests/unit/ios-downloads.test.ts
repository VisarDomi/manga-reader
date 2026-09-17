import { beforeEach, expect, it, vi } from 'vitest';
import { createChapterProgress } from '../../src/core/compute/progress';
import { ChapterLoadResultKind } from '../../src/provider/types';
const mock=vi.hoisted(()=>({native:vi.fn(async()=>({})),chapter:vi.fn(),list:vi.fn(),routes:new Map<string,string>()}));
vi.mock('../../apps/ios/web/native',()=>({native:mock.native}));
vi.mock('../../apps/ios/web/provider',()=>({originalChapter:mock.chapter,chapterList:mock.list,routes:mock.routes,refreshLists:vi.fn(),chapterKey:(slug:string,id:string)=>JSON.stringify([slug,id])}));
const progress=(series='one',chapter='2',page=0)=>createChapterProgress('test',series,chapter,page,11);
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
beforeEach(()=>{vi.resetModules();mock.native.mockClear();mock.chapter.mockReset();mock.list.mockReset();mock.routes.clear();mock.chapter.mockImplementation(async({chapterId})=>({kind:ChapterLoadResultKind.Chapter,data:{images:[{url:'https://images/'+chapterId}]}}));});
it('prepares every Home current independently of its chapter list and other series',async()=>{
 const list=deferred<any[]>();mock.list.mockReturnValue(list.promise);
 const app=await import('../../apps/ios/web/downloads');app.preparationContext(true);app.updateProgress([progress(),progress('two')]);app.resumeDownloads();await tick();
 expect(mock.native.mock.calls.filter(([c])=>c==='prepare')).toHaveLength(2);
 list.resolve([{chapterId:'3'},{chapterId:'2'},{chapterId:'1'}]);await tick();
 expect(mock.native.mock.calls.filter(([c])=>c==='prepare')).toHaveLength(6);
 const metadataCalls=mock.chapter.mock.calls.length;
 app.updateProgress([progress('one','2',1),progress('two','2',2)]);await tick();
 expect(mock.chapter).toHaveBeenCalledTimes(metadataCalls);
});
it('does not publish an obsolete window after the current chapter changes',async()=>{
 const old=deferred<any[]>();mock.list.mockReturnValueOnce(old.promise).mockResolvedValue([{chapterId:'4'},{chapterId:'3'},{chapterId:'2'},{chapterId:'1'}]);
 const app=await import('../../apps/ios/web/downloads');app.preparationContext(false,'one');app.updateProgress([progress(),progress('two')]);app.resumeDownloads();await tick();
 app.updateProgress([progress('one','3'),progress('two')]);await tick();old.resolve([{chapterId:'3'},{chapterId:'2'},{chapterId:'1'}]);await tick();
 const windows=mock.native.mock.calls.filter(([c])=>c==='window').map(([,a])=>a);
 expect(windows).toEqual([{series:'one',keys:['3','4','2'].map(id=>JSON.stringify(['one',id]))}]);
 expect(mock.chapter.mock.calls.every(([request])=>request.slug==='one')).toBe(true);
});
it('promotes already queued chapter metadata when a reader opens it',async()=>{
 const {metadata,prioritizeMetadata}=await import('../../apps/ios/web/metadata-queue');
 const finished=Array.from({length:6},()=>deferred<void>()),started:number[]=[];
 const jobs=finished.map((gate,index)=>metadata(()=>{started.push(index);return gate.promise;},false,String(index)));
 expect(started).toEqual([0,1]);
 prioritizeMetadata('5');expect(started).toEqual([0,1,5]);
 for(const gate of finished)gate.resolve();await Promise.all(jobs);
});
it('PC Load cannot let pending work recreate a removed series window',async()=>{
 const list=deferred<any[]>();mock.list.mockReturnValue(list.promise);
 const app=await import('../../apps/ios/web/downloads');app.preparationContext(true);app.updateProgress([progress()]);app.resumeDownloads();await tick();
 app.updateProgress([]);list.resolve([{chapterId:'3'},{chapterId:'2'},{chapterId:'1'}]);await tick();
 expect(mock.native.mock.calls.filter(([command])=>command==='window')).toHaveLength(0);
 expect(mock.native.mock.calls.filter(([command])=>command==='windows-retain').at(-1)).toEqual(['windows-retain',{series:[]}]);
});
