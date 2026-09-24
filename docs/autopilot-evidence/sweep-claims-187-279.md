# S3d source sweep, claims 187–279

Audit time: 2026-09-24. Worker owns only this file. `feature-list.md`, `src/main/agent-control.ts`, `docs/autopilot-brief.md`, `docs/autopilot-backlog.md`, and `docs/autopilot-evidence/claim-matrix.md` were not modified. No checklist item was marked done or reopened. No vitest, build, Electron, model server, download, or `git.ship` from this checkpoint.

Ledger: 93 data rows (187–279), all written below. **verified: 0. failed: 0. inspected: 93. not-opened: 0.** A green S2 baseline does not accept any row. `s3Complete: false` until the controller has runtime or restart evidence. No test in this file was executed. Follow-up on 2026-09-24 opened the 17 rows that were still unread and withdrew both earlier failure calls. Row 233 is the earlier stop-button sentence; row 238 is the later split (button blue, stopped indicator red). Row 275's effort control shows a concrete level; the model-name string "Account default" is a different control.

| Checkpoint | Rows | Inspected | Not opened |
| --- | --- | ---: | ---: |
| 1 | 187–206 | 20 | 0 |
| 2 | 207–226 | 20 | 0 |
| 3 | 227–246 | 20 | 0 |
| 4 | 247–266 | 20 | 0 |
| 5 | 267–279 | 13 | 0 |

Row 249 matrix id `3f20f90967b0832b5063-0` is not a `conductor-task` id. The matching checklist text is `feature-list.md:569`, marker `strict-local-remote-projects` on the next line. That row is inspected under checkpoint 4.

Method: read the checklist sentence and the current source or test it names. Unit tests below were read, not executed. **unverified** means the code or test was read and no runtime or restart was performed. **not-opened** means that path was not read.

## Checkpoint 1 (187–206) — settled

### 187 `feature-all-project-activity` — inspected — unverified
`aggregateProjectActivity` (`src/main/project-activity.ts:51-71`) rolls persisted phases for every project, including panes never mounted (`index.ts:539-549`, IPC `activity:projects` at `index.ts:1760`, coalesced publish `index.ts:2091-2098`). Renderer holds only the active project's sessions (`App.tsx:178-180`) and merges the backend snapshot (`App.tsx:224-227`, `572-578`; `attention.ts:115-126`). `project-activity.test.ts:181-210` expects a never-opened project to report `working`, then `idle` after `reconcileInterruptedRuntimes`. `attention.test.ts:244-266` covers the merge. Next: two projects open, work only in the unfocused one, confirm its row without focusing it, then restart and confirm an in-flight row does not stay `working`.

### 188 `feature-memory-loop` — inspected — unverified
`formatRecalledMemories` / `fitRecalledMemories` budget 3500 chars (`memory.ts:252-267`). `MEMORY_PROTOCOL` (`memory.ts:234-247`) is sent only when `staticDue` (`turn-briefing.ts:74-84`); prune runs on that same first send (`turn-briefing.ts:77`). `turn-briefing.test.ts:37-64` expects the static block once, then a delta. `captureMemories` ignores the protocol template (`memory.test.ts:101`). Per-item dedup is `capturedMemoryKey` (`memory.ts:277`, `memory.test.ts:106-107`) checked in `agent-manager.ts:332-340` before `remember`. A repeat of the same gist from another item still consolidates and does `strength + 1` (`database.ts:1403-1411`). The seen set clears at 500 (`agent-manager.ts:339`), so a later snapshot can bank again. `forgetStaleMemories` drops only faded unrehearsed agent episodes (`database.ts:1548`, `database.test.ts:91-103`; gates in `memory.ts:116-124`). Next: run `memory.test.ts`, `turn-briefing.test.ts`, and the database memory cases. Restart: prune is once per runtime ledger, not once per process lifetime across relaunch.

### 189 `feature-memory-curation` — inspected — unverified
Checklist body is `feature-list.md:371-379` (the marker line is only the lead-in). Provenance is `MemoryProvenance` (`MemoryPane.tsx:29-54`): source, origin conversation, relative time. Edit/delete for both sources (`MemoryPane.tsx:67-80`, `160-196`). Visible prune calls `memoryPruneCandidates` (`database.ts:1471-1476`), which ranks with `standingMemoryScore` (`memory.ts:103-172`) and deletes nothing. `MEMORY_KINDS` is imported by `MemoryPane.tsx:3` and the `memory.remember` catalog (`agent-control.ts:137`). Recall strip mounts on the turn (`StructuredAgentPane.tsx:822`, `MemoryRecallStrip.tsx:67`). `database.test.ts:110-136` covers origin and re-attribution. No test renders `MemoryProvenance`. `memory-recall-strip.test.ts` was not read. Next: open that test and `scripts/smoke-memory-curation.mjs` offline; correct a recalled memory from the strip and confirm the pane. No Electron this pass.

### 190 `663db862-e082-436a-9826-c385c232ae2d` — inspected — unverified
`taskTitleRow` draws `project-task-done-check` only for `done` (`ProjectBacklogPane.tsx:185-187`). CSS strike-through is `.project-task.status-done` (`ProjectBacklogPane.css:44`). `ProjectBacklogPane.test.ts:110-119` expects the class for done and not for todo/doing. CircleCheck at line 331 is selection, not completion. Next: the test file only. Visual glance in the installed panel was not done.

### 191 `a17381dc-57e2-4232-9e3c-85bfdbb32455` — inspected (credential half) — unverified
GitHub device-code login is `github-auth.ts:21-22` and `:244-256`. `github-auth.test.ts:70-93` stubs `https://github.com/login/device/code` and expects `userCode`. That is not a live login. The rest of the sentence (a server another Conductor can drive, and picking which machine runs the window) was not opened here; later rows in this sweep name relay, Tailscale, and remote projects. Next: those rows, then a real device-code login only if the owner asks. Do not start a relay.

### 192 `3439f02b-608f-4bd6-9ded-97ed51ec573a` — inspected — unverified
`ConversationFindBar.tsx:20-39` is "Find in this workspace", Ctrl+F refocuses, two characters before other conversations (`:40`). Bound from `StructuredAgentPane.tsx:538-546`. No test file was opened. Next: read the search test if one exists; in the app, Ctrl+F must hit another workspace conversation and scroll to the highlight. Not run.

