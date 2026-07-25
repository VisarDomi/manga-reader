# Investigation Lessons Learned

## Tool Usage Failures

### 1. Forgetting `action: "run"` in browser tool
Repeatedly called `browser()` with `code` but omitted `action: "run"`. This wasted dozens of round-trips.

**Fix**: Always include `action: "run"` — it's required even when the intent is obvious.

### 2. TypeScript in `page.evaluate()`
Used `as` type assertions, `const` arrow functions with TS syntax inside `page.evaluate()`. The evaluate callback runs in a plain JS browser context — no TypeScript.

**Fix**: Plain JavaScript only. No `as`, no parameter types, no TS features.

### 3. `require('fs')` in browser context
Used `require('fs')` inside `page.evaluate()` which doesn't exist in the browser.

**Fix**: File I/O must happen in the Node.js context (the browser tool's run code), not inside evaluate.

### 4. Module syntax (`import`) in evaluate
Tried to use `import` statements inside evaluate. Same issue — it's browser context.

**Fix**: All the tool's Node.js-side imports are pre-loaded. Browser-side code uses global APIs only.

### 5. Using `window` directly in browser tool's run code
Referenced `window` in the tool's run code (outside evaluate). `window` only exists inside the page's JS context.

**Fix**: Page property access goes through `page.evaluate()`. The run context is Node.js on the tool side.

## Investigation Approach Failures

### 6. Rolling scroll instead of element-targeted scroll
Used `window.scrollBy(0, window.innerHeight * 0.9)` which doesn't trigger lazy loading reliably.

**Fix**: Find actual image elements and call `img.scrollIntoView()` on each one. Then wait for `img.complete`.

### 7. Not waiting for lazy images
Scrolled before images loaded, then checked DOM and got wrong counts.

**Fix**: After each scroll, wait for the specific image to load (`onload` or `complete` check) before proceeding.

### 8. Checked DOM state before async settled
Read `document.querySelectorAll('.hs-chapter').length` before the userscript had time to render. Got `0` or wrong count.

**Fix**: Always `await new Promise(r => setTimeout(r, N))` after navigation/click before reading state.

### 9. Assumed SPA click worked without verifying URL
Clicked a link with `href*="chapter-25"` when the page only had `chapter-24`. The click silently did nothing, URL never changed, but I continued assuming we were on the next page.

**Fix**: Always check `page.url()` after navigation/clicks before proceeding.

### 10. Listener lost after full page navigation
Set up `page.on('request')` listener on page A, then did a full navigation (not SPA). The listener was on the destroyed page context and stopped working.

**Fix**: Listeners must be set up after the new page loads, or use persistent listeners that survive navigation.

### 11. Over-relying on `scrollHeight` for content detection
Checked `document.body.scrollHeight` to determine if content loaded. With lazy images, height changes as images load, so the initial height misled the scroll logic.

**Fix**: Track actual image element count and `complete` status, not scroll height.

### 12. Didn't verify Next.js router state
Never checked `window.__NEXT_DATA__` or the RSC payload for embedded tracking data. The server might track during SSR in ways invisible to client-side network capture.

**Fix**: Check both client and server rendering paths. Inspect `__NEXT_DATA__`, RSC payloads, and initial HTML for server-side operations.

### 13. Focused on client-side HTTP only
Assumed the tracking was purely a client-side fetch. The Next.js server might handle tracking server-to-server during SSR, invisible to browser DevTools.

**Fix**: When client-side analysis is inconclusive, consider server-side rendering paths.

### 14. Same-site cookie confusion
Lua's API (`api.luacomic.org`) is same-site to the page (`luacomic.org`). Cookies with `SameSite=Lax` should be sent. But `cf_clearance` had `partitionKey`, meaning CHIPS partitioning applied. Didn't account for this properly.

**Fix**: Check for partitioned cookies and understand their scope before debugging auth issues.

## What Worked / Best Practices

### A. Page context for authenticated API calls
`page.evaluate(async () => fetch(url, { credentials: 'include' }))` runs in the browser's authenticated context with all cookies and Cloudflare clearance. This is the only reliable way to test authenticated APIs.

### B. Cookie introspection
`page.cookies()` shows all cookies including HttpOnly ones. This revealed `ts-session`, `cf_clearance`, and `t2nyozvhs80egf9h9z4gfrun` — essential for understanding auth.

### C. Storage inspection
Checking `localStorage` found asura's `access_token` — the key insight that made asura tracking work. Always check all three storage layers: cookies, localStorage, sessionStorage.

### D. Request/response interception
`page.on('request')` and `page.on('response')` capture live traffic. Capture both request body AND response status/headers. Compare SPA vs manual calls side-by-side.

### E. Network timing traces
Dump full traces to `/tmp/` with timestamps. This allows comparing request ordering, timing, and cookie evolution between test runs.

### F. Native page load vs SPA comparison
The direct comparison between `page.goto()` (full load) and `element.click()` (SPA) revealed the tracking behavior difference immediately. Always test both modes.

### G. Bisect by eliminating variables
When SPA works but manual fetch doesn't, start from the SPA and change ONE thing at a time:
1. First, replay the SPA's exact request (headers, body, timing)
2. Then change one variable (referer, body content, timing)
3. Test each variation independently

### H. User-as-verifier collaboration
The user can see visual UI state that I can't reliably read from the DOM. Use them as the ground truth for whether an action succeeded. This saved endless debugging of visual indicators.

### I. Check `fetch` is native
`fetch.toString().includes('native code')` reveals if the framework wraps fetch. Lua's fetch was native — meaning no hidden auth injection by Next.js. Asura might be different.

### J. Check for service workers
`navigator.serviceWorker.getRegistrations()` reveals if requests go through a SW that adds auth. None found here, but critical to check for other sites.

### K. Regex path extraction from page source
Searching the raw HTML for `API_Response`, `__NEXT_DATA__`, and `self.__next_f` reveals server-embedded data that isn't visible in network capture. This showed the chapter data was pre-fetched during SSR.

### L. Image-by-image scroll with load confirmation
The only reliable scroll technique:
```js
for each image:
  img.scrollIntoView({ block: 'start' })
  await img.onload || img.complete
```
This guarantees lazy-loaded content is actually rendered before proceeding.

## Standard Investigation Checklist

For any new site/tracking investigation:

1. **Storage** — Check localStorage, cookies, sessionStorage for tokens
2. **Network** — Capture ALL API requests during native page load
3. **Identify** — Which endpoint is the tracking call?
4. **Shape** — What body/headers does it send?
5. **Auth** — Token? Cookie? Both?
6. **Test** — Replicate the call from `page.evaluate`
7. **Verify** — User checks visual result
8. **Compare** — Direct load vs SPA navigation — any difference in tracking behavior?
9. **SSR data** — Check `__NEXT_DATA__`, RSC payloads, embedded HTML data
10. **Intercept** — Monkey-patch `fetch` to capture exact args mid-flight
