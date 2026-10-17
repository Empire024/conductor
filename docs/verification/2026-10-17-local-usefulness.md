# Frontier-led local work: normal-settings usefulness and fresh model comparison (2026-10-17)

Feature-list item `frontier-local-usefulness-20260928`, plan `2026-09-28-local-work-plan.md`.
Agent `agent_mvc1obt6_hcqfzjg` (Opus coworker; the previous owner `agent_mul69e93_at3uf5h` is gone).

## Status of the plan's six steps

| Step | Status | Evidence |
| --- | --- | --- |
| 1 Question UI | **Done** | `227286e` (Codex async questions as GUI cards), `2026-09-28-codex-question-fix.md`, feature-list `codex-async-question-gui` [x] |
| 2 Durable safety and fault checks | **Done** | `bc78c2e` (fail-closed local stop and smoke cleanup), `e7cfab0`, `2026-09-28-local-safety-fix.md` / `-review.md`; real server-kill and app-restart faults PASS in `2026-09-29-durable-jobs.md` rows 3-4 (`d681960`) |
| 3 Under-load guard and normal-priority control | **Done** | `6251695`, `2026-09-29-typing.md`: launch p99 -0.2 / p95 +0.6 ms, swarm p99 +24.2 ms (bound 25); the normal-priority control fails it (+39.9 ms) |
| 4 Normal-settings usefulness | **Done here** (below) | this document; harness and answers in `artifacts/verification/2026-10-17-local-usefulness/` |
| 5 Fresh model comparison | **Partly done here.** Held-out file tasks on all four installed models: done (below). Held-out *current web questions + research follow-up*: **remaining** (the FX44 set from 2026-09-26 predates the plan and is not held-out) | see "What remains" |
| 6 Overnight six-hour soak | **Done** | `d681960`, `2026-09-29-durable-jobs.md` row 5: 6 h 16 min, 20/20 iterations, 42 rollovers, 24 credited, attempt audit PASS; follow-up semantic completion check `386c55e` |

Forced-rollover stress (step 6, fraction 0.55) and the usefulness runs below are separate: nothing
below forces a rollover. Every run used the configured 32,768-token context and default settings.

## Method (step 4)

A held-out task set written for this run (`gen.mjs`, seeded, regenerable), graded by a script
against truth computed from the files (`grade.mjs`), not by eye:

| Task | What | Truth |
| --- | --- | --- |
| T1 source extraction | exported functions/consts of the real `src/main/local-assist/digest.ts`, `name: line` | 8 rows |
| T2 cross-reference | 8 synthetic modules; every real import edge `importer <- exporter.name`; each module also has a commented-out import and an import inside a string as decoys | 23 edges |
| T3 large-log evidence | 1.55 MB, 18,000-line service log; the 5 ERROR lines (timestamp + code) among 19 decoy WARN lines that quote E-codes and INFO lines saying `errors=0` | 5 codes |
| T4 file aggregation | 3 timesheet CSVs (84 rows, quarter hours): hours per person and grand total | 4 totals + grand |
| T5 mechanical edit | rename `toKilobytes` to `bytesToKilobytes` in a 3-file TS project and add `bytesToMegabytes`; the focused test `src/units.test.ts` is given and must stay untouched | vitest passes, old name gone, test unchanged |

Routes, all real product code against the real llama.cpp server:
- **local_ask / run_and_summarize**: the `conductor-local` MCP tools of the installed app, called by
  this Claude tab (T1-T4).
- **local agent**: `npm run local -- run --model <id> [--read-only] --cwd <copy>` (`LocalAgentSession`,
  the same loop a local tab runs, with `calculate`, `apply_edits` etc.), on a fresh copy of the fixture
  per run (T4, T5). Docker Desktop was not running, so the agent's `run_command` could not execute
  (file edits run on the host and were unaffected); grading ran the focused test on the host.

Rules from the plan: one correction at most, then escalate to the frontier. Times are wall clock from
the caller's side (my timestamp before the call to the ledger's completion stamp, ±3 s); agent times
are the CLI's own run. Local token counts are from `savings.jsonl` / the server; **frontier token
counters are not available** to a tab for its own tool calls, so the frontier-only comparison is
given as characters the frontier would have to read, labelled as such. No savings are estimated.

## Results

Correct / attempted, time, local tokens (in/out). "corr." = after the one allowed correction.

