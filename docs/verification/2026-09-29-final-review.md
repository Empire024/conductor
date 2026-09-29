# Final independent review: every feature-list [x] since 2026-09-28 (2026-09-29)

Reviewer: agent_mumqlnae_4t3gege (Opus, fresh tab, built none of this work; read-only on product code).
Controller: agent_mump56zh_1t3kiav. Orchestration task: task_mumqlnh4_35xu5l4.

## Scope

Items flipped to `[x]` in `feature-list.md` since 2026-09-28, found with
`git log -p --since=2026-09-27 -- feature-list.md` plus `git diff feature-list.md` (uncommitted
flip of 21b9a1d6). 44 items. Not reviewed here, by instruction: durable-jobs-verification,
frontier-local-usefulness-20260928, production-agent (still open). The 2026-09-27 commits
(4c12c5a, 451b33b) are outside the window.

## Method and gates

- **G1 commit:** the implementing commit(s) exist and the diff contains each main claim (read the
  diff, not the message). Per-item file:line evidence: `.conductor-scratch/final-review/batch-A.md`
  … `batch-D.md` (Opus helpers, read-only) and this reviewer's own reads where noted.
- **G2 tests:** targeted vitest files per item (all passed; counts in the batch files), plus the full
  suite on HEAD feeae95 in a detached worktree:
  `npx vitest run` → 486 files passed, 1 skipped; 5373 tests passed, 54 skipped, **3 failed**, all
  "Test timed out in 5000ms" under machine load (GPU soak + parallel runs):
  `conversation-history.test.ts` (2) and `database-wal.test.ts` (1, the known 5 s flake). Rerun
  alone: still at ~5.2 s; with `--testTimeout=60000`: 11/11 pass. No in-scope commit touches them.
  `npm run test:scripts` → 197 pass, 0 fail, 3 skipped.
  Logs: `.conductor-scratch/final-review/fullsuite.log`, `scripts-tests.log`, `rerun-timeouts.log`.
- **G3 installed:** installed = `0.1.55-local.1790688605855`,
  `%APPDATA%/Conductor/local-updates/conductor-local-build.json` commit
  `fe86375fe3ea991b851702b08ecf45b707006ca7`, `dirty:false`; live control calls answer with that
  build string. `git merge-base --is-ancestor <c> fe86375` = yes for every implementing commit
  cited below (57 commits checked). feeae95 (after fe86375) changes only a doc, fixtures, scripts,
  one test and feature-list.md (`git show --stat feeae95`).
- **G4 behaviour:** a parked smoke or probe rerun by this review on a build of HEAD feeae95
  (detached worktree `.conductor-scratch/final-review/wt`, node_modules junction, built with
  electron-vite under smoke-lock), one at a time under `scripts/smoke-lock.mjs`, each launch parked
  (`CONDUCTOR_TEST_USER_DATA`); or a read-only live probe of the installed app over app control; or,
  where a rerun was not possible today, a verification record with commands and outcomes.
  Smoke logs: `.conductor-scratch/final-review/smoke-*.log`, run list `smokes-b1..b4.txt`.
  New parked probes written for this review (no product change):
  `.conductor-scratch/final-review/probes/` (P1-P3) and `probes2/` (Q1-Q6), each with `RESULTS.md`
  (commands, timestamps, exit codes, every check with observed values).

Constraints kept: no local model server started or stopped (llama-server pid 26392 of the soak ran
throughout); no Haftheme tab touched; installed app not restarted or updated; no product file
edited; no commit.

## Smokes and probes rerun on HEAD feeae95 (2026-09-29, 13:59-16:30 local)

