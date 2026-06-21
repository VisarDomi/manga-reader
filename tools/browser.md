# browser

## Failures

- `results is not defined` when `code` returns a variable defined inside `page.evaluate()` — the outer scope doesn't have it. Capture with `const result = await page.evaluate(...)` then `return result`.
- `document is not defined` when using `document` directly in `code` body — the code runs in Node context, not browser context. Use `page.evaluate()` to access the DOM.
- `window is not defined` when using `window` directly in `code` body — same issue. Use `page.evaluate()` to access browser globals.
- `Failed to fetch` when using `fetch('file:///...')` inside `page.evaluate()` — browser security blocks file:// URLs. Read the file with the `read` tool, then inline the content as a string in `page.evaluate()`.

## Passes

- Use `page.evaluate(() => { ... })` inside the `code` body to run JS in the browser context. `page` is a puppeteer Page object available in scope.
- Return pattern: `return await page.evaluate(() => { ... })` — the evaluate result IS the return value of `code`.
- For async operations inside evaluate: `return await page.evaluate(async () => { const r = await fetch(url); return r.json(); })`.
