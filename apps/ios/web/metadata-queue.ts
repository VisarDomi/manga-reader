// Limit background chapter metadata without delaying visible chapter requests.
let active=0;
const waiting: Array<{key?:string;urgent:boolean;start():void}>=[];
function pump() {
    while(waiting.length) {
        const urgent=waiting.findIndex(job=>job.urgent);
        if(active>=(urgent<0?2:6))return;
        active++;waiting.splice(urgent<0?0:urgent,1)[0].start();
    }
}
export function metadata<T>(work:()=>Promise<T>,urgent=false,key?:string):Promise<T> {
    return new Promise((resolve,reject)=>{
        waiting.push({key,urgent,start(){void work().then(resolve,reject).finally(()=>{active--;pump();});}});
        pump();
    });
}

export function prioritizeMetadata(key:string) {
    const job=waiting.find(job=>job.key===key);
    if(job) { job.urgent=true;pump(); }
}