| run | result |
| --- | --- |
| smoke-needs-attention | N1-N4 PASS (N2 republishedIn20s 0) |
| smoke-waiting-tabs | W1-W4 PASS (first run that includes fcd3558 + 33cf309) |
| smoke-tab-archive | L1, S1-S4, A1, K1, E1, L2 PASS |
| smoke-tab-archive-endpoint | E2a-E2d PASS, E2-info INFO |
| smoke-approvals-residual | 1-r0, 1-r1, 3, 4a, 4b PASS |
| smoke-full-auto-card | 6/6 PASS |
| smoke-restart-gap-resume | S1, S2 PASS, close clean |
| smoke-grant-interrupt | 3/3 PASS (retry ran 650 ms after approval, no "Interrupt and retry") |
| smoke-pasted-text-open | 4/4 PASS |
| smoke-workspace-clarity | S1-S6 PASS |
| smoke-agent-id-links | 13/13 PASS (incl. 4 detached-window palette checks) |
| smoke-agent-confirm | 5/5 PASS |
| smoke-codex-async-questions | Q1, Q2, Q3, control PASS (copy with only the load-admission assert logged instead of enforced: the GPU soak holds CPU at 86-94 %) |
| smoke-token-burn | **FAIL** at check 2 (meter 0, expected 6,420,000) — also fails now on the 14208ca and fe86375 candidate builds, although 14208ca passed it at 12:59; see codex-credit-burn |
| smoke-permission-grant | FAIL at check 3: expects card text "Approved once, and used"; since 19ba9c9 a used card shows the execution result ("Action succeeded", `data-grant-status="used"`). Stale smoke text, not a product defect |
| smoke-pasted-text (older, 47978c1) | FAIL at step 2: expects the chip to open an inspect dialog; 0f968a8 deliberately moved "Put back as text" to its own chip button. Stale smoke, not a product defect |
| probe P1 handoff-cross-provider | 16 PASS (4 refusals open nothing; Claude→Codex gpt-6-astra/xhigh keeps wand and coworker; rollback on a failing successor; Codex→Claude) |
| probe P2 cross-project-to-wizard | 11 PASS (tabs.open/submit/steer/router.dispatch by projectId reach Beta's wizard, reply returns; direct:true / workspaceId open a tab) |
| probe P3 coalesce-queued-messages | 3 PASS, 2 INFO (queued messages arrive as one; see note) |
| probe Q1 gap-H17 | 11 PASS (masking on write in journal, projection, snapshot, history, artifact; backfill masks pre-existing rows, records done) |
| probe Q2 gap-H16 | 6 PASS, 1 NOT RUN (real CLI timeout) |
| probe Q3 gap-H12 | 7 PASS (static block once; not after restart+resume; again after compaction / credential change) |
| probe Q4 gap-H14 | 6 PASS, 1 NOT RUN (real codex-cli) |
| probe Q5 gap-H06b | 3 PASS, 1 NOT RUN (queued run behind killed tree) |
| probe Q6 gap-H19 | 5 PASS (local-model refusals via a stub endpoint; no llama-server touched) |

Live read-only probes on the installed app (build 0.1.55-local.1790688605855):
`agents.lits` → "Unknown control method … in build 0.1.55-local.1790688605855. Did you mean agents.list? …";
`agents.history({…, bogusKey})` → "accepts only agentSessionId, limit, before, afterSequence, raw; bogusKey is not an argument";
`tabs.open({…, bogusKey})` → refused listing the accepted keys (incl. prompt), no tab opened;
`tools.list({prefix, brief})`, `tools.list({methods})` answer; `agents.status` is a read (burn
{tokensPerHour 3,971,486, reports 7}); `app.state` lists each project's `wizards`;
`models.route` returns an explained decision (N10 rank-2 floor exclusions, N18 `scoredCostUsd`
with `costBasis`, owner exclusions, fallback); `models.registry` shows per-field provenance;
`decisions.list` shows boundaries/agreement and the Laya decider: completion asked 32, classify 3,
**escalate 0, retry 0**.

Typing perf was not rerun: `perf-input` numbers are invalid while llama-server generates
(docs/perf and memory); accepted on the recorded record below.

## Verdicts

G1 = claims in the diff; G2 = targeted tests; G3 = in fe86375; G4 = behaviour shown.

| item | commit(s) | G1 | G2 | G3 | G4 | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| claude-full-auto-p0 | 19ba9c9, 0774d8c, ff8bc3d (+6fec9f3, c1b17d7 smoke; c56e2b8, b90490d docs) | yes | 442 pass | yes | installed A-K receipts under artifacts/full-auto-installed (execution plan :207-215); H rerun (tab-archive-endpoint E2) | ACCEPT |
| full-auto-ui-redesign | d42a1d4 | yes | pass | yes | smoke-full-auto-card 6/6 rerun | ACCEPT |
| waiting-tabs-stay-active | 93c049f, 66e7037, 14208ca, fcd3558, 33cf309 | yes | 224 pass | yes | smoke-waiting-tabs W1-W4 rerun | ACCEPT |
| eb5faab5 Needs attention | 14208ca | yes | 5/5 | yes | smoke-needs-attention N1-N4 rerun | ACCEPT |
| codex-credit-burn | 3ba57d5, 2fdd0d5, f6789be | **partial** | 197 pass | yes | **smoke-token-burn fails** | **REJECT** |
| 4538163d tab select/archive/continued-from | 97eafe9, 19ba9c9, 36da722 | yes | 36/36 | yes | smoke-tab-archive + -endpoint rerun | ACCEPT |
| typing-lag-long-conversation | 2892a5b (+ed322d5, b4dbb52) | yes | 20/20 | yes | recorded: 2026-09-29-typing.md:24,104-115 + raw logs .conductor-scratch/typing29/run-cand3-*.log | ACCEPT |
| typing-lag-under-test-load | 6251695 (+de10b49, 3329115, b4dbb52) | yes | 12/12 | yes | recorded: typing.md:165,180-199 + run-guard*.log | ACCEPT |
| permission-approval-delivery-classifier | 90f2501, c0330b1, 4daaa98, 50cea29, 404f175, f609f10, 3c508c0, f3ee077, bd5c09c, 0b79dee, 8d40298, cee677e, 121af3f, 3bdcb3d (fixes); 36da722, feeae95 (proof) | **no (clause 3)** | 392 pass | yes | clauses 1, 2, 4 shown (residual 5/5, grant-interrupt 3/3, workspace-clarity S5-S6 rerun; real-CLI records); **clause 3 unproven, clause 5 listing half unverified** | **REJECT** |
| cpu-shadow-decider | 9167480, f7e7c0b | **no (escalate)** | 35 pass | yes | **not rerun; only smoke predates both commits** | **REJECT** |
| model-intelligence-routing | 4df3653, a9b715f, a724171, be55034, 6e9c084, cd091c1, 8e60a17 | yes | 367 pass | yes | live models.route/registry/decisions on installed | ACCEPT |
| b5-agent-control | cee677e | yes | 336 pass | yes | recorded live on install (plan :150-151: waitCapped 90→50) | ACCEPT |
| b5-approvals | 50cea29 | yes | 108 pass | yes | smoke-agent-confirm 5/5 rerun | ACCEPT |
| b5-model-routing | be55034 | yes | pass | yes | unit tests replay the exact recorded N19/N20 repros (service.test.ts:287-308, evaluation.test.ts:302) | ACCEPT |
| b5-palette-detached | 61bfd66 | yes | 13/13 | yes | smoke-agent-id-links detached checks rerun | ACCEPT |
| b5-eval-phantom | 6e9c084 | yes | pass | yes | recorded real opus[1m] evaluation 7/7 (plan :158) | ACCEPT |
| b5-deliver-commit | da76a21 | yes | pass | yes | recorded b5d/e2e.log; installed build record itself came through app.update (commit fe86375, dirty false) | ACCEPT |
| b5-friction | da76a21 | yes | pass | yes | smoke-agent-confirm 5/5 rerun (409 path); b5f confirm-head fails before fix | ACCEPT |
| b5-eval-lean | cd091c1 | yes | pass | yes | recorded real run 4,985 tokens (plan :158) | ACCEPT |
| gap-H01 | c85daa2 | yes | pass | yes | live: this tab's briefing carries the ErrorDetails/curl.exe refusal route | ACCEPT |
| gap-H02 | fb8a219 | yes | pass | yes | live: this review ran through control({method,args}) | ACCEPT |
| gap-H03 | b155ec4 | yes | pass | yes | recorded real "queued behind" ship (plan :147); git.ship.status live | ACCEPT |
| gap-H04 | c85daa2, b155ec4 | yes | verify-kit 79/79 | yes | node --test verify-kit (the behaviour is the script) | ACCEPT |
| gap-H06 | c0330b1, 404f175 | yes | pass | yes | residual 3 (wizard answers), grant-interrupt rerun | ACCEPT |
| gap-H06b | 4daaa98, 404f175 | yes | pass | yes | probe Q5 3/3 | ACCEPT |
| gap-H07 | c85daa2 | yes | pass | yes | live tools.list({brief,prefix,methods}), agents.status read | ACCEPT |
| gap-H09 | 3bdcb3d | yes | pass | yes | live validateArgs refusal; P1 model refusals list offered ids | ACCEPT |
| gap-H12 | d31e403 | yes | 32 pass | yes | probe Q3 7/7 | ACCEPT |
| gap-H14 | 4daaa98 (+3bdcb3d) | yes | 63 pass | yes | probe Q4 6/6 (synthetic app server) | ACCEPT |
| gap-H15 | ba646aa | yes | 231 pass | yes | live unknown-method text; tools.list finish/interrupt text | ACCEPT |
| gap-H16 | b155ec4 | yes | pass | yes | probe Q2 6/6 | ACCEPT |
| gap-H17 | 95d1814, 50cea29 | yes | 28 pass | yes | probe Q1 11/11 incl. backfill | ACCEPT |
| gap-H18 | 95d1814 | yes | pass | yes | live: this tab's briefing (Write tool, no sleep-poll) and conductor-local instructions (background Bash for long runs) | ACCEPT |
| gap-H19 | 95d1814 | yes | 15 pass | yes | probe Q6 5/5 | ACCEPT |
| tabs-open-unknown-args | 221f1ee (+3bdcb3d) | yes | pass | yes | live refusal, no tab opened; tabs.open({prompt}) used by smokes rerun | ACCEPT |
| handoff-cross-provider | d185d31, 0b79dee | yes | pass | yes | probe P1 16/16 | ACCEPT |
| workspace-clarity | 121af3f | yes | pass | yes | smoke-workspace-clarity S1-S6 rerun | ACCEPT |
| cross-project-to-wizard | ddbc6fb | yes | 4 pass | yes | probe P2 11/11 | ACCEPT |
| restart-resume-finished-gap | 67bb754 | yes | 35 pass | yes | smoke-restart-gap-resume S1-S2 rerun | ACCEPT |
| agent-id-links-and-messages | 3608e48, 61bfd66 | yes | 26 pass | yes | smoke-agent-id-links 13/13 rerun | ACCEPT |
| codex-async-question-gui | 227286e | yes | pass | yes | smoke-codex-async-questions Q1-Q3 + control rerun (synthetic Codex) | ACCEPT |
| local-web-extraction-assessment | 0f5c607 | yes (browser fallback assessed, not built, as documented) | 58 pass | yes | recorded live before/after on dolphin (local-scraper.md:107-144, raw files); not rerun (needs a local model server) | ACCEPT |
| coalesce-queued-messages | 227286e (+214d21f) | yes | 5 pass | yes | probe P3 | ACCEPT (note) |
| 21b9a1d6 pasted text | 0f968a8 (+47978c1) | yes | pass | yes | smoke-pasted-text-open 4/4 rerun | ACCEPT (flip uncommitted) |

**Totals: 41 ACCEPT, 3 REJECT.**

## Rejections (back to `[ ]`)

### permission-approval-delivery-classifier
The item's own "Expected" line is the acceptance test. Clauses 1 (queued approval reaches a running
turn: residual 1-r1, grant-interrupt), 2 (a session grant makes the exact call pass: residual 4b,
probe-classifier-precedence 7/7 recorded in approvals-residual.md; the literal `cd … && … < file`
form can never match a rule and now gets a Deny-only card, documented) and 4 (steer within the
workspace; send_message crosses workspaces) are shown. Not shown:
1. **Clause 3, "request_permission is exempt from the classifier": no code.** No allow rule or
   other mechanism exempts `mcp__conductor__request_permission` (grep of src/main: the only
   allow rules are the owner's grant rules, `providers/claude.ts:338,646`), and
   `docs/permissions-classifier.md` "UNCONFIRMED" still says it is unknown whether the classifier
   judges conductor MCP calls. The only evidence is one real run where the call was not refused
   (approvals-tabs.md (c)), while the classifier refused nothing on demand in 14 attempts, so a
   non-refusal proves nothing. The recorded precedence result (an exact allow rule decides before
   the classifier in 2.1.282) suggests the fix: a launch allow rule for the request_permission tool,
   then a replayed-refusal or real check.
2. **Clause 5, "agents.list shows dispatched coworkers":** no cause was found and no check re-ran
   the reported case (a controller that router.dispatched coworkers into another project); since
   ddbc6fb such work goes to the target's wizard (probe P2), which changes the case but was not
   verified against this clause. approvals-tabs.md:119-120 says parts 4 and 5 were not re-verified.
   The "finished router.dispatch tab stays reachable" half is shown (121af3f; workspace-clarity S5-S6).
To close: add and prove the request_permission exemption; re-check clause 5's listing with a
cross-project router.dispatch (or have the owner restate it for the wizard route).

### codex-credit-burn
1. Fix (3) says "relay/coordinator roles default to medium effort **and short-lived fresh
   sessions**". Only medium effort exists (`agent-control.ts:133-141` coordinationRole, `:1446`,
   router.dispatch role `:2811`; 2fdd0d5's own message claims only the effort). Nothing turns a
   relay/coordinator over to a fresh session, caps its turns or context, or prompts a handoff.
2. G4: `smoke-token-burn.mjs` fails on HEAD (2 runs), and the same script now fails on the
   14208ca and fe86375 candidate builds too, although it passed on 14208ca at 12:59
   (`conductor-candidates/14208ca/artifacts/token-burn/result.json`): the turn reports 6.4M, but
   `tokenBurn.snapshot()` gives 0 for the tab within the 15 s poll. Not a code change between
   the builds, so it is time- or environment-dependent; the meter keeps each tab's measure for
   55 s (`token-burn.ts:15,45`), which may cache a measurement taken before the turn's usage row.
   The meter does work on real data on the installed app (agents.status burn above). Fix the
   smoke (or the cache race) so check 2 passes reliably.
   No smoke covers fixes (1) cross-workspace send or (4) limit-stop report (unit tests only,
   agent-control.test.ts); the item has no verification record.
   To close: build the fresh-session part of (3) or have the owner narrow the item text; make
   smoke-token-burn pass on HEAD; add a parked check of (1) and (4).

### cpu-shadow-decider
1. The item claims system-one "for approval/retry/**escalate**/completion/classify". The escalate
   shadow can never fire: `model-intelligence/index.ts:552-560` `loopAssessed` journals kind
   `escalate` only when `input.stage.status === 'completed'`, and its only caller
   (`app-wiring.ts:132-141` withStageCapture wrapping `loopGuard.assess`) is reached from
   `durable-jobs/controller.ts:460`, which always passes `stage: failed` with `status: 'pending'`
   (`:438`). Live `decisions.list` on the installed app: Laya escalate asked 0.
   ("Never live" holds by default: route/fallback are decided by the scorer first; any kind goes
   live only through the owner's `decisions.live`.)
2. G4: the only smoke run (smoke-cpu-shadow-decider 9/9, 11:47 local) predates both commits and
   was built from a separate worktree; there is no verification record. It was not rerun here
   because it starts the decider sidecar and today's constraint is to start no local model
   server. The live installed decisions.list does show completion/classify shadows journaled.
   To close: wire an escalate shadow for a completed stage (or drop "escalate" from the text),
   then run smoke-cpu-shadow-decider on a build containing f7e7c0b and record it.

## Notes on accepted items (open follow-ups, not blocking)

- **21b9a1d6:** code is committed (0f968a8, in fe86375); only the `[~]`→`[x]` flip is uncommitted.
  `scripts/smoke-pasted-text.mjs` (older 47978c1 smoke) is now stale at step 2 and fails; update it.
- **smoke-permission-grant.mjs:103** expects "Approved once, and used"; since 19ba9c9 the card shows
  the execution result. Update the smoke.
- **coalesce-queued-messages:** proven for messages that wait in Conductor's queue. During a running
  Claude turn, owner composer messages and agents.steer calls are each steered in immediately and
  separately (by design of steering), while `agents.steer` still answers `delivery:"queued"`,
  which misleads a caller. Worth an item if the owner meant "anything sent while a turn runs".
- **gap-H17:** before the backfill finishes (60 s after launch plus the walk, ~45 min on the owner
  journal), `agents.history {raw:true}` reads journal rows from the DB and can return a stored
  token unmasked (`agent-history.ts:120`, `structured-store.ts:492`). Small window; worth masking
  on read too.
- **gap-H06 / H06b** item text still describes the 2-min notice; 404f175 replaced it with an
  immediate interrupt by owner decision. Behaviour matches the newer decision.
- **claude-full-auto-p0:** `docs/verification/2026-09-28-full-auto-acceptance.md:44` and
  `2026-09-28-full-auto-recovery.md:3` still read "not yet run"/"in progress"; installed results live
  only in the execution plan (:207-215) and gitignored artifacts. `claude.ts:733` treats an
  acknowledgement with no mode as confirming the requested mode.
- **waiting-tabs-stay-active:** the owner's own Explorer-style bulk close can still close a waiting
  tab (owner-confirmed closes are exempt by design).
- **typing-lag-under-test-load:** the Playwright Chromium GPU priority follow-up
  (typing.md:208-218) has no open item of its own.
- **Full suite:** 3 timeouts under load (conversation-history.test.ts x2, database-wal.test.ts);
  pass with a longer timeout; unrelated to the reviewed items, but the 5 s default is tight.
- **handoff-cross-provider (P1):** a successor tab is titled "<A> (continued)" while refusal texts
  name it by its auto-title from the handoff's first line; two names for one tab.