### 193 `2aa42f5b-c9d6-45a4-b71e-c75776557094` — inspected — unverified
`evaluateUsageWarning` (`usage-warning.ts:38-49`) flags 70%/90% of the active cap, or $2/$5 when no cap exists, and returns null when cost is unreported (`:47-49`). Tab telemetry calls it (`StructuredAgentTelemetry.tsx:68`). Processes calls it (`ProcessDashboardPane.tsx:47`, `ProcessStatusSummary.tsx:126`). `usage-warning.test.ts:16-49` matches those thresholds. Next: run that file. A live expensive turn was not opened. Warning does not prove the Processes row paints it.

### 194 `9a048670-02d1-4315-85b9-28356a06f42e` — inspected — unverified
File menu has Open session and Save session (`TitleBar.tsx:100-101`). The top bar shows `sessionName` (`TitleBar.tsx:126`, state `App.tsx:124`). `parseSessionArchive` is tested (`session-archive.test.ts:48+`), including refusal of a bad machine and a cross-project agent tab. Import forces `continueOnLimit: false` (`session-archive.ts:184`). Handlers that replace the desk were not read. Next: save, quit, open, and confirm every project and agent tab returns. Unit parse is not that.

### 195 `a9fbb1af-a90c-454c-9242-71cba7350e85` — inspected — unverified
A user message that carries `origin` renders `Link2` plus the sender label and calls `onFocusOrigin` (`StructuredAgentRenderers.tsx:590`). The pane resolves that with `agentControl.focusOrigin` (`StructuredAgentPane.tsx:577-581`). `StructuredAgentRenderers.test.ts:24-27` expects `aria-label="Show Fixer tab"`. `agent-control.test.ts:245-270` expects `tabs.focus` for a controller, a worker, and a peer, still after `releaseByOwner`, and `tabs.focus-origin` for a closed-tab id; an unknown id throws `no longer available`. A plain owner "You" message has no link. Next: run those two tests. A click in the running app was not done. The first search missed this control; this correction replaces the not-opened note.

### 196 `urgent-runtime-startup` — inspected — unverified
The `[x]` line is `feature-list.md:401`. The following acceptance paragraph (`:403-405`) still says shell, REPL, and apply_patch failed with `helper_unknown_error`, and says not to assume a report file exists. Conductor source explains the failure once (`codex.ts:121`, notice at `codex.ts:1022`). `codex.test.ts:243` filters that notice. It does not make the sandbox helper succeed. The later checklist item `codex-sandbox-long-path` (`feature-list.md:611`) claims an out-of-repo path move; `docs/codex-windows-sandbox-repair.md` was not re-read past the header match, and the quarantine directory was not checked. Next: one model-free Codex `command/exec` in a visible tab. Do not disable the sandbox.

### 197 `urgent-coworker-visibility` — inspected — unverified
`feature-list.md:413` says the `app.state` attempt never ran because the shell would not start, and the control API was not shown broken. Current `app.state` includes co-open projects (`agent-control.test.ts:729-730`) and `agents.snapshot` exists, but that test is a synthetic adapter, not live Claude activity in another tab. Next: after a Codex shell works, `tools.list` then `app.state` and snapshot the other tab's phase. Distinguish that from the briefing.

### 198 `urgent-project-tasks` — inspected — unverified
`feature-list.md:419` says that session could not call the task API. `tasks.update` is implemented and tested for status, claim ownership, and priority (`agent-control.test.ts:395-415`). That is not a live add/update in the installed Project tasks panel, and the "migrate the urgent handoff" sentence was not checked against the checklist. Next: one `tasks.update` from a real coworker and a visible panel refresh. Do not mark checklist rows from this audit.

### 199 `urgent-claude-session-permission` — inspected — unverified
Choices include `allow-session` with a session-only description, disabled when Claude offered no reusable rule (`claude.ts:895-916`). Required-approval and plan mode force an empty update list (`:894-895`). `claude.test.ts:911` expects the choice disabled with "did not offer". `StructuredAgentRenderers.test.ts:284-289` expects the button label. No test was read that a second identical prompt is not asked again, or that the grant dies on resume. Next: run the Claude permission block, then one real card. Session grant must not become a permanent rule.

### 200 `urgent-claude-auto-mode` — inspected — unverified
`auto-mode` is a separate choice (`claude.ts:917-918`). Disabled with "already active" when `permission === 'auto'` and not plan. The renderer test expects that disabled button (`StructuredAgentRenderers.test.ts:285-292`). The handler that applies the provider mode and resolves the pending request was not read. S3a left this not-opened; this pass opened the choice list only. Next: read the choice handler and a test that auto is offered only when the provider lists it, then one real card.

### 201 `task-multiline-reports` — inspected — unverified
`submitTaskShortcut` submits on Ctrl/Cmd+Enter and does not submit on plain Enter (`ProjectBacklogPane.tsx:145-148`). Edit and add textareas use it (`:340`, `:381`). `ProjectBacklogPane.test.ts:122-141` matches that, including IME. Image lines are extra title lines (`:150-164`). The checklist parser's round-trip of a newline was not opened. Next: run that describe block; file a two-line report and reload the pane.

### 202 `bug-tab-close-resize-flash` — inspected — unverified
`closeFocusedTab` wraps the layout patch in `startViewTransition` (`App.tsx:969-982`). CSS snapshots are `styles.css:554-556`. No test references this close path. "Without re-rendering content" is not asserted. Next: close a tab beside a terminal and a code pane and watch for a flash. Reduced-motion was not checked.

### 203 `bug-move-tab-shortcut` — inspected — unverified
Ctrl+Shift+Alt+Arrow calls `moveFocusedTabTo` (`App.tsx:1214-1215`, key handler `:1341`). `moveFocusedTab` is `tab-keyboard.ts:142`. `tab-keyboard.test.ts:130-155` expects a right move and a no-op when already at the edge. Resize remains the chord without Alt (`nudgeFocusedGroup` is separate in the same handler). Next: run `tab-keyboard.test.ts`. A real keypress was not sent. The checklist marker has no agent id (`feature-list.md:443`).

### 204 `bug-theme-switch-lag` — inspected — unverified
`applyAppTheme` uses one `startViewTransition` on `<html>` instead of per-element transitions (`appearance.ts:33-42`). `appearance.test.ts:59-88` expects the wrapper when motion is allowed, a sync apply when the API is missing, and no transition under reduced motion. `styles.css:554` sets 0.24s. Next: run `appearance.test.ts`. Day/night click lag was not timed.

