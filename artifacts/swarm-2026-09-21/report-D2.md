Task D2 done. Report:

## What I changed

Four files, all inside my ownership. `src/main/agent-control.ts` is **135 insertions, 0 deletions** — the other agent's `app.update` lines are untouched (11 `app.update` references still present).

| File | Change |
| --- | --- |
| `src/main/agent-control.ts` | +135: `handoffSections`/`handoffText` validation helpers, one `toolSignatures` entry, one dispatch line, one `private async handoff()` |
| `src/main/agent-control.test.ts` | +120 appended (a new `describe` block, 6 tests) |
| `docs/agent-control.md` | +3: one paragraph after the methods table |
| `scripts/smoke-context-handoff.mjs` | new, 138 lines |
| `artifacts/swarm-2026-09-21/handoff/` | `report.json`, `context-handoff.png` |

Line endings match each file's existing convention (these sources are LF; `docs/*.md` is CRLF).

## Behaviour

`agents.handoff({handoff, title?})` takes **no** `agentSessionId` and refuses one explicitly. It validates 200–12,000 characters and the six policy headings each on their own line, in order, then opens a tab through the ordinary `open()` path with the caller's provider (inherited by omission), model, effort and permission — so `inheritedPermission` clamps exactly as `tabs.open` does, and machine placement inherits the caller's. It submits through `this.call(scope, 'agents.submit', …)` so the receiver gets the normal first-turn briefing, posts a `kind: 'handoff'` collaboration message naming the new tab, and returns the ids, URI, resolved settings and a note to finish the current step and stop. The caller is never interrupted or closed and keeps steering rights via the link `open()` records.

Headings are accepted as `Objective`, `## Objective`, `**Objective**` or `Objective:` — but a mention inside a sentence is prose, not a section. Titles default to `<caller title> (continued)`, with the suffix stripped first so repeated handoffs don't grow it.

## Evidence

- `npx tsc --noEmit` — clean.
- `npx vitest run src/main/agent-control.test.ts` — **49 passed** (43 pre-existing + 6 new): format refusals naming the missing section, size bounds, out-of-order, prose-only heading, markup variants, inherited provider/model/effort/permission, the exact first prompt, the recorded collaboration message and its metadata, caller-only enforcement, restricted callers handing off, and the `tools.list` entry.
- `node scripts/smoke-context-handoff.mjs` — **5 checks passed, 0 page errors**, parked window, offline fixtures, no inference. Report at `artifacts/swarm-2026-09-21/handoff/report.json`.

I rebuilt (`npm.cmd run build`, ~16s) because the smoke needs my code in `out/`.

Two of my own test expectations were wrong on the first run and I corrected the tests, not the code:
- Swapping `Verified findings`/`Remaining work` makes the scanner report the *later* missing heading (`no "Remaining work" section on its own line after "Verified findings"`). That message is more useful than what I'd predicted, so the test now asserts it verbatim.
- The synthetic adapter advertises `plans: false`, so any Claude tab opened from a restricted caller gets `plan: true` from `open()` and the fixture then rejects its turn with "Planning is unavailable on this adapter baseline". That's a fixture limit, not a product bug — I dropped that sub-case and said so in a comment; plan propagation is already covered by the existing `tabs.open` tests.

Same in the smoke: my first run asserted the new tab's model against `callerTab.state.model`, which a launcher-opened tab still reports as `"default"`. The correct source is the caller's session settings, which is what `handoff()` reads.

## For other owners

- **`open()` gives any Claude tab opened from a restricted caller `plan: true`**, including a caller that is read-only but not planning (`plan: restricted(sourceSettings) && provider === 'claude'`). Inherited deliberately per "reuse the existing tabs.open path", and fine in production where Claude advertises `plans: true`. Flagging it because handoff now makes that path much more common.
- **`dispatchRouter` calls `connectSession(tab.resourceId!)` on a tab that may have been placed on a paired machine**, where `open()` returns the remote shape with `agentSessionId` and no `resourceId` — that would be `undefined`. My `handoff()` reads both and fails with a clear message instead; `router.dispatch` does not. Not my file.
- The `agents.handoff` `tools.list` string is the surface your nudge should name; it already spells out the six sections and the no-`agentSessionId` rule, so the nudge needn't repeat them.

CONDUCTOR_MEMORY[procedural]: The synthetic provider adapter in src/main/agent-control.test.ts advertises `plans: false` and only `['default','read-only','accept-edits']`, so a test that puts a Claude tab into planning mode fails at submit with "Planning is unavailable on this adapter baseline" — and since `open()` sets `plan: restricted(source) && provider === 'claude'`, *any* Claude tab opened from a read-only or planning caller hits this; exercise plan propagation through a codex tab instead. | cues: agent-control.test.ts, synthetic fixture, plans false, planning unavailable adapter baseline, tabs.open plan propagation

CONDUCTOR_MEMORY[procedural]: Line endings in this repo are mixed and per-file, not uniformly CRLF — `src/main/agent-control.ts`, `src/main/agent-control.test.ts` and `scripts/*.mjs` are LF-only while `docs/*.md` are CRLF-only — so check the target file with a CRLF/LF count before appending generated text, or the diff shows a whole-file rewrite. | cues: line endings, CRLF, LF, appending to source files, git autocrlf warning