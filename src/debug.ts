export function setupDebug() {
    // ── panel ─────────────────────────────────────────────────
    const logEl = document.createElement('div');
    logEl.id = 'hs-debug-log';
    logEl.style.cssText = 'position:sticky;top:0;z-index:99999;background:#0a0a12;color:#aaa;font:12px/1.4 monospace;max-height:200px;overflow-y:auto;padding:4px 8px;border-bottom:1px solid #333;display:flex;flex-direction:column';

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:2px;flex-shrink:0';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy log';
    copyBtn.style.cssText = 'background:#333;color:#ccc;border:1px solid #555;border-radius:3px;padding:2px 8px;font:11px monospace;cursor:pointer';
    toolbar.appendChild(copyBtn);
    logEl.appendChild(toolbar);

    const logBody = document.createElement('div');
    logBody.style.cssText = 'flex:1;overflow-y:auto';
    logEl.appendChild(logBody);

    const logEntries: string[] = [];
    const rawLines: string[] = [];
    function log(msg: string, color = '#aaa') {
        const t = performance.now().toFixed(0);
        const html = `<span style="color:${color}">[${t}] ${msg}</span>`;
        const raw = `[${t}] ${msg.replace(/<[^>]+>/g, '')}`;
        logEntries.unshift(html);
        rawLines.unshift(raw);
        if (logEntries.length > 50) { logEntries.length = 50; rawLines.length = 50; }
        logBody.innerHTML = logEntries.join('<br>');
    }
    (window as any).hsLog = log;

    // ── copy ──────────────────────────────────────────────────
    function fallbackCopy(text: string) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        const isIOS = /ipad|iphone|ipod/i.test(navigator.userAgent);
        if (isIOS) {
            const range = document.createRange();
            range.selectNodeContents(ta);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            ta.setSelectionRange(0, 999999);
        } else {
            ta.select();
        }
        try { document.execCommand('copy'); copyBtn.textContent = 'Copied!'; } catch { copyBtn.textContent = 'Failed'; }
        setTimeout(() => { copyBtn.textContent = 'Copy log'; ta.remove(); }, 1500);
    }

    copyBtn.onclick = () => {
        const text = rawLines.join('\n');
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy log'; }, 1500);
            }).catch(() => fallbackCopy(text));
        } else {
            fallbackCopy(text);
        }
    };

    document.body.insertBefore(logEl, document.body.firstChild);
    log('debug panel ready', '#6af');

    // ── event monitors ────────────────────────────────────────
    const sugg = document.getElementById('search-suggestions')!;
    const searchWrap = sugg.parentElement!;
    const input = document.getElementById('query-input') as HTMLInputElement;

    for (const ev of ['pointerdown', 'mousedown', 'click'] as const) {
        sugg.addEventListener(ev, (e) => {
            const t = e.target as Element;
            const tag = t.tagName;
            const cls = t.className?.toString?.() ?? '';
            const txt = (t as HTMLElement).textContent ?? '';
            const insideA = !!(t as HTMLElement).closest?.('a.search-suggestion_string');
            const phase = {1:'CAPTURE',2:'TARGET',3:'BUBBLE'}[e.eventPhase] ?? e.eventPhase;
            const inputVal = input.value;
            log(
                `${ev} ${phase} on <${tag.toLowerCase()}> ."${cls}" "${txt}" ` +
                `insideLink=${insideA} defaultPrevented=${e.defaultPrevented} ` +
                `cancelBubble=${e.cancelBubble} input="${inputVal}"`,
                '#8f8',
            );
        }, true);

        sugg.addEventListener(ev, (e) => {
            const phase = {1:'CAPTURE',2:'TARGET',3:'BUBBLE'}[e.eventPhase] ?? e.eventPhase;
            log(
                `${ev} ${phase} (bubble) defaultPrevented=${e.defaultPrevented} ` +
                `cancelBubble=${e.cancelBubble} input="${input.value}"`,
                '#6c6',
            );
        });
    }

    document.addEventListener('click', (e) => {
        const t = e.target as Element;
        const insideInput = !!(t as HTMLElement).closest?.('#query-input');
        const insideSugg = !!(t as HTMLElement).closest?.('#search-suggestions');
        log(
            `click CAPTURE document → insideInput=${insideInput} insideSugg=${insideSugg} ` +
            `target=<${t.tagName.toLowerCase()}> defaultPrevented=${e.defaultPrevented}`,
            '#f88',
        );
    }, true);

    document.addEventListener('click', (e) => {
        const insideSugg = !!(e.target as Element).closest?.('#search-suggestions');
        if (insideSugg) {
            const val = input.value;
            log(
                `click BUBBLE document (post-handlers) → defaultPrevented=${e.defaultPrevented} ` +
                `cancelBubble=${e.cancelBubble} input="${val}"`,
                '#f44',
            );
        }
    });

    // ── .active monitor ───────────────────────────────────────
    const activeObserver = new MutationObserver(() => {
        const active = searchWrap.classList.contains('active');
        log(`.active ${active ? 'ADDED' : 'REMOVED'} on hs-search-input`, active ? '#8af' : '#f84');
    });
    activeObserver.observe(searchWrap, { attributes: true, attributeFilter: ['class'] });
    log('monitoring .active class toggles', '#8af');

    // ── jQuery handler inspection ─────────────────────────────
    const jq = (window as any).jQuery;
    if (jq) {
        for (const el of [sugg, sugg.parentElement!, document.body, document.documentElement, document]) {
            const data = jq._data?.(el, 'events') as Record<string, any[]> | undefined;
            if (!data) continue;
            for (const [type, handlers] of Object.entries(data)) {
                for (const h of handlers) {
                    const sel = h.selector ? ` selector="${h.selector}"` : '';
                    const ns = h.namespace ? ` ns="${h.namespace}"` : '';
                    const origin = h.origType ? ` origType="${h.origType}"` : '';
                    const elName = (el as Element).tagName?.toLowerCase() ?? (el === document ? 'document' : 'unknown');
                    const handlerSrc = String(h.handler).replace(/\n/g, '↵');
                    log(
                        `jQuery handler on [${elName}] ` +
                        `type="${type}"${sel}${ns}${origin} src="${handlerSrc}"`,
                        '#aaf',
                    );
                }
            }
        }
        log('jQuery handler inspection complete', '#aaf');
    } else {
        log('jQuery not found — cannot inspect handlers', '#f84');
    }

    // ── inline onclick check on existing suggestion links ─────
    for (const a of sugg.querySelectorAll('a')) {
        const onclick = (a as any).onclick;
        const hasAttr = a.hasAttribute('onclick');
        const href = a.getAttribute('href') ?? '';
        log(
            `suggestion <a> href="${href}" has-onclick-attr=${hasAttr} onclick-prop=${!!onclick} ` +
            `text="${a.textContent ?? ''}"`,
            '#ff0',
        );
    }

    // ── input value change monitoring around clicks ───────────
    if (input) {
        let preClickVal = '';
        sugg.addEventListener('pointerdown', () => {
            preClickVal = input.value;
        }, true);
        sugg.addEventListener('click', () => {
            const postVal = input.value;
            if (preClickVal !== postVal) {
                log(
                    `INPUT-VAL-CHANGE from click: "${preClickVal}" → "${postVal}"`,
                    '#ff0',
                );
            }
        });

        // Delayed check — site handler may run after ours and change it back
        sugg.addEventListener('click', () => {
            const immediateVal = input.value;
            setTimeout(() => {
                const delayedVal = input.value;
                if (immediateVal !== delayedVal) {
                    log(
                        `INPUT-VAL-REVERTED after 0ms: "${immediateVal}" → "${delayedVal}"`,
                        '#f00',
                    );
                }
            }, 0);
        });
    }

    // ── stopPropagation / stopImmediatePropagation monitor ────
    const origStop = Event.prototype.stopPropagation;
    const origStopImm = Event.prototype.stopImmediatePropagation;
    Event.prototype.stopPropagation = function () {
        const insideSugg = this.target instanceof Element &&
            !!(this.target as Element).closest?.('#search-suggestions');
        if (this.type === 'click' && insideSugg) {
            log('stopPropagation() called on click inside suggestions', '#f80');
        }
        return origStop.call(this);
    };
    Event.prototype.stopImmediatePropagation = function () {
        const insideSugg = this.target instanceof Element &&
            !!(this.target as Element).closest?.('#search-suggestions');
        if (this.type === 'click' && insideSugg) {
            log('stopImmediatePropagation() called on click inside suggestions', '#f00');
        }
        return origStopImm.call(this);
    };
    log('Event.prototype.stopPropagation wrappers active', '#f80');

    // ── function wrappers ─────────────────────────────────────
    const origClearPage = (window as any).clear_page as Function | undefined;
    if (origClearPage) {
        (window as any).clear_page = function () {
            log('clear_page() called — dropdown HTML cleared', '#fa0');
            return origClearPage();
        };
        log('wrapped clear_page()', '#fa0');
    }

    const origToPage = (window as any).to_page as Function | undefined;
    if (origToPage) {
        (window as any).to_page = function (result: any) {
            log(`to_page("${result.s ?? ''}") ns="${result.n ?? ''}" t="${result.t ?? ''}"`, '#0f0');
            return origToPage.call(this, result);
        };
        log('wrapped to_page()', '#0f0');
    }

    const origGSQ = (window as any).get_suggestions_for_query as Function | undefined;
    if (origGSQ) {
        (window as any).get_suggestions_for_query = function (term: string, serial: number) {
            log(`get_suggestions_for_query("${term}", serial=${serial})`, '#c0f');
            const p = origGSQ.call(this, term, serial);
            if (p?.then) {
                p.then((r: any) => {
                    const [results] = r || [];
                    log(`← suggestions returned: ${results?.length ?? 0} results`, '#c0f');
                }, (err: any) => {
                    log(`← suggestions FAILED: ${err?.message ?? err}`, '#f44');
                });
            }
            return p;
        };
        log('wrapped get_suggestions_for_query()', '#c0f');
    }

    log('all monitors active — click a dropdown item', '#6af');

    // ── bfcache / page lifecycle monitors ──────────────────────
    log('--- bfcache monitors active ---', '#f0f');

    // sentinel: capture init-time state
    log(`INIT-STATE search="${window.location.search}" input.value="${input?.value ?? 'NO-ELEMENT'}" readyState=${document.readyState}`, '#ff0');

    // 1) pageshow — canonical bfcache restore detection
    window.addEventListener('pageshow', (e) => {
        const inp = (document.getElementById('query-input') as HTMLInputElement)?.value ?? 'NO-EL';
        log(`PAGESHOW persisted=${e.persisted} search="${window.location.search}" input="${inp}"`, e.persisted ? '#0f0' : '#888');
    });

    // 2) pagehide — fires when entering bfcache (or unloading)
    window.addEventListener('pagehide', (e) => {
        log(`PAGEHIDE persisted=${e.persisted}`, e.persisted ? '#0f0' : '#f80');
    });

    // 3) visibilitychange — fires on tab switch AND bfcache restore
    document.addEventListener('visibilitychange', () => {
        const inp = (document.getElementById('query-input') as HTMLInputElement)?.value ?? 'NO-EL';
        log(`VISIBILITY visible=${!document.hidden} search="${window.location.search}" input="${inp}"`, '#0cf');
    });

    // 4) freeze / resume — Page Lifecycle API (Chromium, not Safari)
    document.addEventListener('freeze', () => { log('FREEZE', '#c0f'); });
    document.addEventListener('resume', () => {
        const inp = (document.getElementById('query-input') as HTMLInputElement)?.value ?? 'NO-EL';
        log(`RESUME search="${window.location.search}" input="${inp}"`, '#c0f');
    });

    // 5) focus / blur
    window.addEventListener('focus', () => {
        log(`FOCUS search="${window.location.search}" input="${(document.getElementById('query-input') as HTMLInputElement)?.value ?? 'NO-EL'}"`, '#fa0');
    });
    window.addEventListener('blur', () => { log('BLUR', '#fa0'); });

    // 6) popstate — history navigation
    window.addEventListener('popstate', () => {
        log(`POPSTATE search="${window.location.search}" input="${(document.getElementById('query-input') as HTMLInputElement)?.value ?? 'NO-EL'}"`, '#af0');
    });

    // 7) load / DOMContentLoaded — should NOT fire on bfcache restore
    window.addEventListener('load', () => {
        log(`LOAD search="${window.location.search}"`, '#888');
    });
    document.addEventListener('DOMContentLoaded', () => { log('DOMContentLoaded', '#888'); });

    // 8) beforeunload — bfcache eligibility check (Safari allows it, Chrome/Firefox don't)
    window.addEventListener('beforeunload', () => { log('BEFOREUNLOAD', '#f44'); });

    // 9) unload — known bfcache killer, log if it fires
    window.addEventListener('unload', () => { log('UNLOAD — page is dying', '#f00'); });

    // 10) navigation timing — check if navigated via back/forward
    try {
        const navEntries = performance.getEntriesByType('navigation');
        const navType = navEntries.length > 0 ? (navEntries[0] as any).type : 'N/A';
        const oldType = (performance.navigation as any)?.type ?? 'N/A';
        log(`NAV-TYPE=new=${navType} old=${oldType}`, '#ff0');
    } catch { log('NAV-TYPE=ERROR', '#f44'); }

    // 11) document.wasDiscarded (Safari 17+)
    if ('wasDiscarded' in document) {
        log(`wasDiscarded=${(document as any).wasDiscarded}`, '#ff0');
    }

    // 12) mutation observer on input value attribute
    if (input) {
        const mo = new MutationObserver((muts) => {
            for (const m of muts) {
                log(`INPUT-MUTATION attr=${m.attributeName} val="${input.value}"`, '#f8f');
            }
        });
        mo.observe(input, { attributes: true, attributeFilter: ['value'] });
        // polling: MutationObserver doesn't catch .value = x (property, not attribute)
        let lastVal = input.value;
        setInterval(() => {
            if (input.value !== lastVal) {
                log(`INPUT-VALUE-CHANGED "${lastVal}" -> "${input.value}"`, '#f8f');
                lastVal = input.value;
            }
        }, 250);
    }

    // 13) pagereveal — newer event, Safari may support it
    window.addEventListener('pagereveal', () => {
        log(`PAGEREVEAL search="${window.location.search}"`, '#af0');
    });

    // 14) global sentinel — survives across bfcache if page was cached
    (window as any).__bfcacheSentinel = (window as any).__bfcacheSentinel || 0;
    (window as any).__bfcacheSentinel++;
    log(`SENTINEL=${(window as any).__bfcacheSentinel} (1=first init, >1 if init ran again)`, '#ff0');

    // 15) also use the property form (some old Safari inconsistencies)
    const origOnPageShow = window.onpageshow;
    window.onpageshow = (e) => {
        log(`ONPAGESHOW persisted=${e.persisted}`, '#fa0');
        if (origOnPageShow) origOnPageShow.call(window, e);
    };

    // ── bfcache fix-approach tests ──────────────────────────────
    const query = decodeURIComponent(window.location.search.replace(/^\?/, ''));
    function fixSet(tag: string) {
        if (input && query) input.value = query;
        log(`${tag} query="${query}" input="${input?.value ?? 'NO-EL'}"`, '#0f0');
    }

    // 1) pageshow + setTimeout(0)
    window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return;
        log('fix-setTimeout scheduling', '#0f0');
        setTimeout(() => fixSet('fix-setTimeout'), 0);
    });

    // 2) pageshow + queueMicrotask
    window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return;
        log('fix-microtask scheduling', '#0f0');
        queueMicrotask(() => fixSet('fix-microtask'));
    });

    // 3) pageshow + rAF
    window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return;
        log('fix-rAF scheduling', '#0f0');
        requestAnimationFrame(() => fixSet('fix-rAF'));
    });

    // 4) pageshow + double set (now + setTimeout(0))
    window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return;
        log('fix-double-1 scheduling', '#0f0');
        if (input && query) input.value = query;
        setTimeout(() => fixSet('fix-double-2'), 0);
    });

    // 5) pagereveal
    window.addEventListener('pagereveal', () => {
        log('fix-pagereveal scheduling', '#0f0');
        fixSet('fix-pagereveal');
    });

    // 6) visibilitychange (when visible)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            log('fix-visibility scheduling', '#0f0');
            fixSet('fix-visibility');
        }
    });

    // 7) focus
    window.addEventListener('focus', () => {
        log('fix-focus scheduling', '#0f0');
        fixSet('fix-focus');
    });

    // 8) MutationObserver — detect Safari clear, re-set
    if (input) {
        let moTimeout: ReturnType<typeof setTimeout> | null = null;
        const mo = new MutationObserver(() => {
            if (input.value !== query && query) {
                log('fix-mo clearing detected, re-setting', '#0f0');
                input.value = query;
                if (moTimeout) clearTimeout(moTimeout);
                moTimeout = setTimeout(() => {
                    fixSet('fix-mo-final');
                    moTimeout = null;
                }, 500);
            }
        });
        mo.observe(input, { attributes: true, attributeFilter: ['value'] });
    }

    // 9) polling — brute force 200ms intervals for 2s after pageshow
    window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return;
        log('fix-poll starting', '#0f0');
        for (let i = 1; i <= 10; i++) {
            setTimeout(() => fixSet(`fix-poll-${i * 200}ms`), i * 200);
        }
    });

    log('all-fix-approaches REGISTERED', '#ff0');
}