### 205 `bug-cross-project-access` — inspected — unverified
`agent-control.test.ts:721-777`: `projects.list` returns both projects, `app.state.projects` includes the sibling, `files.read` with `projectId` reads it, `files.write` to the sibling throws, `tabs.open({projectId})` creates the tab there, and `router.dispatch` into the sibling refuses this project's task claims. A paired-machine scope is a different test (`:700`, "Remote machine placement is unavailable") and was not read through. Next: run that describe block. Live handoff to a second open project was not done.

### 206 `bug-release-workflow-short-paths` — inspected — unverified
The 8.3 false-symlink comment and `lstat` walk are in `file-drop-move.ts:23-29` and `prompt-context.ts:92-95`. `scripts/repair-codex-workspace-owner.test.mjs:13` uses `realpathSync.native`. No `.github` workflow file matched a search for `realpathSync.native` or `Get-Acl` (workflows may be unscanned). v0.1.19 installer, blockmap, and `latest.yml` were not fetched. Next: read the workflow YAML and the annotation step. Do not push or publish to confirm it.

## Checkpoint 2 (207–226) — settled

### 207 `bug-limit-continuation-structured` — inspected — unverified
Structured sessions parse the provider error, persist the wait, emit the "will send continue" notice, and schedule it (`structured-sessions.ts:994-1063`). `ensure` re-arms from SQLite (`:161-162`, `:1019-1026`). `structured-sessions.test.ts:1489-1570` expects phase `limited`, a `continue` submit after 2h, no submit when opted out, a toggle applied after the wait started, owner-first cancelling the timer, and a new `StructuredSessions` on the same database re-arming the wait. A usage cap rejects a later `submit` (`structured-sessions-usage-cap.test.ts:81-100`) but that file does not arm `continueOnLimit`. `runContinuation` still calls `submit('continue')` (`structured-sessions.ts:1059`); the cap throws from `assertUnderUsageCap` (`:1103-1110`) rather than skipping the timer. Next: run the continuation describe, then one case where a cap is set before the window reopens. Restart is asserted only by constructing a second manager on the same SQLite file, not by quitting Electron.

### 208 `task-selection-dispatch` — inspected — unverified
Selection uses `Circle` / `CircleCheck` (`ProjectBacklogPane.tsx:331`). Status `<select>` includes Done (`:343`). `agent-control.test.ts:540-563` expects one claimed id to open a visible worker at the chosen effort, move that task to `doing` then `done`, and reject missing, finished, owned, or duplicate ids before any tab. The "Auto opens a main Fixer that chooses models" sentence was not opened. Next: run that describe. Multi-select in the pane was not clicked.

### 209 `feature-subagents-view-detail` — inspected — unverified
`SubagentCard` shows model plus effort, tokens, status, native session id, task, and activity cards (`StructuredAgentTelemetry.tsx:118-153`). `subagentModelLabel` (`usage-summary.ts:85-87`). No tab title or workspace name is rendered on that card, so the clause "which tab and workspace it belongs to when that differs" is absent from the component that was opened. Nested "Within X" is a parent label (`StructuredAgentRenderers.test.ts:356`), not another workspace. Next: confirm there is no second component, then a live Codex subagent. Do not accept the card's existence as that clause.

### 210 `briefing-once-per-runtime` — inspected — unverified
Same path as 188. `CONTEXT_RESET` resets the ledger (`turn-briefing.ts:25`, `:108`). `turn-briefing.test.ts:76-88` expects a new process and a compaction to restate `MEMORY_PROTOCOL`. Local prompts omit the control credential (`turn-briefing.ts:80-82`). The claim's two-week measurement and `scripts/probe-context-cost.mjs` were not opened or run. S3a did not accept this. Next: run `turn-briefing.test.ts` only. Do not re-measure logs.

### 211 `swarm-token-thrift` — inspected — unverified
Admission refusal names the running model and says Conductor has not stopped it (`resource-guard.ts:105`). The machine line is composed with the static briefing (`turn-briefing.ts:61-62`, `:84`). `docs/machine-profile.md`, the tool-result cap, `agents.handoff`, and the before/after 9B numbers were not re-read. The claim cites a 2026-09-21 measurement. Next: read `resource-guard.test.ts` for the busy-server refusal. Do not start a second server.

### 212 `swarm-capability-repairs` — inspected — unverified
`docs/conductor-provider-parity.md:96-112` marks R3, R5, R6 deferred and R1, R2, R4, R7–R15 applied, with smoke notes dated 2026-09-21. Those smokes were not re-run. Spot checks: `resolveEffortChoice` returns undefined instead of guessing `medium` (`model-effort.ts:27-34`); Codex structured efforts include `max` and `ultra` (`codex.ts:261`). The checklist colon-list still describes the old "launch on --effort medium" bug in present tense (`feature-list.md:465`). Current source matches the doc's applied R7, not a medium launch. Next: run `model-effort.test.ts` and one Codex effort test. Do not treat the 2026-09-21 smoke log as this tree.

### 213 `7afeb35f-7d25-4674-b49c-909242c08070` — inspected — unverified
Send-on-disconnect is `autoResumeOnSend` when `phase === 'disconnected'` (`StructuredAgentPane.tsx:558-560`). `StructuredSendButton.test.ts:58-60` expects state `resume` with no draft and `Send message` when a draft exists. Resume/play uses `--blue` on `--surface-0` text (`StructuredAgentPane.css:221-222`), not a hard-coded dark gray. Night contrast was not viewed. Next: run the send-button test, then night mode with a disconnected tab. A real resume was not sent.

### 214 `5c928ae5-389c-49dd-bca9-cc2199947109` — inspected — unverified
The add row uses `TaskScaleSlider` for priority and weight, and the submit control is a `Send` icon with `aria-label="Add task"` (`ProjectBacklogPane.tsx:382`). No test in `ProjectBacklogPane.test.ts` mentions the slider. Next: render the pane and move both sliders; confirm the filed task stores the values. Not done.

### 215 `24b0a4de-e4a3-4ff7-b9ec-57f88ad84da4` — inspected — unverified
A disconnected sibling does not outrank a working tab: `aggregateProjectActivity` returns `working` (`project-activity.test.ts:86-97`). A project whose only visible agents are disconnected returns `waiting` (`:59`, `:102-105`). `attention.ts:97-98` documents the same rule for the renderer fold. Next: run `project-activity.test.ts`. The sidebar color for `working` vs `waiting` was not looked at in CSS or on screen.

