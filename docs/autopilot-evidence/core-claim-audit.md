# S3a core claim audit

Audit time: 2026-09-24. Worker: Grok, orchestration task `task_muerh5me_8f41end`. Scope owned: this file only. `feature-list.md`, `src/main/agent-control.ts`, `docs/autopilot-brief.md`, `docs/autopilot-backlog.md`, and `docs/autopilot-evidence/claim-matrix.md` were not modified. No checklist item was marked done or reopened.

Status: **source audit settled.** Partial coverage: all 40 checked claims stay **unverified**, and thirty were not opened. No production edit and no commit from this worker. Queue, as recorded for the controller's handoff: F1 event-history repair is active and exclusively owned by `agent_muerw1fu_a33x86v` (`src/main/durable-jobs/` store, controller, wiring, index, report, and their tests). F2 generation-gate and F3 watchdog are queued, not active. No generation-gate implementation is assigned.

Method: read current source and existing tests/docs. This worker did not run vitest, `npm run build`, `npm run dev`, a model, or an Electron smoke. The controller reports the baseline full working-tree run now passed: 256 files, 3020 tests, plus 65 script tests. That green run supports unit-level findings only where a relevant test was read and is in that suite. It is not runtime or restart acceptance. The durable-job P0s below are still in source after that run, so the suite does not cover them. A missing smoke is **unverified**, not failed. **failed** is used only when source contradicts a checked claim. None of the 40 was contradicted by source that was opened. **verified** would require runtime or restart evidence; none was read.

## Commands

| Command | Exit | Log |
| --- | --- | --- |
| `node` extract of `[x]` claims in `feature-list.md` matching durable/orchestration/recovery/persistence/schedules/provider | 0 | none (stdout only) |
| `git diff --stat -- src/main/agent-control.ts` | 0 | working tree: 8 lines, 4 hunks |
| `git diff -- src/main/agent-control.ts` | 0 | stdout; hunks quoted below |
| `git log -1 --format="%h %ci %s" bb9b8f2` (as `git log -1` of `src/main/providers/grok.ts`) | 0 | `bb9b8f2 2026-09-24 01:21:21 +0200 Add Grok as a native provider over ACP` |
| `git log -1 --format="%h %ci %s" 03aed7b` | 0 | `03aed7b 2026-09-24 00:57:16 +0200 Add durable overnight local-model jobs` |
| `git log -1 --format="%h %ci %s" 51d2fb7` | 0 | `51d2fb7 2026-09-24 01:30:55 +0200 Fix what the real Qwen durable-job run exposed` |
| `git log -1 --format="%h %ci %s" -- src/main/durable-jobs/controller.ts` | 0 | same `51d2fb7` |

No test or build log was produced.

## Open item: `durable-jobs-review-fixes`

Checklist: `feature-list.md:2`, still `[ ]`, marker `conductor-task:durable-jobs-review-fixes`. Not a completed claim. Implementation commits cited by the item are `03aed7b` and `51d2fb7` (both 2026-09-24, about the same night as this audit). Findings below are against the tree as read, not against those SHAs in isolation.

There is no checked durable-jobs delivery claim. Acceptance remains the open item `durable-jobs-verification` (`feature-list.md:3`). `docs/durable-jobs.md:56` says a restart gap counts as elapsed, not active. `store.ts:329` adds that gap into `activeMs` when a still-`running` job leaves `running` on reconcile. That doc sentence is false relative to the store.

### Confirmed (P0 first)

1. **Approval block holds `LocalGenerationGate`.** P0. `gatedRuntime` acquires the gate in `submit` (`wiring.ts:290-293`) and releases only when `observe` sees a settled phase (`wiring.ts:268-298`: `completed|failed|interrupted|disconnected|missing`) or on `interrupt` (`wiring.ts:301-302`). `waiting_approval` is not settled. `wait` returns `needs-owner` without interrupting (`controller.ts:334`). `block` (`controller.ts:192-200`) transitions to `blocked` and releases the lease, not the gate. The next job's `submit` waits on `LocalGenerationGate.acquire` (`server-lifecycle.ts:253-255`) while its stage is already `running`. `controller.test.ts:100` asserts the session stays `waiting_approval`; no test asserts `gate.holder()` is clear afterwards. `server-lifecycle.test.ts:137-150` covers release only when `release()` is called.

