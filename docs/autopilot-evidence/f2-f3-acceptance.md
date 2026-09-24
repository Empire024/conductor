# F2 + F3 acceptance (durable-jobs-review-fixes items 1 and 2)

Worker: agent_mufbsk96_b6astk1 (Opus), task task_mufbsl2h_i7kef16, 2026-09-24.
Paths are under `src/main/durable-jobs/` unless stated otherwise. Raw logs are in the git-ignored
`artifacts/autopilot/` folder on this machine (listed at the end).

## F2: an approval block held local generation capacity

**Cause.** `gatedRuntime` released the `LocalGenerationGate` only when it saw a settled phase or on
interrupt. When the controller saw `waiting_approval`/`waiting_input`, it blocked the job, released
the job lease and stopped observing the conversation. After that, nothing ever released the gate.
A second job then showed `running` forever, queued in `gate.acquire`. If the owner resumed the
first job, it queued behind the second job's controller slot, so both jobs deadlocked.

**Fix.**
- `wiring.ts` `gatedRuntime.observe`: while a conversation waits on the owner, the gate is released
  and the attempt stays *parked*. A parked attempt keeps the baseline from its original submit.
- `wiring.ts` `gatedRuntime.reattach(id)` is new. On resume, if the same conversation is generating
  again (the owner answered in the tab), it takes the gate again, queued behind any current holder,
  before the controller watches the attempt. It never resubmits the prompt. It does not take the
  gate while the conversation still waits on the owner (the controller blocks again at once) or
  after it has stopped. If an interrupt arrives while it waits for the gate, it gives the gate back.
- `controller.ts`: the re-attach branch of `runStage` calls `runtime.reattach?.()` inside its slot,
  before `wait`. `ControllerOptions.runtime` gained an optional `reattach` method; a runtime
  without a gate leaves it out.
- `server-lifecycle.ts`: `LocalGenerationGate.acquire(jobId, signal?, { yieldToInteractive })`.
  With `false`, the caller queues behind the holder only. Re-attach uses this because a local
  conversation's own turn counts in `localTurnsInFlight()`. Otherwise a resumed generation that is
  already under way would yield to itself for up to `maxYieldMs` (30 min).

**What the owner's answer can and cannot gate.** The owner answers in the tab, outside the job
runtime, so generation can resume before the job is resumed. That generation is the owner's own
interactive action. It counts as an interactive local turn, so other jobs' `acquire` yields to it.
The job's supervision of that attempt, and every later job generation, runs under the gate again.

**Reachability in the real app.** The local adapter never enters `waiting_approval` or
`waiting_input`: `providers/local.ts` `respond()` throws "Local models do not raise approvals or
questions". A local job's approval block in the running app goes through a different path. The
watchdog records two identical refusals, which produce an approval verdict. The attempt is then
interrupted, and `gatedRuntime.interrupt` already released the gate there before this change. So
the starvation lives in the `StageRuntime` port contract (the needs-owner path in `controller.ts`
`conclude`). The unit tests below reproduce it. The runtime smoke guards the real-app lifecycle but
does **not** reproduce the starvation. This smoke was not run on the pre-fix build.

### Tests (failing first)

`wiring.test.ts` > "generation gate across an approval block". These use a real `LocalGenerationGate`
with `gatedRuntime` over `FakeRuntime`, driven through `DurableJobsServiceImpl` and the controller:
1. *releases local generation capacity while a job waits on an approval, so a second job runs.*
   Before the fix: `Error: second job starved: running, gate held by the blocked job` (two-job
   starvation).
2. *resumes the answered approval in the same conversation only after reacquiring the gate behind a
   running job.* The second job holds the gate while the first is resumed. The first does not take
   the gate until the second settles, then holds it until it completes. Exactly once: the same
   conversation is used (`opened` has 2 entries for 2 jobs), no second prompt, attempt 1, one
   model-call operation `done`, and one approval event. Before the fix: `Condition not reached in
   time` (the second job never got the gate).
3. *blocks again without holding the gate when resumed before the approval is answered.* Before
   the fix: `expected 'job_…' to be null` (the blocked job held the gate).

