# Repository inventory

Checked 2026-09-24 by reading the checkout. This file is the S1 recovery report. No production source was edited. No typecheck, unit suite, smoke, build, model restart, or installer was run for this inventory. A file on disk is evidence that the module exists and of what its source says. It is not evidence that the workflow succeeds in the app.

Local Qwen 3.6 35B-A3B (`agent_muerczw7_p9xz3df`) scanned the tree and then lost two `write_file` calls at the 2,560-token output cap (`artifacts/autopilot/local-recent.json` sequence 278–280, `local-second-write-failure.json` sequence 282–284). Both calls stayed `running`; the runtime notice says nothing was written. The partial JSON in those artifacts was used only as a lead and was re-checked below.

## Salvage from the failed writes

These claims in the truncated drafts do not match the tree:

- TODO hits are five generated Codex sites, not three. The drafts omitted `ThreadRealtimeStartParams.json:194` and `ThreadRealtimeStartParams.ts:27`.
- `scripts/` contains 89 `smoke-*.mjs` files and 5 `probe-*.mjs` files. The second draft said no smoke files exist.
- `src/main/schedule-jobs/` is the registry plus `latest-models.ts`. Controller, handoff, watchdog, and reconcile live under `src/main/durable-jobs/`. The drafts merged those trees.
- Claude, Codex, and Grok are local CLI adapters (`src/main/providers/factory.ts:18`). They are not HTTP API clients.
- The relay writes sealed messages to a private GitHub gist (`src/main/remote-relay.ts:36`). The first draft called it a generic file relay.
- `orchestration-roster.test.ts`, `editor-drafts.test.ts`, and `workspace-restore.test.ts` are tests. Workspace restore is `ConductorDatabase.restoreSession`, exercised at `src/main/workspace-restore.test.ts:19` and `src/renderer/src/App.tsx:937`.

The drafts were right that hand-written `src/` and `scripts/` contain no `TODO` / `FIXME` / `HACK` markers, and that the scheduled job id is separate from durable jobs.

## TODO / FIXME / HACK

Search: `\b(TODO|FIXME|HACK)\b` in `src/**/*.{ts,tsx,js,mjs,cjs}` and the same markers in `src/**/*.json`, plus `scripts/**/*.{ts,js,mjs,cjs,ps1,md}`. `artifacts/`, `recovery/`, and `node_modules/` were not searched.

| File | Line | Marker |
| --- | ---: | --- |
| `src/main/providers/generated/codex/schema/ClientRequest.json` | 5803 | TODO: remove transcript-tail rollout knob |
| `src/main/providers/generated/codex/schema/codex_app_server_protocol.schemas.json` | 26786 | same sentence |
| `src/main/providers/generated/codex/schema/codex_app_server_protocol.v2.schemas.json` | 24384 | same sentence |
| `src/main/providers/generated/codex/schema/v2/ThreadRealtimeStartParams.json` | 194 | same sentence |
| `src/main/providers/generated/codex/v2/ThreadRealtimeStartParams.ts` | 27 | same sentence; file header line 1 says `GENERATED CODE! DO NOT MODIFY BY HAND!` |

`scripts/` has zero matches. Hand-written TypeScript and JavaScript under `src/` has zero matches. These five lines are upstream Codex protocol text. They are not Conductor work items.

Unit tests outside `src/main/providers/generated/`: 256 `*.test.ts` files. Smokes present and not executed here: 89. Probes present and not executed: `scripts/probe-browser-mcp-approval.mjs`, `probe-browser-mcp-attack.mjs`, `probe-browser-mcp-crash.mjs`, `probe-capability-sweep.mjs`, `probe-context-cost.mjs`.

## Subsystem map

### Orchestration

