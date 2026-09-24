# Review items 3, 6, 7 and the small controller/index items (durable-jobs-review-fixes)

Worker: agent_mufcimjq_codvj3z (Opus), task task_mufciny8_enjnbgi, 2026-09-24. Builds on HEAD 85b9b0d
(F1 cacfc74, F2 + F3 85b9b0d, F4 462fc11 already fixed; not redone). Paths are under
`src/main/durable-jobs/` unless stated otherwise.

## (3) The server wait ignored pause and cancel

**Cause.** `serverPort.ensureReady` called `ServerSupervisor.ensureReady()` with no signal. While
another model held the one server, the supervisor slept `pollMs` (30 s) or a backoff delay (up to
2 min) and kept waiting for up to `waitForModelMs` (2 h). Pausing did not stop that wait. It kept
the job's loop alive, so `resume` (which awaits `controller.idle`) could hang for up to 2 h. A
cancelled job could also call `startServer` with `allowSwitch` after its quiet window.

**Fix.**
- `wiring.ts` `supersededSignal`: an `AbortSignal` per `ensureReady`/`recover` call. It aborts once
  the job's lease epoch moves on (owner pause or cancel, or a restart takeover). It is fed by
  `store.onChange`, so the controller port contract (`ports.ts`) is unchanged.
- `server-lifecycle.ts` `ensureReady(signal)`: every wait (loading grace, other-model poll,
  backoff) now ends when the signal aborts. The signal is checked again after each probe and right
  before `ports.ensure`, so a superseded job never starts or switches a model.
- The controller's `serverReady` already stops quietly when the job is no longer owned. The loop
  exits at once, and `resume` re-enters cleanly.

## (6) Pause during a running tool recorded a clean failure

**Cause.** `pause` (and `cancel`) settled every intended operation as `failed` without looking at
the stage conversation. A tool call cut off mid-run (a half-applied migration, a partial write) was
not recorded at all. The controller's pending-tool check never ran for it because the superseded
loop stops without writing.

**Fix.** In `index.ts`, pause and cancel run the pending-tool check themselves:
- `settleCutOff` reads `execution.pending` from the stage conversation, which is the same durable
  local-task checkpoint that the controller and reconciliation read. If a tool call is pending, the
  stage's model call is settled `unknown`, and the tool call gets its own ledger entry
  (`operationKindForTool`), settled `unknown`. It is never replayed.
- `interruptStage` checks again after the interrupt. A tool that started between the check and the
  interrupt is recorded too.
- A pause that cut off a tool says so in its status reason and sets the handoff's next action to
  inspect that call. `resume` notes unverified side effects for a paused job as well as a blocked
  one.

**Corrected `jobs.pause` catalog wording (for the owner).** This string lives in
`src/main/agent-control.ts` line 197, which is owner work and was not edited. Replace the
description with:

> `({jobId,reason?}) — the owner, a wizard tab, or the conversation that created the job; interrupts the running stage at once (there is no safe point to wait for), records a tool call it cut off as an unknown side effect that is never replayed, and starts nothing new; the interrupted attempt is not charged, and resume starts the stage again in a fresh conversation`

The old text said "the current step finishes at a safe point". That is wrong: pause interrupts
the conversation immediately.

## (7) A blocked job with a running stage re-blocked on every resume after a restart

**Cause.** `reconcileJobs` listed only `running` and `recovering` jobs. A job blocked with its stage
still `running` has a dead conversation after a restart. That happens in two cases: blocked on an
approval or a question in its conversation, or blocked by an earlier reconciliation on an unknown
side effect. The next launch never marked that conversation lost. When the owner resumed, the
controller re-attached to the dead conversation, read its persisted `waiting_approval` phase, and
blocked again, on every resume.

**Fix.** `reconcile.ts` `reconcileBlocked`:
- Blocked jobs are listed too.
- For a running stage whose conversation had not finished, the session is reported lost. The
  owner's resume then retries the stage once in a fresh conversation.
- A model call left `intended` is settled under a taken-over lease. An unknown effect updates the
  handoff's next action.
- The job stays `blocked`. A later launch with nothing left to settle writes nothing.

## Smaller items

- **Pause/cancel in the 3 s before reconciliation** (`index.ts`): the service now remembers the jobs
  a previous process left `running`/`recovering` until `start()` has reconciled them. `pause` and
  `cancel` on those jobs are refused with "Conductor is still reconciling this job after the
  restart…; try again in a few seconds." Jobs created by this process in that window are
  unaffected.
