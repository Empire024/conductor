# Verifier retrospective: V1, V2, V3, RV1 and V4 (2026-09-24 evening to 2026-09-25 midday)

This is a look back at how the verify loop (`.conductor/loops/verify.md` v2) actually ran, so that v3 is faster and more
accurate. Times are local (UTC+2) unless marked Z. "≈" means an estimate, and its basis is given.

Sources:
- the reports in `docs/verification/`;
- the executor logs in `.conductor-scratch/{v1,v2,v3-verify,rv1,verify-v4}/` and the RV1 logs in `%TEMP%\*.log`;
- the per-scenario logs `artifacts/v3-verify/results.md`, `artifacts/verification/2026-09-25-rv1/results.md`,
  `artifacts/verify-v4/*/result.json` and `.conductor-scratch/verify-v4/results.md`;
- the steer and dispatch files in `.conductor-scratch/*/steer*.json` and `%TEMP%\swarm\`;
- the live V4 transcripts, read with `agents.history`: judge `agent_mug7atbc_uuh0ra8` (3,652 events) and executor
  `agent_mug7fxq4_64ypujv` (18,261 events). The closed V1–V3 and RV1 tabs could not be read from control;
- `git log`.

## 1. Per round

| Round | Pair (brain / hands) | Dispatched → report | Wall | Planned (brief asked 10–25) | Items: VERIFIED / REOPEN / UNVERIFIED | Scenario rows with no result |
| --- | --- | --- | --- | --- | --- | --- |
| V2 conversation | Fable→Opus / Sonnet | 23:34 → 05:45 (cf451ba) | 6.2 h | 37 | 4 / 2 / 0 | 2 blocked (A3, A7); 7 rows redone after the judge rejected them |
| V3 app shell | Fable→Opus / Sonnet ×2 (handoff at 05:08) | 23:34 → 06:05 (6173483) | 6.5 h | 23 | 5 / 3 / 2 | 3 not run (S16–S18: installer guard refused by the classifier) |
| V1 local models | Opus / Sonnet | 02:06 → 04:39 (eda190a) | 2.5 h | 28 | 1 / 4 / 0 | 4 not run (S16, S22–S24) |
| RV1 re-verify | Opus / Sonnet | 07:58 → 11:04 (1b921f9) | 3.1 h | ≈60 | 4 / 3 / 0 | ≈23 not run, ≈8 not conclusive, 5 retracted as script bugs; the second pass could not be submitted |
| V4 panels/phone | Opus / Sonnet | 02:06 → not done at 12:10 | ≥10 h | 76 | open | ≈41 of 76 not run or blocked (all of E–G, C7/C10–C12, 5 in D) |

In total, 224 scenarios were planned and roughly 80 (≈36 %) ended NOT RUN, BLOCKED, inconclusive or retracted.
Four verifier pairs, eight tabs in all, ran at once on one serial smoke lock: V2 and V3 from 23:34, and V1 and V4 from
02:06. The FX4 and FX6 fixers were queuing on the same lock.

## 2. Where the time went (≈26.5 executor-hours of wall time in total)

| Bucket | Measured | ≈ Hours | Source |
| --- | --- | --- | --- |
| Waiting on a smoke that had already finished and hung in teardown | V4 group B wrote `result.json` at 02:43. Its background task ended only at 10:18, when a cleanup killed it, and the executor waited for that notification for 7 h 35 min. Group D did the same for ≥55 min. The V4 smokes end in a bare `await app.close()`, with no quit-dialog stub and no bound. V2's judge had diagnosed this exact hang at 02:02 (3 hung smokes; steer2, steer4), 27 min before V4's group B started, but the fix never reached V4. | 9–10 | V4 transcript `task_notification` times; `artifacts/verify-v4/B/*` mtimes; `scripts/smoke-verify-v4-b.mjs` tail |
| Queued on the smoke lock | Summed waits per run: V1 8.2 h across 25 runs (5 queued at once), V2 2.3 h across 26 runs, RV1 14.0 h across ≈40 runs. The longest single waits were 66 min (V1), 43 min (V2) and 95 min (RV1 `a-limits`). The sums overlap, so the wall-clock cost is lower but still large. | ≈5–7 wall | `[smoke-lock] waiting … (N s)` lines in every log |
| Writing and repairing per-round harnesses | 70 new scripts with 10,091 lines (v2 19/2,384, v4 8/1,331, v1 19/2,012, v3 12/2,655, rv1 12/1,709). Helpers were re-implemented over and over: `record` 34×, `call` 25×, `poll` 17×, `safeClose` 14×, `credential` 14×; 69/70 do their own temp profile. Reruns: V1 9 of 25 runs were `-retry`; V4 ran group A 3× and group C 4× for locators; RV1 retracted 5 rows as script bugs. | ≈5 | `scripts/smoke-{verify,v1,v3,rv1}-*.mjs`; the log names |
| Long and real-model runs during the day | RV1 D1 took 53 min and a retry, and both were inconclusive. D5 was capped at 60 min. The 6 h soak was killed by the 20-min lock timeout. A5–A8 found "local model busy" on every window. | ≈3 | RV1 results.md; `%TEMP%\d1-run*.log` |
| Idle judge | The V4 judge was active 7 min in 9.4 h: plan and dispatch at 00:06–00:11Z, then its watcher died unnoticed until 08:18Z. It cost $3.12 in 3 turns. The executor was active ≈0.5 h in 9.3 h and cost $13.63 (≈50 M tokens, mostly cache reads). | idle, cheap | `agents.history` usage items (turn cost estimates) |
| Executor stopped or lost | V1's executor ended its turn at 35 min with 19 of 28 not run (steer1). V3 needed a handoff tab. RV1's pass 2 was refused ("no longer accepts agents.submit"). | ≈1 | the steer files; the RV1 report |

## 3. Accuracy

Item-level REOPEN and UNVERIFIED verdicts from V1–V3 and RV1 (13), against what the fixes found:

| Outcome | Items | Evidence |
| --- | --- | --- |
| Real, confirmed by a fix (11) | Ideas never registered (338bbec); durable option style (338bbec) and second picker (47ddc8c); rollovers spending attempts (68b115e); local assist S4b, S7, S13b and S25 (1839003) and S11 (47ddc8c); Copy transcript below 20k (d9ae618); typing p95 (ed322d5, still open); S12 quit dialog (19306d3, reproduced "before"); S20 family lock (f675e46, 26 s → 0.7 s); D5 completion without evidence and D1 loop guard (47ddc8c) | the commit messages |
| Mixed (1) | V3 S2: the fixture sent no `command_lifecycle` receipts, so it stalled on correct code. The fix also repaired a real steer handover. No pre-fix real-CLI run exists. | 9ce9e3a; RV1 E1 (the old fixture still fails 3/3), E4 (real Claude passes) |
| False positive (1) | RV1 A2 "the process leaks at 600 s": the PowerShell `CommandLine -like '*marker*'` query matched its own command line. A5–A8's "busy" was then blamed on that non-leak. | 47ddc8c; `scripts/smoke-rv1-a-limits.mjs:164` |
| Unconfirmed | RV1 C10 (no relaunch after an Ideas explore) used a Playwright-launched app for `app.restart`, while every restart that passed used a raw spawn. RV1 F2 (the fix's own smoke failed 3/3 on a 5 s wait) was never re-run with 30 s. | `smoke-rv1-c-ideas-adversarial.mjs:34`; `rv1/pass2.md` |
| False negatives found | None in the data. RV1 marked 19c298e4 VERIFIED while its fix's smoke still failed; that is a risk, not a proven miss. | the RV1 report |

At scenario level, the executors produced about 25 FAIL rows that were not product bugs. The judge caught most of
them:
- V2: B1, B5 and B8 (Escape semantics); C6 (a non-`SYNTHETIC` prompt); D3 (a target below the journal floor); E3
  (a flat tab count); B4 (a fixture that does not behave like the CLI).
- V3: S7 (a workspace-mount race); S2-control (the fixture).
- RV1: 5 retracted, including a wrong method (`agents.transcript`), a wrong field (`idea.note`), a 30 s wait that was
  too short, and a regex that counted the steer prompts.
- V4, still unjudged: A8 (locator), C8/C9 (a flat tab count against a group chip), B3 (a DB-only seed), C1 (a CSS
  variable read on the wrong element).

The owner's own count is that the reviewers caught 12 of 28 "done" claims.

**What produced the catches.** By my classification, ≈16 of the ≈19 real catches came from scenarios written in the
owner's words or on the owner's real data:
- Ideas capture as the owner uses it; "can the local agent run vitest"; the owner's gate on prepare-deps;
  "saved tokens in control";
- the soak judged as an overnight job; the owner's long wizard conversation (the 20k floor);
- the per-family lock the owner asked for; "a toggle on the model I pick";
- the owner's real `feature-list.md` (V4 A11: the pane does not render) and the owner's old `[x]` items (V4 A6).

The generic hostile-input checklist yielded 2 catches (the 1 MB needle, and the endless command) from ≈40 scenarios.
Paths with spaces, binary files, unicode, emoji, clamps and 20 captures in 5 s all passed.

## 4. Top causes

**Lost time**
1. Hung teardown plus waiting on a notification with no deadline: 9–10 h (V4 B and D, V2). Every script re-implemented
   close, and V4 had not learned from V2.
2. Four rounds in parallel on one serial lock, plus fixers: waits of up to 95 min per run. The old 20-min takeover
   made runs overlap (V2/V3 reports); fixed in 2de1884, whose waiters now give up after 60 min.
3. Scenario inflation: 28/37/23/60/76 planned against a brief of 10–25, and ≈36 % never reached a verdict.
4. Per-round boilerplate and harness bugs: 10k lines, ≈5 h of writing and reruns.
5. Long, real-model and soak runs in the day lane: the soak was cut at 20 min, D1 was inconclusive twice, and perf
   numbers were invalid under llama-server load (V2 A1 p95 48.3 ms loaded against 23.4 ms quiet; FX10 log "no
   clean perf numbers yet").
6. Owner-gated steps met mid-run: the installer guard, stray-process kills and prepare-deps were refused by the
   classifier and left NOT RUN.

**Wrong verdicts**
1. Self-matching process and liveness queries (A2).
2. Fixtures that do not behave like the real CLI (S2 receipts, B4, C6).
3. Proxy measurements: tab counts, regexes over mixed items, the wrong DOM node, DB-only seeds.
4. Misattribution cascades (A5–A8 blamed on A2).
5. The launch mode differs from the passing controls (C10 Playwright against spawn).
6. Measurements taken under load (typing p95, A5–A8 "busy").
7. Waits that are too short for a loaded machine (C10/C12 at 30 s, F2 at 5 s).

## 5. Changes (the v3 drafts in `.conductor-scratch/verify-v3-draft/`)

| Change | Why (data) |
| --- | --- |
| One Opus verifier tab plans, writes, runs and judges. Sonnet or Haiku only as a runner that re-runs committed smokes unchanged. | The V4 judge idled 9.2 h while ≈25 false FAILs came from the executor side. The judge added value only when it read results actively (V2's 8 steers fixed 7 rows). The owner rule is that Opus implements. |
| At most 2 verifier rounds at once, and never more than 1 smoke queued per tab. | Waits of up to 95 min; 8 verifier tabs against a machine limit of 4 native coworkers. |
| Day lane: ≤12 scenarios per round, ≤3 per item, owner's words and real data first, ≤5 min each. Everything longer goes to the overnight lane. | Most catches came from owner-words scenarios; the generic checklist gave 2 of ≈40; 36 % never ran. |
| Overnight lane (00:00–06:00, quiet machine): soaks, real-model runs over 5 min, perf, real Claude. Queued in the plan and judged in the morning. | The soak was cut, D1 wasted 2 h, perf was invalid (owner: long tests only overnight). |
| Shared harness `scripts/verify-kit.mjs` (launch, owner call, workspace wait, safe close, watchdog, pid-tree check that excludes itself, load check, evidence writer), built once before the next round. | 10k lines of copies; V4 repeated V2's hang; RV1's script bugs. |
| Every wait has a wall-clock deadline, and the judge checks results every ≤30 min, not only when the executor settles. | The 7 h 35 min stale wait; the watcher died silently. |
| False-positive guard: a REOPEN needs 2/2 reproductions plus a control (the harness passes a known-good neighbour, or reproduces on the pre-fix build) and a clean artifact checklist. | A2, S2, C10, and the V2 and V4 proxy FAILs. |
| Perf only on a quiet machine, with a load record (no lock holder, CPU <30 %, GPU <40 %, no mid-turn tab; the thresholds of `schedule-gate.ts`). | V2 A1 at 48 against 23 ms; FX10 had no clean numbers. |
| Owner-gated steps are listed in the plan and asked once, before the run. | S16–S18 and the kill refusals, found mid-run. |
| NOT RUN is a first-class state: an item with a must-have scenario NOT RUN is UNVERIFIED, never VERIFIED. | RV1 verified 19c298e4 with its fix's own smoke still failing. |