| Task (route) | Qwen 3.5 9B (default) | Qwen 3.6 35B-A3B (best) | Ornith 1.5 9B | Dolphin X1 8B |
| --- | --- | --- | --- | --- |
| T1 (local_ask) | **8/8**, ~3 s, 1,920/56 | **8/8**, 34 s (cold), 1,920/56 | **8/8**, ~8 s | 0/8 (numbers without names); corr. 7/8 (one line number off); escalate |
| T2 (local_ask) | **23/23**, 0 FP, 14 s, 15,398/197 | **23/23**, 0 FP, 63 s | **23/23**, 0 FP, ~8 s | 2/23, 30 FP (invented edges), 25 s; escalate |
| T3 (local_ask over the whole 1.5 MB log) | **lost**: Claude's MCP client timed out at 60 s; the tool finished at 64 s having read 115k tokens; nothing reached the caller | **lost**: client timeout at 60 s; first window never finished | not run | not run |
| T3 corr. (frontier re-plan: `findstr` ERROR+WARN through run_and_summarize, model filters) | **5/5**, 0 FP, ~10 s | **5/5**, 0 FP, ~21 s | **5/5**, 0 FP | 4/5, 1 FP (labelled a WARN as ERROR) |
| T4 (local_ask, arithmetic in the model) | 0/5, wrong but self-consistent totals (230 vs 328.75), 7.5 s | 0/5 (334), 16 s | 0/5 (306) | 0/5 (213), with plausible-looking working |
| T4 corr. (local agent with `calculate`) | 0/5: 65 s, 32 calls; transcribed numbers into expressions (dropped rows), then **ended on an unrun `<tool_call>` written as text** | **5/5**, 55 s, 8 calls: `calculate` path+group_by per file, then `combine` | 4/5, 9 s: per-file `calculate` right, merged per person in its head (Ana 88.5 vs 87.5) | 0/5, 7 s: invented file names, "files do not exist", 6 of 9 calls failed |
| T5 (local agent) | **1/1**, 11 s, 6 calls, 0 failed | **1/1**, 85 s, 13 calls (1 edit miss, 1 run_command without Docker) | **1/1**, 18 s, 14 calls (5 run_command without Docker); **ended on an unrun `<tool_call>` text** after the edits | 0/1: 7 calls, all run_command (Docker down) with a script path that was a shell line, stopped by the loop guard; never edited |

Totals over the 5 tasks (first attempts: T1, T2, T3 and T4 via local_ask, T5 via the agent; the T3/T4
alternative routes count as the one correction). Completed correctly at first attempt: Qwen 3.5 9B 3/5 (T1, T2, T5), Qwen 3.6 3/5,
Ornith 3/5, Dolphin 0/5. After one correction: Qwen 3.6 5/5, Ornith 4/5 (T4 one value off), Qwen 3.5
9B 4/5 (T4 failed), Dolphin 0/5 complete (T1 7/8, T3 4/5 with a false positive). Escalations to the
frontier: Qwen 3.6 0, Ornith 1 (T4), Qwen 3.5 9B 1 (T4), Dolphin 5.

Frontier-only comparison (characters the frontier reads to do the task itself with grep/read):
T1 764, T2 836, T3 442 (a grep for ` ERROR `), T4 2,356 (then arithmetic in a script), T5 1,140.
Delegated, the frontier read back 189-1,200 characters per answer and still had to verify T4 and T5
(recompute / run the test). **On these bounded tasks, delegating did not save frontier reading: a
targeted grep is as small as the local answer.** The local model pays off only when the material
cannot be narrowed first (whole files without a searchable key), which is the case T3 was meant to
test and which failed on the client timeout. The ledger's "saved" figure counts `raw/4` per call and
does not see that alternative.

Frontier review cost: every answer here was checked by the deterministic grader (about 1 s). Without
a grader the frontier must recompute T4 and run T5's test; T1-T3 answers carry line numbers and can be
spot-checked with one grep.

## Improvement areas, from the failures observed

