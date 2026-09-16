let next = 0;
const pending = new Map<number, {resolve(value: any): void; reject(error: Error): void}>();
export function host(command: string, args: unknown = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const bridgeID = ++next; pending.set(bridgeID, {resolve,reject});
        self.postMessage({bridgeID,command,args});
    });
}
self.addEventListener('message', ({data}) => {
    if (!data.bridgeID) return;
    const request = pending.get(data.bridgeID); pending.delete(data.bridgeID);
    if (data.error) request?.reject(new Error(data.error)); else request?.resolve(data.value);
});
