# Schedules, the latest-models check, and Auto Fixer gaps

Design only. Implementable by one worker; no code was changed.

## 1. Schedule core (deterministic, testable without timers)

`src/shared/schedules.ts` (new) — `ScheduleDefinition {id, projectId, name, jobId, enabled, everyMinutes, catchUp:'collapse', timeoutMs, lastRunAt, nextDueAt}`, `ScheduleRun {id, scheduleId, startedAt, finishedAt, outcome:'unchanged'|'changed'|'dispatched'|'skipped'|'failed'|'stale', detail, digest, validUntil}`, plus pure `nextDue(schedule, now)` and `dueNow(schedules, now)`. All scheduling maths lives here so tests pass a clock, never a timer.

`src/main/schedule-store.ts` (new) — sqlite tables `schedules` / `schedule_runs` created with the same `ensureTables` + `makeId` style as `src/main/orchestration-store.ts:47-135`. Prune to the newest 50 runs per schedule. `nextDueAt` is persisted so a restart cannot re-fire a run that already happened.

`src/main/schedule-runner.ts` (new) — one `setInterval(30_000)` owned by `src/main/index.ts` (same lifecycle slot as the existing timers there; dispose on quit). Bounded execution:

- `private running = new Set<string>()` per schedule, **and** a global cap of one concurrent job (`docs/machine-profile.md`: smokes one at a time).
- Missed windows collapse: at most one catch-up run, never a backfill loop.
- Every run is inserted as `running` *before* the job executes and finalized in `finally`, so a crash leaves evidence rather than a lost run; rows still `running` after `timeoutMs` (default 120 s) are reconciled to `failed` on next tick.
- An `AbortController` passed into the job; a job that ignores it still loses its slot at the timeout.

## 2. The preconfigured "latest models/methods" check — no model turn when unchanged

`src/main/schedule-jobs/latest-models.ts` (new), registered in a small `src/main/schedule-jobs/index.ts` job registry keyed by `jobId` so schedules store an id, never a prompt or a URL from the UI.

1. Sources are a **const array in the repo** (https origins only, allowlisted host per source), plus one local source: the `models.list` catalog from `ProjectTaskDispatcher.options()` (`src/main/project-task-dispatch.ts:75-95`).
2. Conditional fetch: send stored `If-None-Match` / `If-Modified-Since`. `304` → outcome `unchanged`, zero tokens, zero dispatch.
3. `200` → normalize (strip nonces, CSRF, build stamps, timestamps), sha256 → compare to the stored digest. Equal → `unchanged` (servers that never send ETags still cost no turn).
4. Only a changed digest writes a sanitized extract to the app data dir and dispatches.
5. Result validity: store `fetchedAt`, `etag`, `digest`, `validUntil = fetchedAt + ttl`. Past `validUntil` the stored answer is reported `stale` in the UI; it is never silently reused as if fresh.

Fetch budget per source: 10 s timeout, ≤256 KB body, no cross-origin redirects, no cookies, response parsed as text only.

## 3. Strongest capable coordinator, local/cheap workers

`src/shared/model-routing.ts` (new) — `capabilityRank(provider, modelId): 0..3` encoding the ladder in `docs/token-thrift-policy.md` (frontier / strong / cheap / local). In `ProjectTaskDispatcher.autoTarget` (`src/main/project-task-dispatch.ts:178-196`) sort `usable` by **rank first**, then `remainingPercent`, then `source==='runtime'`, then `isDefault` — today it picks the emptiest bucket, which can hand architecture work to a cheap model. Add one line to `AUTO_FIXER_INSTRUCTIONS` (`src/shared/orchestration.ts`) pointing workers at `docs/token-thrift-policy.md` so the coordinator's own `router.dispatch` calls go local/cheap; the dispatch rules there already exist.

## 4. Auto Fixer creates a workspace when there is none

`src/main/project-task-dispatch.ts:120-140`. For `target.type==='auto'` only: if `options.workspaces` is empty, call `database.createSession(projectId, 'Automation')` (`src/main/database.ts:792`) and re-read `this.options(projectId)`. Do it **after** task/revision validation and after `autoTarget()` succeeds, so a doomed dispatch never leaves an orphan workspace. Broadcast the new workspace on the same channel `index.ts` uses for session changes, or the tab opens into a workspace the renderer does not know about. An explicitly supplied but missing `sessionId` still fails as today. Extend `ProjectTaskDispatchTarget` (`src/shared/project-backlog.ts:63`) so `auto` takes `sessionId?: string`.

## 5. Allowance evidence without an already-open tab

`src/main/allowance-probe.ts` (new). Build an ephemeral `AgentSpec` (no `PaneTab`), then `sessions.ensure` → `connectSession` → `refreshUsage` → dispose. Codex answers `account/rateLimits/read` with **no model turn** (`src/main/providers/codex.ts:492`). Probe results land in the durable event journal that `autoTarget` already reads, so there is no second evidence path.

Claude has **no** `refreshUsage`; its windows arrive only from `rate_limit_event` inside a stream (`src/main/providers/claude.ts:530`). Do not spend a Claude turn per tick. Either add a genuine non-turn read to the Claude adapter, or leave Claude `unknown` and let the runner say "needs allowance evidence" — `autoFixerAllowance` already refuses safely on stale buckets (`project-task-dispatch.ts:34-56`); keep that refusal, do not weaken it to get a schedule to run.

## 6. Visible controls and history

- `src/renderer/src/components/Sidebar.tsx:117` — replace `unfinished: true` with `utility: 'schedules'`; add `'schedules'` to `WorkspacePanel` (line 94).
- `src/renderer/src/App.tsx:139` (persisted-panel allowlist), `:278-281` (header label), `:1459` and `:1503` (drawer render).
- `src/renderer/src/components/SchedulesPane.tsx` + `.css` (new): per schedule — enabled toggle, interval, next due, last outcome, **Run now**; run history showing outcome, digest short-hash, validity/`stale`, and a link to the extract. No URL or prompt is editable from the UI.
- `src/main/schedule-ipc.ts` + `src/preload/schedules.ts` (new), mirroring `src/main/orchestration-ipc.ts`; add the channel names to the preload allowlist or the pane silently does nothing.

## 7. Security and test pitfalls

- **SSRF**: job ids and allowlisted origins are code, never IPC input. Validate `projectId`/`scheduleId` with the existing `validId` shape.
- **Turn leakage**: assert in a test that an unchanged check performs zero `submit`/`steerAccepted` calls.
- **Overlap**: test that a second tick during a slow run records `skipped`, not a second run; test that a 3-hour outage yields exactly one catch-up.
- **Crash evidence**: test that a `running` row past `timeoutMs` becomes `failed`.
- **Workspace side effect**: test that a failing auto dispatch creates no workspace, and a succeeding one creates exactly one.
- **Allowance**: test that a stale bucket still refuses, and that a Codex probe emits usage events without a turn.
- Timers in tests: inject the clock and tick function; never `setInterval` in a unit test.