- Store: `OrchestrationStore` at `src/main/orchestration-store.ts:47` (SQLite `DatabaseSync`, WAL, `orchestration_tasks` at line 117). Task statuses include `backlog`, `ready`, `in_progress`, `blocked`, `done`, `cancelled` (`src/shared/orchestration.ts:41`).
- IPC: `registerOrchestrationIpc` at `src/main/orchestration-ipc.ts:23`. Preload: `orchestrationBridge` at `src/preload/orchestration.ts:6`.
- Wiring: `src/main/index.ts:2029` constructs the store; `src/main/index.ts:2296` registers IPC.
- UI: `OrchestrationHub` at `src/renderer/src/components/OrchestrationHub.tsx:70`.
- Control surface used by coworkers: `AgentControl` at `src/main/agent-control.ts:248`, served by `AgentControlServer` at `src/main/agent-control-server.ts:21`.
- Tests: `src/main/orchestration-store.test.ts:28`, `src/main/orchestration-roster.test.ts:25`, `src/main/agent-control.test.ts`. No unit test references `OrchestrationHub`. No `smoke-orchestration.mjs`. Nearby app smokes that were not run: `scripts/smoke-project-task-dispatch.mjs`, `scripts/smoke-steering.mjs`, `scripts/smoke-agent-control.mjs`.

### Local agents

- Session loop: `LocalAgentSession` at `src/main/local-models/agent.ts:294`. Default policy, including the 2,560-token tool-round reserve, is `src/main/local-models/agent-policy.ts:83`.
- Adapter: `LocalAdapter` capabilities at `src/main/providers/local.ts:227`. Permissions offered are only `accept-edits` and `read-only` (line 234). `sandboxModes` is absent. Limitation text at line 240 says commands run in a non-root Docker container and are refused when that sandbox is unavailable.
- Process owner for native CLIs: `AgentManager` at `src/main/agent-manager.ts:293`.
- Tests present, not run: `src/main/local-models/agent-loop.test.ts` (includes the cut-off `write_file` case at line 298), `local-models.test.ts`, `bounded-tools.test.ts`, `harness.test.ts`, `sandbox-startup.test.ts`, `resource-guard.test.ts`. `agent.ts` has no sibling `agent.test.ts`; the loop suite imports the session.
- Smokes present, not run: `scripts/smoke-local-models.mjs`, `smoke-local-admission.mjs`, `smoke-local-files.mjs`, `smoke-local-grants.mjs`, `smoke-local-harness-fixer.mjs`, `smoke-structured-agents.mjs`, `smoke-agent-pane.mjs`, `smoke-agent-confirm.mjs`.

### Persistence

- `ConductorDatabase` at `src/main/database.ts:159`.
- Structured timeline: `StructuredSessions` at `src/main/structured-sessions.ts:90`, store tests in `src/main/structured-store.test.ts`.
- Session archive: `parseSessionArchive` at `src/main/session-archive.ts:216`, tests `session-archive.test.ts` and `session-archive-database.test.ts`.
- Project checklist file: `PROJECT_TASK_FILE = 'feature-list.md'` at `src/main/project-backlog.ts:12`.
- Editor drafts are database rows (`database.saveEditorDraft` is called from `workspace-restore.test.ts:32`), with renderer state in `src/renderer/src/panes/editor-draft-state.ts`. There is no `editor-drafts.ts`.
- Tests present, not run: `database.test.ts:17`, `workspace-restore.test.ts:19`, `editor-drafts.test.ts`, `editor-files.test.ts`.
- Smokes present, not run: `scripts/smoke-workspace-restore.mjs`, `smoke-session-archive-fixer.mjs`, `smoke-composer-drafts.mjs`, `smoke-editor-safety.mjs`.

### Scheduling

