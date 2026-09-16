# Asura cover resume and the three-chapter download window

September 16, 2026. This supersedes the authenticated-account additions in the
third fidelity pass and the previous current-plus-next-only download policy.

## Reproduced cause

The installed Asura app stored Magic Tower chapter 61 with slug
`the-magic-towers-problem-child-53fc8424` and chapter 62 with
`the-magic-towers-problem-child-6f7fe6eb`. Both API routes return HTTP 200 and
25 images. A read-only native bridge probe opened cached 61 through the current
catalog slug, then requested cached 62 as Next. It returned the two different
slugs; the reader's exact route check rejected Next. Directly opening chapter
62 worked because it did not traverse the stale chapter-61 manifest.

The userscript fetches each chapter using its current route. Native download
keys already remove Asura's rotating suffix, but the stored manifest's slug
was returned unchanged. Cache identity and navigation identity had been mixed.

Native manifest reads now retain stable downloaded files but return the route
requested by each caller, including memory, disk and shared in-flight reads.
The Next check remains: genuinely mismatched chapters must still be rejected.
No reading history reset or wholesale image redownload is needed.

## Updated requirements

- Download previous, current/last-read/partial, and next chapters per manga.
  Neighbours follow provider chapter-list order, not numeric arithmetic. At an
  end of the list there are fewer neighbours; a locked next chapter is not skipped.
- Home prepares these windows for all started manga. While reading, chapter
  transitions update just that manga's window without waiting for Home.
- Delete obsolete chapter images and manifests, retaining history, progress,
  catalog/list metadata and other manga's downloads. Active file readers finish
  before their files are deleted. Obsolete preparation stops when the current
  chapter changes; the latest requested window wins. Backgrounding pauses new
  batches and foregrounding resumes preparation.
- Uncached visible pages remain on-demand. `asura://app/page/...` serves native
  downloaded files; this is a local WebView route, not a remote cache service.
- Remove server read history, chapter/view tracking, authentication refresh,
  provider tracking callbacks and cookie forwarding in userscript/extension and
  native app. Progress is local, with the existing explicit PC Load/Save only.
  Legacy token fields remain inert solely for existing state/backup compatibility.
- Set shared reader top and bottom padding to `50svh`. The old `100svh` bottom
  came from userscript commit `08cfb65` and had been copied faithfully into the
  native stylesheet. This correction therefore applies to both surfaces.

## Comparison pass

Reviewed Home cover destinations, local chapter styling, catalog row updates,
Back restoration, reader title/current-page tracking, continuation/error paths,
image retry and load geometry, checkpoint persistence, native file routing,
provider identity/order, PC replacement and lifecycle download scheduling.

The shared history resolver now takes only local progress. The userscript still
opens a completed chapter at its saved last image; native cover resume retains
its agreed fractional position. First chapter, native cold-screen restoration,
bounded visible image sources and the explicitly requested download window
remain app adaptations. Provider fetching stays in each adapter; UI/storage and
window scheduling remain one shared implementation for all six builds.

## Verification

- Captured the installed build's exact Magic Tower cache mismatch without
  changing reading progress.
- Shared unit, TypeScript and installed extension fixtures cover all providers.
- Native browser fixtures cover Home/Back, cover resume, row identity, reader
  continuation, local-only progress, manual PC controls and equal half-screen padding.
- Swift regressions cover rotating slugs through memory/disk/offline/shared
  requests, and Home/reader window movement, end chapters, rapid jumps,
  background/foreground, preserving other manga and retaining history.

The same physical Asura bridge probe passes after the build-5 update: both
chapter manifests now return `the-magic-towers-problem-child-6f7fe6eb`, so the
existing Next check accepts chapter 62. Both still contain the cached 25 pages.
Final provider delivery and renewal outcomes are recorded in
[the verification receipt](asura-resume-download-window-verification.json).

All six provider apps were installed at build 5 with their existing identities
and data retained, then each monthly renewal check passed. The user manually
accepted the Asura fix. The standard scheduler is active (last exit 0); the
temporary build job, phone probe and private diagnostic state copies were removed.
Userscript 287 and the extension were rebuilt, and the extension was staged in
Reader Extensions without reinstalling that host.
