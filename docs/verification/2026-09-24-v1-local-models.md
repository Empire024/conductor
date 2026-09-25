# Verification V1: local models (2026-09-24 swarm)

Loop: `.conductor/loops/verify.md` v2. Brain (plan and judge): Opus, agent_mug7aqxo_gcoz4c3. Executor: Sonnet,
agent_mug7heop_zlfllc0. Plan: 28 scenarios written from the owner's item text (feature-list.md) and the named
commits, not from the implementers' tests. Every run was a parked instance (`CONDUCTOR_TEST_USER_DATA`, `smoke-lock`)
on the real `local/qwen3.6-35b-a3b` server, except S10, which ended on `qwen3.5-9b`. Evidence is in
`artifacts/verification/2026-09-24-v1/` (git-ignored, local to MAIN), and the smoke scripts are in
`scripts/smoke-v1-*.mjs`. Run on 2026-09-25, 00:11–02:35Z.

## Verdicts

| Item | Scenarios | Verdict | Failing scenario and evidence |
| --- | --- | --- | --- |
| `local-models-save-tokens` (9f48ec4, 8a981be, 55aa7bb) | S1–S13, S25 | **REOPEN** | Host-side acceptance is not wired (S25). `local_ask` gives a confident wrong answer on large files (S7). The saved-tokens figure is not in app control (S11). prepare-deps runs without the owner (S13b). The default `run_and_summarize` holds the caller for 10.7 min (S4b). Details below. |
| `local-turns-survive-restart` (9c0dcf2) | S14, S15 (S16 not run) | **VERIFIED** | A real model turn restarted mid-turn continued in its tab, with no round lost or repeated. A `run_command` cut off by the restart was not replayed: `counter.txt` has 1 line. `s14-s16-restart-real.json` |
| `durable-jobs-as-local-option` (6031783) | S17, S18 | **REOPEN** (visual) | It works: the sidebar panel is gone, the job tab shows progress, and Pause/Resume/Cancel all work (`s17-*.png`). But the launcher option is unstyled browser-default HTML: a native `<select>` and a bare `<details>` in a larger, unthemed font under the launcher grid (`s17-launcher.png`). There is no CSS for `.launcher-durable-option` or `.durable-job-launcher`. The busy label is mojibake: `DurableJobsPane.tsx:178` reads `'Startingâ€¦'`. The option is also a second model dropdown (default Ornith, not the loaded model) below the grid, not a toggle on the local model entry the owner picks. |
| `durable-jobs-verification` (aaaf72c) | Soak log review, S18, S19 | **REOPEN** | This is not acceptable for overnight use; see "Durable jobs" below. |
| `9b15feab` Ideas MVP (4f9bf46, 1a2cf7f) | S20–S24 | **REOPEN** | The backend is never registered: `registerIdeas` (`src/main/ideas/register.ts:87`) has no caller anywhere in `src/`, `index.ts` never mentions ideas, and `agent-control.ts` never routes `ideas.*`. The desktop view and phone screen render, but every operation fails with `No handler registered for 'ideas:list'` (S20). On the phone, typed text never reaches the list, and `#/ideas/list` shows "Could not read the ideas. Unknown route." (S21). Capture, the Incubator, explore and "Work on this idea" cannot run at all (S22–S24). |

## local-models-save-tokens: per scenario

| # | Scenario | Result | Evidence and numbers |
| --- | --- | --- | --- |
| S1 | `run_and_summarize` on a failing `npm test` (200 tests, 3 fail) | PASS | All 3 failures named with file:line; 126 lines, 3.4 KB returned; 14.1 s. `group-a-results.json` |
| S2 | Full passing `npm test` on the checkout | PASS | Exit 0; 146.5 s run, 162.8 s call; 62.6 KB log kept; the MCP client did not time out |
| S3 | 20 MB log with 3 errors | PASS | All 3 found in 12.6 s. Note: the digest's failure regex matched `Error:` but not `ERROR:` |
| S4a | Endless command, `timeoutSec: 30` | Inconclusive | Returned at 34.3 s and reported the timeout. The pid was still listed 6–12 s later; the re-check harness timed out (`s4a-recheck-results.json`) |
| S4b | Endless command, default timeout | **FAIL** | The caller was held for 641.5 s with no progress: the 600 s default contradicts "never blocking the caller" |
| S5 | Windows path with spaces | PASS | Ran in the right cwd, and the returned log path opens |
| S6 | Permissions | PASS | Refused in default and accept-edits; `.env` and `..\..` refused. Plan mode could not be set from control (not run) |
| S7 | `local_ask` on a 1 MB file, needles at ~100 KB and ~900 KB | **FAIL** | Found neither needle. It answered "the file does not contain X … consists only of filler lines". `digest.ts` `modelExcerpt` shows the model only the head, the tail and lines matching the failure regex, and the answer never says it saw an excerpt |
| S8 | Binary file (5 MB random) | PASS | Refused as binary |
| S9 | GPU busy with an interactive local turn | PASS | Assist calls returned the raw fallback in 20.8 s; the interactive turn finished normally |
| S10 | No server running → starts Qwen 3.5 9B | Partial | `local.stop` stopped the 35B server cleanly. The script crashed before the cold-start call, so the ~20 s fallback followed by a later model answer was not measured. The 9B was then started through a local tab and is running now |
| S11 | Honesty of "saved ≈ N tokens" | **FAIL** (control) | The Usage view and the ledger agree (≈ 0 for the single line recorded; `s11-usage-view.png`). The spec requires the figure "in control" too: `tools.list` has no savings method and `usage.limits` does not carry it. A scripted `local_ask` wrote no ledger line at all (not root-caused) |
| S12 | Real Claude session: "run the tests in src/shared/usage-accounting.test.ts" | Info | That file does not exist. The agent found the 3 real test files (32 passed), but ran them with its own Bash tool, not `run_and_summarize`. The briefing line alone did not make it delegate. $0.23, 44 s |
| S13a | No Linux-deps volume appears on its own | PASS | `docker volume ls` checked before and after every scenario |
| S13b | Does prepare-deps refuse without the owner? | **FAIL** | An Auto coworker ran `npm run local -- prepare-deps --cwd <zero-dep dir>` through `run_and_summarize`. It started "Installing … from the network" and created `conductor-linux-deps-275aafec2c97ae02` (`s13b-output.txt`). The only gate is that someone types the command, and any Auto agent can type it. That volume is a test leftover the owner may remove; my attempt to remove it was blocked |
| S25 | Local coding task with acceptance `npx vitest run …`, deps not prepared | **FAIL** | The model's edit was correct. The acceptance ran in the Docker sandbox (`cwd=/workspace`) and crashed with `Cannot find module '@rollup/rollup-linux-x64-gnu'` before vitest started (`s25-full-transcript.json`). `agent.ts:597-610` calls `sandbox.exec`, and `DockerSandbox.runAcceptance` (the host-copy fallback) has no caller: the "host-side acceptance until then" part is not delivered, as docs/local-assist.md "Not yet wired" admits |