### 216 `90565509-288b-467a-9e77-eebd319485bf` — inspected — unverified
`loadProject` prefers `sessionIdsByProject[projectId]` over the first session (`App.tsx:322-357`). That map is part of the recovery checkpoint (`database.ts:866-876`) and survives a reopened database (`database.test.ts:257-280`). It is in-memory plus the checkpoint, not a per-project column read on every click unless recovery was flushed. Next: switch A→B→A without restart, then quit and reopen. The test is a database round-trip, not the React switch.

### 217 `42bcf09f-562f-4a85-b308-a3e8accfaa30` — inspected — unverified
`BrowserMcpServer` advertises project browser tools (`browser-mcp.ts:175`). The composer Globe button toggles `settings.browserMcp` and does not open the view (`StructuredAgentPane.tsx:872`). `browser-mcp.test.ts` was not read. A session with the toggle off was not shown to lack the tools. Next: read the test that tools are omitted when `browserMcp` is false, then one live tool list. Do not start Electron here.

### 218 `9f0e21b4-browser-partition` — inspected — unverified
Main-process guests use `persist:conductor-browser-${projectId}` (`browser-views.ts:95`). `browser-owned-surface.test.ts:97-115` expects project-a and project-b partitions to differ. Renderer `browserPartition` matches (`browser-partition.test.ts:12-13`). Cookie isolation was not executed in a real Electron partition. Next: run `browser-owned-surface.test.ts`. A live cookie in project A must be absent in project B. Not done.

### 219 `6c1d77a2-webview-allowpopups` — inspected — unverified
`BrowserPane` markup under test contains no `<webview` and no `allowpopups` (`browser-partition.test.ts:32-37`). The main process denies `setWindowOpenHandler` (`browser-views.ts:364-368`) because a string `"false"` would enable popups. `browser-mcp.test.ts:314` comments the same trap. Next: run the partition test. A `window.open` in the live view was not attempted.

### 220 `c3edd052-0f61-4222-b103-2301735b1d77` — inspected — unverified
Escape in an active pane calls `interrupt(id, true)` (`StructuredAgentPane.tsx:524-530`). That marks every queued prompt and then, after interruption, requeues them as steering in order (`structured-sessions.ts:957-968`, `:697-705`). `structured-sessions.test.ts:1308-1321` expects three queued texts to flush, first as a submit and the rest as steers. A non-expedited interrupt leaves the queue (`:1295-1306`). Composer drafts are excluded (`:961`). Next: run that test. Esc in the app was not pressed.

### 221 `cd2ebc99-4682-44a2-9568-cbd1563988c9` — inspected — unverified
A collapsed group summary appends `Latest` plus the last tool title (`StructuredAgentPane.tsx:824-828`). The subagent roster's own completed group does not (`StructuredAgentTelemetry.tsx:153`). No test for `sa-completed-latest` was opened. Next: a turn with many tools, collapsed, must show the latest title. Not viewed.

### 222 `1e7535e5-eb65-4a1a-927c-dd962fa92183` — inspected — unverified
Relationship markers say MAIN vs COWORKER and the popover names both tabs (`AgentControlLinks.tsx:108-113`). Whether that is "always very clear" which tab opened the others is a visual claim. No test was opened. Next: open a controller with two coworkers and read the marker without hovering. Not done.

### 223 `2f0c12e2-979f-40a9-ac26-0d396419f0b7` — inspected — unverified
Each activity with a parseable timestamp renders `<time class="sa-activity-time" title={occurredAt}>` (`StructuredAgentRenderers.tsx:610-611`). `StructuredAgentRenderers.test.ts:18-21` expects `dateTime="2026-09-07T00:00:00Z"`. Usage and session events return null before that (`:607-608`), so those rows have no time. Next: run the test. Hover in the app was not done.

### 224 `e145f826-7a27-459c-8eef-0a36d9dcd706` — inspected — unverified
Ctrl+W is consumed as close-tab, not close-window (`index.ts:310-315`, menu accelerator `index.ts:885`, renderer `App.tsx:1259-1263`). Quit goes through `before-quit` → `confirmApplicationStop` (`index.ts:2324-2331`, `:755-763`), which lists `hasRunningWork` across `database.listProcesses()` and asks before stopping. The dialog was not shown. `close-confirmation.test.ts` covers `hasRunningWork`, including detached background tools (`:43`) and excluding a finished tool (`:24`). Closing the main window calls `app.quit()` (`index.ts:322`), which still hits `before-quit`. Next: Ctrl+W with a running agent must close a tab only; Alt+F4 or the window X must show the dialog and Cancel must leave the process up. Not done.

### 225 `8c9cc6a2-ae55-4a49-a82d-e675ffb4a9c0` — inspected — unverified
Docked questions render `sa-question-dock` with Reopen (`StructuredAgentRenderers.tsx:521`). State is `setQuestionDocked` (`StructuredAgentPane.tsx:583-588`). `StructuredAgentRenderers.test.ts:30-34` expects `sa-interaction-docked` and `Reopen question`. Whether the dock stays on screen while the timeline scrolls was not viewed (CSS `StructuredAgentPane.css:323` is only flex). Next: run the test, then scroll a long transcript with a docked question.

### 226 `f7e72b8d-94c7-4b47-adc1-ce0005eb83d5` — inspected — unverified
The composer globe toggles model browser tools (`StructuredAgentPane.tsx:872`). The view lives on the activity rail (`BrowserSidebar.tsx:37`), and the legacy pane says "Browser moved to the activity rail" (`browser-partition.test.ts:40-43`). The two controls were not clicked. Next: globe on must not open the sidebar; the rail button must. Not done.

## Checkpoint 3 (227–246) — settled

### 227 `d7be3750-9883-4597-8f0b-339b11434a6d` — inspected — unverified
The local loop has a typed policy, shaped tool results, conductor memory and `tasks.update`, and a research grant that adds `web_search` while the shell stays `--network none` (`agent.ts:76-94`, `tools.ts:39-82`, `local-models.test.ts:114-126` and `:734-739`). Catalog ids are Qwen 3.5 9B, Qwen 3.6 35B-A3B, Ornith 1.5 9B, and Dolphin X1 8B (`config.ts:61-83`). There is no Qwen 3.8 id. No recorded Qwen or 3.8 run was opened. Next: a real local turn only on a server the owner already has up. Do not download a model.

### 228 `cbbdb1a8-60c9-47d3-9718-bef1ebe90a6e` — inspected — unverified
Processes distinguishes attention, working, paused, disconnected, ready, finished (`ProcessDashboardPane.tsx:35`, `ProcessDashboardPane.helpers.ts:4-21`). `ProcessDashboardPane.test.ts:19` and `:26` were named by search, not read. "In sync with projects" was not watched. Next: read those tests, then compare the pane to a live running tab.

