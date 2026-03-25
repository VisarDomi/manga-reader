# Technical Decisions

Non-obvious constraints from upstream services, platforms, and protocols that drive implementation choices. These are things you can't derive from reading the code alone.

## D1. Cloudflare Binds cf_clearance to User-Agent

Cloudflare's cf_clearance cookie is bound to the User-Agent string used during the challenge solve. Subsequent requests must send the exact same UA or the cookie is rejected. This means the proxy must track which UA the headless browser used during solving and replay it on every CF-protected request.

## D2. CDN Hotlink Protection Uses Referer

The image CDN (wowpic*.store) rate-limits requests that send a bare origin (`https://comix.to`) as Referer. Requests with the full chapter page URL (`https://comix.to/title/{mangaId}/{chapterId}-chapter-{number}`) are not rate-limited. The CDN starts throttling after ~7 requests with a bare referer — TTFB degrades from 100ms to 5s+, then streams timeout. Discovered 2026-03-25.

## D3. iOS PWA Freezes JS Without Firing visibilitychange

When iOS backgrounds a PWA, it freezes the JS event loop entirely. On resume, `visibilitychange` often doesn't fire. The workaround is a 1-second setInterval sentinel that detects clock drift — if 3+ seconds passed since the last tick, JS was frozen. Both mechanisms (visibilitychange and sentinel) trigger the same recovery path.

## D4. iOS WebKit Touch Handler Desync After Resume

After an iOS PWA warm resume, WebKit's internal touch event handler can desync from the scroll container. Toggling `overflow: hidden` then back forces WebKit to recreate the handler. Without this, scroll containers appear frozen after resume despite the DOM being intact.

## D5. Shared IntersectionObserver for Reader Pages

Creating one IntersectionObserver per page element degrades performance with 100+ elements. A single shared observer instance is reused for all elements in a reader session, recreated only when the root element changes.

## D6. comix.to Embeds Chapter Images in Two HTML Formats

comix.to embeds chapter image data in `<script>` tags in two formats that vary between renders: escaped (`\"images\":[...]` inside JSON strings) and unescaped (`"images":[...]` in inline script blocks). The parser tries both patterns.

## D7. Cloudflare Cookie Domain Inheritance

Cloudflare sets cf_clearance on the parent domain (`.comix.to`), covering all subdomains. The cookie cache looks up by exact domain first, then tries the parent — so a request to `static.comix.to` finds cookies cached under `comix.to`.

## D8. Provider Bundles Served No-Cache

Provider JS bundles are served with `Cache-Control: no-cache` so updates take effect immediately without cache busting. Frontend immutable assets (content-hashed by Vite) are cached forever.

## D9. HTTPS Required for iOS PWA

iOS Safari requires HTTPS for PWA installation (Add to Home Screen). The server uses mkcert certificates. The manga-reader and gallery-reader backends crash without certs (no HTTP fallback).

## D10. Server Runs Under xvfb-run

The manga-reader systemd service is wrapped in `xvfb-run` because Playwright/CloakBrowser needs a display for Cloudflare solving. Never kill the process directly or restart with nohup — always use `systemctl --user restart manga-reader`.
