# New Provider Investigation: mangadot.net

## Scope

This file tracks provider-specific facts for adding `mangadotnet` beside `comix`.
Read it together with `goal.md` after context compaction.

## Current Status

Mangadot is accessible to the backend browser only after a human-solved
Cloudflare clearance is present in the browser profile. Once the same profile is
reused under Xvfb, search, manga detail, chapter list, and reader image APIs are
available.

Implementation status:

- Provider registry/coordinator exists and owns `comix` and `mangadotnet`
  runtime/cache/comment/byte-cache instances.
- Mangadot uses a provider-scoped SQLite cache and provider-scoped byte cache.
- Mangadot search, manga detail, chapter list, and chapter image metadata run
  through the Mangadot runtime owner, not raw backend fetch.
- Mangadot direct images bypass Comix store-candidate and image-store
  observation policy.
- Identical runtime API calls are coalesced by `BrowserSession`; this was added
  after duplicate Mangadot search probes produced competing runtime requests.
- Current limitation: Mangadot comments and recommendations need more endpoint
  investigation before claiming parity.

## Observed Facts

- Direct backend `fetch('https://mangadot.net/search?keyword=solo')` returns:
  - HTTP `403`
  - server `cloudflare`
  - HTML challenge page titled `Just a moment...`
- Xvfb cloakbrowser Playwright probe returns the same challenge page for:
  - `/`
  - `/search?keyword=solo`
- Reusing the old in-memory `solveCloudflareCookies()` helper can temporarily
  observe a `cf_clearance` cookie, but reopening a Playwright persistent
  context with that helper's profile still lands on the challenge page.
- Keeping a single live Playwright/Xvfb context open did not pass the challenge
  after roughly 90 seconds.
- Stock `/usr/bin/chromium` launched through Playwright, without cloakbrowser
  fingerprint args, also stayed on the challenge page.
- The browser console reported:
  - `Request for the Private Access Token challenge.`
  - `No available adapters.`
  - a `401` during the Cloudflare challenge flow.
- A normal visible Chromium profile manually verified by the user produced a
  durable `cf_clearance` cookie for `.mangadot.net`.
- The same manually verified profile then worked under Xvfb/Playwright:
  `/search?search=solo&page=1&sortBy=relevance` returned the real search UI and
  did not show the challenge page.

## Inferences

- Mangadot uses a stronger Cloudflare challenge than Comix.
- The current Comix cache browser strategy is insufficient for Mangadot as-is.
- Provider session acquisition is the first hard requirement.
- A manually solved, durable browser profile is viable and should be modeled as
  an explicit provider session state, not hidden in generic cache code.
- Once clearance exists, Mangadot is easier than Comix for chapters/images:
  direct JSON APIs return chapter lists and exact reader image URLs.

## Source Context

Cloudflare documentation says:

- `cf_clearance` proves the visitor passed a challenge and is tied to the
  visitor/device.
- Different challenge levels may require a new solve.
- Private Access Tokens reduce challenge friction but do not automatically skip
  all challenge pages.
- Automation frameworks such as Playwright/Selenium can be treated as automated
  traffic and blocked by challenges.

## Cloudflare Bootstrap

Use a normal visible browser profile, not Xvfb and not Playwright automation, to
bootstrap the provider session:

```bash
/usr/bin/chromium --user-data-dir=/tmp/mangadot-human-profile --new-window https://mangadot.net/
```

After the user manually passes Cloudflare, verify:

1. The profile has a `cf_clearance` cookie for `mangadot.net`.
2. A normal browser using the same profile can reload `/search?keyword=solo`
   without a challenge.
3. A backend-owned browser can reuse the exact same profile without triggering
   a challenge.

This has been verified with `/tmp/mangadot-human-profile`: Xvfb/Playwright can
reuse the human-solved profile and read real Mangadot pages.

Latest Xvfb verification, using the same profile under `xvfb-run`:

- home page loaded real UI in 2597 ms, not Cloudflare challenge HTML
- search page `/search?search=solo&page=1&sortBy=relevance` loaded in 1723 ms
- `/search.data?search=solo&page=1&sortBy=relevance`: HTTP 200 in 600 ms
- `/api/manga/118`: HTTP 200 in 87 ms, title `Solo Leveling`,
  `total_chapters=231`
- `/api/manga/118/chapters/list`: HTTP 200 in 111 ms, array count 909
- `/api/uploads/32749/images`: HTTP 200 in 84 ms, image count 12
- the Xvfb session retained `cf_clearance` for `.mangadot.net`

Long-term ownership: the Mangadot provider should expose an explicit
`needsHumanClearance`/`sessionStatus` state. The app should surface that state
instead of silently failing search/cache work.

## Xvfb Cache Browser Recipe

Mangadot cache work should run in a headed browser under Xvfb, using the
human-solved provider profile. This keeps Chromium warm in RAM/Xvfb instead of
opening a real desktop window, while preserving the Cloudflare clearance that
was acquired manually.

The verified sequence is:

1. Bootstrap Cloudflare once in a visible browser:

   ```bash
   /usr/bin/chromium --user-data-dir=/tmp/mangadot-human-profile --new-window https://mangadot.net/
   ```

2. Close the visible browser so the profile lock is released.