1. **Claude callers lose any local_ask longer than 60 s, and the model keeps working for nobody.**
   `local_ask` budgets a call at 240 s (hard 285 s, `tools.ts` `CALL_BUDGET_MS`), sized for a 300 s
   HTTP client, but Claude Code's MCP client gives up at 60 s (`CLIENT_WAIT_SEC`, measured again here
   twice). Every large-file read on Qwen 3.6 and a 1.5 MB read on the 9B ended with nothing returned.
   Either give the Claude `conductor-local` entry a per-server `timeout` (the installed CLI's config
   schema has `timeout` and `request_timeout_ms` in ms on http entries; `mcp-server.ts` writes none for
   Claude), verified in a live Claude tab first as the 60 s memory note asks, or budget a Claude
   caller's call under 55 s so it returns the partial answer and the unread ranges. Not changed here:
   it needs that live verification and it changes a designed budget.
2. **Savings were credited for answers the caller never received.** The lost 9B call above was
   recorded as 1,555,419 raw characters "saved" (about 389k tokens). **Fixed** (below).
3. **Qwen-family models write tool calls as template text.** Qwen 3.5 9B and Ornith ended 2 of 8
   agent runs with `<tool_call>\n<function=…>` as their final answer; the call never ran and the turn
   reported done. **Fixed** (below).
4. **Arithmetic must not be asked of local_ask.** 4/4 models gave wrong totals with confident,
   self-consistent working. local_ask has no `calculate`; a number question over files belongs to a
   local agent turn (where Qwen 3.6 used `calculate` correctly) or to a frontier-run script. Suggested:
   local_ask detects a numeric aggregation question (the agent's `wantsMath`) and says so, or routes it.
5. **Merging per-file results in the head.** Ornith computed each file correctly with `calculate` and
   then merged by hand (one value off); the 9B transcribed rows into expressions and dropped some. The
   agent's calc guidance already names `combine`; an answer whose numbers do not appear in any
   `calculate` result could be refused once (number provenance check).
6. **Without Docker, agents retry `run_command` and Dolphin never edits.** Docker Desktop was off;
   Dolphin spent its whole turn on a failing `run_command`, Ornith five calls. The refusal should say
   up front that the sandbox is down and that the host acceptance step will run the test, so the
   model edits instead of retrying.
7. **Dolphin X1 8B is not usable for file work** (0/5 complete, invented edges and file names); keep it
   out of local-assist and file delegation. Qwen 3.6 is the only model that completed every task after
   at most one correction, at 2-10x the latency; the 9B default is fast and right on extraction and
   cross-reference but not on aggregation.
8. **Ask-prompts that give an example leak answers.** The Dolphin T1 correction used a true row as the
   example; graded 7/8 it is still a fail, but held-out prompts should use invented examples.

## Code changes (focused tests, typecheck)

- `src/main/local-models/agent.ts`: a reply with no parsed call whose text contains a template tool
  call (`TEXT_TOOL_CALL`: Qwen XML `<tool_call><function=name>` or Hermes JSON `<tool_call>{"name":`)
  gets the same grammar-enforced retry as a dropped call (shared at-most-2 budget per turn), and the
  unrun call text is withdrawn from the timeline first. Test: `agent-loop.test.ts` "re-asks under the
  tool grammar when a Qwen-family model writes its call as template XML text" (fails on HEAD, passes
  with the change).
- `src/main/local-assist/tools.ts`: `local_ask`/`summarize_file` (single and windowed) and
  `run_and_summarize` credit 0 raw characters when the caller's request was aborted. Tests:
  `tools.test.ts` "credits no saving for an answer whose caller hung up…" and "…run_and_summarize
  whose caller hung up" (both fail on HEAD).
- `npm run typecheck` passes. `agent-loop.test.ts` 23/23, `tools.test.ts` 26/26.
  Whole-folder flake, investigated at the coordinator's request: an early tally (5 of 9 runs failing
  with the change, 0 of 7 without it) looked like the change was to blame. More runs show it is
  not. **HEAD itself** (both agent.ts and agent-loop.test.ts restored from HEAD) failed **2 of 6**
  default-worker runs with the same `SyntaxError: Unexpected end of JSON input`, thrown in the stub
  servers of `recovery.test.ts:15` and `fx40-loop.test.ts:28` (logs kept in
  `.conductor-scratch/usefulness-20261017/head-run3.log`, `head-run4.log`). The cause is in those
  stubs: they `JSON.parse` every request body without a guard, and under 12-worker load one
  receives a POST with an empty body (where that request comes from was not pinned down; no client
  path sends a POST without a body). The `swarm-control` failure is its 5 s `testTimeout` under the
  same load. The new detection cannot fire in any other test: no other test or fixture under `src/`
  contains `<tool_call>` or `<function=`. The retry is already guarded: only when tools were
  offered, never while finalizing, never on a truncated or ruminating reply, at most 2 per turn
  (shared with the dropped-call repair). With the change: `--maxWorkers=4` **5 of 5 passed in a
  row**; default workers 3 of 4 passed afterwards (one `swarm-control` timeout).

