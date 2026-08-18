/**
 * Visible fatal-error surface. The app must fail loudly: a blank takeover
 * hides the failure; this banner never does.
 */

export function showFatalError(message: string): void {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('hs-fatal-error');
    if (existing) {
        existing.textContent = 'Startup failed: ' + message;
        return;
    }
    const banner = document.createElement('div');
    banner.id = 'hs-fatal-error';
    banner.textContent = 'Startup failed: ' + message;
    banner.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'right:0',
        'z-index:2147483647',
        'background:#b00020',
        'color:#fff',
        'padding:12px 16px',
        'font:14px/1.4 system-ui,sans-serif',
        'white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(banner);
}

/**
 * Trap any uncaught error or unhandled rejection after the takeover and make
 * it visible. Console-only reporting is a swallowing path: the phone shows
 * nothing and the failure looks like a hang.
 */
export function trapUncaughtErrors(): void {
    // INSTRUMENTATION: report every error with its full identity — message,
    // filename, target, and stack — so the banner itself proves where a
    // failure comes from. No filtering, no fixes until the offender is known.
    window.addEventListener('error', event => {
        const details = {
            message: event.message,
            filename: event.filename ?? null,
            target: event.target === window ? 'window' : String(event.target),
            errorName: event.error instanceof Error ? event.error.name : null,
        };
        console.error('manga-reader window error', details, event.error);
        const stack = event.error instanceof Error && event.error.stack
            ? String(event.error.stack).slice(0, 800)
            : '';
        showFatalError('window error: ' + JSON.stringify(details) + (stack ? '\n' + stack : ''));
    });
    window.addEventListener('unhandledrejection', event => {
        const reason = event.reason instanceof Error
            ? event.reason.name + ': ' + event.reason.message + '\n' + String(event.reason.stack ?? '').slice(0, 800)
            : String(event.reason);
        // Only OUR rejections are app failures. The takeover nuke aborts the
        // site's in-flight module scripts, and their rejections reach this
        // window listener — banner them and we'd be blaming ourselves for
        // the site's casualty of our own window.stop().
        if (!reason.includes('manga-reader.user.js')) {
            console.error('manga-reader foreign rejection (not ours)', event.reason);
            return;
        }
        console.error('manga-reader unhandled rejection', event.reason);
        showFatalError('unhandled rejection: ' + reason);
    });
}
