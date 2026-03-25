# Logging & Observability Report

Last updated: 2026-03-25

## Current logging coverage

### Backend

**Image proxy** (`[imageProxy]`): Full stream lifecycle.
- `ok/fail {domain} ttfb={ms} stream={ms} total={ms} {bytes} inflight={n} cf={bool} ref={url}`
- `err={message}` on failure
- Covers TTFB (CDN responsiveness), body transfer (stream speed), total wall time, and stream errors
- `inflight` tracks concurrent proxy requests
- `cf` shows whether CF cookies were injected
- `ref` shows the referer sent to upstream — critical for hotlink protection debugging

**API proxy** (`[proxy]`): Request-level.
- `{method} {path} {status} {ms}`
- Covers chapter list fetches, chapter page scrapes, search queries

**Cloudflare** (`[cloudflare]`): Solve lifecycle.
- Starting solve, cleared stale cookies, browser UA, solved/failed
- Prewarm status transitions (`[prewarm] comix.to OK/BLOCKED`)

**Fetch errors** (`[proxyFetch]`): On timeout or fetch failure.
- `timeout/fetch-error {method} {url} {ms} ua={ua} referer={ref} cf={bool}`

### Frontend (via `[Frontend]` prefix in journalctl)

**Boot**: `boot-start`, `provider-loaded`, `restore-start/ok/fallback`, `boot-ready {ms}`

**Search**: `search-result {query, page, resultCount, hasMore, currentPage, lastPage, total}`

**Chapters**: `chapters-page {mangaId, page, items}`, `chapters-parallel`, `chapters-done {pages, failed, total}`

**Images**: `img-ok {key, fetchMs, blobMs, totalMs, sizeKB, pending}`, `img-fail {key, totalMs, error, pending}`
- `fetchMs` = time from browser fetch() to response headers (includes Safari queue + server TTFB + stream)
- `blobMs` = time to convert response to blob
- `pending` = number of images still loading
- Compare frontend `fetchMs` to backend `total` — the gap is Safari connection queue time

## How to diagnose common issues

| Symptom | What to check in logs |
|---------|----------------------|
| Images not loading | `[imageProxy] fail` — check `err`, `ref`, `cf` |
| Images loading slowly | `[imageProxy]` ttfb vs stream — CDN slow or stream stalling? |
| Rate limiting from CDN | `ref=` should be full chapter URL, not bare `https://comix.to` |
| CF blocking | `[cloudflare]` solve lifecycle + `[prewarm]` status |
| Safari bottleneck | Frontend `fetchMs` >> backend `total` = queue time. `pending` shows depth |
| Stream stalls | `ttfb` low but `stream` high (e.g. ttfb=60ms stream=9000ms) |

## Known logging gaps

1. **Request cancellations**: aborted image fetches are silently skipped. No `img-abort` log — can't see wasted work when user navigates away mid-load.

2. **Cache hits**: browser HTTP cache hits (within 24h `max-age`) produce frontend `img-ok` with low `fetchMs` but no backend `[imageProxy]` line. Can't distinguish "fast cache hit" from "fast CDN."

3. **Chapter-level aggregation**: no summary log at chapter completion (total images, ok/fail count, total time, total bytes). Must grep and aggregate manually.

4. **CDN host health**: images come from different CDN hosts (wowpic1-5). If one host degrades, must grep by domain. No per-host summary.

5. **Upstream response headers**: rate limit headers, unexpected content types, redirect chains from CDN are not logged. Diagnosing upstream behavior changes requires curl testing outside the logging system.

## Architecture notes

- `proxyFetch` returns `{ response, meta }` — callers own logging. The function never logs itself except on fetch errors.
- `resolveHeaders` is a pure function — takes caller headers + domain, returns resolved headers + CF injection status. No mutation.
- Frontend logger injected via constructor (`ReaderMemoryManager(log)`) — no global state.
- All non-obvious platform/upstream constraints documented in `decisions.md`, not in code comments.
