# App-control catalog and dispatch repairs (grok-agent-control-hunks, G6, jobs.pause, G7, G1, G3)

Orchestration task `task_mufdruim_roihc2t`, worker `agent_mufdruai_v8cqa1a`, 2026-09-24.

## What changed

| Item | Root cause | Change |
| --- | --- | --- |
| grok-agent-control-hunks | The owner's four working-tree hunks (Grok in the `tabs.open` text, the `models.list` provider filter, Grok planning under a planning controller, Grok in `agents.configure`) were in no commit. No durable-jobs `createdBy` hunk was left in the file. | Kept as they were and shipped with this file. New test: Grok is listed beside Codex and Claude, opens on Auto, opens in planning under a planning controller, and is configurable. |
| G6 | The `git.ship` text described every delivery as push plus release, and a local model's approval dialog always said "push … publish". `delivery.ts` defaults to a local commit. Also, app control validated `publish` and then **never passed it to `delivery.ship`**, so `git.ship({publish: true})` from an agent quietly made a local commit. | The catalog says a delivery is a local commit and only `publish: true` pushes, starts the release workflow and checks assets. The local approval text names the one that will happen. `publish: true` is now passed through, the same as the Source control panel's Publish switch. Who may call `git.ship` and when the owner is asked are unchanged. |
| jobs.pause | The text said "finishes at a safe point". | The corrected wording from `review-items-3-6-7.md`, verbatim. |
| G7 | `agents.steer` always called `StructuredSessions.steer`. Its followup path requires a live adapter and a phase in `starting…idle`, so an idle-but-unconnected, `interrupted`, `failed` or `disconnected` conversation got 400 "There is no active turn to queue behind". | New `StructuredSessions.steerOrStart` does what the composer does. While a turn is under way it steers or queues. When nothing is running it calls `submit`: one turn, same settings, same control link. While the conversation is still `interrupting` it refuses with a clear message. `agents.steer` returns `delivery: "started"` or `"queued"`, and the catalog states the idle/running/interrupted contract. |
| G1 | No zero-turn quota read. | `usage.limits({provider?})`. `StructuredSessions.emit` folds each provider usage event that carries `rateLimits`/`rateLimitsByLimitId` into one settings row (`usageLimits.latest`, at most 32 buckets per provider). That is a small latest-state record: the read never queries `structured_events`. Claude reports its keyed windows (five_hour, seven_day, Fable weekly model window). Codex reports each limit-id bucket's primary/secondary windows, merged across sparse updates, plus credits and plan type. Each window carries usedPercent, windowMinutes, resetsAt, observedAt, ageSeconds and its source conversation (named only inside the caller's project). A window past its resetsAt is `state: "reset"`. Grok, or any provider with nothing recorded, is `status: "unknown"` with the reason. Added to `tools.list` and `LOCAL_CONTROL_METHODS`, accepting only `provider`. It is read-only and carries no secrets. |
| G3 | `tabs.open` added `sandbox: 'read-only'` to every read-only dispatch. Only Codex advertises `sandboxModes`; the local adapter enforces read-only through `permission` (no write tools, no `run_command`, no Docker sandbox). The first `submit` failed `validateSettings` with "Execution sandbox unsupported by this provider". `router.dispatch` then left the tab open and the task blocked. | The sandbox mode is set only when the provider advertises it. Local read-only dispatch now works under the local runtime's read-only permission. Separately, a `router.dispatch` worker whose prompt was refused before any turn began (no user message, no active phase) gets its tab closed, its link released and its orchestration task removed, and the result says `tabClosed`. A worker that did or may have received its prompt keeps its tab, and its task is marked blocked as before. |

Files: `src/main/agent-control.ts`, `src/main/agent-control.test.ts`, `src/main/structured-sessions.ts` (steerOrStart and the allowance record only), `src/shared/usage-accounting.ts`, `src/main/local-models/tools.ts` (allowlist entry and its one-sentence description), `docs/agent-control.md`, the new `scripts/smoke-control-repairs.mjs`, and this file with its three logs.

