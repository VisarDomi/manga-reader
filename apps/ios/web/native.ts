export const documentID = crypto.randomUUID();
let activation: Promise<any> = Promise.resolve();
let resumeBridge: (()=>void) | undefined;
addEventListener('pagehide', () => {
    // Frozen workers can deliver queued messages before pageshow. Hold reads and
    // requests until this document has reclaimed the native bridge.
    activation = new Promise<void>(resolve => { resumeBridge = resolve; });
});
export function native<T = any>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const send = () => (window as any).webkit.messageHandlers.asura.postMessage({command,args,document:documentID}).then(JSON.parse);
    // A cached document must reacquire the bridge before its shared pageshow
    // callbacks resume provider/history work. They run in the same event turn.
    if (command === 'init' || command === 'activate') {
        const resume = resumeBridge; resumeBridge = undefined;
        activation = send();
        if (resume) void activation.then(resume, resume);
        return activation;
    }
    return activation.then(send);
}
export function localURL(raw: string): string {
    const url = new URL(raw, __IOS_ORIGIN__);
    if (url.origin !== new URL(__IOS_ORIGIN__).origin) throw new Error('Invalid provider destination');
    return location.origin === 'null' ? `asura://app${url.pathname}${url.search}${url.hash}` : `${location.origin}${url.pathname}${url.search}${url.hash}`;
}
export function imageURL(url: string, cover = false): string {
    return `${location.protocol==='asura:'?'asura://app':location.origin}/image?url=${encodeURIComponent(url)}${cover ? '&cover=1' : ''}`;
}
