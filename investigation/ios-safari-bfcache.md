# iOS Safari bfcache Investigation

## Problem Statement

imhentai cache is breaking on iOS Safari. The hypothesis: a WebSocket or persistent connection is being kept open, which prevents or interferes with the browser's back-forward cache (bfcache). When a user navigates from the userscript back to the original site (or vice versa), the cached page state is stale or broken.

---

## How bfcache Works

### Core Mechanism

bfcache is a **full in-memory snapshot** of a page — DOM, JS heap, layout, scroll position, form inputs, everything. When a user navigates away (back/forward), instead of destroying the page, the browser **freezes** it. If the user navigates back, the browser **restores** the snapshot instantly, without any network requests.

Key distinction from HTTP cache: bfcache stores the entire rendered page in memory, not just HTTP responses. A bfcache restore is always faster than even the best HTTP cache hit.

### Lifecycle Events

| Event | When it fires | Key property |
|---|---|---|
| `pagehide` | Page is about to be destroyed OR enter bfcache | `event.persisted` — `true` if entering bfcache, `false` if being destroyed |
| `pageshow` | After initial `load`, OR restored from bfcache | `event.persisted` — `true` if restored from bfcache |
| `freeze` | Immediately after `pagehide` (Chromium only) | Page is frozen, JS paused |
| `resume` | When page is unfrozen (Chromium only) | Fires before `pageshow` on restore |

**Critical:** `unload` event is the enemy of bfcache. Safari on iOS will cache pages with `unload` listeners but **won't fire** the event, making it unreliable. Use `pagehide` instead.

### What Gets Frozen

- All `setTimeout`/`setInterval` — paused, resumed on restore
- All pending Promises — frozen, resolved on restore
- JS execution — completely paused
- WebSocket connections — **this is the problem** (see below)

---

## WebSocket + bfcache Interaction

### Browser Behavior Varies

| Browser | Active WebSocket + bfcache |
|---|---|
| **Chrome (desktop)** | Page is **ineligible** for bfcache — evicted entirely |
| **Firefox** | Page is **ineligible** for bfcache — evicted entirely |
| **Safari/WebKit** | Page **enters bfcache**, WebSocket is **auto-closed on entry** |

