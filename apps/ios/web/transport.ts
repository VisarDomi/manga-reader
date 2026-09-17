import workerCode from '@worker-code';
import type { OpTypes, ComputeResponse } from '../../../src/core/compute/messages';
import { native } from './native';
let next = 0, worker: Worker | undefined, workerURL: string | undefined;
const pending = new Map<number,{resolve(value: any): void; reject(error: Error): void}>();
export let progressChanged: ((progress: any[])=>void) | undefined;
export function onProgressChange(callback: (progress: any[])=>void) { progressChanged=callback; }
function spawn() {
    workerURL=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));
    const current=new Worker(workerURL); worker=current;
    current.onmessage=async ({data})=>{
        if(worker!==current)return;
        if(data.bridgeID) {
            try { const value=await native(data.command,data.args); if(worker===current)current.postMessage({bridgeID:data.bridgeID,value}); }
            catch(error) { if(worker===current)current.postMessage({bridgeID:data.bridgeID,error:String(error)}); }
        } else if(data.progressChanged) progressChanged?.(data.progress);
        else {
            const response=data as ComputeResponse, request=pending.get(response.id);pending.delete(response.id);
            if(response.ok)request?.resolve(response.value);else request?.reject(new Error(response.error));
        }
    };
    current.onerror=event=>{for(const request of pending.values())request.reject(new Error(event.message));pending.clear();closeWorker();};
    return current;
}
export function computeRequest<K extends keyof OpTypes>(op: K,payload: OpTypes[K]['payload']): Promise<OpTypes[K]['result']> {
    if(op==='page-context')payload={href:new URL(location.pathname+location.search,__IOS_ORIGIN__).href} as OpTypes[K]['payload'];
    return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});(worker??spawn()).postMessage({id,op,payload});});
}
export function closeWorker() {
    worker?.terminate();worker=undefined;
    if(workerURL)URL.revokeObjectURL(workerURL);workerURL=undefined;
    for(const request of pending.values())request.reject(new Error('Document suspended'));pending.clear();
}