2. **Tool runs are watched as model calls. `toolCallTimeoutMs` is never applied.** P0. `wiring.ts:144-167` only `begin('model-call')`. A tool item ends that watch and starts another model-call only once its status is `completed` or `failed` (`wiring.ts:161-167`). Until then the open watch is the previous model call, so a quiet test/build is judged by `modelCallTimeoutMs` and the stall rule (`wiring.ts:187-189`, `watchdog.ts:145`). `Watchdog.begin('tool-call')` exists and is unit-tested (`watchdog.test.ts:56`, `watchdog.test.ts:76`) but production wiring never starts that scope.

3. **`ensureReady` is not cancelled.** P0. `ServerSupervisor.ensureReady(signal?)` honors `signal.aborted` (`server-lifecycle.ts:152-165`) and otherwise waits up to `waitForModelMs` default `2 * 60 * 60_000` (`server-lifecycle.ts:100`). The port has no signal (`ports.ts` `ensureReady(model, context?)`). `serverPort` calls `.ensureReady()` with none (`wiring.ts:239-241`). `controller.serverReady` checks `owned()` only after the await (`controller.ts:302-304`). Pause/cancel during that wait does not abort, and the loop can still `ensure({ allowSwitch })` (`server-lifecycle.ts:169-170`).

4. **`events(id, undefined, 1000)` is the oldest 1000.** P0 for a long job. `store.ts:244-248` is `seq > after ORDER BY seq LIMIT` (oldest forward). No tail query. Consumers that then `.at(-1)` or filter miss newer rows once seq exceeds 1000: elapsed-budget restart note `controller.ts:228`, same-failure previous errors `controller.ts:395`, replan restore `wiring.ts:128`, and `service.report` `index.ts:249`. `lastEvent` (`store.ts:251-253`) is newest-one only. `generateDurableJobReport` does page (`report.ts:191-196`) but `DurableJobsServiceImpl.report` does not call it. `jobs.events` documents a 200-event page (`docs/durable-jobs.md:106`); the report path does not use that page.

5. **`redactSensitive` is not applied on the ledger or the report.** `redactSensitive` / `redactData` run in watchdog emit, loop-guard evidence, and server emit (`watchdog.ts:301`, `loop-guard.ts:202`, `server-lifecycle.ts:126`). `store.insertEvent` stores `message` and `data` raw (`store.ts:177-179`). `intend` stores `description` raw (`store.ts:385-389`). `saveStage` / `transition` pass event data through (`store.ts:374-378`, `store.ts:335`). Tool arguments are copied into the operation description (`controller.ts:406`). `extractHandoff` / `writeDurableJobReport` do not redact (`report.ts:175-180`). A secret in a tool argument, `lastError`, last answer, next-action, or handoff is persisted and can land in `report.md`.

6. **Pause marks in-flight operations failed and skips the pending-tool check.** `index.ts:199-207` supersedes, settles every `intended` op as `failed` with "Interrupted by the owner's pause", and interrupts. It does not read `execution.pending`. Contrast the failure path, which records `unknown` when a tool was pending (`controller.ts:401-410`), and reconcile, which does the same (`reconcile.ts:54-60`). `jobs.pause` says the current step finishes at a safe point (`agent-control.ts:197`). The implementation does not wait for a safe point. `agent-control.test.ts:1471` only asserts status `paused`.

7. **Reconcile skips `blocked` jobs whose stage is still `running`.** `reconcileJobs` lists only `running` and `recovering` (`reconcile.ts:86`). Approval `block` does not change the stage (`controller.ts:192-200`), so the stage stays `running` with `agentSessionId`. `database.reconcileInterruptedRuntimes` (`database.ts:1004-1011`) clears `starting|running|waiting_input` on `agent_sessions` and does not mention `waiting_approval`. Structured `observe` uses the projection phase (`structured-runtime.ts:67-77`). On resume, a projection still in `waiting_approval` is `ACTIVE` (`controller.ts:66-67`) and not in `lost`, so `runStage` re-attaches (`controller.ts:243-247`) and `wait` returns `needs-owner` again (`controller.ts:334`, `controller.ts:348-351`). That is a re-block on every resume until the projection phase changes.