## Server state

Start: Qwen 3.5 9B (pid 14972, started by the installed Conductor), idle. Stopped with `local.stop`;
Qwen 3.6, Dolphin and Ornith were each started and stopped with `npm run local -- start/stop`, one at
a time. End: the installed app's local-assist runner restarted Qwen 3.5 9B itself on the next call
(pid 62220, `startedByConductor: true`, 07:33:44Z), idle. The CPU decider was not touched. Another
project's Codex tab was using local assist during the 12-minute window when other models held the GPU.

## What remains

- **Step 5, web part:** a new held-out set of current questions plus one research question with a
  follow-up, primary-source truth captured on the day, run on Qwen 3.6, Qwen 3.5 9B, Ornith and
  Dolphin under the same conditions. `scripts/smoke-fx44-models.mjs` hard-codes the VR9d questions,
  so it needs a `--questions <file>` option (or a copy) first. The exact run, one model at a time,
  serially, from `C:\Claude\conductor` with a detached-worktree build (memory: smoke build in a
  worktree), on a machine with no other smoke holding the lock:

  ```
  node scripts/smoke-lock.mjs --timeout-min 40 -- node scripts/smoke-fx44-models.mjs --model local/qwen3.6-35b-a3b --only A,R --label 2026-10-held-out --minutes 35
  node scripts/smoke-lock.mjs --timeout-min 40 -- node scripts/smoke-fx44-models.mjs --model local/qwen3.5-9b --only A,R --label 2026-10-held-out --minutes 35
  node scripts/smoke-lock.mjs --timeout-min 40 -- node scripts/smoke-fx44-models.mjs --model local/ornith1.5-9b --only A,R --label 2026-10-held-out --minutes 35
  node scripts/smoke-lock.mjs --timeout-min 40 -- node scripts/smoke-fx44-models.mjs --model local/dolphin-x1-8b --only A,R --label 2026-10-held-out --minutes 35
  ```

  (add `--questions <file>` to each once that option exists). Answers land under
  `artifacts/verification/2026-09-26-fx44`; grade them against the truth re-checked that day. The
  parked smoke stops the server it started, so afterwards restore Qwen 3.5 9B: any `local_ask` from a
  Claude/Codex tab of the installed app starts it, or `tabs.open` a local Qwen 3.5 9B tab plus
  `agents.submit`, then `tabs.close`.
- Improvement areas 1, 4, 5 and 6 above (1 needs a live Claude-tab check of the `timeout` key).
- The item can be marked done once step 5's web part is run, or now if the owner accepts FX44
  (2026-09-26) plus today's held-out file comparison as the step-5 evidence.

Raw answers, logs of the agent runs and the harness: `artifacts/verification/2026-10-17-local-usefulness/`
(the harness runs from `.conductor-scratch/usefulness-20261017/`, where `node gen.mjs` regenerates the
fixtures and `truth.json`).

## Follow-up the same day: step 5 web part, local_ask budget and arithmetic (second coworker)

### Step 5, held-out web comparison

Question set `docs/verification/2026-10-17-held-out-web-questions.json`: same shape as VR9d/FX44 (5 current
between 4 plain and 1 history; a research question and its follow-up), all new questions. Truth for each
current question was read from its primary source at 07:56Z (GOV.UK content API, python.org release API,
ECB daily XML, kernel.org releases.json, nodejs.org dist index; review pages for the research question),
sources in the file. Run with the new `--questions` option, serially under smoke-lock, from a detached
worktree build of `3e7ad23` (the shared `out/` was from 2026-10-06), default settings, one server at a
time. Dolphin X1 8B was not run: improvement area 7 above rules it out of delegation. Answers:
`artifacts/verification/2026-09-26-fx44/2026-10-held-out-<model>-{A,R}.answers.json`.

