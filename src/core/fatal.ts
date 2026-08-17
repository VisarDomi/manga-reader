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
    const report = (error: unknown): void => {
        console.error('manga-reader uncaught error', error);
        showFatalError(error instanceof Error ? error.message : String(error));
    };
    window.addEventListener('error', event => {
        report(event.error ?? event.message);
    });
    window.addEventListener('unhandledrejection', event => {
        report(event.reason);
    });
}