- The only job id is `latest-models-methods` (`src/shared/schedules.ts:1`).
- Runner: `ScheduleRunner.start` polls every 30 seconds (`src/main/schedule-runner.ts:16`). `tick` calls `reconcileInterrupted` (line 32) and, while one job is active, records every other due schedule as skipped (lines 35–37).
- The registry passed at boot is that one job (`src/main/index.ts:2183`). Implementation: `LatestModelsJob` in `src/main/schedule-jobs/latest-models.ts:13`.
- UI: `SchedulesPane` at `src/renderer/src/components/SchedulesPane.tsx:15`. No unit test references it.
- Tests present, not run: `schedule-runner.test.ts:20`, `schedule-store.test.ts:18`, `src/shared/schedules.test.ts`, `src/main/schedule-jobs/latest-models.test.ts`.
- Smoke present, not run: `scripts/smoke-schedules.mjs` (launches Electron under `CONDUCTOR_TEST_USER_DATA`, line 8).

### Terminal / CLI

- Local PTY: `TerminalManager` at `src/main/terminal-manager.ts:120`, tests `terminal-manager.test.ts:93`. Renderer: `src/renderer/src/panes/TerminalPane.tsx`.
- Provider CLI pane: `NativeCliManager` at `src/main/native-cli-manager.ts:48`, arguments tested at `native-cli-manager.test.ts:7`. Renderer `NativeCliPane` at `src/renderer/src/panes/NativeCliPane.tsx:8` has no unit-test references.
- Remote PTY: `RemoteTerminalHost` at `src/main/remote-terminals.ts:122`, tests `remote-terminals.test.ts`.
- No `scripts/smoke-terminal.mjs`. Nearby smokes not run: `scripts/smoke-phone-shell.mjs`, `scripts/smoke-processes-fixer.mjs`, `scripts/smoke-session-controls.mjs`.

### Remote

- Gist mailbox: `GitHubRelayMailbox` at `src/main/github-relay.ts:85`, used by `RemoteRelayDependencies.mailbox` (`src/main/remote-relay.ts:49`). Comment at lines 36–46 says each message is sealed and written to a private gist.
- Listener: `RemoteControlServer` at `src/main/remote-control-server.ts:151`. Client: `RemoteControlClient` at `src/main/remote-control-client.ts:171`.
- Phone: `PhoneAccessServer` at `src/main/phone-access-server.ts:103`. Static shell under `src/phone/`.
- Companion relay process: `src/relay-server/server.ts`.
- Tests present, not run: `remote-relay.test.ts` (imports `github-relay` and `relay-crypto`), `remote-control-server.test.ts`, `remote-control-client.test.ts`, `remote-peers.test.ts`, `relay-host.test.ts`, `phone-access.test.ts`, `phone-access-server.test.ts`, plus several `remote-*-adversarial.test.ts` files.
- Smokes present, not run: `scripts/smoke-remote-relay.mjs`, `smoke-remote-integration-fixer.mjs`, `smoke-conductor-relay.mjs`, `smoke-relay-settings.mjs`, `smoke-multi-device.mjs`, `smoke-phone-access.mjs`.

### Browser

- Loopback MCP: `BrowserMcpServer` at `src/main/browser-mcp.ts:33`. Constructor line 41 sets `disabled` when `CONDUCTOR_LIVE_TESTS=1`, so a live-test process does not open this endpoint.
- Views: `src/main/browser-views.ts`, covered by `browser-mcp.test.ts:6`, `browser-views-routing.test.ts`, `browser-owned-surface.test.ts`, `browser-presentation-adversarial.test.ts`, `browser-optin-adversarial.test.ts`.
- Renderer: `BrowserPane` at `src/renderer/src/panes/BrowserPane.tsx:62`.
- Smokes and probes present, not run: `scripts/smoke-browser-mcp.mjs` (header lines 9–13: real Electron, synthetic provider unless `--live-cli`), `smoke-browser-composer-button.mjs`, `smoke-browser-isolation-fixer.mjs`, `smoke-browser-presentation-fixer.mjs`, `smoke-browser-quit-diagnostic.mjs`, and the three `probe-browser-mcp-*.mjs` scripts.

### Memory