### 229 `3b124a0c-c10e-404a-aaf2-bfb0e94318d3` — inspected — unverified
Detached bash/powershell/shell launches are removed from the roster (`usage-summary.ts:140-142`, return `visibleAgents` at `:181`). A foreground shell is not in that set. No test in `usage-summary.test.ts` mentions `legacyShell`. Next: a fixture with a detached `cd` and a foreground bash, and confirm only the detached one is hidden.

### 230 `f36121ad-bb30-41cc-9cca-d1729fdd2c1e` — inspected — unverified
`resolveFileLinkTarget` accepts `C:\`, `C:/`, `/C:/`, and `file:///` and can point at a sibling project (`file-link-target.ts:13-40`). `file-link-target.test.ts:13-26` expects a miron-relative path and a conductor sibling id; a hosts-file URL is null (`:26`). Next: run that file. A click on a model-written path was not done.

### 231 `2ca846e3-ec45-4a15-84a2-566e231da69d` — inspected — unverified
`StructuredLiveTokens` animates `summarizeWorkingUsage` output tokens (`StructuredAgentTelemetry.tsx:13-19`). That summary uses a usage event after the latest user message, preferring `limits.workingOutputTokens` (`usage-accounting.ts:120-132`). `usage-summary.test.ts:166-168` expects no label between the prompt and the response usage event, then `19 output tokens`. A tool event by itself does not increment the figure. Next: a live turn whose provider emits usage during tool calls, and one that does not. The pending dots are the second case.

### 232 `26fe51b6-3c25-4bf2-bc54-0d19cd81ef64` — inspected — unverified
Assigning to an existing tab submits immediately, or `steerAccepted` when the phase is active (`project-task-dispatch.ts:138-144`, `:193-197`). Disconnected or failed targets throw instead of queueing (`:143`). A second assignment in the same project throws "already being submitted" (`:101`). The test that a running Fixer actually receives the steer was not opened. Next: `project-task-dispatch.test.ts` for an in-flight target. Do not dispatch a live fixer.

### 233 `4c1f63a2-c91e-436f-8ff3-a2ee67c8067c` — inspected — unverified
Superseded by row 238, not a defect. This sentence asked for a red stop control. The later checked sentence asks for a blue stop button and a red "session has stopped" indicator. Current source follows that later split: `.sa-send.sa-stop` uses `--blue` (`StructuredAgentPane.css:219-220`). The stopped indicator is row 238. Do not reopen 233 because the button is blue.

### 234 `b7655962-d90e-4d55-98a8-45d79109ff7f` — inspected — unverified
Built-in starter `grill-me` is asserted to interview one question at a time and not implement (`composer-starters.test.ts:5-9`). Other starters in that file were not read. The button in the composer was not clicked. Next: run that test.

### 235 `api-coworker-model-effort` — inspected — unverified
`agents.configure` changes model and effort, rejects an unknown model, an unsupported effort, extra keys, a non-idle tab, a queued tab, and self/ancestor (`agent-control.test.ts:469-503`). "Agrees with the native runtime" is the synthetic fixture's configure action, not a live CLI. Next: run that test. A live model change was not sent.

### 236 `local-qwen-reserved-ports` — inspected — unverified
`adoptRunningServer` adopts only a healthy server of the same model that presents the API key (`llama.ts:245-256`). Another process on the port is refused (`:394`). `local-models.test.ts:554` comments that 51424–51623 were the reserved range; the bind-probe body was not read. Next: read that test. Do not start llama-server.

### 237 `remote-control-internet-relay` — inspected — unverified
Direct dial is tried first, with a short probe when a relay exists, and a 4xx answer is not retried on the other route (`remote-control-client.ts:304-338`). The gist path seals to a published X25519 key (`relay-crypto.ts:8-19`, `remote-relay.ts:36-43`) and checks the envelope (`relay-envelope.ts:81`). `github-relay.ts:9-18` is one private gist per machine. `remote-relay.test.ts` was not read. A live off-LAN pair was not made. Next: that test file only. Do not poll GitHub.

### 238 `ed4ec639-8f09-4048-b662-3013bd6f4a89` — inspected — unverified
Stop button is blue (`StructuredAgentPane.css:219-220`). A stopped tab uses `CircleStop` colored `var(--danger)` (`TabActivityIndicator.tsx:38`, `styles.css:1047`); `--danger` is a red (`styles.css:15`, `#ff6d75`, and the theme values in `appearance.css`). An interrupted runtime banner uses the same red (`StructuredAgentPane.css:397-398`). The in-pane session dot is not shown once stopped: `activePhases` excludes `interrupted` (`StructuredAgentPane.tsx:55`, `:778`), and `.sa-session-dot` has no stopped rule (default `--text-3` at `StructuredAgentPane.css:12`). Disconnected tabs are amber, not red (`styles.css:1046`). Tool-row `interrupted` text is `--text-2` (`StructuredAgentPane.css:59`), which is not the session indicator. Next: look at a stopped tab in night and day. Not viewed.

### 239 `e1492d28-2b1b-4098-af3d-e201ee7a1b4e` — inspected — unverified
`SystemPerformanceChip.tsx:75-129` renders CPU, RAM, GPU utilization, and VRAM, including a local server row. When it mounts (only while a local session exists) was not read. No test was opened. Next: the mount condition and a screenshot only if a local server the owner already started is up. Do not start one.

### 240 `local-request-failures` — inspected — unverified
`repairToolProtocol` runs before the request (`agent.ts:231`, `:413`). `agent-loop.test.ts:284-295` expects a scripted HTTP 400 to surface in notices and a later turn to recover. Queue drain after a failed phase is commented in `structured-sessions.ts:714-716` and was not matched to a local-model test. Next: run the agent-loop 400 case only. Do not call a live model.

### 241 `remote-local-models-and-close` — inspected — unverified
`createPlacedTab` sends the chosen model to the other machine and says a local model must be asked for that exact id (`machine-placement.ts:147-160`). The host looks up `args.model` on its catalog and refuses an unknown id (`remote-control-host.ts:564-571`). Closing a placed agent tab calls `remote.closeTab` (`machine-placement.ts:90-94`). `remote-session-mirror.test.ts:191-200` expects `tabs.close` on the remote tab id and an empty mirror list afterwards. A terminal is explicitly not closed that way (`machine-placement.ts:86-88`). No paired Qwen tab was opened or closed. Next: that unit test only. Do not start a server.

