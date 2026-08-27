// Worker-side context about the page it serves. The main thread feeds this
// via the 'cookie-snapshot' op (cookies and page URL). The page URL
// is required as the explicit fetch referrer: some Cloudflare-fronted
// provider APIs (luacomic) reject requests whose Referer is not the site
// page — a worker's default referrer is not the page URL.

interface WorkerContext {
    cookies: string;
    href: string;
}

const context: WorkerContext = { cookies: '', href: '' };

export function setWorkerContext(update: Partial<WorkerContext>): void {
    Object.assign(context, update);
}

export function workerContext(): WorkerContext {
    return context;
}