8. **`contextRolloverFraction` is applied between stages, not during one.** `shouldRollover` runs in `afterStage` (`wiring.ts:94-99`). `buildStagePrompt` uses the fraction only as the next prompt's ceiling (`handoff.ts:210-211`). Nothing passes the fraction into the live local loop. The local policy compacts at 0.78/0.90 (`agent-policy.ts:84`), which is a different threshold from the job default 0.7 (`src/shared/durable-jobs.ts:49`). A stage can sit past 0.7 until it ends.

9. **Job worktree has no `node_modules`.** `gitWorktrees.create` is `git worktree add` only (`worktree.ts:52-59`). No dependency provision and no junction. A verify stage that runs project tests in that worktree has no installed deps. No `node_modules` reference under `src/main/durable-jobs/`.

10. **Non-git checkpoints copy only already-changed paths.** `controller.ts:452-457` snapshots `handoff.filesChanged` plus `extraFiles`. `worktree.snapshot` copies that list (`worktree.ts:79-99`). Files changed on disk but not named are absent.

11. **`<think>`-only success.** `stageSucceeded` (`controller.ts:71-77`) treats any non-empty `lastAnswer` as an answer. It does not call `visibleContent`. `classifyStageOutcome` rejects reasoning-only text (`handoff.ts:487-493`, test `handoff.test.ts:287`) but `conclude` uses `stageSucceeded` (`controller.ts:356`). `controller.test.ts:74` expects `lastAnswer: 'ok'` to succeed and has no think-only case. `afterStage` strips think for the handoff text (`wiring.ts:79`) after success was already decided.

12. **Job view reloads up to 20k events on every change.** `durable-jobs-ipc.ts:51-57` pages by 500 until 20,000, then returns the last 200. `DurableJobsPane.tsx:174` calls `detail` on every service change.

13. **Reconciliation adds downtime to `activeMs`.** `store.ts:329` adds `now - running_since` whenever status leaves `running`. A crash leaves status `running` (`controller.ts:173-175`). The next launch's transition to `recovering` (`reconcile.ts:93`) counts the outage as active. Contradicts `docs/durable-jobs.md:56`.

14. **Research stages get no `web_search` grant.** Confirmed. `stageTooling` sets `research: entry.research && grants.research` (`handoff.ts:446`) and defaults grants to `NO_GRANTS`. `handoffPort.stagePrompt` calls `stageTooling` with no grants (`wiring.ts:66`). `STAGE_TOOL_MAP.research.research` is true (`handoff.ts:427`) and is then forced off.

15. **Pause/cancel in the 3s before reconcile bypasses reconcile.** Confirmed. App start calls `durableJobs.start()` after 3000 ms (`src/main/index.ts:2317-2318`). `start` is what runs `reconcileJobs` (`index.ts:104-106` in `durable-jobs/index.ts`). A pause or cancel in that window takes the `index.ts:194-244` path (ops marked failed, no pending-tool verdict). Reconcile then skips the job because it is no longer `running`.

### Refuted

**"The conductor tool schema is not budgeted" (finding 9, second clause).** Refuted for the prompt that is actually sent. `stagePrompt` passes `tooling.tools` into `buildStagePrompt` (`wiring.ts:66-67`). Overhead includes those tools (`handoff.ts:207-211`). `schemaTokens` is computed (`handoff.ts:448`) and checked in `handoff.test.ts:263`, and no other caller reads it, but the budget path does not depend on that field.

## Bounded fixes

This audit does not implement them. F1 is already owned by another worker. F2 and F3 are queued, not active.

### F1. Read the newest events for budget, loop, and report — active

Exclusive owner: `agent_muerw1fu_a33x86v`. Files: `src/main/durable-jobs/store.ts`, `controller.ts`, `wiring.ts`, `index.ts`, `report.ts`, and their tests. Do not edit those files from this audit.

