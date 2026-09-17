import { startInit } from '../../../src/core/shell';
import { open as openHome } from '../../../src/routes/home';
import { open as openReader } from '../../../src/routes/reader';
import { Handler } from '../../../src/provider/types';
import { provider, selected, routes, identity } from './provider';
import { native, localURL } from './native';
import { installFetch } from './fetch';
import { computeRequest, onProgressChange } from './transport';
import { preparationContext, pauseDownloads, resumeDownloads, updateProgress } from './downloads';
import { setRestore, restored, ready, viewReady, type View } from './platform';
installFetch(args=>native('fetch',args as any),requestID=>{void native('fetch-cancel',{requestID});});
let view: View|null=null, home=true, saving=Promise.resolve(), skipSaving=false, initialized=false;
function capture(): View {
    const elements=[...document.querySelectorAll<HTMLElement>(home?'.hs-home-card':'.hs-reader-img')];
    const point=home?0:innerHeight/2;
    const node=elements.find(el=>{const r=el.getBoundingClientRect();return r.top<=point&&r.bottom>point;})??elements.at(-1);
    const rect=node?.getBoundingClientRect();
    const route=selected.matchRoute(location.pathname,location.hash);
    return {path:location.pathname+location.search+location.hash,home,y:scrollY,
        fraction:rect?Math.max(0,Math.min(1,-rect.top/rect.height)):0,
        ...(home?{series:node?.dataset.series}:{series:route?.handler===Handler.Reader?route.slug:undefined,chapter:node?.closest<HTMLElement>('.hs-chapter')?.dataset.chapter,index:Number(node?.id.slice(1)||0)})};
}
function save() {
    if(!initialized||!ready||skipSaving)return saving;
    view=capture();saving=saving.catch(()=>{}).then(()=>native('view-save',{view}));return saving;
}
async function resume() {
    await native('activate',{home});
    if(!initialized)return;
    updateProgress((await computeRequest('backup-export',undefined)).indexedDB.progress);
    resumeDownloads();
}
(window as any).mangaApp={save,pause(){void save();pauseDownloads();},resume(){void resume().catch(console.error);},diagnostics(){return {home,view,restored,ready};}};
addEventListener('scrollend',()=>{void save();},{passive:true});
addEventListener('click',()=>{void save();},{capture:true});
addEventListener('pagehide',()=>{void save();pauseDownloads();});
addEventListener('pageshow',event=>{if(event.persisted){skipSaving=false;void resume().catch(console.error);}});
onProgressChange(updateProgress);
async function main() {
    const initial=await native('init');
    for(const [key,slug] of Object.entries(initial.routes??{}))routes.set(key,slug as string);
    const match=selected.matchRoute(location.pathname,location.hash);
    if(!match)throw new Error('Invalid reader route');
    home=match.handler===Handler.Home;
    const coldTarget:View|null=initial.cold&&initial.view&&!initial.view.home&&home?initial.view:null;
    const saved=home?initial.home:initial.view?.path.split('#')[0]=== (location.pathname+location.search)?initial.view:null;
    setRestore(saved??null);
    startInit('');
    preparationContext(home,match.handler===Handler.Reader?identity(match.slug):null);
    const database=await computeRequest('backup-export',undefined);updateProgress(database.indexedDB.progress);
    initialized=true;await native('activate',{home});resumeDownloads();
    if(home) {
        const opening=openHome(provider).then(viewReady);
        if(coldTarget) {
            // Keep a functioning Home underneath the reader for native swipe back.
            skipSaving=true;
            const url=coldTarget.series&&coldTarget.chapter?provider.readerUrl(coldTarget.series,coldTarget.chapter,String(coldTarget.index??0)):localURL(coldTarget.path);
            location.assign(url);
        }
        await opening;
    } else if(match.handler===Handler.Reader) {
        await openReader(provider,{...match,...(saved?{imageIndex:String(saved.index??0)}:{})});
        void save();
    }
}
void main().catch(console.error);
