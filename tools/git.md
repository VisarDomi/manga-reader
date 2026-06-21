# Git / GitHub tool

## Failures

- `git checkout <commit> -- <file>` — overwrites uncommitted working tree changes.
- `git merge --allow-unrelated-histories` — merges all file content, resurrecting deleted files from old history.
- `git replace --graft` — replacement refs are NOT supported by GitHub; history won't show.
- `git rebase --onto <target> --root` — no-op when root commit has no parent. Commit hashes unchanged.
- `git filter-branch --parent-filter` with range `<root>..HEAD` — excludes root commit, parent filter never fires.
- `git subtree split -P <deleted-path>` — fails when the path doesn't exist in HEAD working tree.

## Passes

- Read a file from another commit without side effects: `git show <commit>:<path>` (not `git checkout`).
- Extract subdirectory history: `git checkout <pre-deletion-commit> && git subtree split -P <path> -b <branch>`.
- Graft history by rewriting root commit parent: `git filter-branch --parent-filter '...' -- --all`.
- Verify before pushing: `git diff <known-good-commit> --stat` to check for stray files.