- Ranking and capture: `captureMemories` at `src/main/memory.ts:195`, tests `memory.test.ts:41`.
- Directive parser: `src/shared/memory-directive.ts:1`, tests `memory-directive.test.ts`.
- UI: `MemoryPane` at `src/renderer/src/panes/MemoryPane.tsx:119`. No unit test references `MemoryPane`. Offline smoke present, not run: `scripts/smoke-memory-curation.mjs` lines 7–12 mount that pane under Vite.
- Other smokes present, not run: `scripts/smoke-permission-memory.mjs`, `scripts/smoke-project-workspace-memory.mjs`.

### Context

- Prompt attachments: `promptContextLimits` at `src/main/prompt-context.ts:123`, tests `prompt-context.test.ts:11`.
- Turn briefing: `TurnBriefings` at `src/main/turn-briefing.ts:66`, tests `turn-briefing.test.ts:36`.
- Local window: `requestBudget` at `src/main/local-models/context-budget.ts:29` (estimate, not the server tokenizer). Compaction: `compactHistory` at `src/main/local-models/context-manager.ts:147`. Tests: `context-budget.test.ts`, `context-management.test.ts`.
- Checkpoint that refuses a corrupt blob: `src/main/local-models/session-checkpoint.ts:14`.
- Smokes and measures present, not run: `scripts/smoke-context-briefing.mjs`, `smoke-context-handoff.mjs`, `smoke-context-menu.mjs`, `scripts/measure-context-churn.mjs`, `scripts/probe-context-cost.mjs`.

### Providers

- Factory: `createProviderAdapter` at `src/main/providers/factory.ts:18`. `local` skips the offline fixture. Claude, Grok, and Codex otherwise spawn their CLI, or `scripts/fixtures/fake-<provider>.mjs` when `CONDUCTOR_OFFLINE_TESTS=1`.
- Baselines named in source: Claude CLI `2.1.278` (`src/main/providers/claude.ts:15`), Grok `grok agent stdio` baseline `1.0.41` (`src/main/providers/grok.ts:13`). Codex speaks the generated app-server protocol (`src/main/providers/codex.ts:7`) and advertises `sandboxModes` at `codex.ts:262`.
- Tests present, not run: `claude.test.ts`, `codex.test.ts`, `grok.test.ts`, `local.test.ts`, `codex-auto-refusal.regression.test.ts`, `claude-transport.test.ts`.
- Live scripts present, not run: `scripts/smoke-grok-live.mjs` (header line 7: real `grok agent stdio`), `scripts/smoke-claude-permissions.mjs`, `scripts/live-structured-codex.mjs`, `scripts/live-claude-permissions.mjs`. Those cost provider usage. This inventory did not start them.

### Automation / recovery

- Durable jobs are a separate service from schedules. `createDurableJobsService` is wired at `src/main/index.ts:2187`. Restart reconciliation: `reconcileJobs` at `src/main/durable-jobs/reconcile.ts:84`. One local generation at a time is commented at `src/main/index.ts:2193`.
- Tests present, not run: `durable-jobs/controller.test.ts`, `reconcile.test.ts`, `server-lifecycle.test.ts`, `watchdog.test.ts`, `wiring.test.ts`, `structured-sessions-local-checkpoint.test.ts`, `local-models/recovery.test.ts`, `local-models/session-checkpoint.test.ts`.
- `scripts/smoke-durable-jobs.mjs` lines 15–27 advertise stub mode, `--real-model`, `--kill-server`, `--restart-app`, `--loop-case`, and `--stall-case`. None of those modes was run here.
- `scripts/smoke-recovery.mjs` lines 1–9 attach to an already listening Conductor CDP target. The script does not launch the app.
- `scripts/overseer.mjs` lines 2–3 is an external supervisor. `scripts/overseer.test.mjs` exists. Neither was run.
- Host quit path: `installHostLifecycle` at `src/main/host-lifecycle.ts:84`, tests `host-lifecycle.test.ts:37`.

