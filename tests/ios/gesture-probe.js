// Transient native-inspector diagnostic; bundled only with MANGA_GESTURE_PROBE=1.
(() => {
    if (window !== window.top || location.hostname !== 'asurascans.com') return;
    console.log('MANGA_SETUP begin');
    window.__mangaGestureProbe?.stop();
    console.log('MANGA_SETUP stopped-old');
    const deadline = __CAPTURE_DEADLINE__;
    if (Date.now() >= deadline) return;
    const id = `${Date.now()}`;
    const visualViewport = window.visualViewport;
    console.log('MANGA_SETUP viewport-reference');
    const events = [];
    const listeners = [];
    const undo = [];
    let stopped = false;
    let dropped = 0;
    let touchedAt = null;
    let lastFrame;
    let raf;
    let lastFlushMs = 0;
    const record = (type, data = {}) => {
        if (stopped) return;
        if (events.length >= 1000) { dropped++; return; }
        events.push({ type, at: performance.now(), y: scrollY, ...data });
    };
    const flush = () => {
        if (events.length || dropped) {
            const started = performance.now();
            console.log('MANGA_GESTURE ' + JSON.stringify({ version: 2, id, epoch: Date.now(), timeOrigin: performance.timeOrigin,
                path: location.pathname + location.hash, events: events.splice(0), dropped, lastFlushMs }));
            lastFlushMs = performance.now() - started;
            dropped = 0;
        }
    };
    const eventData = event => {
        const stamp = event.timeStamp > 1e12 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
        return { trusted: event.isTrusted, eventAt: stamp,
            dispatchDelay: performance.now() - stamp };
    };
    const sync = type => record('clock-marker', { label: type });
    const listen = (target, name, fn) => {
        target.addEventListener(name, fn, { capture: true, passive: true });
        listeners.push(() => target.removeEventListener(name, fn, true));
    };
    listen(window, 'manga-inspector-sync', event => record('clock-sync', eventData(event)));
    console.log('MANGA_SETUP first-listener');
    for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'keydown']) {
        listen(window, name, event => {
            touchedAt = performance.now();
            const point = event.touches?.[0] || event.changedTouches?.[0] || event;
            record(name, { ...eventData(event), touches: event.touches?.length,
                clientX: point.clientX, clientY: point.clientY });
            if (name === 'touchstart' || name === 'touchend') sync(name);
        });
    }
    listen(window, 'scroll', event => record('scroll', eventData(event)));
    listen(window, 'scrollend', event => { record('scrollend', eventData(event)); sync('scrollend'); });
    const viewport = () => ({ height: innerHeight, width: innerWidth,
        visualHeight: visualViewport?.height, visualTop: visualViewport?.offsetTop,
        visualPageTop: visualViewport?.pageTop, scale: visualViewport?.scale });
    listen(window, 'resize', () => record('resize', viewport()));
    if (visualViewport) {
        listen(visualViewport, 'resize', () => record('visual-resize', viewport()));
        listen(visualViewport, 'scroll', () => record('visual-scroll', viewport()));
    }
    listen(document, 'click', event => {
        const link = event.target.closest?.('a');
        if (link) {
            const url = new URL(link.href);
            record('click', { trusted: event.isTrusted, className: link.className, to: url.pathname + url.hash });
        }
    });
    listen(document, 'load', event => {
        const img = event.target;
        if (img.matches?.('.hs-reader-img')) record('image-load', {
            image: img.id, chapter: img.parentElement?.dataset.chapter,
            width: img.naturalWidth, height: img.naturalHeight,
        });
    });
    listen(window, 'pageshow', event => record('pageshow', { persisted: event.persisted }));
    listen(document, 'visibilitychange', () => {
        lastFrame = undefined;
        record('visibility', { value: document.visibilityState });
    });
    console.log('MANGA_SETUP listeners');
    for (const [object, name] of [[window, 'scrollTo'], [window, 'scrollBy'], [Element.prototype, 'scrollIntoView'], [history, 'replaceState']]) {
        const original = object[name];
        const wrapped = function (...args) {
            record(name, { sinceInput: touchedAt === null ? null : performance.now() - touchedAt,
                request: name === 'replaceState' ? String(args[2]) : args,
                stack: new Error().stack?.split('\n').slice(1, 5) });
            const started = performance.now();
            try {
                return Reflect.apply(original, this, args);
            } finally {
                record(name + '-returned', { duration: performance.now() - started });
            }
        };
        object[name] = wrapped;
        undo.push(() => { if (object[name] === wrapped) object[name] = original; });
    }
    const mutation = new MutationObserver(records => {
        let added = 0;
        let imageStyles = 0;
        for (const item of records) {
            if (item.type === 'attributes' && item.target.matches?.('.hs-reader-img')) imageStyles++;
            for (const node of item.addedNodes) {
                if (node.nodeType === 1 && node.matches('.hs-chapter')) added++;
            }
        }
        if (added || imageStyles) record('reader-dom', { chaptersAdded: added, imageStyles });
    });
    console.log('MANGA_SETUP wrappers');
    mutation.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    const frame = at => {
        if (stopped) return;
        if (lastFrame !== undefined && !document.hidden && at - lastFrame > 25) {
            // Callback delay is not a measurement of displayed/dropped frames.
            record('raf-gap', { ms: at - lastFrame, frameTimestamp: at });
        }
        lastFrame = at;
        raf = requestAnimationFrame(frame);
    };
    const timer = setInterval(flush, 1000);
    const calibration = setTimeout(() => window.dispatchEvent(new Event('manga-inspector-sync')), 500);
    const expiry = setTimeout(() => stop(), Math.max(0, deadline - Date.now()));
    function stop() {
        if (stopped) return;
        record('stop');
        flush();
        stopped = true;
        clearInterval(timer);
        clearTimeout(calibration);
        clearTimeout(expiry);
        cancelAnimationFrame(raf);
        mutation.disconnect();
        listeners.forEach(remove => remove());
        undo.forEach(restore => restore());
        delete window.__mangaGestureProbe;
    }
    listen(window, 'pagehide', event => {
        record('pagehide', { persisted: event.persisted });
        flush();
        lastFrame = undefined;
    });
    window.__mangaGestureProbe = { stop, id, version: 2 };
    console.log('MANGA_SETUP ready');
    record('armed', { boot: window.__mangaExtensionBoot, visible: document.visibilityState, viewport: viewport() });
    sync('armed');
    raf = requestAnimationFrame(frame);
    flush();
    return 'Asura gesture capture armed';
})()
