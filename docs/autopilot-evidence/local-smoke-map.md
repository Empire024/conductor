# Local Smoke Map — smoke-durable-jobs.mjs

1. **Launch environment (parked windows)**: Lines 116–125 set `CONDUCTOR_TEST_USER_DATA` to a temp profile and `delete env.CONDUCTOR_BACKGROUND_WINDOWS`. Line 204 of `src/main/index.ts` defaults `backgroundWindows` to `true` when `CONDUCTOR_TEST_USER_DATA` is set (the `??` fallback). So windows are parked off-screen even though the script deletes the env var — the app's own logic restores the default.

2. **--restart-app branch** (lines 240–249): Saves `before` status, closes the app (race-limited 20s), kills the process, relaunches on the same profile, asserts `after.id === job.id`, and observes the job after relaunch.

3. **>1000 event history**: **Not exercised** — the script contains no code that injects >1000 events nor asserts on event count. `CONDUCTOR_TEST_EMPTY_HISTORY: '1'` starts with empty history.

4. **llama-server killed in stub mode**: **Explicitly prevented** (line 34) — `--kill-server` throws if `--real-model` is not set: "there is no llama-server to kill in stub mode".

5. **Identity/reconcile assertions**: `assert.equal(after.id, job.id)` (line 248); `waitFor` accepts `running|completed|blocked` (line 250). This is not proof of successful completion.

Controller checked the source and corrected the remaining line references after one local repair. The first draft's parking inference was rejected. Size/scope acceptance proved only the bounded write, not factual accuracy. No smoke ran.