### 242 `local-tasks-update-and-contract` — inspected — unverified
The local prompt tells the model to read `tasks.list` for the revision and that read-only cannot update tasks, and it states `.git` is read-only unless repository writes are granted (`agent.ts:88-91`). `harness.test.ts:73-82` expects `tasks.update` in the writable tool list, absent when read-only, and a read-only call to fail. `control-integration.test.ts:54-74` claims then completes `local-1`, reopens the database for the memory, and rejects `tasks.update` after permission is set read-only. `agents.snapshot`'s catalog text says the id must be one from `agents.list` (`agent-control.ts:116`). The throw for a missing id is still the generic `Invalid agentSessionId` from `text()` (`agent-control.ts:61-64`); that sentence does not name `agents.list`. Next: run `control-integration.test.ts` and `harness.test.ts`. A live local edit of `feature-list.md` was not made.

### 243 `local-git-and-research-grants` — inspected — unverified
Both toggles render only when `provider === 'local'` (`StructuredAgentPane.tsx:884-887`). Unset `localGit` / `localResearch` is off: the adapter passes `Boolean(settings.localGit)` into the session and `setGitAccess` before the turn (`local.ts:299-307`). Without the git grant the mount is `/.git,readonly` and `--network none` stays on either way (`local-models.test.ts:114-126`). Research adds `web_search` and raises rounds to 48 (`agent.ts:323`, `agent-policy.ts:93`, `local-models.test.ts:734-739`). The checklist sentence "never push" is older than row 250: the prompt and the button now describe a host-brokered plain push (`agent.ts:88-89`). Non-local refusal is the `agents.grant` test in row 251. Next: run the mount test. Do not grant writes on this repo.

### 244 `conductor-own-relay` — inspected — unverified
`src/relay-server/server.ts:96-98` requires a room secret of at least 16 characters. `relay-server.test.ts:119` and `:145` expect two holders of the secret to exchange a sealed message, and a machine that cannot prove the secret or its device key to be refused. `relay-server/main.ts:39` still documents `CONDUCTOR_RELAY_SECRET` for the standalone process. Envelopes stay the gist route's sealed form (`remote-relay.ts:39-43`). Whether an idle pair no longer polls GitHub was not observed. Next: run `relay-server.test.ts`. Do not start a relay.

### 245 `relay-hosting-in-settings` — inspected — unverified
`RelayHost` binds in-process, moves to another port when the asked port is taken, and publishes `wss://` addresses (`relay-host.ts:203-231`). `relay-host.test.ts:205` expects the "already in use" message. UPnP refusal is exercised by a fake router (`port-mapping.test.ts:27-46`). The settings switch that calls this host was not opened. A router was not asked to forward a port. Next: the settings handler that starts `RelayHost`. Do not start one.

### 246 `foolproof-device-linking` — inspected — unverified
Account & machines leads with Invite a device and I have an invite (`RemoteControlSettings.tsx:214-233`). The comment says invite turns on what the link needs and starts a relay if none is configured. Port-in-use move is `relay-host.ts:229-230`. The one-sentence status is `linkSummary(state)` (`:224`); that function was not opened, and neither was the fold labeled Advanced. Next: read `linkSummary` and the `remote.invite` implementation. Do not pair a machine.

## Checkpoint 4 (247–266) — settled

### 247 `tailscale-multi-device` — inspected — unverified
`PhoneAccessServer` test expects a Tailscale address and DNS name and an `exposure: 'tailscale'` update (`phone-access-server.test.ts:171-178`, `:228`). The listener bind and "no gist, no port forward" path were not read. `index.ts:2266` passes `remoteControl.tailscale` into the host. Next: the bind call. Do not bring Tailscale up.

### 248 `239a2ee8-458c-47a9-a3e2-22b47d129c05` — inspected — unverified
When the provider executable is missing, the terminal offers `installUrl` via `openExternal` (`RuntimeTerminal.tsx:651`). Local setup errors use `LOCAL_MODEL_SETUP_URL` (`StructuredAgentRenderers.tsx:600`). Neither link was clicked. Next: a provider with no CLI, confirm the button target. Do not download.

### 249 `3f20f90967b0832b5063-0` — inspected — unverified
Checklist text is `feature-list.md:569` (marker `strict-local-remote-projects`). `remote-project-adoption.test.ts:58-63` expects adopted names and a desk of those ids, and says the grant maps to the host id. Removal memory, "which computer" on add, and refusal of local/remote pairing were not read. Next: `database-remote-projects.test.ts:95` onward. The two-instance smoke named in the checklist was not run.

### 250 `local-git-push-broker` — inspected — unverified
`parsePushCommand` allows one `git push` with an optional remote, branch, and `-u`, and refuses flags, compound commands, and refspecs (`git-push.ts:24-42`). `git-push.test.ts:42-70` expects `--force` refusal and a branch mismatch throw. `brokeredGitPush` (`:80`) was not read line by line; those tests call it against a temp repo, not the network. `tools.ts:371` is the caller. Next: run `git-push.test.ts`. Do not push.

### 251 `agents-grant-local-model-grants` — inspected — unverified
A non-local caller can set `repository` and `research`, revoke one, reject unknown keys and non-booleans, and a local caller cannot grant another tab or itself (`agent-control.test.ts:1128-1161`). Enforcement inside the sandbox was not re-read. Next: run that block. Do not flip a real conversation's grant.

### 252 `background-work-tab-status` — inspected — unverified
A completed or idle turn that still owns background work is stored as `waiting_background`, and a completed turn that owns a subagent stays `working` (`structured-sessions.ts:1152-1159`). `structured-sessions.test.ts:1470-1476` expects `waiting_background`, then `disconnected` after a disconnect event. The live inventory is `adapter.backgroundWork()` (`:1150`), which a restart does not have. Project rollup treats the phase as working (`project-activity.test.ts:61-63`). Next: run that test. A multi-hour render was not left running.

### 253 `phone-access` — inspected — unverified
Phone server tests exist (`phone-access-server.test.ts`, `phone-access.test.ts:352` disconnected resume). Push notifications, "every conversation", and the phone web UI were not read. Next: `src/main/phone-notifications.ts` and one phone page. Do not bind a port.

