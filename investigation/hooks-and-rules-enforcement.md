# Investigation: Hooks and Rule Enforcement

Goal: understand whether oh-my-pi hooks can enforce AGENTS.md-style rules, and whether RULES.md is a better fit.

## Key sources
- `omp://hooks.md` — full hook subsystem docs
- `omp://extensions.md` — extension events (superset of hook events)
- `omp://system-prompt-customization.md` — SYSTEM.md vs RULES.md discovery
- `omp://config-usage.md` — config roots, profiles, capability discovery
- `omp://context-files.md` — sticky rules vs normal context files

## Hook discovery paths

| Scope | Path |
|---|---|
| Project | `<cwd>/.omp/hooks/pre/*.ts`, `<cwd>/.omp/hooks/post/*.ts` |
| User | `~/.omp/agent/hooks/pre/*.ts`, `~/.omp/agent/hooks/post/*.ts` |

Loaded as TypeScript modules. Each exports a default factory: `export default function(pi: HookAPI) { ... }`.

## Events relevant to failure-documentation enforcement

1. **`tool_result`** — fires after every tool call (success or failure). Can inspect `event.isError`, `event.toolName`, `event.content`. Can return `{ content, details }` overrides.
   - Could detect failures and inject context, but cannot force the agent to write a file.

2. **`context`** — fires before each LLM call. Can modify `event.messages` array. Last handler wins (chained).
   - Could inject a reminder message about failure documentation when a failure was recently detected.

3. **`turn_end`** — fires at end of each agent turn. Notification-only; no mutation possible.
   - Could log failures to an external file or database.

4. **`session_before_compact`** — can cancel or customize compaction. Could ensure AGENTS.md-style rules aren't lost.

## What hooks CANNOT do

- Cannot force the agent to take a specific action (like writing to tools/edit.md)
- Cannot modify the agent's internal todo list
- Cannot intercept the agent's own reasoning — only tool calls and LLM context
- The agent decides whether to act on injected context

## What CAN enforce the behavior

### 1) RULES.md (recommended)

RULES.md at `<cwd>/.omp/rules.md` (or `~/.omp/agent/rules.md`) creates a "sticky rule" that persists through compaction. From omp://context-files.md: "Sticky rules come from a top-level RULES.md. They are converted into an always-apply rule that is re-attached near the current turn, so they keep their hold even after the visible conversation grows."

Current situation: the repo has `rules.md` (lowercase, repo root) which IS loaded as context. The AGENTS.md instruction about documenting tool failures could move into RULES.md for stickiness.

### 2) AGENTS.md (current, less sticky)

AGENTS.md is loaded but does NOT have sticky behavior. When the conversation grows past the compaction window, AGENTS.md content can be summarized away. The instruction survives only as long as it fits in context.

### 3) SYSTEM.md / APPEND_SYSTEM.md

SYSTEM.md replaces the system prompt block 0 (stable default instructions). APPEND_SYSTEM.md appends to the full prompt. Both are less volatile than AGENTS.md but still subject to context limits. Best for permanent behavioral instructions.

### 4) Hook-based injection

A hook on `tool_result` could:
- Detect failure (`event.isError === true`)
- Store failure info in session state (`pi.appendEntry(...)`)
- On `context` event, check for recent failures and inject a high-priority reminder message

```ts
// .omp/hooks/pre/failure-doc.ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  let recentFailures: string[] = [];

  pi.on("tool_result", async (event) => {
    if (event.isError) {
      recentFailures.push(`${event.toolName}: ${JSON.stringify(event.input).slice(0, 200)}`);
    }
  });

  pi.on("context", async (event) => {
    if (recentFailures.length === 0) return;
    const reminder = {
      role: "user" as const,
      content: [{ type: "text" as const, text: `[HOOK] Recent tool failures detected: ${recentFailures.join("; ")}. Document them per AGENTS.md in tools/<tool>.md.` }],
      timestamp: Date.now(),
    };
    recentFailures = [];
    return { messages: [...event.messages, reminder] };
  });
}
```

This is fragile and complex. Prefer RULES.md.

## Best practice: use RULES.md for sticky enforcement

1. Move enforcement instructions from AGENTS.md to `<cwd>/.omp/rules.md` (or the current `rules.md` at repo root, since that's already loaded)
2. Keep AGENTS.md for non-critical context
3. Use hooks only when behavior needs to be automatic (e.g., auto-logging failures to a file without agent involvement)

## Todo vs AGENTS.md tension analysis

The issue observed: the structured todo system creates forward momentum ("next task!") that drowns out lateral instructions from AGENTS.md ("document the failure!"). Possible mitigations:

- **RULES.md** — the instruction persists through compaction as a sticky rule, so it's always visible alongside the todo list
- **APPEND_SYSTEM.md** — injects the instruction directly into the system prompt block, making it part of the agent's core directives rather than just context
- **Hook** — could detect `todo_reminder` events and inject a parallel reminder about failure documentation, but this couples the hook to the todo format

## Implementation

Created `.omp/hooks/pre/failure-doc.ts`:

- **`tool_result` handler**: sets a `pendingFailure` flag when `event.isError` is true, storing tool name and input
- **`context` handler**: on the next LLM call, if a failure is pending, injects a user-role message containing the AGENTS.md failure-documentation prompt. The flag is cleared so the prompt only fires once per failure.

Why `context` instead of `tool_result` content override:
- Injecting as a user message gives it higher priority in the agent's attention
- The agent sees it as something the "user" is asking, not just a tool error
- Clean separation: the tool error remains unmodified; the documentation instruction is a separate message

Why state tracking instead of `pi.sendMessage()`:
- `context` event message injection is explicitly documented and type-safe
- `pi.sendMessage()` API surface differs between hooks and extensions; avoiding ambiguity
- The `context` handler pattern (return `{ messages: [...event.messages, ...] }`) is the documented way to inject messages
