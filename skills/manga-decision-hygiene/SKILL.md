---
name: manga-decision-hygiene
description: Maintain goal.md, decisions.md, reports, todos, and checkpoints during long manga-reader sessions so compaction does not lose intent or leave stale architecture notes.
---

# Manga Decision Hygiene

Use this skill whenever work spans multiple turns, creates a report/plan/todo,
changes architecture, or reaches a user-approved checkpoint.

## File Roles

- `goal.md`: only unfinished active work. It must survive compaction.
- `decisions.md`: durable architecture/product decisions and lessons.
- `reports/`: named investigation reports worth keeping.
- `plan.md`, `todo.md`, `report.md`, `new-provider.md`: temporary by default.
  Merge useful decisions into `decisions.md`, then remove them when done.
- `AGENTS.md`: short routing/instruction pointers only, not a knowledge dump.
- `skills/`: reusable investigation workflows loaded on demand.

## During Long Work

Before coding a multi-step task:

1. Write/update `goal.md`.
2. Include the source request, constraints, and checklist.
3. Mark items complete as they finish.
4. If the user changes direction, update `goal.md` immediately.

Command template:

```bash
cat > goal.md <<'EOF'
# Goal: <short name>

## Objective

<copy the user goal in concrete terms>

## Constraints

- Evidence first.
- Do not change behavior without approval.
- Update decisions.md when architecture changes.

## Checklist

- [ ] Inspect logs/code.
- [ ] Implement focused fix.
- [ ] Build/restart.
- [ ] Verify logs.
- [ ] Move durable decisions to decisions.md.
EOF
```

After a successful architectural fix:

1. Update `decisions.md` before committing.
2. Remove or merge temporary planning/report files.
3. Run the repo verification command.
4. Commit and push when the user asks for a checkpoint or approves the state.

## Commit Checkpoint Rule

The user often says "commit and push", "good checkpoint", "working perfectly",
or "I'm happy". Treat that as:

- verify build/restart/status if relevant;
- update `decisions.md` if architecture changed;
- commit only intended files;
- push;
- report commit hash and verification.

Do not silently commit unrelated user changes. If the worktree has unrelated
changes, leave them alone or call them out.

## Drift Audit

Run targeted searches before finishing architecture sessions:

```bash
rg -n "todo|later|obsolete|prewarm|proxy|cache-only|hibern|guard|timer|monkey|BrowserSession|restore|xvfb" decisions.md AGENTS.md skills packages
git status --short
git diff --stat
git diff --check
```

Fix stale statements that contradict current code. Do not rewrite decisions
just for style.

Find recently changed commits to see if docs drifted:

```bash
git log --all --graph --pretty=format:'%C(auto)%h%d %s %C(bold black)(%ar by <%aN>)%Creset' --max-count=40
git show --stat --oneline HEAD
```

Check whether a temporary file still has unmerged decisions:

```bash
for f in goal.md plan.md todo.md report.md new-provider.md; do
  test -f "$f" && { echo "--- $f"; sed -n '1,220p' "$f"; }
done
```

## Reports

Use reports for deep investigations:

- Name reports by topic under `reports/`.
- Keep facts, failed paths, and final recommendation.
- If the report becomes a durable decision, summarize into `decisions.md`.
- Delete temporary root-level `report.md` after merging.

Create a report without polluting root:

```bash
mkdir -p reports
cat > reports/<topic>-investigation.md <<'EOF'
# <Topic> Investigation

## Question

## Evidence

## Failed Paths

## Decision / Recommendation
EOF
```

Commit checkpoint command pattern:

```bash
npm run build
npm run restart
curl -sk https://localhost:11555/api/health
git status --short
git add <intended files>
git commit -m "<imperative summary>"
git push
```

## Anti-Patterns

- Leaving completed tasks in `goal.md`.
- Letting `decisions.md` describe a reverted architecture.
- Hiding unfinished work only in chat.
- Creating one giant memory file that will be loaded every turn.
- Committing experimental litter after the user decided to abandon it.
