use npx tsc --noEmit 2>&1 and npm run build to check your code.

investigation:

`action: "run"` in browser tool: Always include `action: "run"` because it's required even when the intent is obvious.

`page.evaluate()`:The evaluate callback runs in a plain JS browser context.

loading JS from a file: File I/O must happen in the Node.js context (the browser tool's run code), not inside evaluate.

All the tool's Node.js-side imports are pre-loaded. Browser-side code uses global APIs only.

Page property access goes through `page.evaluate()`. The run context is Node.js on the tool side.

Always `await new Promise(r => setTimeout(r, N))` after navigation/click before reading state.

Always check `page.url()` after navigation/clicks before proceeding.

Listeners must be set up after the new page loads, or use persistent listeners that survive navigation.

### A. Page context for authenticated API calls
`page.evaluate(async () => fetch(url, { credentials: 'include' }))` runs in the browser's authenticated context with all cookies and Cloudflare clearance. This is the only reliable way to test authenticated APIs.

### B. Cookie introspection
`page.cookies()` shows all cookies including HttpOnly ones. This revealed `ts-session`, `cf_clearance`, and `t2nyozvhs80egf9h9z4gfrun` — essential for understanding auth.

### C. Storage inspection
Always check all three storage layers: cookies, localStorage, sessionStorage.

### D. Request/response interception
`page.on('request')` and `page.on('response')` capture live traffic. Capture both request body AND response status/headers. Compare SPA vs manual calls side-by-side.

### E. Network timing traces
Dump full traces to `/tmp/` with timestamps. This allows comparing request ordering, timing, and cookie evolution between test runs. Analyize after dumping enough.

### I. Check `fetch` is native
`fetch.toString().includes('native code')` reveals if the framework wraps fetch. Lua's fetch was native — meaning no hidden auth injection by Next.js. Asura might be different.

### J. Check for service workers
`navigator.serviceWorker.getRegistrations()` reveals if requests go through a SW that adds auth. None found here, but critical to check for other sites.
