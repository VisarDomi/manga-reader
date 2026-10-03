// Native transport only. Providers retain Fetch's prompt cancellation semantics.
export function installFetch(send: (request: unknown) => Promise<any>, cancel: (requestID: string) => void) {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (!request.url.startsWith('https://')) return original(input, init);
        request.signal.throwIfAborted();
        const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.text();
        const requestID = crypto.randomUUID();
        let rejectAbort!: (reason: unknown) => void;
        const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const abort = () => { cancel(requestID); rejectAbort(request.signal.reason); };
        request.signal.addEventListener('abort', abort, {once:true});
        try {
            request.signal.throwIfAborted();
            const result = await Promise.race([send({ requestID, url: request.url, method: request.method,
                headers: Object.fromEntries(request.headers),
                // The local app origin is opaque to Fetch. Preserve the source
                // provider's referrer instead of Request reducing it to about:client.
                referrer: init?.referrer?.startsWith('https://') ? init.referrer : __IOS_ORIGIN__, body }), interrupted]);
            request.signal.throwIfAborted();
            const bytes = Uint8Array.from(atob(result.body), c => c.charCodeAt(0));
            return new Response([204,205,304].includes(result.status) ? null : bytes, { status: result.status, headers: result.headers });
        } finally { request.signal.removeEventListener('abort', abort); }
    };
}
