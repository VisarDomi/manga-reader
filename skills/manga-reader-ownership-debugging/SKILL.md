---
name: manga-reader-ownership-debugging
description: Debug reader scroll jumps, black screens, virtual window issues, momentum stops, wrong chapter transitions, or programmatic scroll leaks in the manga-reader PWA.
---

# Manga Reader Ownership Debugging

Use this skill when the reader jumps, flashes black, stops momentum, shows dead
space, moves to the wrong chapter, or loads images too late.

## Core Ownership Rules

- Layout/virtual geometry has one writer.
- Progress has one writer.
- Visible page/chapter is observation, not authority.
- Programmatic scroll must be named and logged.
- Guards/timers are suspect unless the user explicitly accepted the policy.
- A fix is architectural only if it changes who owns the state, not if it hides
  a symptom.

## First Checks

Read logs with `manga-log-investigation`, then inspect these code areas:

```bash
rg -n "programmatic|scrollTo|scrollBy|reader-rebase|visible|currentChapter|virtual|rebase|setTimeout|scrollend" packages/app/src/lib
rg -n "reader-image|chapter-images|cache.*foreground|store-ranking" packages/app/src/lib packages/server/src
rg -n "requestAnimationFrame|addEventListener\\('scroll|onscroll|scrollend|IntersectionObserver|ResizeObserver" packages/app/src/lib
rg -n "\\$state|\\$derived|\\$effect" packages/app/src/lib/state packages/app/src/lib/components/Reader.svelte
```

Look for:

- A visible-page observer committing layout.
- Progress saving a speculative previous/next chapter.
- Async hydration changing geometry while the user/momentum owns scroll.
- Prepend/top removal changing physical scroll space outside a safe rebase.
- Timer-based "stable" guesses standing in for a real scroll boundary.

## Reader Timeline To Reconstruct

For a reported jump/black screen, build this sequence:

1. Entry chapter and saved page/ratio.
2. `reader-open` and initial restored geometry.
3. Loaded/rendered chapter slots and their virtual positions.
4. Current visible page/chapter before the bug.
5. Any `programmatic-scroll`, `reader-rebase`, prepend/append, slot shrink/grow,
   image schedule, or progress save.
6. Current visible page/chapter after the bug.

If the logs do not expose one of these, add logs there and stop for user repro.

Useful timeline extraction command:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg "reader-open|reader-close|reader-visible|reader-current|reader-rebase|programmatic-scroll|reader-window|reader-surface|chapter-images|reader-image|progress-save|view-|restore-"
```

Count repeated ownership events:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg -o "reader-[a-z0-9-]+|programmatic-scroll|progress-save|view-[a-z]+" \
  | sort | uniq -c | sort -nr | head -40
```

Find suspicious programmatic scroll writers:

```bash
rg -n "scrollTop\\s*=|scrollTo\\(|scrollBy\\(|scrollIntoView\\(" packages/app/src/lib
```

Find timer/gate code in reader ownership:

```bash
rg -n "setTimeout|clearTimeout|stable|idle|debounce|throttle|gate|guard" packages/app/src/lib/state packages/app/src/lib/components/Reader.svelte
```

Inspect current reader implementation around a hit:

```bash
nl -ba packages/app/src/lib/state/reader.svelte.ts | sed -n '1,260p'
nl -ba packages/app/src/lib/components/Reader.svelte | sed -n '1,260p'
```

## Good Patterns From History

- Keep virtual geometry bounded so iOS/Safari does not handle huge physical
  scroll heights.
- Use native `scrollend + 100ms` for physical rebase; the 100ms wait is a user
  decision and should remain documented.
- Use reader-owned prewarm based on the rendered/virtual window, not fixed
  "previous N / next N" constants.
- Critical visible images should use the best-store policy; offscreen prewarm
  can explore.
- For restore, do not wait on image bytes to build UI shell.

## Rejected Patterns

- `reader-visible-page-ignored`-style guards that hide wrong ownership.
- Hardcoded chapter warm counts.
- Large arbitrary gates like "wait 2s" unless proven and accepted.
- IntersectionObserver owning loading when the virtualizer already knows the
  viewport.
- Per-frame `$state` writes for gestures or scroll probes.

## Verification

After a fix:

```bash
npm run build
npm run restart
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager
curl -sk https://localhost:11555/api/health
```

Ask the user to test the exact failing flow if it is iOS/PWA-specific. Do not
claim hard-to-reproduce reader bugs are fixed solely from desktop tests.
