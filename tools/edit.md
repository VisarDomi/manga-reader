# Edit tool

## Failures

- `SWAP N:=M:` — wrong range separator. Error: "payload line has no preceding hunk header".
- Anchoring on lines inside a folded/elided summary (`..`/`…`). Error: "This edit anchors to lines X-Y ... never displayed".
- Multiple SWAPs in one call on overlapping regions — leaves duplicate/stale code behind.
- Replacement body duplicates a line that sits just outside the SWAP range — produces an unintended duplicate. E.g. `SWAP 46.=52:` whose body re-introduces `render()` that also exists at line 54. The repair machinery may drop the keeper, may not — don't rely on it.
- SWAP range includes a closing brace (`}`) from a prior block, but replacement body omits it — auto-repair fixes the brace balance but drops unrelated lines that were inside the range. E.g. `SWAP 36.=42:` replaced header append + saved-searches container + `}`; the body only restated header append + submit handler; auto-repair kept the `}` but lost the saved-searches div.
- Stale tag — prior edit in same session advanced the file. Warning: "Recovered from a stale file hash".
- Batching edits across multiple files in one call — first edit succeeds, rest get stale hash. Each successful edit invalidates all prior tags.
- Edit with both "Recovered from stale file hash" AND "line X never displayed" in the same response — some SWAPs in the batch may silently not apply while others do. The response looks successful but the file is unchanged for those lines.

## Passes

- Use `SWAP N.=M:` with `.=` between numbers (not `:=`).
- Before editing a range that was elided, re-read it explicitly: `read path:L1-L2` to get a fresh tag.
- For adjacent changes, use separate edit calls — verify each before the next. Never batch SWAPs that are close.
- Always get a fresh tag (re-read the file) between edits. Only chain edits on the same tag if the file hasn't been modified since.
- When the replacement body needs a line that also exists just outside the range, widen the range to swallow it, or restructure so the body doesn't repeat it. Never type a line in the body that you're also keeping untouched nearby.
- When inserting code before a closing brace, use `INS.PRE N:` targeting the brace line instead of `SWAP` that swallows it. The brace stays untouched, nothing gets lost.
- Multi-file refactors: read → edit → verify each file one at a time. Never batch edits on different files in one call.

- After any edit that produced a warning (stale hash, auto-repair, delimiter-balance), verify with `search` that the intended content actually landed in the file before moving on.