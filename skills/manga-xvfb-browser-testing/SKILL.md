---
name: manga-xvfb-browser-testing
description: Use headed browser/Xvfb tests for manga-reader provider behavior, cache runtime verification, userscript proofs, Cloudflare/session issues, or Comix/Mangadot API/runtime questions.
---

# Manga Xvfb Browser Testing

Use this skill when provider behavior cannot be proven with plain backend logs
or `curl`. The production cache path uses a browser context, so investigation
must often use the same class of context.

## Read First

The machine-level Xvfb procedure is in:

```text
/home/visar/Documents/memory/xvfb.md
```

Use that file for exact Xvfb/CDP and Mangadot Cloudflare bootstrap commands.

## When To Use Xvfb

- Provider runtime/signing/decryption behavior is unclear.
- Comix or Mangadot returns Cloudflare/challenge/HTML instead of JSON.
- The app uses BrowserSession/cache context but a manual test used a different
  browser or raw HTTP.
- You need to prove whether a userscript/SPA idea can call provider APIs from
  the site runtime.
- A descrambler/image issue appears only through the provider page/runtime.

## Ownership Rule

Do not let the test context become the claim.

- If production uses BrowserSession, test with BrowserSession-like context.
- If production uses a provider-cleared profile, reuse that profile under Xvfb.
- If the user asks for an inspectable normal browser, use a visible browser only
  for human Cloudflare/bootstrap, then move back to Xvfb if possible.
- Manual injected JS is discovery. Durable proof is the real app/userscript or
  cache path producing the same result through logs.

## Typical Flow

1. Read logs and code to identify the production browser owner.
2. If needed, create a small `/tmp/*.cjs` proof script using Playwright.
3. Launch headed Chromium under Xvfb with the same profile/context class.
4. Make requests from inside the page with `fetch(..., { credentials: 'include' })`.
5. Save proof output under `/tmp`.
6. Move stable conclusions into `decisions.md`; do not keep exploratory scripts
   in the repo unless they are intentionally maintained.

## Command Recipes

Open the in-memory Xvfb display for human inspection:

```bash
source ~/.bash_aliases && peek
```

Bootstrap Mangadot Cloudflare in a visible browser profile:

```bash
/usr/bin/chromium --user-data-dir=/tmp/mangadot-human-profile --new-window https://mangadot.net/
```

After the user passes the challenge, close visible Chromium and reuse the
profile under Xvfb:

```bash
cd /home/visar/Documents/work/manga/manga-reader/packages/server
NODE_PATH=/home/visar/Documents/work/manga/manga-reader/node_modules:/home/visar/Documents/work/manga/manga-reader/packages/server/node_modules \
  xvfb-run -a node /tmp/mangadot-xvfb-check.cjs
```

Minimal provider proof script template:

```bash
cat >/tmp/mangadot-xvfb-check.cjs <<'EOF'
const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext('/tmp/mangadot-human-profile', {
    executablePath: '/usr/bin/chromium',
    headless: false,
    viewport: { width: 1200, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://mangadot.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const result = await page.evaluate(async () => {
    const res = await fetch('/api/manga/166', { credentials: 'include' });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      startsWith: text.slice(0, 80),
      isCloudflare: /Just a moment|cf-|cloudflare/i.test(text),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await context.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
EOF
```

Minimal Comix runtime proof from the site page:

```bash
cat >/tmp/comix-runtime-check.cjs <<'EOF'
const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext('/tmp/comix-xvfb-profile', {
    executablePath: '/usr/bin/chromium',
    headless: false,
    viewport: { width: 1200, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://comix.to/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const result = await page.evaluate(async () => {
    const res = await fetch('/api/query?sort=uploaded&limit=20&page=1', { credentials: 'include' });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get('content-type'), startsWith: text.slice(0, 120) };
  });
  console.log(JSON.stringify(result, null, 2));
  await context.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
EOF

cd /home/visar/Documents/work/manga/manga-reader/packages/server
NODE_PATH=/home/visar/Documents/work/manga/manga-reader/node_modules:/home/visar/Documents/work/manga/manga-reader/packages/server/node_modules \
  xvfb-run -a node /tmp/comix-runtime-check.cjs
```

Capture screenshots from an Xvfb proof when visual state matters:

```js
await page.screenshot({ path: '/tmp/manga-provider-proof.png', fullPage: true });
```

## What To Prove

For provider APIs:

- Status code and content type.
- JSON vs Cloudflare/challenge HTML.
- Whether cookies/clearance are present.
- Whether response shape matches provider parser expectations.
- Whether the same call works from the provider page runtime but not from raw
  backend HTTP.

For image/descrambler issues:

- Whether the upstream site can render the same page.
- Whether all store candidates fail or only our selected candidate fails.
- Whether local decoder/browser context uses the correct chapter URL.
- Expected dimensions vs decoded dimensions.

## Anti-Patterns

- Claiming provider failure from raw `curl` when the app uses a browser session.
- Testing in a desktop browser and applying the result to Xvfb/cache without
  checking profile/cookies/Cloudflare state.
- Depending on minified bundle export names as a "fix".
- Leaving ad-hoc scripts or browser profiles as undocumented architecture.