**Failing scenarios for the next batch (write them as tests):**
1. A provider-local tab with `contract.acceptance = 'npx vitest run <file>'` in a project with Windows `node_modules` and no prepared Linux deps. The acceptance must run in the host copy and report vitest's own pass or fail, never a Rollup native-module error.
2. `local_ask({files:[1 MB text file], prompt:'quote the line containing NEEDLE-900K'})` with the needle at 900 KB. It must quote the needle, or say the file was truncated or excerpted and where. It must never answer "not present".
3. `run_and_summarize` with no `timeoutSec` must not hold the caller more than a short bound with no output. Either return early with a job handle and log path, or make the default short.
4. App control exposes the weekly local-assist savings figure (e.g. `local.savings` or a `usage.limits` field), and every `local_ask` call appends a ledger line.
5. `prepare-deps` must need an owner act that an Auto agent's shell cannot supply (owner confirm dialog, or a control method that asks the owner). Calling it through `run_and_summarize` must be refused.

## Durable jobs: judgement on the soak

W15 recorded the soak as ending on "a single-slot local queueing timeout … an environment limit". The log does not
support that:
- **Iteration 31 did not queue for 20 minutes.** Its stage started on the model at 23:58:23Z and the smoke gave up
  at 00:00:15Z, 1 min 52 s later. `STAGE_TIMEOUT` is 20 min, and iterations took 4–11 min. The real cause is
  unknown, because `waitFor`'s catch drops the underlying error (`scripts/smoke-durable-jobs.mjs:173`).
- **The soak ran 2.5 h, not the 6 h the item asked for.**
- **29 of 30 iterations blocked, and this is the finding that matters for overnight use.** An in-stage context
  rollover stops the stage as a failed attempt (`durable-jobs/wiring.ts:200`, counted as a retry at
  `controller.ts:421`). Three rollovers of one stage therefore block the job ("used all 3 attempts. Last error:
  Watchdog: context rollover …", iterations 1, 29 and others). A long overnight stage that needs more than 3 fresh
  contexts stops at night and waits for the owner in the morning. That is the opposite of an overnight job. S19
  could not trigger this at the default 0.7 threshold with 40 small files (peak 71.6 %, no rollover, job completed).
  The soak did trigger it at 0.4.
- S18 (a durable job alongside a 5-minute interactive local turn) passed: both completed, and the job never sat
  silent.

**Failing scenario:** `--soak` for 6 h at the default rollover fraction with a stage that needs at least 4 contexts
(e.g. 150 files × 2 KB, "one line per file into INDEX.md, in order"). The job must complete. A rollover that made
file progress continues from the handoff without spending an attempt, and the iteration's real error is logged.

## The local agent in general (the owner's own question)

| # | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| S25 | "Add a unit test for X and make it pass" with vitest acceptance | FAIL | See above: correct edit, but vitest cannot run in the sandbox or on the host; deps "not prepared (owner action)" |
| S26 | "What is the meaning of life?" in a coding tab | PASS | 14.5 s, 0 tool rounds, completed. `s26-open-ended.json` |
| S27 | Find a codeword in a 1 MB file | PASS | Found `BRAVO-2024`, no llama 400. `s25-s27-s28-results.json` |
| S28 | Rename a function across 3 files and its test | PASS (re-run) | 4 reads → 4 `apply_edits` → acceptance exit 0; all files now say `computeGrandTotal`. The first run under heavy load showed no edit, unexplained. `s28-transcript.json` |

So, can the local agent run vitest itself now? No. Deps are not prepared (owner action), and the host-acceptance
path it was supposed to use in the meantime is not wired. It can do reads, open questions and multi-file edits
whose acceptance is a plain `node --test`.

## Notes

- The installed app on MAIN (the owner's window) predates these commits. Its app control has no `local.servers`,
  `ideas.*` or conductor-local tools. The owner will not see local assist until the next `app.update`.
- Machine state at the end: `qwen3.5-9b` llama-server running (started in S10); the 35B server was stopped with
  `local.stop` after an idle check (GPU 4 %, smoke lock free).
- Not run: S6 plan mode (no control setter), S16 (restart mid-generation), S23 and S24 (blocked by the Ideas wiring).
