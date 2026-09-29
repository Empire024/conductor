# cpu-shadow-decider: escalate shadow fixed and proven (2026-09-29)

The final review (`2026-09-29-final-review.md`, "cpu-shadow-decider") rejected the item on two points:
the escalate shadow never fired (live `decisions.list`: Laya escalate asked 0), and the only smoke
predated 9167480 and f7e7c0b.

## Cause

`loopAssessed` journaled kind `escalate` only for a completed stage handed to the loop guard. The
controller asks the guard about a completed stage in one narrow case only
(`controller.ts`, open-ended job, stage changed no file and planned another implicit stage). A planned
job returns before it, and so did every soak job, so escalate was asked 0 times. (The review's
"only caller passes a pending stage" missed that call, but the effect it reported was right.)

## Fix

The escalation decision is the controller's own answer after every completed stage: go on (the next
stage, or finishing the job) or block for the owner. It is now reported at that point:

- `ports.ts` `StageConclusion`; `ControllerOptions.stageConcluded` / `DurableJobsServiceOptions.stageConcluded`.
- `controller.ts` calls it once per completed stage, after the answer is made: `continue` for a next
  planned stage, a finished job or an appended implicit stage; `escalate` with the block reason for
  the implicit-stage limit, the stall guard and a stage that says neither done nor what comes next.
  An observer failure is logged, never fails the stage.
- `model-intelligence/index.ts` `stageConcluded` journals kind `escalate` (requester `durable-jobs`,
  decided by `durable-jobs-controller`); the decider reads the stage and its result, never the
  controller's reason. `loopAssessed` now journals only `retry` (failed attempts), so the stall
  check is not journaled twice.
- `app-wiring.ts` `withStageCapture(…, concluded)` hands it on after the controller has answered;
  `src/main/index.ts` wires it to `modelIntelligence.stageConcluded`.

Nothing is live: escalate stays in shadow and the controller's answer is unchanged.

## Tests

- `controller.test.ts` "tells the stage-conclusion observer…": planned job → continue, continue;
  declining open-ended job → continue, continue, escalate ("not making progress"); no-status stage →
  escalate; a failed attempt → no conclusion.
- `shadow-decider.test.ts`: the loop guard's completed-stage call no longer journals escalate; the new
  test journals continue and escalate through the wrapped ports, with the controller as decider, Laya
  as system-one, the reason kept out of the decider's state, and `deciderAgreement(['escalate'])`.
- `vitest run src/main/durable-jobs src/main/model-intelligence`: 489 tests, all pass; `tsc --noEmit` clean.

## Smoke (parked, HEAD build)

`scripts/smoke-cpu-shadow-decider.mjs` gained section E (`--no-gpu`): durable jobs on a loopback
OpenAI-compatible stub (`CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT`, no llama-server) — a planned job whose
first attempt answers nothing and is retried, and an open-ended job whose stage reports no status —
and the final check now requires the decider asked for approval, retry, escalate, completion and
classify. `--no-gpu` skips C because the stub takes every local conversation of the launch and the
durable-jobs soak holds the GPU; no llama.cpp server was started. The decider is the CPU sidecar.

Run `wt-1790695524272`, 2026-09-29T15:25:53Z, detached worktree of 8507c9a plus exactly this change,
built with electron-vite, under `smoke-lock`, parked (`CONDUCTOR_TEST_USER_DATA`), `CONDUCTOR_TEST_DECIDER=1`,
`CONDUCTOR_OFFLINE_TESTS=1`: **8/8 PASS**, ok true.

- Decider listed by `local.servers`: CPU, 4 threads, gpu:false; pid 21328 on 127.0.0.1:51440; not on the GPU.
- approval: reviewer allow, Laya escalate 0.51 (2122 ms); second approval Laya escalate 0.45.
- route: scorer claude/sonnet, Laya agrees (854 ms); classify review/review; completion finished/finished.
- retry: loop guard `retry` after the empty first attempt, Laya retry 0.63 (the stub saw the retry prompt once).
- escalate: 3 records, one per completed stage, all `durable-jobs-controller`: `escalate` (open-ended job
  blocked: "Stage 1 finished without saying whether the objective is met or what comes next"), Laya
  escalate 0.56; `continue` ×2 (planned job), Laya escalate 0.58 / 0.57.
- `decisions.list` decider: route 1 (1/1), approval 2 (0/2), retry 1 (1/1), **escalate 3 (1/3)**,
  completion 5 (4/5), classify 1 (1/1).

Evidence: `artifacts/cpu-shadow-decider/runs.jsonl` (run `wt-1790695524272`),
`artifacts/cpu-shadow-decider/smoke-wt-1790695524272.log`.

Zero-shot Laya still leans to "escalate" on approvals and stage conclusions, as recorded in
docs/model-routing.md; that is why every kind stays in shadow.