### 254 `5c8e0194-04c1-4eeb-aa23-60d858eb2530` — inspected — unverified
Quit lists only `hasRunningWork` (`index.ts:751-763`). Finished tools are not work (`close-confirmation.ts:19-23`, test `:24`). A disconnected phase with no background count is not work (`close-confirmation.ts:20`). A stale `activityPhase: 'working'` with no projection still counts (`:10`). Next: quit while an idle tab is open and confirm it is absent from the dialog. Not done.

### 255 `6967d7ed-c567-481d-bff3-69728caf9375` — inspected — unverified
Unchanged sources return `outcome: 'unchanged'` and the detail says no agent turn was started (`latest-models.ts:144-149`). The daily row and the runner were not re-read. S3a did not accept this. Next: `schedule-runner.test.ts` and `latest-models.test.ts`. Do not run the network script.

### 256 `240c37ad-9556-47de-bbcf-9a40cd3e2fc5` — inspected — unverified
Phone sessions are appended in project, workspace, then tab order and are not re-sorted when a state changes (`phone-access.ts:613-648`). `stateOrder` and `rank` at `:937-938` have no caller, so activity does not reshuffle the list. The page groups that array and nests coworkers under their controller (`app.js:1262-1321`). No movement animation was found. Next: open the phone list with two working threads and confirm the rows stay put. Do not pair a phone from here.

### 257 `a90fed0f-2d01-4a66-a69f-11d3d649cdd5` — inspected — unverified
The phone hides coworkers until the owner expands that controller (`app.js:1306-1321`, compact row class `coworker-session` at `:1224`). Desktop tab groups can collapse to the chip (`tab-groups.ts:25`, `:164-176`, `styles.css:1738`). Nothing read assigns a swarm to a collapsed group by itself. Next: confirm a MAIN tab with several coworkers is grouped without a manual "new group". Not viewed.

### 258 `c699b997-a586-460a-925c-0c0aabd7db9a` — inspected — unverified
The phone New screen has a Project task mode and posts title, kind, priority, and weight (`app.js:2123-2152`). `PhoneAccess.createProjectTask` writes through `projectTasks.create` and rejects an empty title, a task marker, and an unknown kind (`phone-access.ts:902-919`). No phone UI test was opened, and no task was created. Next: the phone-access test for that method, if one exists. Do not post a task.

### 259 `codex-permission-presets` — inspected — unverified
Composer modes map to sandbox and approval presets; Auto is `workspace-write` / `on-request` / network / unattended (`codex.ts:70-78`). `never` is documented as refused (`:65-67`). The composer control that shows Ask / Read only / Edit / Auto was not opened. Next: the Codex mode picker test. A live approval was not raised.

### 260 `e2a9d29e-39bf-48ef-8203-1e0184a18156` — inspected — unverified
The phone state includes `weeklyUsage` and allowance windows (`phone-access.ts:649-650`). The page renders "Last 7 days by model" with token totals and a percent meter per window (`app.js:2390-2418`). It does not render a live per-turn counter. Next: open that phone card against a machine that already has usage rows. Do not generate a turn to fill it.

### 261 `40de020c-def4-486b-b85f-273d4aaea75d` — inspected — unverified
A running tab needs confirmation; an interrupted tab closes with `confirm` not called and the snapshot kept (`agent-control.test.ts:273-290`). History richness was not opened. Next: run that test. A live close was not sent.

### 262 `c6ed3a5f-ae1b-4850-8901-6591d4d887b9` — inspected — unverified
`ensureDockerAvailable` (`sandbox.ts:165`) is called before sandbox use (`:614`). `sandbox-startup.test.ts:6` is "lazy Docker Desktop startup"; the cases were not read. Llama autostart is the server path in row 236, not a second start here. Next: read the startup test. Do not launch Docker Desktop.

### 263 `a3fdf8ee-d7ab-450a-a04f-0b143fa586bd` — inspected — unverified
The header flame renders only when some project has a usage warning (`ProcessStatusSummary.tsx:179-186`). A row flame renders only for `entry.warning` (`:201`). `WeeklyUsage` is the compact footer (`:209`). `evaluateUsageWarning` is the same helper as row 193, so an inactive tab with no cost and no cap does not warn (`usage-warning.ts:47-49`). No test of the flame's absence on an idle row was opened. Next: `ProcessStatusSummary.test.ts` if it covers the flame. Not viewed.

### 264 `c5d85a81-712d-4dc6-83bb-3e4132fdee5c` — inspected — unverified
Ornith 1.5 9B is a pinned catalog entry beside Qwen 3.5 9B, not a replacement of it (`config.ts:61-76`, size `5780090816`). `ready()` refuses a server whose chat template reports `toolCalls === 'unsupported'` (`local.ts:283`). `docs/local-model-shortlist.md:263-276` still tells the owner to download and probe; that download was not checked on disk. Qwen 9B remains in the catalog. Next: do not download. A tool-call probe is the owner's command in that doc.

### 265 `codex-auto-mcp-approval` — inspected — unverified
Auto does not use Codex `never`; the comment says `never` refuses unannotated MCP tools (`codex.ts:65-74`). The regression file `codex-auto-refusal.regression.test.ts` was not read. Next: the test that an MCP tool is allowed under Auto. Do not call Codex.

### 266 `browser-toggle-memory` — inspected — unverified
A new Claude/Codex/Grok conversation sets `browserMcp` from the remembered setting, defaulting to on (`structured-sessions.ts:141-146`), and permission from remembered mode, defaulting to `auto` (`:177-182`). `browser-optin-adversarial.test.ts:66-70` expects a saved `false` to stick. Phone and remote open paths are only in the comment. Next: run that test and a restart of the setting. Not done.

## Checkpoint 5 (267–279) — settled

### 267 `codex-sandbox-long-path` — inspected — unverified
Same notice as row 196 (`codex.ts:1022`). The checklist says the 2026-09-22 repair was moving one long pnpm directory outside the repo (`feature-list.md:611`). That directory was not checked. The doc `docs/codex-windows-sandbox-repair.md` was matched by search, not re-read. Next: one model-free Codex exec. Do not treat the doc's date as this session.

### 268 `approval-review-owner-lockout` — inspected — unverified
If review cannot run, `pause` leaves a normal owner approval and records why (`approval-review-gate.ts:93-99`). `approval-review-routing.test.ts:22` is titled as not reviewing a cross-project or closed controller; the body was not read. Next: read that test. A live locked card was not reproduced.

