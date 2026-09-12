// Use scrollend immediately; no additional settling timer.
export function onSettledScroll(callback: () => void): () => void {
    let scrolling = false;
    let touching = false;
    let active = true;
    const schedule = () => {
        if (scrolling || touching || !active || document.hidden) return;
        callback();
    };
    window.addEventListener('scroll', () => { scrolling = true; }, { passive: true });
    window.addEventListener('scrollend', () => { scrolling = false; schedule(); });
    window.addEventListener('touchstart', () => { touching = true; }, { passive: true });
    const touchFinished = (event: TouchEvent) => {
        touching = event.touches.length > 0;
        if (!touching) schedule();
    };
    window.addEventListener('touchend', touchFinished, { passive: true });
    window.addEventListener('touchcancel', touchFinished, { passive: true });
    window.addEventListener('pagehide', () => { active = false; touching = false; });
    window.addEventListener('pageshow', () => { active = true; scrolling = false; });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { scrolling = false; touching = false; }
    });
    // Image loads, initial restoration and bfcache restoration use the same
    // settling gate; none may bypass an in-progress scroll.
    return schedule;
}
