Task B is delivered and the orchestration task is marked done. Nothing is left to request; this is the report.

**What I changed (my files only, nothing committed)**

- `docs/conductor-provider-parity.md`: new dated section "Capability sweep (2026-09-21)" with the four-label matrix (documented / installed / advertised / verified) for Codex, Claude Code and local models, the live-turn table, the "not verified" list and 15 proposed repairs as file:line. The 2026-09-07 ledger is kept below it with its version rows updated.
- `scripts/probe-capability-sweep.mjs`: zero-inference discovery against the real CLIs (Codex `initialize`, `model/list` visible and hidden, `config/read`, account and rate-limit reads; Claude Code `initialize` over stream-json) plus Conductor's static catalogs read from source, producing `matrix.json` and `matrix.md`. Account emails and organization names are redacted.
- `scripts/smoke-capability-sweep.mjs`: parked-window smoke. Offline mode runs my fixtures through the unchanged production adapters by copying `out/` into a temp tree. Live mode uses the real CLIs, discovery only; `--turns` adds counted one-word turns; `--local` opens the 9B tab only if its server already answers.
- `scripts/fixtures/swarm-capabilities-claude.mjs` and `swarm-capabilities-codex.mjs`: catalogs verbatim from what the CLIs advertised today, plus one under-described model each, with usage, context-window and compaction frames.
- `artifacts/swarm-2026-09-21/capabilities/`: raw probe answers, matrices, and 53 screenshots across the offline and live runs. Note that `artifacts/` is git-ignored, so the numbers are copied into the doc.

**What I measured**

| Evidence | Result |
| --- | --- |
| Probe | 0 inference turns |
| Offline smoke | 14 checks, 0 failures, 28 screenshots, 0 turns |
| Live smoke | 9 checks, 0 failures, 25 screenshots, 9 one-word turns |
| Total inference spent | 19 one-word turns (two earlier live attempts hit script faults) |
| `npx tsc --noEmit` | clean |
| Provider unit tests | 143 passed in 5 files |

Key live figures: Codex reports a 258,400-token window for all five models; Claude reports 1,000,000 for Fable and Sonnet and 200,000 for Haiku, but nothing for the account default Opus 1M. Claude 5-hour usage stood at 45%, weekly 16%, Fable weekly 26% after the run.

**Most important findings (all in the doc's repair list)**

- R7: every new Claude conversation is launched with `--effort medium`, because Claude's initialize reports no default and Conductor's resolver falls back to medium; documented default is high and the owner's saved default is xhigh.
- R14: on `opus[1m]` (the account default) the context window and ring never appear, because the API message names `claude-opus-5` while `modelUsage` is keyed `claude-opus-5[1m]`. The fixture reproduces it.
- R1/R2: Codex advertises `max` and `ultra` on every model except GPT-5.5, and no model offers `minimal`; Conductor's static ladders have it backwards.
- R6: Codex Fast tier (`priority`, "2x speed, increased usage") and Claude fast mode state are advertised but not surfaced at all.
- R11: Codex's "compacted this conversation" notice is overwritten in the timeline by the generic item notice (same item id).
- R15: after a turn on the `sonnet` or `haiku` alias, the composer shows the raw resolved id instead of the label.
- R4, R8, R10, R12: static Claude catalog lacks the `[1m]` ids and falls back to `--model opus`, which the picker does not list; local models carry two different labels; local turns report no context figures; Codex display names are rewritten.

**What I did not do**

- No production or UI edits, per the batch rules. `local.ts` changed under another coworker while I worked; R10 is written as an additive one-line hunk against it.
- Codex Fast tier, Claude fast mode, `ultra`/`ultracode` and hidden Codex models were listed, not exercised. `/compact` was verified on fixture frames only. The 35B local model was never opened.
- The live smoke spawns the owner's user-level MCP servers, as any Conductor Claude tab does.

CONDUCTOR_MEMORY[semantic]: Claude Code 2.1.278 initialize reports no defaultEffort and its API message frames omit the [1m] suffix that system/init and result.modelUsage carry, so Conductor launches Claude on --effort medium by default and never learns the context window on opus[1m] until model-effort.ts and claude.ts modelUsage lookup are repaired (parity ledger R7 and R14). | cues: claude, effort, medium, 1m, modelUsage, context window, parity
CONDUCTOR_MEMORY[procedural]: To run a synthetic fixture other than fake-claude.mjs/fake-codex.mjs through the real adapters without editing factory.ts, copy out/ and package.json to a temp tree with the fixture placed under scripts/fixtures/fake-<provider>.mjs and a node_modules junction, as scripts/smoke-capability-sweep.mjs does. | cues: offline fixture, factory.ts, smoke, temp tree, CONDUCTOR_OFFLINE_TESTS