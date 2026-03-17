# Comix Provider — Business Decisions

These rules are specific to the comix.to provider. They define how this provider talks to the upstream API and interprets its responses.

## 1. Search Page Size Is 100

The upstream API accepts a `limit` parameter. The maximum accepted value is exactly 100 — any value above 100 returns an empty result. This applies to both the search endpoint and the chapter list endpoint (both tested: `limit=100` returns data, `limit=101` returns nothing). This reduces the number of requests (and Cloudflare encounters) compared to smaller page sizes.

## 2. hasMore Computed from Pagination Object

Both the search and chapter endpoints return a `pagination` object with `current_page`, `last_page`, and `total`. The provider computes `hasMore = current_page < last_page` — no need to infer from item count. This is exact and avoids the edge case of an extra empty request when the total is a multiple of 100.

## 3. Sort Order Depends on Whether a Keyword Is Present

When the user types a keyword, the API's default relevance ranking takes over and no explicit sort is sent — keyword search shows the best matches. When the user browses with no keyword and no filters, results are sorted by `chapter_updated_at` descending — a "latest updates" feed. When the user browses with no keyword but has active filters, only the filters are sent — no keyword and no explicit ordering — so the API decides the best ordering for filtered results.

## 4. NSFW Genres

The following 5 genres are NSFW: Adult, Ecchi, Hentai, Mature, Smut. The provider marks these as NSFW so the app can auto-exclude them when the provider is first used (see root AA) without knowing the names itself.

## 5. Chapter List Pagination Is Adaptive

The chapter API returns a `pagination` object with `total` and `last_page`. The provider fetches page 1 first (at `limit=100`, `order[number]=desc`) and yields those chapters immediately — this gives the app the newest chapters first so they render at the top of the list without scroll jumps. It then reads `last_page` and fetches remaining pages in parallel, yielding each as it arrives. No artificial cap — a manga with 800 chapters gets 8 requests, a manga with 9 chapters gets 1.

If any parallel request hits a Cloudflare block during this process, the provider follows the Cloudflare strategy in rule 6:
1. Yield results from whichever requests already succeeded
2. Trigger solving on first block, wait for server to signal "solved"
3. After solved, retry the failed requests in parallel (cookies are now cached)

## 6. Cloudflare Retry Strategy

Comix.to is behind Cloudflare. When a request receives a Cloudflare block, the server-side proxy triggers Playwright to solve the challenge. The client opens an SSE (Server-Sent Events) connection to a solving-status endpoint and waits. The server pushes one of two events: "solved" (retry now) or "failed" (give up). On "solved", the client closes the SSE connection and retries the original request — cookies are now cached so it goes through. On "failed", the SSE connection closes and the error propagates. No polling, no fixed intervals, no arbitrary retry counts — the server notifies the client the instant the challenge is resolved. Toast behavior is owned by the app layer (see root AW) — the provider does not control when toasts appear.

Only the Cloudflare solving flow uses SSE. The rest of the app's request/response architecture is unchanged.

## 7. Chapter Images Are Extracted from HTML

Comix.to has no JSON API for chapter images. The provider fetches the chapter page as HTML and extracts the image data from inline `<script>` tags. The upstream serves the data in two formats that vary between renders:

- **Escaped**: `\"images\":[{\"url\":\"https:\/\/cdn.com\/page1.jpg\"}]` — JSON embedded inside a JavaScript string, with escaped quotes and slashes.
- **Unescaped**: `"images":[{"url":"https://cdn.com/page1.jpg"}]` — plain JSON inside a JS object.

The parser tries escaped first, then falls back to unescaped. When matched, it extracts the JSON array, unescapes if needed, validates the result as valid JSON, and returns the image list. If neither pattern matches or the extracted data is malformed, it fails with an error. Both formats must be supported because the upstream varies between renders — supporting only one would cause intermittent failures.

## 8. Image Requests Require Referer Header

The CDN serving chapter images rejects requests without a `Referer: https://comix.to` header (returns 403). The provider declares this required header and the app's image proxy forwards it. Without it, every image silently fails to load — the reader shows blank pages with no error.

## 9. Manga ID Is `hash_id` with `slug` Fallback

The provider uses the manga's `hash_id` (e.g. `"okdv"`) as the primary identifier, falling back to `slug` if `hash_id` is missing. This ID is used everywhere — API requests, progress tracking, favorites. If comix.to changes their ID scheme, all stored progress and favorites become orphaned and would need migration.
