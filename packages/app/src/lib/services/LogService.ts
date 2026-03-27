// ── Event Catalog ─────────────────────────────────────────────────
// Every log event is a variant of this union. Adding a new event
// requires adding it here first — the compiler then forces every
// emitter to supply the right payload. No untyped `string` events.

export type LogEvent =
    // Boot
    | { event: 'boot-start' }
    | { event: 'boot-ready'; ms: number; view: string }
    | { event: 'init-crash'; message: string; stack: string; ms: number }

    // Provider
    | { event: 'provider-loaded'; name: string; version?: string; mode: string }

    // Restore lifecycle — every exit path emits exactly one terminal event
    | { event: 'restore-none' }
    | { event: 'restore-start'; view: string; mangaId: string | null; targetId: string | null; hasSearch: boolean }
    | { event: 'restore-search-done'; view: string }
    | { event: 'restore-target-found'; targetId: string; page: number; scrolled: boolean }
    | { event: 'restore-target-missed'; targetId: string; pagesSearched: number; reason: 'not-found' | 'cancelled' | 'error' | 'no-chapters' }
    | { event: 'restore-ok'; view: string; mangaId?: string }
    | { event: 'restore-fallback'; view: string; reason: string; fallback?: string }

    // Search
    | { event: 'search-result'; query: string; page: number; resultCount: number; hasMore: boolean; currentPage?: number; lastPage?: number; total?: number }

    // Chapters
    | { event: 'chapters-page'; mangaId: string; page: number; items: number; lastPage?: number; total?: number }
    | { event: 'chapters-parallel'; mangaId: string; remaining: number; total: number }
    | { event: 'chapters-page-error'; mangaId: string; page: number; error: string }
    | { event: 'chapters-done'; mangaId: string; pages: number; failed?: number; total: number }

    // Chapter images
    | { event: 'chapter-images-result'; mangaId: string; chapterId: string; chapterNumber: number; imageCount: number }

    // Reader navigation — every append/prepend exit path logged
    | { event: 'reader-open'; mangaId: string; chapterId: string; chapterNumber: number; hasRestore: boolean }
    | { event: 'reader-append-ok'; mangaId: string; chapterId: string; chapterNumber: number }
    | { event: 'reader-append-skipped'; reason: 'loading' | 'no-manga' | 'no-loaded' | 'no-next' | 'already-loaded' }
    | { event: 'reader-append-failed'; mangaId: string; chapterId: string; error: string }
    | { event: 'reader-prepend-ok'; mangaId: string; chapterId: string; chapterNumber: number }
    | { event: 'reader-prepend-skipped'; reason: 'loading' | 'no-manga' | 'no-loaded' | 'no-prev' | 'already-loaded' }
    | { event: 'reader-prepend-failed'; mangaId: string; chapterId: string; error: string }
    | { event: 'reader-chapter-change'; mangaId: string; fromChapterId: string | null; toChapterId: string }
    | { event: 'reader-close'; mangaId: string; chapterId: string | null }

    // Progress
    | { event: 'progress-save'; mangaId: string; chapterId: string; chapterNumber: number; pageIndex?: number; pageCount?: number }

    // View navigation
    | { event: 'view-push'; from: string; to: string }
    | { event: 'view-pop'; from: string; to: string }
    | { event: 'view-reset'; to: string }

    // Resume
    | { event: 'resume'; kind: string; elapsedMs: number; view: string }
    | { event: 'resume-recover'; view: string; searchWasStuck: boolean; resultCount: number; currentPage: number; query: string }
    | { event: 'watchdog-freeze'; gapMs: number }
    | { event: 'sentinel-forced-resume'; frozenSeconds: number }

    // Image loading (from ReaderMemoryManager) — only failures; successes logged server-side by imageProxy
    | { event: 'img-fail'; key: string; totalMs: number; error: string; pending: number }

    // Errors
    | { event: 'uncaught-error'; message: string; source: string; line: number; col: number; stack: string }
    | { event: 'unhandled-rejection'; message: string; stack: string }
    | { event: 'db-error'; op: string; error: string }
    | { event: 'favorites-toggle-failed'; message: string };

// ── Emit function type ───────────────────────────────────────────
// Every consumer receives this — one generic function that accepts
// any variant. The `event` field is pulled out as the first arg,
// the rest is the payload. This gives callsites the ergonomic
//   emit('boot-ready', { ms: 42, view: 'list' })
// while the compiler checks the payload matches the event name.

type EventName = LogEvent['event'];
type PayloadOf<E extends EventName> = Omit<Extract<LogEvent, { event: E }>, 'event'>;
type HasPayload<E extends EventName> = keyof PayloadOf<E> extends never ? false : true;

export type LogEmit = <E extends EventName>(
    ...args: HasPayload<E> extends true ? [event: E, data: PayloadOf<E>] : [event: E]
) => void;

// ── LogService ───────────────────────────────────────────────────

export class LogService {
    private cleanups: (() => void)[] = [];

    start(): void {
        if (typeof window === 'undefined') return;

        const onError = (event: ErrorEvent) => {
            this.emit('uncaught-error', {
                message: event.message,
                source: event.filename ?? '',
                line: event.lineno ?? 0,
                col: event.colno ?? 0,
                stack: event.error?.stack ?? '',
            });
        };

        const onRejection = (event: PromiseRejectionEvent) => {
            const reason = event.reason;
            this.emit('unhandled-rejection', {
                message: String(reason?.message ?? reason),
                stack: reason?.stack ?? '',
            });
        };

        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        this.cleanups.push(
            () => window.removeEventListener('error', onError),
            () => window.removeEventListener('unhandledrejection', onRejection),
        );
    }

    emit: LogEmit = ((event: string, data?: Record<string, unknown>) => {
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, data }),
        }).catch(() => {});
    }) as LogEmit;

    destroy(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
    }
}