| | Qwen 3.6 35B-A3B | Qwen 3.5 9B (default) | Ornith 1.5 9B |
| --- | --- | --- | --- |
| Plain + history (5) | 5/5 | 5/5 | 5/5 |
| Current (5) | **5/5** (Node: "v24" line, no patch number) | 4/5: Node wrong ("26.x LTS, 26.11.1"; truth v24.22.0, v26 is Current) | **5/5** (Node 24.22.0 exact, but adds a false "26 became Active LTS on 28 October") |
| UK PM (all pages failed to load) | right, from search snippets, 153 s | right, from snippets | right, 1 page read |
| Research Q1 | consistent with truth, 3 pages read; one quote from an unopened Digital Trends snippet | consistent, 3 pages read | consistent, 4 pages read |
| Research follow-up | **right**: the 3 opened pages and their verdicts | partial: ran an unrelated new search (Rotten Tomatoes), then listed the 3 opened pages without verdicts | partial: same unrelated search; PhoneArena 7.4, Trusted Reviews, Popular Mechanics verdicts right, but says it did not open Android Headlines, which it did |
| Model time (12 answers) | 716 s (current median 44 s) | 106 s (median 8 s) | 113 s (median 8 s) |
| Shape flags | Q7 (20 C to F) used calculate: right, answer printed twice | none | Q7 same as Qwen 3.6 |

Total model time about 16 min, inside the 60 min bound. The step-5 picture is the file-task one again: Qwen
3.6 is the only fully correct model, at 6-7x the 9B's latency; the 9B default is fast and right on 9/10 but
gets a version-line question wrong with confidence; Ornith is as fast and as right as Qwen 3.6 on the
current questions but misreports its own reads.

New improvement areas from this run:
9. **A follow-up about the conversation's own reads starts a fresh web search** on both 9B models
   ("which of those reviews did you open"): web intent should treat a question about the previous turn's
   sources as answerable from the conversation.
10. **Every `web_read` failed on 3 of 12 questions** (news sites, exchange-rate pages); answers then
    come from search snippets. They were right here, but the answer does not say it rests on snippets.

### Code changes

- **local_ask / summarize_file answer a Claude caller within its MCP client's wait** (area 1, the
  budget route; no MCP `timeout` key was added, so no live-tab check was needed). A Claude caller's call
  starts no section that would end past 45 s and stops a generation still running at 52 s; Codex callers
  (given `tool_timeout_sec`) keep 240/285 s. The runner takes `returnWithinMs`: its waits end by then,
  and a generation still running is stopped and returns what it has streamed as a `partial` answer, or a
  `deadline` fallback when nothing was written. The tool answers `PARTIAL / TIMED OUT` / `TIMED OUT`
  with the file to read yourself (and, windowed, the unread line ranges) and credits no saving.
  run_and_summarize is unchanged. Files: `src/main/local-assist/contract.ts`, `model-runner.ts`,
  `tools.ts`.
- **Arithmetic is refused by local_ask** (area 4): `asksForArithmetic` (sum, total, average, median,
  percentage, count/how many over rows, lines, hours…; not "summarise", "sum it up", questions about code,
  or verbatim extraction) returns a refusal, without a model call, naming the routes that compute: a
  script, or a local agent turn with `calculate`, and "list the values verbatim" for extraction. Routing
  into the agent path was not chosen: local_ask has no agent session, sandbox or grants to run it in.
- `scripts/smoke-fx44-models.mjs`: `--questions <file.json>` (built-in set stays the default) and
  `CONDUCTOR_SMOKE_MAIN` to run a worktree build.
- Tests: `model-runner.test.ts` (fake timers: partial at returnWithinMs, deadline fallback, plain
  timeout unchanged), `tools.test.ts` (45 s Claude budget, partial and timed-out bodies, Codex keeps
  285 s, windowed cut, T4 prompt refused, detector cases). `npm run typecheck` passes;
  `src/main/local-assist` with `--maxWorkers=4`: 70/70.

### Server state

Start: Qwen 3.5 9B (pid 62220), idle. Each parked run stopped the server it started. End: Qwen 3.5 9B
restarted by a `local_ask` from this tab (pid 35800, 08:18:25Z, `startedByConductor: true`), idle; the
CPU decider untouched.

### What remains

Step 5 is now done for the three models worth comparing. Open improvement areas: 5, 6, 9, 10 (none
blocks the item).