### Usage

- CLI limit text: `parseUsageLimitReset` at `src/main/usage-limit.ts:27`, tests `usage-limit.test.ts:6`.
- Figures: `src/shared/usage-accounting.ts:7`. Weekly rollup: `readWeeklyModelUsage` at `src/main/weekly-usage-summary.ts:23`.
- Live-turn money guard: `liveCostLimits` at `src/main/live-test-policy.ts:18`, class `LiveRuntimeBudget` at `src/main/live-runtime-budget.ts:17`.
- Codex allowance handshake with no tab: `AllowanceProbe` at `src/main/allowance-probe.ts:7`, called from `src/main/project-task-dispatch.ts:13`. No test file imports `AllowanceProbe`. `project-task-dispatch.test.ts:181` only looks for a history id prefix.
- Smokes present, not run: `scripts/smoke-usage-warning.mjs`, `smoke-usage-routing-fixer.mjs`, `smoke-limit-continuation.mjs`.
- App control `tools.list` (this session) has no quota or weekly-percentage method. No authoritative Grok percentage was found. The owner override in `docs/autopilot-backlog.md` says to keep using Grok until it refuses, and to apply a 95% stop only when a real percentage exists. That stop was not applied.

### Updates

- Installed feed: `UpdateManager` at `src/main/update-manager.ts:27` (`NsisUpdater`, check interval line 22). Feed URL: `src/main/update-config.ts`. Local checkout feed: `LocalUpdateFeed` at `src/main/local-update-feed.ts:77`, builder `LocalUpdateBuilder` at `src/main/local-update-build.ts:68`.
- Delivery: `ship` at `src/main/delivery.ts:401` sets `publish: request?.publish === true` (line 417). Lines 480–484 skip push and GitHub release unless publish is true. `delivery.test.ts:94` expects no `git push` on a local delivery. That test was not re-run here.
- Catalog text disagrees with that code: `src/main/agent-control.ts:147` describes `git.ship` as commit, then push, then waiting for the release.
- Tests present, not run: `update-manager.test.ts:47`, `update-config.test.ts`, `local-update-feed.test.ts`, `local-update-build.test.ts`.
- Smokes present, not run: `scripts/smoke-local-updates.mjs` (synthetic artifacts, line 9), `smoke-local-update-build.mjs`, `smoke-local-update-download.mjs`, `smoke-update-feed.mjs`, `smoke-update-status.mjs`, `smoke-release-discovery.mjs`.

## Coverage gaps

These are missing checks, not failed checks.

- Renderer panes with no unit-test references found: `OrchestrationHub.tsx:70`, `SchedulesPane.tsx:15`, `NativeCliPane.tsx:8`. `MemoryPane.tsx:119` is only named from `scripts/smoke-memory-curation.mjs`.
- `AllowanceProbe` (`allowance-probe.ts:7`) has no direct unit test. Auto-fixer dispatch depends on it (`project-task-dispatch.ts:38` treats stale allowance as unknown or exhausted).
- `src/main/safe-storage-vault.ts:4` says Electron `safeStorage` is kept out of unit-tested modules on purpose. `index.ts:20` is the production caller. Whether encryption is available on this machine was not checked.
- `src/main/local-models/sandbox.ts` is imported by tool tests as a fake `exec`. `sandbox-startup.test.ts` exists. A real Docker run was not started.
- Fifty-one non-generated `src/main` modules have no same-name `*.test.ts`. Most are covered from a neighbor (IPC wrappers, `agent-control-server.ts` imported by `agent-control.test.ts:6`, relay crypto imported by `remote-relay.test.ts`). The gaps called out above are the ones with no such import.
- Every smoke and probe named in this report was left unrun. Passing unit tests, which were also left unrun, would still not prove the Electron workflows.

## Top ten concerns

