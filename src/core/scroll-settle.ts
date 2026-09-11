// Safari can report scrollend before its visible movement has settled. Sample
// position after 100 ms, not at event delivery. This never blocks the UI thread.
export function onSettledScroll(callback: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scrolling = false;
    let touching = false;
    let active = true;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const schedule = () => {
        cancel();
        if (scrolling || touching || !active || document.hidden) return;
        timer = setTimeout(() => {
            timer = undefined;
            if (active && !document.hidden && !scrolling && !touching) callback();
        }, 100);
    };
    window.addEventListener('scroll', () => { scrolling = true; cancel(); }, { passive: true });
    window.addEventListener('scrollend', () => { scrolling = false; schedule(); });
    window.addEventListener('touchstart', () => { touching = true; cancel(); }, { passive: true });
    const touchFinished = (event: TouchEvent) => {
        touching = event.touches.length > 0;
        if (!touching) schedule();
    };
    window.addEventListener('touchend', touchFinished, { passive: true });
    window.addEventListener('touchcancel', touchFinished, { passive: true });
    window.addEventListener('pagehide', () => { active = false; touching = false; cancel(); });
    window.addEventListener('pageshow', () => { active = true; scrolling = false; });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { scrolling = false; touching = false; cancel(); }
    });
    // Image loads, initial restoration and bfcache restoration use the same
    // settling gate; none may bypass an in-progress scroll.
    return schedule;
}