### 269 `codex-auto-answers-escalations` — inspected — unverified
`ownerOnlyEscalation` keeps hosts, elevation, registry, credentials, and recursive delete for the owner (`codex.ts:80-108`) and strips the Windows PowerShell interpreter path before matching (`:106`). Other out-of-workspace commands are described as allowed once (`:61-62`). The test that a desktop shortcut is answered and a hosts edit is not was not read. Next: that test. Do not run either command.

### 270 `claude-auto-denial-visible` — inspected — unverified
`autoModeDenialOf` recognizes the classifier refusal (`auto-mode-denial.ts:13-36`). The notice renderer swaps in `AutoModeDenialCard` (`StructuredAgentRenderers.tsx:602`). Denial also feeds tab attention (`App.tsx:167-172`). No test was read. Next: the denial-card test, then one real refusal. Not done.

### 271 `cross-project-steer-owner-tab` — inspected — unverified
An uncontrolled tab in a co-opened sibling, including the owner's conversation, can be listed, snapshotted, and submitted; submit takes control (`agent-control.ts:422-446`, `agent-control.test.ts:806-819`). A tab another controller holds is refused (`:822-831`). Configure from next door is refused (`:814`). A paired-machine tab can be read and not steered (`:835`, body not read). Next: run the describe. A live steer was not sent.

### 272 `local-model-idle-switch` — inspected — unverified
An idle server this Conductor started is stopped to make room; a foreign server is left alone; a busy verdict refuses and names why (`llama.ts:409-418`). Without `release`, another model is still refused (`:402-405`). No test of `makeRoom` was opened. Next: the idle-switch test. Do not stop the owner's running server.

### 273 `local-context-management` — inspected — unverified
Default policy compacts at 0.78 and 0.90, reserves 2560 tokens for a tool round, shapes command output to 6000 characters and file reads to 200 lines, warns at rounds 10/16/20, and hard-stops at 24 (`agent-policy.ts:83-87`). A final message that claims edits and passing tests with no write tool is `unverified_claim`, and the model's sentence is not the returned text (`context-management.test.ts:200-209`, `completion.ts:4-8`). Acceptance that already passed tells the model to stop (`context-management.test.ts:184-190`). Those tests were not executed. A 32k Ornith run was not started. Next: run `context-management.test.ts` only.

### 274 `dispatch-auto-mode` — inspected — unverified
`dispatchPermission` returns Auto for a native coworker unless `exactPermission`, the provider is local, or the controller is restricted (`agent-control.ts:57-59`). `tabs.open` calls it with `args.exactPermission === true` (`:764-769`). The test that omits `exactPermission` and expects `auto` was not read. Next: that assertion in `agent-control.test.ts`. A live dispatch was not opened.

### 275 `d0b9a61a-f415-4939-9ec1-7c9dc1dac182` — inspected — unverified
Not a keyword failure. The effort slider renders only when `efforts.length > 0` (`StructuredComposerControls.tsx:103-110`), and `documentedDefaultEffort` then returns `medium` when that rung exists (`model-effort.ts:42-44`). With no saved or reported effort the label is `Medium (account default)` and nothing is committed (`StructuredComposerControls.test.ts:47-65`). A fresh Claude ladder does the same, and a runtime-reported `xhigh` replaces it with `Xhigh` (`:179-193`). The bare output `Account default` is what those tests forbid (`:63`, `:187`). The model-name string "Account default" in `composer-settings.ts:45` is the model control, not this effort claim. Accuracy of the guess is unresolved: the comment records the owner's Claude settings as recommending medium on 2026-09-23, and the same test comment says the CLI's configured level on 2026-09-21 was xhigh (`model-effort.ts:36-40`, `StructuredComposerControls.test.ts:180-182`). `resolveEffortChoice` still sends nothing in that gap (`model-effort.ts:31-33`), so the slider can say Medium while the CLI runs xhigh until a turn reports an effort. Next: read the current Claude `settings.json` effort and one `system/init` or `thread/start` effort, and compare them to the label. Do not treat the parenthetical "(account default)" as a failed claim.

### 276 `340887f9-1af8-4d7b-8181-63ac2cd81ee1` — inspected — unverified
A long composer insertion folds into `Pasted text #n` (`pasted-text.test.ts:30-39`, including a 31,000-character insert). App-control string args still throw above 20,000 characters (`agent-control.ts:61-64`), so a 31k `prompt` through `agents.submit` is still `Invalid prompt`. The claim reads as the composer case. Next: run `pasted-text.test.ts`, and decide whether the 20,000 cap is in scope. A 31k composer send was not tried.

### 277 `phone-tailscale-setup-and-settings-nav` — inspected — unverified
Settings > Phone has four steps: Tailscale on the phone, a trusted address, Pair, and Home Screen and notifications (`PhoneAccessSettings.tsx:279`, `:305`, `:404`, `:451`), each with its own check. The phone keeps a boot card, `#diagnose` over unauthenticated `GET /api/health` (`app.js:560`, `:985-995`), and a Safari hand-off (`app.js:850-853`). Settings search is `SettingsPanel.tsx:96-101`. Commit `a05744e` was not looked up. No phone was paired and Tailscale was not queried. Next: read the step-3 pairing handler. Do not open a listener.

### 278 `review-coworkers-auto` — inspected — unverified
Claude's mode stays `auto` when settings say auto; only the reviewer session is pinned to manual (`claude.ts:392-395`). Codex comments say a review controller does not turn Auto off (`codex.ts:63-64`). `codex-auto-refusal.regression.test.ts:217` comments the same; the assertion was not read. Next: read that test. Do not dispatch a reviewer.

### 279 `grok-provider` — inspected — unverified
`GrokAdapter` is the ACP provider (`grok.ts:165`, baseline comment `grok.ts:13` from the inventory). Tile, models, interrupt, resume, and the live smoke `scripts/smoke-grok-live.mjs` were not opened. Uncommitted `agent-control.ts` hunks are another owner's file and were not diffed. S3a did not accept this. Next: do not edit `agent-control.ts`. Run `grok.test.ts` only when a slot is free. Do not spend a live Grok turn from this sweep.

## Result

All 93 rows are in this file. None is verified. None is failed. The earlier failure calls on rows 233 and 275 are withdrawn: 233 is the older stop-button sentence and 238 is the current split, and 275's effort control shows a concrete level while whether that level matches the CLI's saved effort is still unknown. Every previously unread row was opened against current source or a unit test that was read and not executed. Restart, Electron, a real provider, Docker, llama-server, and a phone or Tailscale session were not run. This file was not committed. The controller merges it into the matrix and backlog.