- Reproduction: insert 1001 events, the last a `note` with `data.elapsedBudget === 'restarted'` (or a third identical `retry` error, or a `loop-detected` replan). `events(id, undefined, 1000).at(-1)` is not that row. `report()` (`index.ts:249`) omits event 1001.
- Acceptance: add a tail or `latest(kind, limit)` query ordered `seq DESC`. Elapsed budget, the same-failure check, and replan restore use it. `report()` pages the way `generateDurableJobReport` already does (`report.ts:191-196`) or tails. A store test with 1001 rows must see the newest match. Keep the oldest-forward page for `afterId` clients (`docs/durable-jobs.md:106`).

### F2. Release the generation gate when a stage blocks on the owner — queued, not active

- Files: `src/main/durable-jobs/wiring.ts` (`gatedRuntime`), `src/main/durable-jobs/controller.ts` (`wait` / `block`), tests in `wiring.test.ts` and `controller.test.ts`.
- Reproduction: job A reaches `waiting_approval` (the fake runtime in `controller.test.ts` already does this). Do not interrupt. Assert `LocalGenerationGate.holder()` is still A's id. Start job B. B's `submit` does not resolve; B's status is `running`.
- Acceptance: after `block` for approval, `holder()` is null and B's `acquire` resolves. Interrupt-on-block is acceptable only if resume still re-attaches to the same conversation (`controller.ts:349-350` currently depends on it staying up). A focused unit test must fail before the fix and pass after. No Electron smoke required for this fix.

### F3. Watch a running tool as a tool call — queued, not active

- Files: `src/main/durable-jobs/wiring.ts` (`supervisionPorts.watch`), existing `Watchdog` in `watchdog.ts`. Test: `wiring.test.ts`.
- Reproduction: set `modelCallTimeoutMs` to 10 minutes and `toolCallTimeoutMs` to 30 minutes. Leave a tool item `running` for 12 minutes. Twelve exceeds the model budget and is still inside the tool budget. Current wiring keeps the pre-tool `model-call` watch open until the tool item is `completed` or `failed` (`wiring.ts:145-167`), so `tick` interrupts at 10 minutes (`wiring.ts:187-189`). A 6-minute tool under a 10-minute model budget does not reach this path.
- Acceptance: at 12 minutes the open watch scope is `tool-call` and the stage is still running. The same fixture interrupts if that tool is still running at 30 minutes. A model call with no tool in flight still interrupts at 10 minutes. When the tool completes, the next watch is a new `model-call` (`wiring.ts:166-167` starts that next call only at completion today). Do not change stall behavior for a model call with no tool in flight.

Still confirmed, and not in the F1–F3 queue: thread an `AbortSignal` from `run.stop` into `ServerSupervisor.ensureReady` (`wiring.ts:239-241`, `server-lifecycle.ts:152`); teach `pause` to record `unknown` for a pending tool. `agent-control.ts:197` still says the current step finishes at a safe point. That file is outside this audit.

## Checked claims (40)

Areas, in order: local-agent and context recovery, persistence and relay, schedules, provider integration, orchestration. Expected behavior is the checked sentence, shortened. Runtime age is "not re-executed 2026-09-24" unless a document date is cited. Next step is the acceptance action when the smoke/test slot is free. Do not mark these done again.

