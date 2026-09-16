export const documentID = crypto.randomUUID();
export async function native<T = any>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return JSON.parse(await (window as any).webkit.messageHandlers.asura.postMessage({command,args,document:documentID}));
}
export function localURL(raw: string): string {
    const url = new URL(raw, __IOS_ORIGIN__);
    if (url.origin !== new URL(__IOS_ORIGIN__).origin) throw new Error('Invalid provider destination');
    return location.origin === 'null' ? `asura://app${url.pathname}${url.search}${url.hash}` : `${location.origin}${url.pathname}${url.search}${url.hash}`;
}
export function imageURL(url: string, cover = false): string {
    return `${location.protocol==='asura:'?'asura://app':location.origin}/image?url=${encodeURIComponent(url)}${cover ? '&cover=1' : ''}`;
}
