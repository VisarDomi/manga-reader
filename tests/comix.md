# Comix Provider

Tests assert business rules. If a test fails, the code is wrong — not the test.
The only exception is when a business rule changes.

---

## Provider-Level Tests (packages/extensions — comix)

### Search Page Size

**T-C1-1: Search limit is 100**
Tests comix rule 1.
The search request uses `limit=100`.

```contract
method: MangaProvider.searchRequest(query, page, filters)
assert: returned HttpRequest.url contains 'limit=100'
```

**T-C1-2: Chapter list limit is 100**
Tests comix rule 1.
The chapter list request uses `limit=100`.

```contract
method: MangaProvider.chapterListRequest(mangaId, page)
assert: returned HttpRequest.url contains 'limit=100'
```

### hasMore Computation

**T-C2-1: hasMore = current_page < last_page**
Tests comix rule 2.
Given a pagination object with `current_page` and `last_page`, `hasMore` is `current_page < last_page`.

```contract
upstream response shape: { pagination: { current_page: number, last_page: number, total: number } }
function: computeHasMore(pagination: { current_page: number, last_page: number }) → boolean
case 1: input: { current_page: 1, last_page: 3 } → assert: returns true
case 2: input: { current_page: 3, last_page: 3 } → assert: returns false
```

### Sort Order

**T-C3-1: No keyword — sort by chapter_updated_at desc**
Tests comix rule 3.
When query is empty or only filters are applied, the request includes sort by `chapter_updated_at` descending.

```contract
method: MangaProvider.searchRequest('', page, filters)
assert: returned HttpRequest.url contains sort param for chapter_updated_at descending
```

**T-C3-2: With keyword — no explicit sort**
Tests comix rule 3.
When the user types a keyword, no sort parameter is sent (API default relevance ranking).

```contract
method: MangaProvider.searchRequest('one piece', page, filters)
assert: returned HttpRequest.url does NOT contain a sort param
```

### NSFW Genres

**T-C4-1: Exactly 5 NSFW genres**
Tests comix rule 4.
The provider's filter definition marks exactly these 5 genres as NSFW: Adult, Ecchi, Hentai, Mature, Smut.

```contract
method: MangaProvider.getFilters() → FilterDefinition
assert: exactly 5 genres have nsfw === true
assert: nsfw genre names are 'Adult', 'Ecchi', 'Hentai', 'Mature', 'Smut'
```

**T-C4-2: NSFW flag is on genre options**
Tests comix rule 4.
Each of the 5 NSFW genres has `nsfw: true` in the FilterDefinition returned by the provider's filter definition.

```contract
method: MangaProvider.getFilters() → FilterDefinition
assert: each of the 5 NSFW genres is a FilterOption with nsfw: true
```

### Adaptive Chapter Pagination

**T-C5-1: Page 1 fetched first and yielded immediately**
Tests comix rule 5.
The first request is page 1 with `limit=100, order[number]=desc`. Its results are yielded immediately before remaining pages are fetched.

**T-C5-2: Remaining pages fetched in parallel**
Tests comix rule 5.
After page 1 returns, the provider reads `last_page` and fetches all remaining pages in parallel, yielding each as it arrives.

**T-C5-3: No artificial cap on pages**
Tests comix rule 5.
A manga with 800 chapters produces 8 requests. A manga with 9 chapters produces 1.

**T-C5-4: Cloudflare during chapter fetch — yield partial, wait, retry**
Tests comix rule 5 + 6.
If a parallel request hits Cloudflare: yield results from succeeded requests, trigger solving, wait for "solved" SSE, retry failed requests with cached cookies.

### Cloudflare Strategy

**T-C6-1: SSE connection to solving-status endpoint**
Tests comix rule 6.
On Cloudflare block, the client opens an SSE connection to the solving-status endpoint and waits.

**T-C6-2: "solved" event triggers retry**
Tests comix rule 6.
On receiving "solved", the client closes SSE and retries the original request.

**T-C6-3: "failed" event propagates error**
Tests comix rule 6.
On receiving "failed", the SSE closes and the error propagates to the caller.

**T-C6-4: No polling, no fixed intervals**
Tests comix rule 6.
The client uses SSE push notifications — no polling, no arbitrary retry counts.

### Chapter Image Extraction

**T-C7-1: Extracts images from escaped format**
Tests comix rule 7.
Given HTML with `\"images\":[{\"url\":\"https:\/\/cdn.com\/page1.jpg\"}]`, the parser extracts the image list correctly.

```contract
method: MangaProvider.parseChapterImagesResponse(html: string) → ChapterPage[]
input: html containing \"images\":[{\"url\":\"https:\/\/cdn.com\/page1.jpg\",\"width\":800,\"height\":1200}]
assert: returns [{ url: 'https://cdn.com/page1.jpg', width: 800, height: 1200 }]
```

**T-C7-2: Extracts images from unescaped format**
Tests comix rule 7.
Given HTML with `"images":[{"url":"https://cdn.com/page1.jpg"}]`, the parser extracts the image list correctly.

```contract
method: MangaProvider.parseChapterImagesResponse(html: string) → ChapterPage[]
input: html containing "images":[{"url":"https://cdn.com/page1.jpg","width":800,"height":1200}]
assert: returns [{ url: 'https://cdn.com/page1.jpg', width: 800, height: 1200 }]
```

**T-C7-3: Tries escaped first, falls back to unescaped**
Tests comix rule 7.
The parser attempts the escaped pattern first. If no match, it tries unescaped. If neither matches, it throws.

```contract
method: MangaProvider.parseChapterImagesResponse(html: string) → ChapterPage[]
case 1: html with escaped format    → assert: extracts successfully
case 2: html with unescaped format  → assert: extracts successfully (fallback)
case 3: html with neither format    → assert: throws error
```

**T-C7-4: Validates extracted data**
Tests comix rule 7.
After extraction and unescaping, the result is validated as valid data.

```contract
method: MangaProvider.parseChapterImagesResponse(html: string) → ChapterPage[]
input: html with images pattern but invalid JSON inside it
assert: throws (JSON.parse validation catches malformed data)
```

### Image Referer Header

**T-C8-1: Provider declares Referer: https://comix.to**
Tests comix rule 8.
The provider's declared image headers return `{ Referer: 'https://comix.to' }`.

```contract
method: MangaProvider.imageHeaders() → Record<string, string>
assert: returns { Referer: 'https://comix.to' }
```

### Manga ID

**T-C9-1: Uses hash_id as primary ID**
Tests comix rule 9.
Given a manga with `hash_id: "okdv"`, the provider uses `"okdv"` as the manga ID.

```contract
upstream manga shape: { hash_id?: string, slug: string, ... }
method: MangaProvider.parseSearchResponse(data) → PagedResult<Manga>
input: manga with hash_id: 'okdv', slug: 'one-piece'
assert: returned Manga.id === 'okdv'
```

**T-C9-2: Falls back to slug if hash_id missing**
Tests comix rule 9.
Given a manga without `hash_id` but with `slug: "one-piece"`, the provider uses `"one-piece"` as the manga ID.

```contract
upstream manga shape: { hash_id?: string, slug: string, ... }
method: MangaProvider.parseSearchResponse(data) → PagedResult<Manga>
input: manga with no hash_id, slug: 'one-piece'
assert: returned Manga.id === 'one-piece'
```

---

## Spec Gaps

None. All gaps resolved.