| ID | Expected behavior | Source / test coverage read | Runtime evidence age | Verdict | Next acceptance step |
| --- | --- | --- | --- | --- | --- |
| `local-file-processing-e2e` | Harness repairs and ordinary Ornith/UI validation are in; short-segment model reliability stays limited. | `docs/local-file-execution.md` (header date 23 Sep 2026) states no successful real-statement replay. `src/main/local-models/file-processing.ts` exists; tests not opened. | Write-up dated 2026-09-23 (~1 day). Not re-run. | unverified | Re-read `file-processing.test.ts` and the ignored local artifact the doc names; do not claim a private bank-statement replay. |
| `bug-local-trim-drops-user-message` | Trimming never drops the latest user message, so Qwen cannot raise "No user query found". | `agent.ts:173` pins the latest user message. `local-models.test.ts:678-683` expects that question to survive a tool-heavy history. | Test logic read; not executed. | unverified | `npx vitest run src/main/local-models/local-models.test.ts` (the never-trims-user case) when the slot is free. |
| `local-request-failures` | Repair tool protocol, fit the window, retry a refusal once, drain the queue after failure. | Not opened this pass beyond `trimMessages` / `repairToolProtocol` imports in `agent.ts:413`. | None read. | unverified | Open the queue-drain and HTTP 400 retry tests and run that file only. |
| `local-context-management` | One policy: shaped tool results, compact at 78%/90%, stop at 24 rounds, no fabricated completion. | Thresholds at `agent-policy.ts:84` (`compactAt: 0.78`, `aggressiveAt: 0.90`). `agent-management.test.ts:22` only checks rejected unordered overrides. | None read. | unverified | Run the agent-policy/context-manager tests; confirm a zero-tool "tests pass" stop is not `completed`. |
| `local-qwen-reserved-ports` | Bind-probe, adopt a healthy own server, move off Hyper-V reserved ports, record the real port. | Not opened this pass. | None read. | unverified | Read `src/main/local-models/llama.ts` bind/adopt path and its unit test; do not start llama-server. |
| `local-model-idle-switch` | An idle Conductor-started server yields; a busy one and a foreign server are refused before `tabs.open`. | Not opened this pass. | None read. | unverified | Read `resource-guard.ts` and the idle-switch test; assert a busy server is refused with the holder named. |
| `local-tasks-update-and-contract` | Sandboxed local tool can `tasks.update`; snapshot errors name where `agentSessionId` comes from; `.git` read-only is in the local prompt. | Not opened this pass. | None read. | unverified | Focused test that a read-only local turn cannot `tasks.update` and a writable one can. |
| `local-git-and-research-grants` | Per-conversation repository-writes and research grants, off by default, refused on non-local, enforced at dispatch. | Grant rule text at `agent-control.ts:122` and `agent-control.ts:519`. Dispatch enforcement not re-read. | None read. | unverified | Run the grant section of `agent-control.test.ts` (see `agents-grant-local-model-grants`). |
| `local-git-push-broker` | Granted push is host-brokered; force/delete/compound commands refused; container stays without network. | `git-push.ts:26-34` refuses flags and compound commands. `brokeredGitPush` at `git-push.ts:80`. Tests not opened. | None read. | unverified | Unit-test a `git push --force` refusal and a plain `git push origin HEAD` parse without a real push. |
| `agents-grant-local-model-grants` | Non-local caller grants repository/research on a local tab it controls; false revokes; local caller cannot. | `agent-control.ts:536` rejects unknown keys. `agent-control.test.ts:1128-1162` encodes grant, revoke, unknown key, non-local, and self-grant refusal. | Test logic read; not executed. | unverified | Run that `agents.grant` test block only. |
| `audit-sandbox-mask-commits` | Repository-writes grant must not let the sandbox mask destroy tracked files. | Not opened this pass. | None read. | unverified | Read the mask path and the regression that a masked secret is not committed as an empty file. |
| `audit-local-probe-recorded-port` | Health probe uses the recorded port, not the configured one, after a port move. | Not opened this pass. | None read. | unverified | Read `ensureServer` / probe call and the test that a moved port does not re-announce startup. |
| `bug-sandbox-destroys-node-modules` | `run_command` must not let `npx`/`npm` reify and delete `node_modules` inside the sandbox. | Not opened this pass. | None read. | unverified | Read the command guard and its test; do not run `npx tsc` in the sandbox. |
| `briefing-once-per-runtime` | Static briefing, memory, and control paragraph go out once per runtime, again after `contextReset`. | `turn-briefing.ts:25` exports `CONTEXT_RESET`. `turn-briefing.test.ts:37` says the static briefing is sent once, then only what is new. | Test logic read; not executed. `scripts/measure-context-churn.mjs` not run. | unverified | Run `turn-briefing.test.ts`. Do not re-measure two weeks of logs in this slot. |
| `swarm-token-thrift` | Machine profile, one-server guard, bounded tool results, local budget check, log analyzer split. | `docs/machine-profile.md` is the cited profile (not re-read). Guard file not opened. | Claim text says 2026-09-21 measurement. Not re-run (~3 days). | unverified | Re-run the cited before/after fixture only if the local server is already the one the owner has up. Do not start a second server. |
| `swarm-capability-repairs` | Twelve parity repairs applied; R3, R5, R6 deferred. | `docs/conductor-provider-parity.md` named by the claim; not opened. | None read. | unverified | Check the doc's file:line list against one repaired case (Claude default effort) and one deferred id. |
| `bug-limit-continuation-structured` | Structured Claude/Codex sessions persist a usage-limit wait and send continue when the window reopens. | `agent-control.ts:757` comment says a coworker waits out usage limits. Timer/persist path not opened. | None read. | unverified | Read the structured wait store and its test; restart evidence is required before verified. |
| `6967d7ed-c567-481d-bff3-69728caf9375` | Schedules run a fixed latest-models script and do not start an agent turn when content is unchanged. | `docs/schedules.md:7-25` matches that contract. `schedule-store.ts:118-119` ensures one daily `latest-models-methods` row. `schedule-runner.test.ts:14` constructs the runner. Script output not run. | Doc undated. Tests not executed. | unverified | `node scripts/check-latest-models-methods.mjs` only when network is acceptable; assert unchanged content writes no artifact and starts no turn. |
| `grok-provider` | Grok is a native ACP provider (tile, models, approvals, interrupt, resume, CLI, browser MCP, app control, wizard for 4.6+). | `grok.ts:13` and `grok.ts:165` (`GrokAdapter`) are in `bb9b8f2` (2026-09-24 01:21 +0200). Working tree `agent-control.ts` still has uncommitted Grok hunks at the catalog filter (line 690), plan flag (line 770), and `agents.configure` provider list (line 894), plus the `tabs.open` sentence (line 109). Open item `grok-agent-control-hunks` (`feature-list.md:4`) matches that diff. | Live smoke named `scripts/smoke-grok-live.mjs` was not opened or run. | unverified | Do not edit `agent-control.ts` here. When its owner is free, commit those four hunks alone. Re-run the Grok live smoke only with the owner's quota. |
| `dispatch-auto-mode` | `tabs.open` / `router.dispatch` open a native coworker on Auto unless the controller is read-only/planning or `exactPermission: true`. | `agent-control.ts:764-769` calls `dispatchPermission` with `args.exactPermission === true`. `agent-control.test.ts:335` opens with `exactPermission: true`. Default-Auto assertion not read line by line. | None read. | unverified | Run the dispatch permission tests in `agent-control.test.ts`. |
| `control-tab-inherits-permission` | A controlled tab inherits the controller's mode, clamped to the provider, never above the controller. | Not opened this pass (related dispatch code is `dispatch-auto-mode`). | None read. | unverified | One test: ask controller opens an ask tab; auto controller opens auto; child never exceeds parent. |
| `codex-permission-presets` | Codex composer offers Ask / Read only / Edit / Auto; settings override wins; choice remembered per provider. | Not opened this pass. | None read. | unverified | Read the Codex preset map and its composer test. |
| `codex-auto-answers-escalations` | Auto answers out-of-workspace escalations except owner-only boundaries. | Not opened this pass. | None read. | unverified | Read the boundary list and a test that hosts-file/elevation stays a card. |
| `urgent-claude-auto-mode` | Claude permission card has a distinct Switch-to-auto action wired to the provider's real auto mode. | Not opened this pass. | None read. | unverified | Read the card handler and a test that auto is offered only when the provider lists it. |
| `browser-toggle-memory` | New tabs default Auto and browser-on; per-provider off/on is remembered for every open path. | Not opened this pass. | None read. | unverified | Read the setting key and a test for owner, router, and remote open. |
| `215fb17f-21d2-45db-aa31-319e35589f9e` | AutoFixer picks a provider that still has usage. | Not opened this pass. | None read. | unverified | Read the provider picker and a test with Astra exhausted and another provider available. |
| `feature-subagents-view-detail` | Subagent row shows model, provider, effort, tab, workspace, status, tokens, and opens the real view. | Not opened this pass. | None read. | unverified | Renderer test or the existing subagent view test; UI smoke only when the slot is free. |
| `background-work-tab-status` | A tab stays non-finished while background work or a re-armed watcher is outstanding. | Not opened this pass. | None read. | unverified | Read the phase rollup and a test with a detached running tool. |
| `cross-project-steer-owner-tab` | An agent in a sibling project can steer the owner's own Conductor tab under an explicit rule. | Not opened this pass. The `tabs.open` sentence in `agent-control.ts:109` still says a sibling tab can be steered only by the controller that opened it. | None read. | unverified | Read the implementation against that sentence so a future pass can fail the claim if the owner-tab path was never added. |
| `urgent-project-tasks` | Agents can read and update Project tasks in the installed panel. | Not opened this pass. | None read. | unverified | Protocol test: `tasks.update` then the panel query returns the same revision. |
| `f6efd042-f3f9-478c-94b7-9ce8ab5687a1` | "Not sent" keeps text and attachments and offers Restore to composer. | Not opened this pass. | None read. | unverified | Read the card copy and a test that restore puts the text back in the composer. |
| `52ae4ebf-396d-4bf3-9fe6-c406cf8899de` | Resume is on the stopped-conversation error, not only in settings. | Not opened this pass. | None read. | unverified | Read the error component and a renderer test for the resume control. |
| `7afeb35f-7d25-4674-b49c-909242c08070` | Sending to a disconnected runtime resumes it. | Not opened this pass. | None read. | unverified | Read the submit path and a test that a disconnected session is resumed before send. |
| `8c4d0c7c-35bd-47dd-a01b-0c026124a910` | Bug-console paste limit raised; workspace checkpoint save no longer throws invalid owner. | Not opened this pass. | None read. | unverified | Read the paste limit and `recovery:checkpoint` owner check. |
| `tailscale-multi-device` | Tailscale-only bind, no relay poll, WebSocket push, terminal resume; smoke claims 19 checks. | `docs/multi-device.md:271` names `scripts/smoke-multi-device.mjs`. Script output not opened. | Claim says a two-instance smoke passed. Log not read. Age unknown. | unverified | Open the latest smoke log if one is on disk; otherwise re-run only when the smoke slot is free. |
| `conductor-own-relay` | In-app relay replaces gist polling. | Not opened this pass (`github-relay.ts` still exists at `github-relay.ts:51`). | None read. | unverified | Read whether the gist mailbox is still on the default path. If it is, this claim needs a narrower reading before anyone calls it verified. |
| `audit-relay-response-auth` | Relay responses are authenticated to the sender, not only sealed against modification. | Not opened this pass. | None read. | unverified | Read the envelope check and the forged-response test. |
| `audit-relay-backoff-lost` | Rate-limit keeps `RelayUnavailableError`, `retryAfterMs`, and still runs `expire()`. | `remote-relay.ts:231-252`: `tick` keeps the typed error, sets delay from `retryAfterMs`, phase `unavailable`, and calls `expire()` in `finally`. Tests not opened. | Source matches the claimed fix. Not executed. | unverified | Run the relay tick test that stubs a 429 and asserts the next delay and an `expire()` call. |
| `relay-probe-poll-storm` | One offline peer must not burn the GitHub budget on a 60s project poll. | Not opened this pass. | None read. | unverified | Read the heartbeat interval and the unreachable-peer backoff test. |
| `remote-local-models-and-close` | A machine without weights can open a Qwen tab on the paired machine that has them, and closing the placed tab closes the remote one. | Not opened this pass. | None read. | unverified | Read `openRemote` placement and a two-instance test. No second model server. |

