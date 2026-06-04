---
name: manga-log-investigation
description: Reconstruct manga-reader bugs from service logs before changing code. Use for any request that says check logs, what story do logs tell, jank, jump, black screen, slow load, cache behavior, provider error, or verify after a user test.
---

# Manga Log Investigation

Use this skill before claiming what the app did. The user treats logs as the
source of truth; if logs cannot prove the story, the logging is part of the bug.

## Start With A Bounded Window

Use the managed service logs, not ad-hoc processes.

```bash
journalctl --user -u manga-reader.service -n 300 --no-pager
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until 'YYYY-MM-DD HH:MM:SS' --no-pager
```

Prefer the time of the last `npm run restart`/build or the exact user timestamp
plus a small window. If the user says "around 14:00", inspect roughly
`13:55-14:05` unless they narrow it.

Find the latest restart/build anchor:

```bash
journalctl --user -u manga-reader.service --since today --no-pager \
  | rg "Started manga-reader|Stopping manga-reader|backend running|Serving frontend"
```

When you are about to rebuild/restart and then ask the user to test, record the
anchor first:

```bash
BUILD_AT="$(date '+%Y-%m-%d %H:%M:%S')"
npm run restart
echo "$BUILD_AT"
journalctl --user -u manga-reader.service --since "$BUILD_AT" --until now --no-pager
```

Filter a window down to useful event families:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg "restore-|view-|reader-|chapter-images|progress-save|cache|provider|browserSession|decoder|frame-gap|surface"
```

Get only frontend JSON event lines if the window is too noisy:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg "\\[frontend\\]|event="
```

Save a reusable filtered excerpt:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until now --no-pager \
  | rg "reader-|restore-|view-|cache|provider|decoder|error|failed" \
  > /tmp/manga-investigation.log
```

## Tell The Story In Order

Extract a timeline, not isolated lines:

1. Restore/view events: `restore-*`, `view-push`, `view-pop`,
   `restore-root`, `foreground-work`.
2. Reader events: `reader-open`, `reader-close`, `reader-visible-page`,
   `reader-current-chapter`, `reader-rebase`, `programmatic-scroll`,
   `chapter-images-*`, `reader-image-*`.
3. Cache/provider events: `cache-hit`, `cache-miss`, `cache-refresh`,
   `observed-job-*`, `provider-*`, `browserSession`, `decoder`,
   `store-ranking`.
4. Save/progress events: `progress-save`, `reader-close`, swipe-back flush.
5. Performance events: frame gaps, commit timings, browser surface/cpu logs.

When answering, separate:

- **Observed**: direct log lines and numbers.
- **Inference**: what likely caused them.
- **Logging gap**: what the logs do not prove.

## Rare Bug Capture

For hard-to-reproduce bugs, save the relevant log window immediately:

```bash
journalctl --user -u manga-reader.service --since 'YYYY-MM-DD HH:MM:SS' --until 'YYYY-MM-DD HH:MM:SS' --no-pager > /tmp/manga-<short-bug-name>.log
```

Do this before restarting if the user says the phone is still showing the bad
state.

Also capture service/process state before touching anything:

```bash
npm run status
systemctl --user show manga-reader.service -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp
ps -o pid,ppid,pcpu,pmem,etime,cmd --forest -p "$(systemctl --user show -p MainPID --value manga-reader.service)"
```

If CPU/process runaway is suspected, add browser process context:

```bash
pgrep -af "chrome|chromium|cloakbrowser|manga-reader"
ps -eo pid,ppid,pcpu,pmem,etime,cmd --sort=-pcpu | head -40
```

## Anti-Patterns

- Do not diagnose from memory when logs exist.
- Do not search unbounded logs unless there is no anchor.
- Do not confuse aggregate counters with a specific user flow.
- Do not treat missing evidence as proof that nothing happened.
- Do not "fix" before proving which owner wrote the bad state.

## Success Pattern From History

Accepted fixes repeatedly followed this loop:

1. Read bounded logs.
2. Identify the exact writer/state transition.
3. Add focused logs only where the story was incomplete.
4. Let the user reproduce once.
5. Fix the owner, rebuild/restart, check logs again.