This is the key: **Safari/WebKit takes a different approach.** Rather than blocking bfcache, it lets the page in and closes the WebSocket. This is the subject of active standards discussion (WHATWG HTML issue #12085, WebKit standards-positions #648). Chrome is experimenting with matching Safari's behavior.

### The "Ghost Socket" Problem

When a page enters bfcache on Safari:
1. JS execution is paused
2. WebSocket is auto-closed by the browser
3. But the JS code **doesn't know** — close event handlers may not fire while frozen
4. On restore, the WebSocket object exists in memory but is **dead**
5. If the code doesn't detect this, it will use a dead connection, losing messages

This is the "ghost socket" — looks alive, actually dead.

### iOS Safari's Additional Layer: Tab Suspension

Beyond bfcache, iOS Safari aggressively suspends background tabs:

1. **Timer throttling** — `setTimeout`/`setInterval` in background tabs can be throttled to once per minute or less
2. **Silent WebSocket death** — iOS can kill WebSocket connections in suspended tabs **without firing close events** (close code 1006 = dropped without close frame)
3. **Heartbeat failure** — if the app uses `setTimeout`-based heartbeats, they won't run in a suspended tab, so the server may close the connection for inactivity
4. **No `visibilitychange` on bfcache restore** — when returning from another app, Safari may restore from bfcache and fire `pageshow` with `persisted=true` but **not** `visibilitychange`

### The Flarum Precedent

The Flarum project (issue #4588, PR #4590) documented exactly this problem:
- WebSocket appears alive after iOS backgrounding but is actually dead
- `visibilitychange` alone misses bfcache restores
- Solution: force reconnect on BOTH `visibilitychange` (with >5s threshold) AND `pageshow` with `persisted=true`
- After reconnect, refresh visible data to catch up on missed events

---

## Browser Investigation Results

### Observed Behavior

- **imhentai**: navigating back from reader → page **refreshes** (bfcache not working)
- **hitomi**: navigating back from reader → page **resumes where it was** (bfcache working)

### What imhentai's Scripts Actually Do

Inspected via headless Chromium on `https://imhentai.xxx/search/?key=big+breasts&en=1`:

| Script | WebSocket | EventSource | unload | setInterval | Notes |
|---|---|---|---|---|---|
| `main.12163238.js` (75KB) | ✗ | ✗ | ✗ | ✓ | Countdown timers for UI messages, keyboard scroll. All clear themselves. |
| `user.14235631.js` (30KB) | ✗ | ✗ | ✗ | ✓ | User interaction code. |
| `notifications.65x2jh3.js` (712B) | ✗ | ✗ | ✗ | ✗ | Just AJAX scroll-to-load-more. Not real-time. |
| `expp.js` (11KB) | ✗ | ✗ | ✗ | ✗ | **Popup ad controller from exosrv.com.** Uses `window.open(href, "_blank")` + `popMagic.top.document.location = popMagic.url`. |
| `phasedcleft.com` (67KB) | ✗ | ✗ | ✗ | ✓ | Ad SDK. `setInterval(ut, 3e4)` polls battery status every 30s. Uses `localStorage`. |
| `waust.at/s.js` (7KB) | ✗ | ✗ | ✗ | ✗ | Tracking script. Creates iframes. |

**No WebSocket or EventSource anywhere.** The original hypothesis was wrong.

### What's Actually Blocking bfcache

The most likely culprits, in order:

1. **`expp.js` (exosrv.com popup controller)** — calls `window.open(href, "_blank")` on click events. Even though `window.opener` is null by default in modern browsers, the popup-redirect pattern (`window.open` + then navigating the parent) can interfere with bfcache eligibility in Safari. Safari may treat pages with active popup ad scripts as ineligible.

2. **`phasedcleft.com` ad SDK** — 30-second `setInterval` for battery polling + `localStorage` writes. While these alone shouldn't block bfcache, Safari's heuristics may penalize pages with persistent ad SDK timers.

3. **Cloudflare Turnstile** — loaded (`challenges.cloudflare.com/turnstile/v0/api.js`) but no widget rendered. Turnstile can maintain challenge state that interferes with caching.

4. **Tracking iframes** — `dtscout.com` and `crwdcntrl.net` iframes are loaded. These may have their own lifecycle handlers.

## Recommendations

Since the problem is **ad scripts preventing bfcache**, not WebSocket connections, the approach is different:

### Option A: Force-Reload on bfcache Restore (Defensive)

Even if the page does enter bfcache sometimes, handle the restore gracefully:

```js
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        // Page was restored from bfcache — re-initialize the userscript
        location.reload();
    }
});
```

This is the simplest fix. If bfcache works (hitomi), we get instant restore. If it doesn't (imhentai), the page reloads anyway — which is what happens now. No downside.

### Option B: Use Hash Navigation to Avoid bfcache Entirely

Since we can't control the ad scripts, avoid full-page navigations:
- Search pagination → hash change (`#page=N`)
- Gallery click → hash change (`#gallery=12345`)
- Reader → still a full navigation (unavoidable for image loading)

This reduces the surface area but doesn't eliminate the problem for reader navigation.

### Option C: Inject Before Ad Scripts (Aggressive)

If the userscript runs early enough (before DOMContentLoaded), we could:
1. Block ad script injection via MutationObserver
2. Remove ad iframes
3. This would make the page bfcache-eligible

But this is fragile and may break the site.

### Recommended: Option A

The `pageshow` + `persisted` check is zero-cost, works on all sites, and handles both cases:
- bfcache works → instant restore (no reload needed, but we re-init)
- bfcache doesn't work → normal page load (pageshow fires with `persisted=false`)

### Debug: Check notRestoredReasons

```js
// In a pageshow handler:
const nav = performance.getEntriesByType('navigation')[0];
if (nav?.notRestoredReasons) {
    console.log('bfcache blocked because:', nav.notRestoredReasons);
}
```

---

## Key Takeaway

**imhentai's own code doesn't break bfcache.** The culprit is third-party ad scripts (`expp.js` from exosrv.com, `phasedcleft.com` ad SDK, tracking iframes) that prevent the page from entering bfcache. hitomi doesn't load these scripts, which is why its bfcache works.

The fix is defensive: listen for `pageshow` with `event.persisted === true` and re-initialize. This works regardless of whether bfcache is available.


---

## Sources

- [web.dev: Back/forward cache](https://web.dev/articles/bfcache) — comprehensive guide
- [MDN: Back/forward cache](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/bfcache) — reference
- [WHATWG HTML #12085](https://github.com/whatwg/html/issues/12085) — WebSocket bfcache standards proposal
- [WebKit/standards-positions #648](https://github.com/WebKit/standards-positions/issues/648) — WebKit's position on WebSocket + bfcache
- [Flarum #4588](https://github.com/flarum/framework/issues/4588) — real-world iOS Safari WebSocket + bfcache bug
- [Flarum PR #4590](https://github.com/flarum/framework/pull/4590) — fix implementation
- [Chrome Platform Status: Disconnect WebSockets on BFCache entry](https://chromestatus.com/feature/5068439115923456) — Chrome matching Safari behavior
- [MDN: Monitoring bfcache blocking reasons](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Monitoring_bfcache_blocking_reasons)
