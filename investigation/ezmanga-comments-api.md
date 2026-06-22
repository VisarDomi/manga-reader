# EzManga vAPI Investigation

## Problem Statement

Need to fetch chapter data, comments, and handle edge cases (404 chapters, paid chapters) for the manga reader userscript. All data comes from the ezmanga vAPI, not DOM scraping.

## API Base

`https://vapi.ezmanga.org/api/v1`

Requires `Referer: https://ezmanga.org/` (curl returns 403 without it; browser `fetch()` on ezmanga.org pages works fine).

---

## Chapter Endpoint

```
GET /api/v1/series/{slug}/chapters/chapter-{number}
```

### Free chapter (chapter-2)

```json
{
  "id": 29018,
  "slug": "chapter-2",
  "number": 2,
  "title": null,
  "content": null,
  "cover": "https://media.ezmanga.org/...",
  "publishStatus": "PUBLIC",
  "price": 0,
  "isFree": true,
  "requiresPurchase": false,
  "series": {
    "title": "Looking for the Villainess's Contract Husband"
  },
  "images": [
    {
      "url": "https://media.ezmanga.org/.../00.webp",
      "order": 0,
      "width": 800,
      "height": 8975
    }
    // ... 20 images total for chapter-2
  ]
}
```

Key fields: `id` (needed for comments fetch), `images[].url/width/height`, `series.title`, `isFree`, `requiresPurchase`.

### Paid chapter (chapter-20, id 29037)

```json
{
  "id": 29037,
  "isFree": false,
  "requiresPurchase": true,
  "price": 100,
  "images": []
}
```

**Critical:** Paid chapters return HTTP 200 but have `images: []` (empty array). The redirect check must be: `requiresPurchase || !isFree` — either flag means the user can't read it.

### Non-existent chapter (chapter-999)

Returns HTTP 404. No JSON body. The redirect check must catch the fetch error.

### Redirect decision table

| Condition | HTTP status | Response | Action |
|---|---|---|---|
| Free chapter | 200 | `isFree: true, requiresPurchase: false, images: [...]` | Render |
| Paid chapter | 200 | `isFree: false \|\| requiresPurchase: true, images: []` | Redirect to series |
| Missing chapter | 404 | — | Redirect to series |

---

## Comments Endpoint

```
GET /api/v1/chapters/{chapterId}/comments
```

Returns top-level comments only (parentId: null). Replies are NOT inlined.

### Response shape (200)

```json
{
  "data": [
    {
      "id": 9903,
      "content": "<p>Yess, a strong mama, but wtf was that on the last panel </p>",
      "status": "APPROVED",
      "isEdited": false,
      "upvotes": 3,
      "downvotes": 0,
      "score": 3,
      "parentId": null,
      "replyCount": 1,
      "author": {
        "id": "5yas6PUKAMHtwDn6w0OTFL8xA31g0e52",
        "username": "@DicInsOn",
        "displayName": "vibsDipz ",
        "avatar": "https://lh3.googleusercontent.com/a/ACg8ocITrU8MSj2RqzlHM7UNONmUzDH2JVLDXcsS0rm2TwOdvn9Obezq=s96-c"
      },
      "userVote": null,
      "deletedAt": null,
      "createdAt": "2026-06-16T18:30:47.142Z",
      "updatedAt": "2026-06-21T16:05:15.211Z"
    }
  ],
  "totalItems": 1,
  "totalPages": 1,
  "current": 1,
  "next": null
}
```

---

## Replies Endpoint

```
GET /api/v1/comments/{commentId}/replies
```

Returns direct replies to a comment. Same shape as the main comments response. One level deep — replies to replies would need another fetch, but `replyCount` on replies is typically 0.

### Example (reply to comment 9903)

```json
{
  "data": [
    {
      "id": 9932,
      "content": "<p></p><p>A bad bad plot 😭( I forgot the thing not bad plot it's that scumbag going to kidnap her!!)</p>",
      "status": "APPROVED",
      "isEdited": true,
      "upvotes": 2,
      "downvotes": 0,
      "parentId": 9903,
      "replyCount": 0,
      "author": {
        "displayName": "Edgar Maturan",
        "avatar": "https://lh3.googleusercontent.com/a/ACg8ocI-6panyralsh2l99ACg8wniaKt7elx6LNdTtyNWo0IonPH2w=s96-c"
      },
      "createdAt": "2026-06-17T07:09:27.978Z"
    }
  ],
  "totalItems": 1,
  "totalPages": 1,
  "current": 1,
  "next": null
}
```

---

## Edge Cases Verified

| Scenario | Chapter endpoint | Comments endpoint |
|---|---|---|
| Chapter 1 (id 29017) | 200, free, 20 images | 200, 3 comments |
| Chapter 2 (id 29018) | 200, free, 20 images | 200, 1 comment, replyCount: 1 |
| Chapter 3 (id 29019) | 200, free | 200, 2 comments |
| Chapter 20 (id 29037) | 200, paid, images: [] | Not tested |
| Chapter 999 | 404 | Not reached — chapter fetch fails first |
| Chapter with 0 comments | [unobserved] | Presumed: `data: [], totalItems: 0` |

All tested chapters had `totalPages: 1` — no pagination observed.

---

## Series Chapters Listing

```
GET /api/v1/series/{slug}/chapters
```

Returns all chapters with metadata (no images). Useful for finding the last free chapter, but not needed for the reader route — just fetch the specific chapter number.

```json
{
  "data": [
    {
      "id": 29037,
      "slug": "chapter-20",
      "number": 20,
      "price": 100,
      "isFree": false,
      "requiresPurchase": true,
      "commentCount": 0
    },
    {
      "id": 29018,
      "slug": "chapter-2",
      "number": 2,
      "price": 0,
      "isFree": true,
      "requiresPurchase": false
    }
  ]
}
```

---

## Design Decisions

### Redirect on fetch failure OR paid chapter

Two conditions trigger redirect to series page:
1. `fetch()` throws (non-2xx, e.g. 404) → catch block → `window.location.href = seriesUrl(slug)`
2. Response has `requiresPurchase || !isFree` → redirect

Both cases redirect — no partial rendering, no error message.

### Top-level comments only, no reply fetching

Reply fetching requires one additional API call per comment with `replyCount > 0` — adds complexity and latency. Initial implementation renders only the comments from the chapter comments endpoint. The heading shows `totalItems` count.

### Content is HTML

`comment.content` contains HTML (e.g. `<p>text</p>`). Render via `innerHTML`. If the API ever returns plain text, switch to `textContent`.

### No pagination needed

Largest chapter observed: 3 comments, `totalPages: 1`. If a chapter later has paginated comments, add `?page=N`.

### Relative timestamps in JS

`createdAt` is ISO 8601. Compute client-side with a simple helper (no library) — "just now", "5m ago", "2h ago", "3d ago", "1mo ago", "2y ago".

---

## Sources

- Browser `fetch()` calls on `https://ezmanga.org/series/looking-for-the-villainesss-contract-husband/chapter-{N}`
- Chapters tested: 1, 2, 3, 20, 999
- Timestamp: 2026-06-22