`server-lifecycle.test.ts` > "re-attaching a generation already under way queues behind the holder
but does not yield to interactive work" (new option, passing).

### Runtime proof on an isolated profile

`node scripts/smoke-durable-jobs.mjs --approval-gate` uses the stub model. The app is launched with
`CONDUCTOR_TEST_USER_DATA` set to a temp profile, parked off-screen. It exited with **exit 0** at
2026-09-24T09:35:56Z, on a build from `npx electron-vite build` (exit 0). That build is of the
shared working tree, which also held other workers' uncommitted `store.ts`/`index.ts`/ipc changes.
- 09:35:40 An approval job (APPROVAL-CASE) is blocked: "Stage 1 needs the owner's permission:
  run_command was refused 2 times …". There is one `approval` event.
- 09:35:48 A second job created while the first is blocked **completed**, and the first job stayed
  `blocked`.
- 09:35:48–49 The app was closed and relaunched on the same profile (pid 17568 → 46372).
- 09:35:49 After the restart, the first job was still `blocked` with the identical `statusReason`
  and the same approval event ids.
- 09:35:56 The owner had done the step (the stub now answers). `jobs.resume` → the job
  **completed**. It still has exactly one approval event and one stub generation after the resume.
  Counters: stagesCompleted 1, retries 1.

## F3: the tool-call timeout was never applied

**Cause.** `supervisionPorts().watchdog.watch` only ever started `model-call` watches. A running
tool that printed nothing (a test suite, a build) looked like a silent model call. After
`stallAfterMs` (3 min), with a healthy, non-processing server, it was interrupted as `stalled`.
`toolCallTimeoutMs` was unused.

**Fix (`wiring.ts`).** When `scan` sees a tool item in `preparing` or `running`, it ends the
model-call watch and starts a `tool-call` watch for that tool (key `<stage>:tool:<name>`). In the
Watchdog, silence is a stall only for a model call, and a tool-call watch is stopped at
`toolCallTimeoutMs` with no extension. When the last running tool finishes (completed, failed,
rejected or interrupted), a new model-call watch starts. A tool-call stop reads "the tool call
`<name>` ran past its `<N>`s tool-call budget". Only completed and failed tools feed the loop guard
and the refusal count, as before. `watchdog.ts` needed no change.

### Tests (fake clock, failing first)

`wiring.test.ts` > "supervision ports". These use a fake `now`, and the clock moves at most a
minute per tick. The budgets are: model 10 min, tool 15 min, stall 3 min, and the probe reports
healthy but not processing.
1. *gives a quiet running tool the tool budget, past the model timeout, then watches the model
   again.* A running tool lasts 12 min (more than the model timeout, less than the tool timeout)
   and **survives**. After it finishes, 4 min of model silence is stopped as a stall. Before the
   fix: stopped at `no progress for 180s and the server is not processing`.
2. *stops a tool that runs past the tool budget, and not before.* It is still running at 14 min and
   **stopped** at 16 min with "run_command ran past its 900s tool-call budget". Before the fix:
   stopped at 180s as a stall.
3. *still stops a silent model call as a stall when no tool is running* (model-stall regression).
   It passed before and after the fix.

A runtime quiet-tool run in the app (a tool that is silent for more than 3 min under the stub) was
not done. F3 is proven by the fake-clock tests only.

## Commands and results

| Command | Result |
|---|---|
| `npx vitest run src/main/durable-jobs/wiring.test.ts` (before the fix) | exit 1: 5 failed, 10 passed |
| `npx vitest run src/main/durable-jobs/` (after the fix) | exit 0: 10 files, 112 tests passed |
| `npx tsc --noEmit -p .` | exit 0 |
| `npx electron-vite build` | exit 0 |
| `node scripts/smoke-durable-jobs.mjs --approval-gate` | exit 0 |

Local logs: `artifacts/autopilot/f2-f3-failing-before.txt`, `f2-f3-passing-after.txt`,
`f2-f3-typecheck.txt`, `f2-f3-build.txt`, `f2-smoke-approval-gate.log` (timeline),
`f2-smoke-approval-gate.json` (smoke summary).