3. Reuse the same profile from an Xvfb-owned browser session:

   ```bash
   cd /home/visar/Documents/work/manga/manga-reader/packages/server
   NODE_PATH=/home/visar/Documents/work/manga/manga-reader/node_modules:/home/visar/Documents/work/manga/manga-reader/packages/server/node_modules \
     xvfb-run -a node /tmp/mangadot-xvfb-check.cjs
   ```

4. The Xvfb session should confirm a retained `cf_clearance` cookie and return
   real Mangadot API responses, not `Just a moment...` Cloudflare HTML.

The proof script used the same primitive the cache service should own: launch a
persistent Chromium context with `userDataDir=/tmp/mangadot-human-profile`,
open a Mangadot page, and then issue page-side `fetch(..., { credentials:
'include' })` calls. The important part is that requests are made from inside
the solved browser context, not from raw backend `fetch`.

Minimal verification calls:

- `GET /search.data?search=solo&page=1&sortBy=relevance`
- `GET /api/manga/118`
- `GET /api/manga/118/chapters/list`
- `GET /api/uploads/32749/images`

Cache architecture implication:

- The Mangadot provider owns this browser/session policy.
- Generic cache code should ask the provider for normalized data.
- Generic cache code should not know about `cf_clearance`, Xvfb, or profile
  paths beyond requesting a provider runtime client.
- If the Xvfb browser returns challenge HTML or lacks `cf_clearance`, the
  provider should surface `needsHumanClearance` instead of retry-looping cache
  work.

## Search

Observed search UI flow:

- Search route:
  `/search?search=solo&page=1&sortBy=relevance`
- Search data route:
  `/search.data?search=solo&page=1&sortBy=relevance`
- Wrong query parameter:
  `/search?keyword=solo` loads the search page but does not run the query.
- Search results contain numeric manga IDs:
  `/manga/118`, `/manga/1249`, etc.
- Result card fields observed in the React Router data stream:
  - `id`
  - `title`
  - `genres`
  - `status`
  - `country_of_origin`
  - `description`
  - `photo`
  - `date_added`
  - `chapter_count`
  - `avg_rating`
  - `rating_count`
  - `authors`
  - `artists`
- Covers are direct URLs under `/uploads/*.webp` or `/uploads/*.jpg`.

## Manga Details

Observed route:

- `/manga/118`

Observed fields from the page/API:

- title, status, rating, genres, description
- `CHAPTERS`, `UPDATED`, `ORIGIN`, `AUTHOR`, `ARTIST`
- related series
- "YOU MAY ALSO LIKE" recommendations
- manga comments rendered at the bottom of the page

Observed detail APIs:

- `/api/manga/118/chapters/filter-options`
  - returns `{ languages: string[], groups: { id, name }[] }`
- `/api/manga/118/chapters/list`
  - returns a single JSON array of chapter rows
- `/api/manga/118/volumes`
  - returns volume rows; useful later, not needed for chapter mode.

Chapter rows include:

- `id`
- `chapter_number`
- `volume_number`
- `chapter_title`
- `language`
- `group_id`
- `group_name`
- `date_added`
- `page_count`
- `source`
- `scanlator_name`
- `comment_count`
- `groups`

The site has language filtering, but initial app behavior should keep all
languages visible by default.

## Reader Images

Observed chapter route:

- `/chapter/32749?source=user`

Observed image metadata API:

- `/api/uploads/32749/images`

Response shape:

- `chapter`: chapter metadata including `manga_id`, `chapter_number`,
  `chapter_title`, `language`, `page_count`, and `date_added`.
- `manga`: manga id, title, photo, origin.
- `images`: array of `{ url, w, h, filename }`.
- `prev_chapter_id`, `next_chapter_id`, `prev_source`, `next_source`.

Observed image URLs:

- `/chapters/manga_118/chapter_0_g0/001.webp`
- `/chapters/manga_118/chapter_0_g0/002.webp`

Observed behavior:

- Images are direct Mangadot-hosted WebP files.
- No store fanout observed.
- No scrambling observed.
- `/api/token/generate?chapter_id=32749&type=upload` returns empty strings for
  this tested user-upload chapter, so token signing does not appear required for
  the basic image path.

## Comments

Observed:

- Manga comments render on `/manga/118`.
- Chapter comment count API:
  `/api/comments/chapter/32749/count?source=user`
  returned `{ success: true, count: 0 }`.
- Guessed list APIs returned 404:
  - `/api/comments/manga/118?sort=new&page=1`
  - `/api/comments/chapter/32749?source=user&sort=new&page=1`

Comments need more targeted investigation from the loaded page's actual network
or source bundle. Do not guess routes.

## Provider Fields Still To Investigate

Remaining unknowns:

- Exact normalized recommendation data shape.
- Exact manga/chapter comments list APIs.
- Whether logged-in Mangadot state is worth using for favorites/bookmarks.
- Whether any chapter source other than `source=user` requires non-empty token
  signing.

## Ownership Direction

- `mangadotnet` must own its Cloudflare/session acquisition policy.
- The generic cache should not know about Cloudflare details.
- The provider registry should expose provider capabilities and normalized data.
- The app should not receive provider-specific browser/session details.
- Reader must consume Mangadot pages as direct normalized URLs with dimensions;
  Comix store selection and scrambled-page decoding must stay Comix-specific.
