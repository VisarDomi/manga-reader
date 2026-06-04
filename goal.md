# Goal: Mangadot Provider Stability

Active handoff for the Mangadot integration. Read this after `decisions.md`.

## Current Evidence

Logs since the 2026-06-04 13:20:02 service restart show these user-facing
Mangadot issues:

1. Reader images leak provider-direct URLs to the frontend.
   - `chapter-images-result providerId=mangadotnet imageCount=30` proved cached
     metadata was present.
   - `reader-image-candidate ok=false host=mangadot.net status=0` showed Safari
     tried direct upstream page URLs.
   - Server logs then ignored store observations with
     `reason=direct-images`, proving those candidates bypassed the intended
     local `/api/cache/.../image` route.
   - Desired ownership: cache may store canonical direct image URLs, but render
     candidates must be server-owned local image routes for Mangadot.
   - Implemented: Mangadot frontend provider parser now preserves
     server-projected `candidates` and `criticalCandidates` instead of
     reconstructing direct upstream candidates from `url`.
   - Verified directly after rebuild: cached page metadata for
     `26855/449182` exposes local `/api/cache/.../image` render candidates, and
     the local critical image route returned `200 image/webp`.
   - Still needs phone-side verification: reader logs should no longer show
     `reader-image-candidate host=mangadot.net` for Mangadot.

2. Filtered Mangadot search is slow and old work can finish after the frontend
   has timed out or moved on.
   - Unfiltered `/api/search` returns `100` items and `total=10000`.
   - Filtered document search is provider-limited to `28` items per page.
   - Page 3 took about `23s`; page 4 hit a frontend timeout while backend work
     later completed. Investigate whether frontend search ownership needs
     request-generation logs/cancellation tightening, or whether backend
     document search needs better coalescing/cancellation.
   - Implemented first ownership tightening: search requests now carry a
     request id through frontend logs and backend search logs, and stale
     responses are ignored if a newer search/page owner took over.
   - Search uses a search-owned 45s request budget instead of the generic 12s
     JSON fetch budget, matching the observed provider document-search latency
     envelope without changing Mangadot's provider-owned 28-item filtered page
     size.

3. Mangadot reconcile jobs can report stale cache but then fetch `new=0`.
   - Examples: `26865 cachedMax=9.1 observed=13`, page fetched `13` items but
     `new=0 reachedExisting=true`.
   - Investigate chapter identity/number semantics before changing behavior.

4. Background Mangadot runtime jobs still intermittently fail with
   `AbortError: signal is aborted without reason` or `TypeError: Failed to
   fetch`.
   - Keep these as provider-runtime health evidence. Do not hide with broad
     retries unless the owning runtime state is explicit.
   - New evidence after the final restart: Mangadot browser launch was quick,
     but runtime HTTP warm took `40.3s` foreground and `42.7s` background before
     provider readiness became true. A status check before that warm finished
     can report `needsHumanClearance=true`; the real issue is slow runtime
     readiness, not necessarily a permanent clearance failure.

5. Cached Mangadot manga open can still feel slower than expected.
   - Example manga `26855`: manga detail and chapter list were cache hits, but
     `manga-open-done` was about `2926ms`.
   - Investigate only after the image-candidate leak and search ownership are
     fixed, because reader image failures and concurrent search/comment work may
     be contaminating perceived latency.

## Implementation Order

1. Phone-test Mangadot reader and verify logs no longer show direct
   `host=mangadot.net` reader candidates.
2. Investigate filtered search timeout/overlap using request-generation logs.
   The next useful test is rapid filter/page changes on Mangadot and then
   reading matching `requestId` values across frontend/backend logs.
3. Investigate why Mangadot runtime warm sometimes takes about `42s` even when
   the persistent browser profile eventually works.
4. Investigate reconcile `new=0` semantics.
5. Investigate background runtime aborts and cached manga-open latency if still
   visible after the first fixes.