## Evidence

| Check | Command | Result | Log |
| --- | --- | --- | --- |
| Failing before (HEAD sources, new tests) | detached worktree of `HEAD` in `%TEMP%\control-repairs-head`; `npx vitest run src/main/agent-control.test.ts -t "control catalog and dispatch repairs"` | exit 1, 9/9 failed for the expected reasons: Grok missing from the catalog, old git.ship and pause text, "There is no active turn to queue behind" (idle and interrupted), no `delivery`, "Unknown control method" for usage.limits, `accepted:false` with "Execution sandbox unsupported by this provider" for local read-only (full result appended), and no cleanup | `control-repairs-failing-before.txt` |
| Passing after | `npx vitest run src/main/agent-control.test.ts src/main/structured-sessions src/main/local-models src/main/usage-limit.test.ts src/main/project-task-dispatch src/main/remote-control-host src/main/phone-access src/main/durable-jobs/handoff.test.ts src/renderer/src/panes/usage-summary src/main/providers/local` | exit 0, 33 files, 709 tests | `control-repairs-passing-after.txt` |
| Typecheck | `npx tsc --noEmit` | exit 0 | — |
| Build | `npx electron-vite build` | exit 0 | — |
| Live, isolated profile | `node scripts/smoke-control-repairs.mjs` (parked window, `CONDUCTOR_TEST_USER_DATA` in `%TEMP%`, offline Claude fixture with `CONDUCTOR_TEST_CLAUDE_QUOTA=fable`, the already-running Qwen 3.5 9B server) | exit 0, `pass: true` | `control-repairs-live-smoke.json` |

The live run through the real control endpoint:

- **Catalog.** `tools.list` returned the new git.ship, jobs.pause and agents.steer texts, and usage.limits.
- **G1.** The synthetic Claude runtime sent a raw `rate_limit_event` while it initialized, before any model turn. It went through the production ClaudeAdapter parser. `usage.limits` then returned Claude five_hour 24 %, seven_day 95 % and Fable weekly 99 % (model scope `fable`), with resetsAt, observedAt, age and the controller as source. Codex was `unknown`. Grok was `unknown` with "does not report…". `provider: "openai"` got 400.
- **G1 persistence.** After a `taskkill /T /F` of the whole app, the stopped profile's `settings` row `usageLimits.latest` held the Claude buckets. After relaunch, the owner credential's first `usage.limits` read returned the same values with the pre-restart observedAt (`firstReadFromKeptRecord: true`).
- **G7.** On a new Claude coworker, `agents.steer`:
  - idle: `started`, and the turn completed;
  - from completed: `started`, and the turn stayed running;
  - while running: `queued`; the runtime acknowledged it inside the running turn, and the phase stayed `running`;
  - after `agents.interrupt`, phase `interrupted`: `started`, and the turn completed.

  Each prompt appears exactly once among the user messages.
- **G3.** `router.dispatch` of `local/qwen3.5-9b` with `permission: "read-only", exactPermission: true` returned `accepted: true`, with settings `permission: read-only` and no `sandbox`. The worker completed in 53 s using only `list_files` (20 completed and 1 failed on a `.git/refs` file). `git status` of the project was byte-identical before and after. No llama.cpp server was started.
- Not claimed: the local model wandered into `.git` and ended on the local output limit. That is model behavior, covered by G5, not by this dispatch fix.

## Not done / notes

- `feature-list.md` was not edited. It is owner work under the batch rules, so the grok-agent-control-hunks checklist item is left for the controller or owner to tick.
- `remote-control-host.ts` and `phone-access.ts` still call `sessions.steer` for their own `agents.steer`/steer modes. Those files belong to others; routing them through `steerOrStart` would give paired machines and the phone the same idle behavior.
- The G6 publish pass-through is a behavior fix, not just text: before it, an agent's `git.ship({publish:true})` never pushed. Coworkers are still told never to pass `publish: true`, and the controller's batch publish now actually publishes.
