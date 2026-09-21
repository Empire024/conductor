All work is verified and the orchestration task is marked done. Here is the report.

## Batch B2 report: capability repairs from the 2026-09-21 sweep

**Twelve repairs applied, three deferred as written.** Type-check is clean, the full unit suite passes (208 files, 2,393 tests), the offline sweep passes 20 checks with no failures, the live discovery-only sweep passes 8 checks with no failures, and the Claude structured-agents smoke passes on the raised baseline. I built once with `npm.cmd run build` (twice in total, after a late composer fix). Nothing was committed, pushed, checked out or reset.

**Live inference spent:** 0 one-word turns on the CLIs. The offline sweep sent 2 one-word requests to the already-running local 9B model across two runs (the first run failed on my own ring assertion, the second passed).

### Files changed

Owned files:
- `src/main/agent-manager.ts`, `agent-manager.test.ts` (R1, R4, R8, R12)
- `src/main/providers/codex.ts`, `codex.test.ts` (R2, R11)
- `src/main/providers/factory.ts` (R13, and it now reports the Claude baseline constant)
- `src/main/providers/local.ts`, `local.test.ts` (R10)
- `src/shared/model-effort.ts`, new `src/shared/model-effort.test.ts` (R7)
- `src/shared/agent-model-selection.ts` and its test (R4)
- `src/renderer/src/panes/composer-settings.ts` and its test (R4, R12, R15)
- `src/renderer/src/panes/StructuredComposerControls.tsx` (R7, R15 tooltip)
- `docs/conductor-provider-parity.md` (status table per repair with evidence, intro sentence), `docs/claude-compatibility.md` (baseline raise)
- `scripts/smoke-capability-sweep.mjs`, `scripts/fixtures/swarm-capabilities-claude.mjs`, `artifacts/swarm-2026-09-21/capabilities/smoke-offline` and `smoke-live`

Protected files, additive hunks only:
- `src/main/providers/claude.ts`: the baseline constant (R9) and the modelUsage lookup (R14)
- `src/main/providers/claude.test.ts`: the [1m] case appended to the context-accounting test; version literals moved to the constant, since 2.1.263 is now below the gate
- `src/shared/models.ts`: the effort union gained `minimal` and `ultra`

Outside my list, each a one-line consequence of a repair, flagged for the controller:
- `src/main/providers/claude-ui-fixture.test.ts`: fixture version literal replaced by the constant (R9 would otherwise refuse the fixture)
- `src/renderer/src/panes/StructuredComposerControls.test.ts`: expectations updated for "Account default" and the verbatim labels
- `src/renderer/src/panes/usage-summary.test.ts`: one expectation follows the R12 convention (subagent label reads `GPT-5-High · high`)

### Repair status

| Repair | Status | Evidence |
| --- | --- | --- |
| R1 | applied | Codex ladder is auto, low, medium, high, xhigh, max, ultra. The legacy PTY launch keeps a guard on max and ultra (not re-verified). Sweep: 6 positions on Astra/Sol/Terra, 5 on Luna, 4 on GPT-5.5, offline and live. |
| R2 | applied | Pre-discovery ladder low…ultra, no minimal. Sweep: 6 positions before discovery. |
| R3 | deferred | Left as a follow-up in the document. |
| R4 | applied via the fallback route | Static Claude catalog mirrors the advertised ids; fallback is `opus[1m]`; composer reads "Account default" before discovery, offline and live. Not passing `--model` at all was not possible: the pre-discovery model is persisted as a concrete id by `structured-sessions.ts:117` and `StructuredAgentPane.tsx:84`, both closed. The launch sends `--model opus[1m]`, the account default. |
| R5, R6 | deferred | Left as follow-ups. |
| R7 | applied | No effort resolves unless saved or reported; the composer shows "Account default", persists nothing, and no `--effort` is sent (proven by the fixture echoing its launch arguments). Once the runtime reports an effort the slider shows and persists it. Live: Claude 2.1.278's system/init carries no effort, so a fresh Claude conversation stays on "Account default" until the owner moves the slider; Codex shows "Xhigh" from thread/start. Side effect: task dispatch sends no effort instead of medium when the catalog has no default. |
| R8 | applied | Sweep: agents.listProviders names "Qwen 3.5 9B" and "Qwen 3.6 35B-A3B", matching the composer. |
| R9 | applied | Baseline 2.1.278. Live discovery: no version limitation on 2.1.278. Docs updated. |
| R10 | applied | One real local turn: 2,698 tokens used, 32,768-token window, 28,672 usable, View usage "9% used". |
| R11 | applied | Test asserts both notices survive the projection; sweep shows both. |
| R12 | applied | Bare ids render as the CLI does (`GPT-6-Astra`); catalog labels verbatim; static labels aligned. |
| R13 | applied | `CONDUCTOR_TEST_FIXTURE_DIR`; the sweep no longer copies `out/`. |
| R14 | applied | Offline on opus[1m]: window 1,000,000, capacity 923,000, View usage "10% used · 100,001 / 923,000". Lookup prefers the current turn's model because modelUsage accumulates every model the session used. |
| R15 | applied | Composer "Sonnet", tooltip "Sonnet (claude-sonnet-5)", View usage "Sonnet". |

### Left undone or worth knowing

- The `--model`-free launch for R4 needs the two closed files above.
- `src/shared/project-backlog.ts` still maps heavy Claude work to the bare `opus` alias. The CLI accepts it, but it is not in the advertised picker. Out of scope, untouched.
- The composer ring paints only from its warning band, so the smoke quotes View usage for low-usage turns.
- `feature-list.md` item "Capability repairs from the 2026-09-21 sweep" carries the controller's marker at `[~]`; I left it for the controller to close after the commit.

CONDUCTOR_MEMORY[procedural]: In Conductor smokes the composer context ring (.sa-context-circle) only paints once usage reaches its warning band, so a low-usage turn must be proven through the View usage dialog text, and a mounted StructuredAgentPane never sees settings written over IPC (it reads its snapshot once at mount), so turns whose composer state matters must go through the picker and slider. | cues: smoke, context ring, View usage, IPC saveSettings, composer, capability sweep

CONDUCTOR_MEMORY[semantic]: Claude Code 2.1.278's system/init reports model, permissionMode, tools and version but no effort level, and modelUsage in the result frame is keyed by the configured name with its [1m] suffix while message frames name the API model without it, so Conductor sends no --effort unless one was saved or reported and resolves the context window by preferring the suffixed key for the current turn's model. | cues: claude, effort, system/init, modelUsage, [1m], context window, R7, R14