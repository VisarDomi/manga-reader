# Manga Reader Skills

Reusable investigation workflows for weaker agents and non-native skill
harnesses. Read only the skill that matches the current task.

Each skill should contain copyable command recipes for the fragile parts of the
workflow. Do not leave a weaker agent to infer how to read logs, inspect SQLite,
run Xvfb browser proofs, search code ownership, or verify a checkpoint.

Default investigation shape:

1. Start bounded by restart/user time.
2. Aggregate first: event counts, failure clusters, queue summaries, process
   state.
3. Then read the smallest timeline that explains the specific user flow.
4. If the timeline cannot prove the story, add focused logs and ask for one
   repro instead of guessing.

- `manga-log-investigation`: service-log timelines, timestamp anchoring, rare
  bug capture.
- `manga-reader-ownership-debugging`: reader scroll jumps, black screens,
  virtual window, rebase, image warm coverage.
- `manga-cache-provider-debugging`: cache/provider boundaries, foreground
  priority, stale-cache-first behavior, store/decoder issues.
- `manga-xvfb-browser-testing`: headed Xvfb/browser-context proofs for provider
  runtime, Cloudflare, userscript, and descrambler behavior.
- `manga-restore-layer-debugging`: restart/session restore, swipe-back layer
  stack, search/favorites/providers root replay.
- `manga-decision-hygiene`: `goal.md`, `decisions.md`, reports, temporary plans,
  and checkpoint discipline.
