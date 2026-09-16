// Worker-side context about the page it serves. The main thread feeds this
// via the 'page-context' op (page URL). The page URL
// is required as the explicit fetch referrer: some Cloudflare-fronted
// provider APIs reject requests whose Referer is not the site
// page — a worker's default referrer is not the page URL.

interface WorkerContext {
    href: string;
}

const context: WorkerContext = { href: '' };

export function setWorkerContext(update: Partial<WorkerContext>): void {
    Object.assign(context, update);
}

export function workerContext(): WorkerContext {
    return context;
}