- **`<think>`-only answer counted as success** (`controller.ts`): `stageSucceeded` and
  `describeFailure` use `visibleContent` (handoff.ts), so an answer that is only a closed or
  unclosed reasoning block is not a completed stage.
- **Reconciliation added downtime to activeMs** (`store.ts` activeMs hunk only, `reconcile.ts`):
  `transition` takes an optional `activeUntil`. Reconciliation passes the time the dead process was
  last seen: its last event, or its last lease renewal (`lease.expiresAt - leaseTtlMs`).
  Limit: the renewal runs every `leaseTtlMs/3` (20 s), so a job that was quiet inside a tool call
  can be undercounted by up to 20 s per restart. The smoke shows this: 103 ms counted for about 14
  s of work. Before the fix, the whole downtime was counted as active.

## Verification

All commands ran on a `git archive` export of HEAD 85b9b0d plus only this change (`%TEMP%\dj-head`),
so they do not depend on other workers' uncommitted edits in the shared tree.

| Check | Command | Result | Log |
|---|---|---|---|
| New tests fail on HEAD | `npx vitest run controller/reconcile/server-lifecycle/wiring .test.ts` on the HEAD export with only the new tests | exit 1, **10 failed** / 53 passed | `review-items-3-6-7-failing-before.txt` |
| Suite passes with the fix | `npx vitest run src/main/durable-jobs src/main/durable-jobs-ipc.test.ts` | exit 0, **124 passed** (11 files) | `review-items-3-6-7-passing-after.txt` |
| Typecheck | `npx tsc --noEmit` | exit 0, no output | — |
| Shared working tree (with other workers' edits) | `npx vitest run src/main/durable-jobs` | exit 0, 138 passed | — |
| Re-block probe (7) | throwaway vitest probe: blocked on approval → restart → resume ×3 (not shipped) | HEAD: `blocked` after every resume, approvals 2 → 3 → 4, no new conversation. Fix: `completed` on the first resume, 1 approval, 2 conversations | below |
| Real restarts (7, index, activeMs) | `node scripts/smoke-durable-jobs.mjs --blocked-restart` (new mode) on `npx electron-vite build` of the export, isolated `CONDUCTOR_TEST_USER_DATA`, parked window | exit 0, **PASS** | `review-items-3-6-7-blocked-restart-smoke.txt` |
| Regression | `node scripts/smoke-durable-jobs.mjs --approval-gate` | exit 0, PASS | `%TEMP%\dj-approval-gate.err.log` |
| Regression | `node scripts/smoke-durable-jobs.mjs --restart-app` (pause/resume, tab close/reload, restart, cancel, approval) | exit 0, PASS (10:00:26–10:01:15 UTC; job paused → resumed → reconciled after relaunch → completed; cancel and approval extras passed) | `%TEMP%\dj-default.err.log` |

Probe output:
```
== HEAD ==
PROBE resume 1: status=blocked approvals=2 opened=1
PROBE resume 2: status=blocked approvals=3 opened=1
PROBE resume 3: status=blocked approvals=4 opened=1
== HEAD + fix ==
PROBE resume 1: status=completed approvals=1 opened=2
```

`--blocked-restart` (2026-09-24 09:57–09:58 UTC), step by step:
1. The stub model had the stage call `run_command sleep 120` (Docker). The app was hard-killed
   (`taskkill /T /F`, polled until no process held the profile) while the call ran.
2. Relaunch 1. An owner `jobs.pause` 7 ms after launch was **refused** with "Conductor is still
   reconciling this job…".
3. Reconciliation then blocked the job with "A side effect was in flight when Conductor stopped and
   its outcome is unknown". It recorded the cut-off `run_command` as unknown, and the stage was
   still `running`.
4. Hard kill again with the job blocked. After relaunch 2 and 8 s, the job was still blocked with
   the same reason and an **identical event list** (nothing rewritten).
5. One `jobs.resume`: `completed`, exactly one new attempt ("attempt 2 started"), **no re-block**.
   The stub model saw 2 requests in total, so the cut-off tool call was not replayed.

Unit tests added: `server-lifecycle.test.ts` (2), `wiring.test.ts` (2, the real `serverPort` under
the service's pause/resume and cancel), `controller.test.ts` (3: think-only answer, pause mid-tool,
cancel mid-tool including a tool that started during the interrupt), `reconcile.test.ts` (3:
approval-blocked stage across two restarts, activeMs excludes downtime, pause/cancel refused before
reconciliation).
