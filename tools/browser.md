# browser

## Failures

- `results is not defined` when `code` returns a variable defined inside `page.evaluate()` — the outer scope doesn't have it. Capture with `const result = await page.evaluate(...)` then `return result`.
- `document is not defined` when using `document` directly in `code` body — the code runs in Node context, not browser context. Use `page.evaluate()` to access the DOM.
- `window is not defined` when using `window` directly in `code` body — same issue. Use `page.evaluate()` to access browser globals.
- `Failed to fetch` when using `fetch('file:///...')` inside `page.evaluate()` — browser security blocks file:// URLs. Read the file with the `read` tool, then inline the content as a string in `page.evaluate()`.
- `el.className?.includes is not a function` when iterating all `*` elements — SVG elements have `className` as `SVGAnimatedString`, not `string`. Use `el.getAttribute('class')` or `typeof el.className === 'string'` guard.
- `X is not defined` when a variable from the outer Node scope is referenced inside `page.evaluate()` — evaluate runs in browser context, not Node. Define all variables inside the callback or use a separate `page.evaluate()` to capture outer values.
- `Attempted to use detached Frame` when the tab navigated away or closed mid-evaluate. Open a fresh tab with `browser open` and retry.
- `Unexpected token '!'` inside `page.evaluate()` — TypeScript non-null assertions (`!`) are not valid JavaScript. Use optional chaining (`?.`) or explicit null checks instead.
- `Waiting failed: Xms exceeded` when `waitForFunction` times out — the condition never became true. Check if the script actually executed by evaluating a simpler check first, or increase the timeout.
- `Invalid or unexpected token` when injecting a script string via `page.evaluate(scriptString)` — the script contains characters (backticks, unescaped quotes, Unicode) that break parsing. Avoid template literals in injected scripts; use string concatenation instead.
- `Tab "X" is not alive` when the tab was closed or crashed. Same fix as detached frame: open a fresh tab with `browser open`.

## Passes

- Use `page.evaluate(() => { ... })` inside the `code` body to run JS in the browser context. `page` is a puppeteer Page object available in scope.
- Return pattern: `return await page.evaluate(() => { ... })` — the evaluate result IS the return value of `code`.
- For async operations inside evaluate: `return await page.evaluate(async () => { const r = await fetch(url); return r.json(); })`.