Confirmed means the source, or the saved local-worker artifact, shows the behavior. Unknown means this inventory did not execute the path.

1. Confirmed defect. A read-only local coworker is opened with `sandbox: 'read-only'` (`src/main/agent-control.ts:770`) even though `LocalAdapter` never sets `sandboxModes` (`src/main/providers/local.ts:227`). `StructuredSessions.validateSettings` throws `Execution sandbox unsupported by this provider` when `settings.sandbox` is set and the capability list does not contain it (`src/main/structured-sessions.ts:836`). Tab open writes settings through `database.structured.update` and skips that check (`agent-control.ts:771`). Submit, queue, resume, and `saveSettings` all call it (`structured-sessions.ts:382`, `414`, `534`, `750`). `messageSettings` does not strip `sandbox`. This is the same error string recorded for the first local S1 dispatch. Not re-executed here.
2. Confirmed defect in the control catalog. `git.ship`'s `tools.list` string says the call pushes and then waits for the release (`agent-control.ts:147`). `delivery.ts:417` and `480–484` skip both unless `publish` is true. A coworker that trusts `tools.list` will misread a local commit as a publish.
3. Confirmed ranking behavior. Project file search ignores `.git`, `node_modules`, `out`, `dist`, `.next`, `.cache`, `coverage`, and `release` (`src/main/project-file-search.ts:7`). It does not ignore `artifacts/` or `recovery/`. Equal scores sort by path (`line 58`), and `artifacts/` sorts before `src/`. Duplicate recovery copies can outrank the source file on a tie. Search was not executed here.
4. Confirmed limit that already blocked this task. Local tool rounds reserve 2,560 tokens (`agent-policy.ts:84`). A `write_file` cut off at that limit runs nothing (`agent.ts:776`; unit coverage at `agent-loop.test.ts:298`). Both failed inventory writes stopped at `outputTokens: 2560`, and the runtime told the model to send smaller parts. The model repeated one oversized call. Local report jobs have to stay inside that reserve.
5. Confirmed gap, behavior unknown. `AllowanceProbe.codex` (`allowance-probe.ts:10`) opens a hidden Codex session, calls `refreshUsage`, and kills the transport. Nothing imports the class from a test. Whether the handshake still matches the current Codex CLI is unknown.
6. Confirmed gap, behavior unknown. `OrchestrationHub`, `SchedulesPane`, and `NativeCliPane` have source and no unit test. Their Electron behavior was not smoked. `MemoryPane` has an offline script that was not run.
7. Unknown. Durable-job fault recovery (`--kill-server`, `--restart-app`, `--loop-case`, `--stall-case` in `smoke-durable-jobs.mjs:20`) is implemented in source (`reconcile.ts:84`, watchdog and loop-guard modules) and was not run. Unit tests existing on disk do not show the current result.
8. Unknown. Remote reachability (gist mailbox, direct HTTPS, Tailscale bind, phone server) has broad unit and adversarial tests on disk and several smokes. None ran. `GitHubRelayMailbox` can throw `RelayUnavailableError` (`github-relay.ts:51`); this inventory did not observe a live mailbox.
9. Unknown quota. No app-control method reports a Grok weekly percentage. `tools.list` in this session has usage parsing (`usage-limit.ts`) and no quota read. The 95% Grok stop was not applied because no authoritative percentage was available.
10. Unknown execution sandbox. Local command tools require Docker and refuse the host when it is missing (`local.ts:240`, mount rules in `local-models/sandbox.ts:414`). This inventory did not ask Docker whether the sandbox image runs. `scripts/smoke-recovery.mjs` also does not boot Conductor; a crash-recovery claim needs a launcher this script does not contain.

## Out of scope

Baseline typecheck, full tests, and production build belong to the S2 worker. Completed-claim audit belongs to the S3 worker. `docs/autopilot-backlog.md`, `docs/autopilot-evidence/claim-matrix.md`, and `feature-list.md` were not modified.