## Inspection ledger

Machine-readable. `inspected` means this pass opened the claim's source and/or a test that asserts it. `not_opened` means it was not. A doc name, a comment, or an import line is `not_opened`. Every id is still verdict `unverified`. Counts: inspected 10, not_opened 30, total 40.

```json
{
  "audit": "partial",
  "s3Complete": false,
  "claims": 40,
  "verdict": "unverified",
  "inspectedCount": 10,
  "notOpenedCount": 30,
  "sourceAudit": "settled",
  "queue": {
    "F1": { "title": "event-history", "state": "active", "owner": "agent_muerw1fu_a33x86v", "files": ["src/main/durable-jobs/store.ts", "src/main/durable-jobs/controller.ts", "src/main/durable-jobs/wiring.ts", "src/main/durable-jobs/index.ts", "src/main/durable-jobs/report.ts", "src/main/durable-jobs/*.test.ts"] },
    "F2": { "title": "generation-gate", "state": "queued" },
    "F3": { "title": "watchdog-tool-call", "state": "queued" }
  },
  "baseline": { "files": 256, "tests": 3020, "scriptTests": 65, "result": "passed", "supports": "unit-level-only" },
  "inspected": [
    { "id": "bug-local-trim-drops-user-message", "source": "src/main/local-models/agent.ts:173", "test": "src/main/local-models/local-models.test.ts:678" },
    { "id": "local-context-management", "source": "src/main/local-models/agent-policy.ts:84", "test": null },
    { "id": "local-git-and-research-grants", "source": "src/main/agent-control.ts:122", "test": null },
    { "id": "local-git-push-broker", "source": "src/main/local-models/git-push.ts:26", "test": null },
    { "id": "agents-grant-local-model-grants", "source": "src/main/agent-control.ts:536", "test": "src/main/agent-control.test.ts:1128" },
    { "id": "briefing-once-per-runtime", "source": "src/main/turn-briefing.ts:25", "test": "src/main/turn-briefing.test.ts:37" },
    { "id": "6967d7ed-c567-481d-bff3-69728caf9375", "source": "src/main/schedule-store.ts:118", "test": null },
    { "id": "grok-provider", "source": "src/main/providers/grok.ts:165", "test": null },
    { "id": "dispatch-auto-mode", "source": "src/main/agent-control.ts:764", "test": null },
    { "id": "audit-relay-backoff-lost", "source": "src/main/remote-relay.ts:231", "test": null }
  ],
  "notOpened": [
    "local-file-processing-e2e",
    "local-request-failures",
    "local-qwen-reserved-ports",
    "local-model-idle-switch",
    "local-tasks-update-and-contract",
    "audit-sandbox-mask-commits",
    "audit-local-probe-recorded-port",
    "bug-sandbox-destroys-node-modules",
    "swarm-token-thrift",
    "swarm-capability-repairs",
    "bug-limit-continuation-structured",
    "control-tab-inherits-permission",
    "codex-permission-presets",
    "codex-auto-answers-escalations",
    "urgent-claude-auto-mode",
    "browser-toggle-memory",
    "215fb17f-21d2-45db-aa31-319e35589f9e",
    "feature-subagents-view-detail",
    "background-work-tab-status",
    "cross-project-steer-owner-tab",
    "urgent-project-tasks",
    "f6efd042-f3f9-478c-94b7-9ce8ab5687a1",
    "52ae4ebf-396d-4bf3-9fe6-c406cf8899de",
    "7afeb35f-7d25-4674-b49c-909242c08070",
    "8c4d0c7c-35bd-47dd-a01b-0c026124a910",
    "tailscale-multi-device",
    "conductor-own-relay",
    "audit-relay-response-auth",
    "relay-probe-poll-storm",
    "remote-local-models-and-close"
  ]
}
```

`local-file-processing-e2e` is `not_opened`: only `docs/local-file-execution.md` was read, not `file-processing.ts` or its tests. `local-context-management`'s opened test (`agent-management.test.ts:22`) does not assert compaction. `6967d7ed-c567-481d-bff3-69728caf9375`'s opened test only constructs the runner. `dispatch-auto-mode`'s opened test line does not assert the Auto default. Those three stay `inspected` for the source lines and `test: null`.

## Not claimed

- No checked claim was marked **failed**. Lack of a smoke was not treated as failure. The 40 unverified verdicts stand.
- `durable-jobs-verification` remains open. Its "done and passing" sentences were not re-proven here.
- `grok-agent-control-hunks` remains open and matches the uncommitted diff in `src/main/agent-control.ts`.
- This audit implemented nothing and committed nothing. F2 and F3 stay queued.
