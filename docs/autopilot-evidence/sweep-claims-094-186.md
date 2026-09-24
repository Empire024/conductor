# S3c sweep: claim-matrix data rows 94–186

Source audit only. `docs/autopilot-evidence/core-claim-audit.md` was not changed. `claim-matrix.md` and `docs/autopilot-backlog.md` were not changed. No production edit, test, build, smoke, ship, or task-status change. F1 (`agent_muerw1fu_a33x86v`) owns durable-job production; F2 and F3 stay queued. This file does not assign them.

Matrix: `docs/autopilot-evidence/claim-matrix.md` data rows only. Header line 5 and separator line 6 are excluded. Data row 1 is line 7, so rows 94–186 are file lines 100–192 (93 claims). Full checklist text was read from `feature-list.md` except the fifteen `*-0` ids, which have no `conductor-task` marker; their text is the `[Implemented]` lines at `feature-list.md:319-336`.

`inspected` means this pass opened the implementing source and/or a test that asserts the behavior. Source existing is not acceptance. Every row stays short of runtime/restart acceptance. Baseline green (256 files / 3020 tests + 65 script tests) was reported by the controller earlier; this pass did not re-run it and does not treat it as acceptance of these rows.

Coverage: **inspected 93, not-opened 0, of 93. Accepted 0.** Third pass added the last 35 rows in two checkpoints (18 then 17): 139–140, 150, 153–173, 174–179, 182–186. Earlier rows were not reopened. Row 124 stays uncertain. Source inspection is not product acceptance.

## Checkpoint rows 94–113 — chrome, focus, tasks

| Row | ID | State | What was opened | Contradiction or pending check |
| --- | --- | --- | --- | --- |
| 94 | `243c62d4-f853-447b-885c-99d7aec33b39` | inspected | Mode, model, and effort render once, in `StructuredComposerControls.tsx:78-110`. Settings dialog does not repeat them (`StructuredAgentPane.tsx:785-792`). `composerChildKey` namespaces remounts (`composer-settings.ts:56-59`). `composer-settings.test.ts:120-128` asserts the three child keys differ and change with the conversation id. Comment there names the duplicate ask/model/effort row. | Uncertain. The test asserts key strings, not a resumed pane's DOM. No second control mount was found in the resume path (`StructuredAgentPane.tsx:411-426`). Not accepted. |
| 95 | `64352192-e182-4d66-8b5e-eecce2901a2c` | inspected | `applyTabDrop` onto a bar index is accepted (`layout-operations.test.ts:247-253`). The preview gap is the slot the drop fills, including a move into another pane (`layout-operations.test.ts:256-287`). Drag handle cursor is grab/grabbing (`styles.css:507-508`). | Uncertain. Tests cover layout math, not a broken pointer path. Not accepted. |
| 96 | `ea09f946-5ebd-494c-9eba-8dad432bb3c4` | inspected | Workspace disclosure is one chevron (`WorkspaceTabList.tsx:26-28`). `WorkspaceTabList.test.ts:33-40` asserts the toggle has no tab-count text and the list does not render a second toggle. Active guide is excluded from `.sidebar-session-open` (`styles.css:329-330`). | Uncertain. No test asserts the guide line does not cover the chevron. Not accepted. |
| 97 | `a2c8c28b-8950-47a4-aa10-1b5943d1ec8b` | inspected | Each option paints its own dot from `priorityColors` (`ProjectBacklogPane.tsx:23`, `:77-78`). Selected option is font weight plus a check (`ProjectBacklogPane.css:57`). High is `var(--danger)` only on the high dot. | Uncertain. No render test asserts the other options stay uncolored when high is selected. Not accepted. |
| 98 | `ea0c7e46-5f3c-4f18-8344-610fb1e3c628` | inspected | Groups join, collapse, and stay contiguous (`tab-groups.test.ts:83-91`, `:120`). Active tab is wider, weight 600, accent bar (`styles.css:1712-1730`). | Uncertain. No test asserts the active tab is identifiable in a full strip. Not accepted. |
| 99 | `7521b5cf-ed36-479b-a4f1-1b9a8421dec6` | inspected | Workspace tab rows label Main/Coworker from control links and focus the other end (`WorkspaceTabList.tsx:15-23`, `:54`). `WorkspaceTabList.test.ts:78-79` expects one main tab to list both coworkers it controls. | Uncertain. The assertion is the role helper, not the projects-view row. Not accepted. |
| 100 | `f296635e-ea63-4b7f-8650-8692acd2cbd1` | inspected | Ended states use distinct glyphs and labels (`TabActivityIndicator.tsx:8-17`, `:34-38`). `TabActivityIndicator.test.ts:12-27`: disconnected markup contains `Disconnected - lost the runtime connection`, and failed/disconnected/stopped markup strings differ. | Not a contradiction. Not accepted: markup test, not a painted tab. |
| 101 | `bf25ae18-1e21-4a1e-9c94-e7742e305129` | inspected | Automation profile parks windows and `revealWindow` calls `showInactive` (`index.ts:200-222`). BrowserWindow options include `skipTaskbar` and the parked origin (`index.ts:279`). | Uncertain. No unit test opened that asserts `showInactive` for the main window. `browser-owned-surface.test.ts:66` is a different parked guest. Not accepted. |
| 102 | `7873476c-35b8-477c-bc50-f7e320fd7d63` | inspected | Checklist image is a long stack of "Claude controls …" rows. `coworkerTabGroups` folds those under the controller (`coworker-tab-groups.ts:20-27`). `coworker-tab-groups.test.ts:10-12` expects child and grandchild under `main`, insertion at `child`. | Uncertain. The test does not render the collapsed strip. Not accepted. |
| 103 | `39a207c9-b656-4b36-8ea1-52627b466913` | inspected | `runUpdateAction` downloads then installs in one call (`use-app-updates.ts:192-204`). `use-app-updates.test.ts:45-50` expects download and install once when nothing is running. `:60-66` expects no install and a named in-app confirm while `agent-1` is working. `:78-85` expects install only after `confirmQuitAndInstall`. | Not a contradiction. Not accepted: store test, not an Electron quit. |
| 104 | `c5d6d189-ff27-430e-ad30-0404f168ee1a` | inspected | `StructuredAgentPane.tsx:842-844` removes a queued prompt via `cancelQueued` and returns its text to the draft. | No test opened. Pending: queue two messages, remove the first, confirm the queue loses it and the composer gains the text. |
| 105 | `0d76c319-42df-4c63-8628-fc74b8e5afdc` | inspected | A finished tab plus an idle disconnected sibling rolls up `done`, not `waiting` (`project-activity.test.ts:66-74`). A disconnected sibling does not outrank live work (`:86-97`). A disconnected sibling does outrank a merely finished other tab (`:108-117`). | Not a contradiction of the finished-plus-idle case. Not accepted: the roll-up token is not the yellow paint. |
| 106 | `2336b162-6bd5-41bd-b446-bbedbfe0e1aa` | inspected | Kind union includes `task` first (`project-backlog.ts:7-8`). New-task control defaults to `task` (`ProjectBacklogPane.tsx:251`) and the select offers Task (`:382`). | Uncertain. No test opened that the add control's default value is `task`. Not accepted. |
| 107 | `f379a89b-d3a5-457e-a511-ccc6e2d7fcb3` | inspected | Reveal is only `focus === true` (`use-agent-control.ts:114-116`). `use-agent-control.test.ts:115-123`: open without focus commits `reveal` false; `focus: true` commits true. `:125-141` keeps the current tab active until `tabs.focus`. | Not a contradiction. Not accepted: host mock, not a project switch. |
| 108 | `2c9f312e-a520-4bcd-aa86-1fae776ba1e0` | inspected | `stripMemoryDirectives` drops a standalone `CONDUCTOR_MEMORY[kind]:` line (`memory-directive.ts:5`, `memory-directive.test.ts:22-29`). Assistant text uses it at `StructuredAgentRenderers.tsx:579`. | Pending: a live assistant turn that emits the directive shows the prose only, including in telemetry (`StructuredAgentTelemetry.tsx:81`). |
| 109 | `ae534926-469d-4e37-ae60-e149cdc72a10` | inspected | Delete is an in-app confirm, then `remove` edits (`ProjectBacklogPane.tsx:300-305`, `:347-348`, `:389-390`). | Uncertain. No test opened for the confirm or the remove call. Not accepted. |
| 110 | `4e23b5c0-afd9-4fc7-b73e-5df4f969551c` | inspected | Closing a floating detached window with `restoreToWorkspace` pushes the tab back into the session layout and removes it from closed tabs (`database.ts:1130-1139`). `workspace-restore.test.ts:80-88` expects the floating tab in the group and active, and not in `closedTabs`. A non-floating close stays in `closedTabs` (`:89-92`). Main calls that path only for floating ids (`index.ts:356-357`). | Uncertain. Drag-back onto the workspace is not this close path. Not accepted. |
| 111 | `758c424a-d177-4460-9bef-7dab1790b37e` | inspected | Assignment dialog has an optional prompt and passes it to `onDispatch` (`ProjectTaskAssignment.tsx:83`, `:146`). Pane forwards `prompt` on `projectTasks.dispatch` (`ProjectBacklogPane.tsx:290-294`). | Uncertain. No test opened that the dispatched prompt text is the textarea value. Not accepted. |
| 112 | `ef91741d-7368-4083-b923-e96dbf3e633e` | inspected | `memory.forget` asks through `deps.confirm` (`agent-control.ts:1008-1011`, `:1201-1206`). The renderer mounts `AgentConfirmDialog` (`App.tsx:1686`), which the component comment says replaced the OS dialog (`AgentConfirmDialog.tsx:7-15`). | Uncertain. No test opened that `confirm` resolves from that dialog rather than `dialog.showMessageBox`. Not accepted. |
| 113 | `a818b8ca-1104-4186-9b67-7ceaea1b888f` | inspected | A question tool call sharing a native id with a question interaction is dropped from the timeline (`StructuredAgentRenderers.tsx:49-56`). `StructuredAgentRenderers.test.ts:427-430` expects only `interaction-toolu_1` to remain. An approval tool stays beside its card (`:433-439`). | Not a contradiction. Not accepted: fixture items, not a live Claude answer. |

## Checkpoint rows 114–133 — composer, permissions, activity

| Row | ID | State | What was opened | Contradiction or pending check |
| --- | --- | --- | --- | --- |
| 114 | `c392beab-56dc-4c33-a0cb-04ff74662897` | inspected | Effort slider stays in the markup when the model id is absent from the catalog (`StructuredComposerControls.test.ts:196-203` expects `aria-label="Reasoning effort"` and `aria-valuetext="Low"`). A model with an empty effort list hides the range (`:42-45`). | Not a contradiction of the unlisted-model case. Not accepted. |
| 115 | `a547f4a6-6226-41cb-84ab-3c4be1a672d0` | inspected | Weight is a separate scale from priority (`ProjectBacklogPane.tsx:24-27`, `:382`). `project-backlog.test.ts:21-36` expects every weight on Claude and Codex to name a model and effort, and heavy effort to outrank light. | Uncertain. The test does not render the picker beside priority. Not accepted. |
| 116 | `05adbbcf-2534-4fe7-af43-b4b6ede981b8` | inspected | `@browser` is a mention token, not a slash command (`composer-commands.test.ts:28-34`). Choosing it calls `activateBrowserMention` (`StructuredAgentPane.tsx:763`), which dispatches `conductor:sidebar-mode` with detail `browser` (`CommandAutocomplete.tsx:6-7`). `CommandAutocomplete.test.ts:7-12` expects that one event and no other. | Not a contradiction. Not accepted: the test stubs `dispatchEvent`; it does not open the pane. |
| 117 | `241cda0c-105f-4de8-a16b-2f064b235717` | inspected | `snapshot-notices.test.ts:57-69` writes 12 files outside the session workspace and expects `notices()` to equal `[]`. Emitter still exists at `structured-sessions.ts:254` for other snapshot failures. `snapshot-notices.test.ts:72-79` expects one notice for a repeated unactionable failure, not twelve. | Pending runtime: a real turn that writes outside the workspace produces no "Snapshot unavailable" spam. Unit assertion is not that runtime. |
| 118 | `e5b29430-909e-41c6-961a-65c2f2e01422` | inspected | `recallsByItem` keeps a memory on the first turn and drops it from later repeats (`memory-recall-strip.test.ts:60-71`). A later turn that only repeats a forgotten id stays empty of memories (`:74-82`). | Not a contradiction. Not accepted: the helper is not a rendered strip on a live send. |
| 119 | `2a82a315-c06e-45ae-8fea-196051840b3e` | inspected | Custom text is an "Other" radio, and the text field renders only after that radio is selected (`StructuredAgentRenderers.tsx:544-555`). `StructuredAgentRenderers.test.ts:520-525` expects three radios and no `sa-custom-answer` until Other is chosen. A question with no options still shows the free-text field (`:527-531`). | Not a contradiction. Not accepted: static markup, not a click. |
| 120 | `311d3613-32ba-461f-8d67-7ccc1e833911` | inspected | Assignment form has `aria-label="Task agent permission mode"` and sends `permission` on a new tab (`ProjectTaskAssignment.tsx:82`, `:137-140`). | Uncertain. No test opened that the select value is the dispatched permission. Not accepted. |
| 121 | `9dafbe07-0b7b-4f8b-8551-3c71cdd809f4` | inspected | A process row uses `processModelLabel` (`ProcessDashboardPane.tsx:137-143`). `agent-models.test.ts:50-54` expects a reported `opus` to display `Opus` when the saved model is `default`. Placeholder `Choose model` remains only when no model can be reported (`:61-63`). | Not a contradiction of the reported-model case. Not accepted. |
| 122 | `23983160-8163-4587-82c7-eacaff9cdd79` | inspected | `ProcessStatusSummary` is documented as the replacement for the "Local status / Local workspace" footer and is mounted in the sidebar (`ProcessStatusSummary.tsx:135-137`, `Sidebar.tsx:447`). | Uncertain. No test opened that the footer string "Local workspace" is absent. `TitleBar.tsx:99` still has a File-menu "Local workspace" label. Not accepted. |
| 123 | `6bdabd01-fdcc-473e-82ef-9b9b9bd7066f` | inspected | A drag renders `pane-drag-ghost` following the pointer (`PaneWorkspace.tsx:1060-1068`, `styles.css:541`). A dock edge renders `.dock-preview` on the hovered half (`PaneWorkspace.tsx:569`, `styles.css:1000-1012`). | Uncertain. No test opened that the ghost or preview node is mounted. Not accepted. |
| 124 | `2153a831-299d-425d-a430-8e86d121920d` | inspected | **Uncertain / needs reproduction. Not a contradiction.** The checklist only says the opaque "1-600000 characters" error appeared. `MAX_PROMPT_CHARS` is 600000 (`structured-agent.ts:8`). `assertPromptWithinLimit` rejects assembled length over that and names the count plus what to remove (`structured-sessions.ts:864-868`). `composerSendBlock('Fix the bug', [])` is undefined (`composer-settings.test.ts:102-103`). A short draft whose attachment content exceeds 600000 is `oversized` before send (`:105-108`). `structured-sessions.test.ts:515-522` rejects a short draft only after a recall larger than `MAX_PROMPT_CHARS`, and expects zero submissions. `submit`/`followup` also reject raw typed text over 60000 (`structured-sessions.ts:748`, `:532`). That second ceiling is not, by itself, the original vague failure. | No ordinary short send was found that still throws. Not accepted. |
| 125 | `038c7a04-7e22-4821-be7e-cc7f82f2a094` | inspected | `waiting_background` rolls up `working`, not `done` (`project-activity.test.ts:61-63`). A detached tab that is still working keeps the project `working` even when the workspace layout only shows a finished tab (`:146-149`). | Not a contradiction. Not accepted: the token is not the green paint. |
| 126 | `3c742022-1449-4898-97be-d574808db6e3` | inspected | A chat file link opens a menu from `buildFileLinkMenuEntries` (`StructuredAgentRenderers.tsx:260-269`). `file-link-menu.test.ts:5-9` expects Click, Ctrl+Click, and Ctrl+Shift+Click. `:24-27` expects the menu to end with `reveal-explorer` and `show-os-explorer`. | Not a contradiction. Not accepted: the menu builder, not a right-click in the pane. |
| 127 | `edbcfcb8-c338-4434-b12a-6be5b1b69c46` | inspected | `safeFileTarget('/C:/work/My project/src/panel.mjs', cwd)` returns `src/panel.mjs`, and a percent-encoded space returns `CR5 render.png` (`StructuredAgentRenderers.test.ts:542-543`). A path outside the workspace renders as text, not a link (`:554`). | Not a contradiction of those fixtures. Not accepted: no PNG or Blender open was exercised. |
| 128 | `39a3d0fa-b6c7-4c55-a3ef-d4122d59e146` | inspected | `rememberPermission` stores Auto for Claude only when that provider offers it (`app-settings.test.ts:48-52`). A mode the provider did not offer is not stored (`:55-58`). | Uncertain. Dispatch still opens native coworkers on Auto unless `exactPermission` (row 180). This test does not assert the owner's next manual Claude tab. Not accepted. |
| 129 | `26d660cd-b2ff-4f27-ace2-acff9b1280ab` | inspected | `bindConversationTab` names a generic tab from the first message and sets `titleLocked` (`conversation-tab.test.ts:32-36`). A second message does not re-derive (`:66`, test title). An owner rename stays (`:45-48`). | Not a contradiction. Not accepted: the binder, not a sent turn. |
| 130 | `05579479-d437-41de-853e-908c4834db6d` | inspected | A read-only selection offers Copy then Select All (`context-menu.test.ts:30-31`). No selection offers only Select All (`:34-35`). `installContextMenu` is attached on `web-contents-created` (`index.ts:249`). | Not a contradiction. Not accepted: template ids, not a chat selection. |
| 131 | `bd4b357f-8b50-4d82-b373-3eb1bd7aa56a` | inspected | The latest owner prompt is pinned above the timeline (`StructuredAgentPane.tsx:568-576`, `:806`). `truncatePromptPreview` cuts at 160 characters plus an ellipsis (`conversation-scroll.test.ts:95-99`). Click calls `scrollToPinnedPrompt` (`StructuredAgentPane.tsx:599-608`). | Uncertain. No test opened for the gap between the top bar and the pin. Not accepted. |
| 132 | `b0404623-d8ee-44c4-9954-16eea1904718` | inspected | The edit form includes `aria-label="Edit task type"` with Task, Bug, Feature, and Idea, and save sends `kind` (`ProjectBacklogPane.tsx:340`). | Uncertain. No test opened that an update change carries the new kind. Not accepted. |
| 133 | `215fb17f-21d2-45db-aa31-319e35589f9e` | inspected | Auto target keeps only `usable` allowance, then throws if every candidate is exhausted or none has more than 5% left (`project-task-dispatch.ts:227-238`). `project-task-dispatch.test.ts:153-161` expects an almost-exhausted Astra default to be skipped for Sol. `:271` refuses low or exhausted pairs. | Not a contradiction. Not accepted: fixture quotas, not a live Astra account. |

## Checkpoint rows 134–153 — links, local model, relay

Reliability band. These rows were the inspection priority.

| Row | ID | State | What was opened | Contradiction or pending check |
| --- | --- | --- | --- | --- |
| 134 | `d9929b6d-b0ce-444f-aec0-292026e75d46` | inspected | The selected-row guide is `::before` on `.session-tree button.active` only when it is not `.sidebar-session-open` (`styles.css:329`). The open-button row draws the guide on the row (`styles.css:330`). The workspace chevron is a separate 15px toggle (`navigation.css:14`, `WorkspaceTabList.tsx:26-28`). | Uncertain. No test measures whether the guide overlaps the chevron. Not accepted. |
| 135 | `c5519807-7b48-4b33-9ee8-a76bc2771718` | inspected | Composer drop accepts a file drag and calls `importContextPath` (`StructuredAgentPane.tsx:483-504`). `prompt-context.test.ts:12-20` expects `notes/idea.md` as kind `file` with content, and `clip.mp4` as kind `media` without decoded content. Image-only rejection is limited to providers without image support (`StructuredAgentPane.tsx:499`). | Uncertain. Explorer move and editor-open drop paths were not opened. Not accepted. |
| 136 | `f6efd042-f3f9-478c-94b7-9ce8ab5687a1` | inspected | Cancelled steering copy and button are in `StructuredAgentPane.tsx:835-840`: status "Not sent", remedy text, button label "Restore to composer", handler returns text and attachments to the draft. | No test opened. Pending: stop a turn before steering is taken, click Restore, confirm the composer holds the text and the card is gone. |
| 137 | `a7ba1584-2b38-49c2-8488-57fbed49995b` | inspected | `seven_day_overage_included` is labeled `Fable weekly`, scope `model`, selector `fable`, and is not the provider weekly window (`usage-limit.test.ts:56-67`). It applies to `claude-fable-5-1` and not to `claude-sonnet-4-5` (`:66-73`). `StructuredUsageDetails.test.ts:82-87` expects the Fable row at 99% and not on the Sonnet view. | Not a contradiction. Not accepted. |
| 138 | `87f8310b-e91f-41fc-8b90-6b87233ec794` | inspected | `@browser` opens the left sidebar browser (`CommandAutocomplete.test.ts:7-12`, `Sidebar.tsx:272`). A separate `toggleBrowserTab` still creates or focuses a browser **tab** (`browser-tab.ts:27-39`). `browser-tab.test.ts:46-64` expects that path to activate an existing browser tab rather than add another. | Uncertain. The mention path is the left pane; the tab path still exists. Not accepted. |
| 139 | `16fd6bdf-2e02-4cca-891d-ceba01aa93da` | inspected | Unmount cleanup hides the native browser view from the last delivered bounds because React clears the frame ref first (`BrowserPane.tsx:102-110`, `:163-169`). A mount that finishes after unmount also hides (`:146-153`). | Not a contradiction. Not accepted: no browser surface was shown. |
| 140 | `819788a2-08bf-4bde-b4b8-c2d2c6bbeae5` | inspected | Leaving a project saves each outgoing workspace layout before `sessions.list` (`App.tsx:322-335`). | Uncertain. No test opened that a new tab survives the round trip. Not accepted. |
| 141 | `audit-sandbox-mask-commits` | inspected | Tracked secrets get a read-only replica of index bytes (`sandbox.ts:484-492`, `trackedMaskPlan`). `local-models.test.ts:240` expects `target=/workspace/src/secret-store.ts,readonly` and an untracked `.env` with no `source`. `local-models.test.ts:250` expects `SandboxUnavailableError` when the index cannot be read. | Pending runtime: with repository-writes on, `git add -A && git commit` in the sandbox does not record deletion of a masked tracked file. Unit mount args are not that commit. |
| 142 | `audit-relay-response-auth` | inspected | `deliver` returns before settle unless `authentic` (`remote-relay.ts:431-438`). `settle` still also requires `call.peerMachineId === envelope.from` (`remote-relay.ts:458-460`). `conductor-relay.test.ts:221-235` feeds a sealed response signed by a different device key and expects `settled === false`; the real peer's answer then settles (`:237-248`). | Pending: the checklist's live gist demonstration was not re-read. Unit forge is not that end-to-end run. |
| 143 | `audit-local-probe-recorded-port` | inspected | `recordedPort` reads the run-record port (`config.ts:224-228`). `endpointFor` uses it (`config.ts:219`). `ensureServer` does not call `health(model.port)`; it calls `inspectAdmission` (`providers/local.ts:161-165`), which probes candidate ports and requires `rejectsAnonymous` (`llama.ts:369-372`). | No test found whose name or body asserts a moved port. Pending: run record on port B, config on port A, one local send, no "Starting … locally" from a failed probe of A. |
| 144 | `audit-adopt-unverified-server` | inspected | `adoptRunningServer` returns null unless `rejectsAnonymous` (`llama.ts:253-257`). `local-models.test.ts:524-533`: a server that answers 200 without enforcing the key is not adopted and no run record is written. | Pending runtime: point adoption at a real unauthenticated server. The unit fake is not that process. |
| 145 | `audit-relay-backoff-lost` | inspected | `tick` keeps `instanceof RelayUnavailableError`, copies `retryAfterMs`, sets phase `unavailable`, and calls `expire()` in `finally` (`remote-relay.ts:231-252`, read earlier this session). | No test of that `tick` catch was opened this pass. Pending: stub a 429 from `pollOnce`/`tick` and assert the next delay is the retry-after, phase `unavailable`, and `expire` ran. |
| 146 | `audit-close-group-placed-tabs` | inspected | Sidebar group action closes each newly closed tab through `closePlacedTab` (`App.tsx:1152-1153`). `closePlacedTab` calls `remote.closeTab` for a non-local agent (`machine-placement.ts:90-94`). `machine-placement.test.ts:206-225` asserts one close, no close for a local tab, and a reported message when `closed: false`. `closeRemote` returns a message when unbound (`remote-session-mirror.ts:387`) and on throw (`:395`). | No test opened that a **group** close calls `closeTab` once per placed member. Pending: close a group containing two placed agent tabs and one local tab; remote close runs twice; the offline message is shown. |
| 147 | `audit-secret-scan-blocking` | inspected | Scan skips `node_modules` and build dirs (`sandbox.ts:210-213`) and `secretPathsFor` is async with an mtime cache (`sandbox.ts:274-288`). `local-models.test.ts:258-271` expects masks `['.npmrc', 'src/.env']` and not `node_modules/left-pad/.npmrc`. | Pending: time one `run_command` on this repo and confirm the main process is not blocked for a full `node_modules` walk. The unit tree is tiny. |
| 148 | `audit-dead-code` | inspected | `releaseTab` has **no** match under `src/**/*.ts(x)`. `scripts/smoke-remote-integration-fixer.mjs:532` still calls `window.conductor.remote.releaseTab`. `etag(` has no match under `src`. `SECRET_SEGMENTS` (`workspace.ts:17`) has no slash entry. `paths.test.ts:50-65` forces an empty pointer set and expects `localRoot()` to throw `LocalRootError` (the old early-return hole). | `.filter(... \|\| true)` was not searched to exhaustion. Pending: run the remote smoke far enough to hit line 532; if preload has no `releaseTab`, that smoke throws. |
| 149 | `relay-probe-poll-storm` | inspected | `interval` ignores a background call older than `RELAY_BACKGROUND_ACTIVE_MS` (`remote-relay.ts:198-204`). `remote-relay.test.ts:579-606` leaves a background probe outstanding, advances the clock, and expects `nextPollDelayMs()` and the scheduled delay to equal `RELAY_POLL_IDLE_MS`. | Pending runtime: one paired machine offline for an hour does not approach the GitHub hourly budget. The unit clock is not that hour. |
| 150 | `bug-send-button-contrast` | inspected | Structured send button uses `color: var(--surface-0)` on an accent gradient, and stop uses white on blue (`StructuredAgentPane.css:216-219`). | Uncertain. No theme snapshot asserts Night Owl night and day. Not accepted. |
| 151 | `bug-local-trim-drops-user-message` | inspected | `trimMessages` pins the latest user message (`agent.ts:173`). `local-models.test.ts:678-683` expects that question to remain the only user message after a tool-heavy trim. | Pending runtime: a real Qwen history past the window still gets HTTP 200, not "No user query found". The unit fixture is not llama.cpp. |
| 152 | `bug-sandbox-destroys-node-modules` | inspected | `containerRunArgs` bind `node_modules` and `package-lock.json` read-only (`sandbox.ts:466-473`). `sandbox-dependency-guard.test.ts:13-16` refuses `npx tsc --noEmit` and `npm install`. `:63` expects the node_modules mount to end with `readonly`. | Pending: the refusal test's output contains the direct `node ./node_modules/typescript/bin/tsc` hint (`:52`). A real container run was not done. |
| 153 | `8c4d0c7c-35bd-47dd-a01b-0c026124a910` | inspected | Task text limit is 200000 (`project-backlog.ts:4`). A bug title that repeats the owner error 500 times round-trips (`project-backlog.test.ts:14-19`). Owner ids may be a session id or `project:`/`detached:` (`database.ts:82-91`). A real session id is kept; a missing detached owner is dropped (`database.test.ts:309-318`). | Uncertain. The owner regex still throws for other shapes (`database.ts:91`). Not accepted. |

## Checkpoint rows 154–173 — project color, older implemented UI, protocol

Rows 156–170 are `[Implemented]` at `feature-list.md:319-336`. They have no `conductor-task` id. None of their implementations were opened.

| Row | ID | State | What was opened | Contradiction or pending check |
| --- | --- | --- | --- | --- |
| 154 | `c1f8f0cf-6e92-4b8d-ae25-7533362d4a2b` | inspected | A Main/Coworker badge is placed on a second grid row under the tab, with overflow hidden (`WorkspaceTabList.css:5-9`, `:18-20`). Pane tabs clip their titles (`styles.css:462-493`). | Uncertain. No test asserts a back pane's title is not painted through. Not accepted. |
| 155 | `c3070e39-1784-4c48-863e-43a76059fee3` | inspected | Project rows paint `session-activity-dot` from the roll-up: working, waiting, or finished (`Sidebar.tsx:397`). Finished-plus-idle-disconnected is `done` in the roll-up already recorded at row 105. | Uncertain. No source says a closed projects view withholds the blue/working dot until click. Not accepted. |
| 156 | `f8adf567ae880eaa0d40-0` | inspected | Send control is a 30px accent circle with hover lift (`StructuredAgentPane.css:216-218`). `feature-list.md:319`. | Uncertain. No visual test. Not accepted. |
| 157 | `1ef60a4ceeb24e6159b2-0` | inspected | Right-click on the theme toggle opens a menu of themes, Day, Night, and follow-local-time (`TitleBar.tsx:129-137`). `feature-list.md:320`. | Uncertain. No test opened. Not accepted. |
| 158 | `03d4f6542598af5de7e6-0` | inspected | A file tab in browser mode shows a globe and the title suffix `Open in browser` (`WorkspaceFiles.tsx:177-179`). `feature-list.md:321`. | Uncertain. The explorer tree cue was not found. Not accepted. |
| 159 | `99b971ba90f20d7c33d3-0` | inspected | Version button tooltip is `Check for updates (last checked …)` and idle success says `Latest version already installed` (`AppVersionButton.tsx:11-20`). Mounted from `App.tsx:1650`. `feature-list.md:322`. | Uncertain. No test opened. Not accepted. |
| 160 | `f30c8e1d210dfe54f376-0` | inspected | Dirty editor shows Save vs Saved and a dirty class (`CodePane.tsx:462-464`). Close asks Save / Don't Save / Cancel (`index.ts:680-686`). File tabs mark unsaved with `file-dirty-dot` (`WorkspaceFiles.tsx:179`). `feature-list.md:323`. | Uncertain. No test opened for the dialog buttons. Not accepted. |
| 161 | `94bc12e5b5d861d74607-0` | inspected | `ProviderIcon` sets a distinct `provider-logo` URL per provider (`ProviderIcon.tsx:11-13`). `feature-list.md:324`. | Uncertain. No test lists the logo files. Not accepted. |
| 162 | `c503fe626d4216b6c141-0` | inspected | Running phase cycles Thinking, Spelunking, Working, Considering (`StructuredAgentPane.tsx:830`). `feature-list.md:325`. | Uncertain. No test asserts the cycle. Not accepted. |
| 163 | `765750cac86138afdabd-0` | inspected | Menu shortcuts are Click, Ctrl+Click, Ctrl+Shift+Click (`file-link-menu.test.ts:5-9`), same builder the chat link uses. `feature-list.md:326`. | Not a contradiction. Not accepted. |
| 164 | `959a6d31db2f08736f16-0` | inspected | File strip is `role="tablist"` (`WorkspaceFiles.tsx:172`). New file is `file-new` (`:182`). Ctrl+W closes the active file tab (`:143`). `feature-list.md:327`. | Uncertain. No test opened. Not accepted. |
| 165 | `21a8da3555f621e698a0-0` | inspected | Activity rows use `padding: 0 0 15px 15px` and paragraphs `margin: 5px 0 9px` (`StructuredAgentPane.css:21`, `:35`). `feature-list.md:328`. | Uncertain. No before/after measure. Not accepted. |
| 166 | `0d288a1b84d10009e7f4-0` | inspected | Ctrl+E toggles the picker (`WorkspaceFiles.tsx:140-146`). Empty query lists recent files, most recent first (`FilePicker.tsx:32-33`). Webview Ctrl+E is forwarded (`index.ts:297-300`). `feature-list.md:330`. | Uncertain. Detached-window and no-workspace cases were not opened. Not accepted. |
| 167 | `eb8ed1d60edf68cdfc6b-0` | inspected | Download phase renders a native `<progress>` and a percent label (`AppUpdateButton.tsx:25-48`). `feature-list.md:331`. | Uncertain. No test of the element. Not accepted. |
| 168 | `67db5fc01cc4a7867e77-0` | inspected | Subagent summary button uses `subagentCountLabel` (`StructuredAgentTelemetry.tsx:34-41`). `usage-summary.test.ts:88-95` expects `2 subagents · 1 running · 1 completed`. `feature-list.md:333`. | Not a contradiction. Not accepted. |
| 169 | `e61fc488b42df2911116-0` | inspected | `StructuredLiveTokens` shows output tokens for the current response (`StructuredAgentTelemetry.tsx:13-19`) and is mounted in the working line (`StructuredAgentPane.tsx:830`). `feature-list.md:334`. | Uncertain. The "View usage" link was not opened. Not accepted. |
| 170 | `d17e87da47e9623be678-0` | inspected | Ctrl+T opens the launcher and a follow-up key chooses the runtime (`App.tsx:1276-1282`). Ctrl+Shift+T reopens (`:1305-1308`). Palette lists Ctrl+T then X for Codex (`:1191`). `feature-list.md:336`. | Uncertain. No test opened for the chord. Not accepted. |
| 171 | `feature-15` | inspected | Slash completion is offered only while typing the token (`composer-commands.test.ts:23-26`). The menu is `CommandAutocomplete` (`CommandAutocomplete.tsx:9-12`). | Not a contradiction. Not accepted. |
| 172 | `feature-16` | inspected | Workspace rows list tabs when expanded (`WorkspaceTabList.tsx:32-47`). Show-tab toast says closing the float returns the tab (`App.tsx:1143`). | Uncertain. The context-menu item labeled Show tab was not opened. Not accepted. |
| 173 | `feature-17` | inspected | App control is the local JSON API. `tools.list` includes `tabs.open` and `router.dispatch` (`agent-control.ts` tool signatures, previously read for other rows; this row's open path is `use-agent-control.ts:105-116`). | Uncertain. A full method inventory was not re-listed this pass. Not accepted. |

## Checkpoint rows 174–186 — tasks, usage, permission

| Row | ID | State | What was opened | Contradiction or pending check |
| --- | --- | --- | --- | --- |
| 174 | `feature-18` | inspected | A task-dispatcher change publishes `feature-list.md` (`index.ts:2182`). `notifyTasks` runs when that path changes (`index.ts:2083`). | Uncertain. The renderer subscription that repaints Project tasks was not opened. Not accepted. |
| 175 | `feature-19` | inspected | History line names actor, workspace, and time, and the jump button dispatches `conductor:focus-process` with the agent id (`ProjectBacklogPane.tsx:355-357`). `project-backlog.test.ts:91-104` expects doing-by-you then a file edit to record done with `agent_A`. | Not a contradiction. Not accepted: the click handler is not executed. |
| 176 | `feature-20` | inspected | Source control is a per-project toggle (`ProjectBacklogPane.tsx:312-317`). GitHub open uses `compareUrl` (`:202`, `source-control.test.ts:31`). `project-backlog.test.ts:94` expects a `sourceControl` object on the board. | Uncertain. The toggle test was not the compare-url test. Not accepted. |
| 177 | `feature-21` | inspected | Template includes `## Ideas` (`project-backlog.ts:14`). `project-backlog.test.ts:82-88` adds an idea and expects it beside a bug, and `Idea list:` parses as kind `idea`. | Not a contradiction. Not accepted. |
| 178 | `48c04f62-1f03-4bd9-827c-5a8ad5dd078e` | inspected | `WeeklyUsage` shows last-7-days recorded tokens per model, not a percent of a provider weekly window (`WeeklyUsage.tsx:8-37`). It says provider allowance is separate (`:37`). | Uncertain. The "munched 60% of weekly" sentence was not found. Not accepted. |
| 179 | `8f31532b-caad-43e4-8604-56e55a3da8a1` | inspected | `initialPermission` returns the mode last remembered for that provider (`permission-memory.test.ts:16-23`). Providers do not leak (`:25-31`). | Not a contradiction. Not accepted. Distinct from row 180's dispatch clamp. |
| 180 | `control-tab-inherits-permission` | inspected | `inheritedPermission` clamps to the controller ceiling and to advertised modes (`agent-control.ts:45-49`). `dispatchPermission` forces Auto unless exact, local, or restricted (`agent-control.ts:57-59`). `agent-control.test.ts:326-332`: controller `auto` opens a child at `accept-edits` on a provider that stops there, not `ask`. `:316-323`: a read-only controller's child is `read-only`. | Pending runtime: a live Claude controller on Auto opens a Claude coworker on Auto without an approval stall. The fixture clamp is not that provider. |
| 181 | `6c263544-4e62-442c-b65f-8b1f0b439749` | inspected | `submit` calls `assertUnderUsageCap` (`structured-sessions.ts:747`). IPC `usage-cap:write` accepts tab/workspace/default (`index.ts:1783-1784`). `structured-sessions-usage-cap.test.ts:80` is titled "usage caps stop a conversation cleanly" — the assertions inside that test were **not** read. | Pending: read that test's expects, then set a tab cap below current use and confirm the next submit stops with the cap reason. |
| 182 | `eced4219-15bd-4cd3-a1e1-34f946d6c79b` | inspected | Change history says snapshots need no commit and revert writes only files that conversation changed (`AgentChangeHistory.tsx:83`). Per-edit Revert calls `structured.revertChanges` (`:48-51`, `:70`). | Uncertain. No test opened. Not accepted. |
| 183 | `b04379de-ad8c-499b-842d-6f6841515577` | inspected | Multi-question cards step one at a time (row 113's renderer). A short card gets `sa-interaction-pinned` when its height is at most 62% of the timeline (`StructuredAgentRenderers.tsx:503`, `:523`). Collapse uses `sa-question-dock` (`:520-521`). | Uncertain. Pin is height-based, not a separate bottom sheet. Not accepted. |
| 184 | `7b979a1a-2f6a-40be-99ca-b9f2964a1f5d` | inspected | Unfinished rail items are disabled, labeled not ready, and sorted after finished ones (`Sidebar.tsx:99-100`, `:236-247`, `:279`). Workspace, Explorer, and Browser are the primary group (`:110-112`). | Uncertain. The current `railItems` list has no `unfinished: true` entry (`:110-119`). Not accepted. |
| 185 | `c978a680-b006-4a86-b758-004fb427aafc` | inspected | Ctrl+E opens `FilePicker` (`WorkspaceFiles.tsx:140-146`, `:198`). An empty query shows recent files, most recent first (`FilePicker.tsx:32-33`). | Not a contradiction of the recent-list path. Not accepted. |
| 186 | `82898f2c-fc9b-4911-b02d-a42421a782e9` | inspected | Same pin as row 131: latest owner prompt, truncated, click scrolls (`StructuredAgentPane.tsx:806`). The pin sits at the top of the timeline with ellipsis (`StructuredAgentPane.css:416-418`). | Not a contradiction. Not accepted. |

## Ledger

```json
{
  "stage": "S3c",
  "rows": "94-186",
  "count": 93,
  "inspected": 93,
  "notOpened": 0,
  "accepted": 0,
  "addedThisPass": 35,
  "uncertain": ["2153a831-299d-425d-a430-8e86d121920d"],
  "contradiction": [],
  "inspectedIds": [
    "243c62d4-f853-447b-885c-99d7aec33b39",
    "64352192-e182-4d66-8b5e-eecce2901a2c",
    "ea09f946-5ebd-494c-9eba-8dad432bb3c4",
    "a2c8c28b-8950-47a4-aa10-1b5943d1ec8b",
    "ea0c7e46-5f3c-4f18-8344-610fb1e3c628",
    "7521b5cf-ed36-479b-a4f1-1b9a8421dec6",
    "f296635e-ea63-4b7f-8650-8692acd2cbd1",
    "bf25ae18-1e21-4a1e-9c94-e7742e305129",
    "7873476c-35b8-477c-bc50-f7e320fd7d63",
    "39a207c9-b656-4b36-8ea1-52627b466913",
    "0d76c319-42df-4c63-8628-fc74b8e5afdc",
    "2336b162-6bd5-41bd-b446-bbedbfe0e1aa",
    "f379a89b-d3a5-457e-a511-ccc6e2d7fcb3",
    "ae534926-469d-4e37-ae60-e149cdc72a10",
    "4e23b5c0-afd9-4fc7-b73e-5df4f969551c",
    "758c424a-d177-4460-9bef-7dab1790b37e",
    "ef91741d-7368-4083-b923-e96dbf3e633e",
    "a818b8ca-1104-4186-9b67-7ceaea1b888f",
    "c392beab-56dc-4c33-a0cb-04ff74662897",
    "a547f4a6-6226-41cb-84ab-3c4be1a672d0",
    "c5d6d189-ff27-430e-ad30-0404f168ee1a",
    "2c9f312e-a520-4bcd-aa86-1fae776ba1e0",
    "241cda0c-105f-4de8-a16b-2f064b235717",
    "2153a831-299d-425d-a430-8e86d121920d",
    "f6efd042-f3f9-478c-94b7-9ce8ab5687a1",
    "audit-sandbox-mask-commits",
    "audit-relay-response-auth",
    "audit-local-probe-recorded-port",
    "audit-adopt-unverified-server",
    "audit-relay-backoff-lost",
    "audit-close-group-placed-tabs",
    "audit-secret-scan-blocking",
    "audit-dead-code",
    "relay-probe-poll-storm",
    "bug-local-trim-drops-user-message",
    "bug-sandbox-destroys-node-modules",
    "control-tab-inherits-permission",
    "6c263544-4e62-442c-b65f-8b1f0b439749",
    "05adbbcf-2534-4fe7-af43-b4b6ede981b8",
    "e5b29430-909e-41c6-961a-65c2f2e01422",
    "2a82a315-c06e-45ae-8fea-196051840b3e",
    "311d3613-32ba-461f-8d67-7ccc1e833911",
    "9dafbe07-0b7b-4f8b-8551-3c71cdd809f4",
    "23983160-8163-4587-82c7-eacaff9cdd79",
    "6bdabd01-fdcc-473e-82ef-9b9b9bd7066f",
    "038c7a04-7e22-4821-be7e-cc7f82f2a094",
    "3c742022-1449-4898-97be-d574808db6e3",
    "edbcfcb8-c338-4434-b12a-6be5b1b69c46",
    "39a3d0fa-b6c7-4c55-a3ef-d4122d59e146",
    "26d660cd-b2ff-4f27-ace2-acff9b1280ab",
    "05579479-d437-41de-853e-908c4834db6d",
    "bd4b357f-8b50-4d82-b373-3eb1bd7aa56a",
    "b0404623-d8ee-44c4-9954-16eea1904718",
    "215fb17f-21d2-45db-aa31-319e35589f9e",
    "d9929b6d-b0ce-444f-aec0-292026e75d46",
    "c5519807-7b48-4b33-9ee8-a76bc2771718",
    "a7ba1584-2b38-49c2-8488-57fbed49995b",
    "87f8310b-e91f-41fc-8b90-6b87233ec794",
    "16fd6bdf-2e02-4cca-891d-ceba01aa93da",
    "819788a2-08bf-4bde-b4b8-c2d2c6bbeae5",
    "bug-send-button-contrast",
    "8c4d0c7c-35bd-47dd-a01b-0c026124a910",
    "c1f8f0cf-6e92-4b8d-ae25-7533362d4a2b",
    "c3070e39-1784-4c48-863e-43a76059fee3",
    "f8adf567ae880eaa0d40-0",
    "1ef60a4ceeb24e6159b2-0",
    "03d4f6542598af5de7e6-0",
    "99b971ba90f20d7c33d3-0",
    "f30c8e1d210dfe54f376-0",
    "94bc12e5b5d861d74607-0",
    "c503fe626d4216b6c141-0",
    "765750cac86138afdabd-0",
    "959a6d31db2f08736f16-0",
    "21a8da3555f621e698a0-0",
    "0d288a1b84d10009e7f4-0",
    "eb8ed1d60edf68cdfc6b-0",
    "67db5fc01cc4a7867e77-0",
    "e61fc488b42df2911116-0",
    "d17e87da47e9623be678-0",
    "feature-15",
    "feature-16",
    "feature-17",
    "feature-18",
    "feature-19",
    "feature-20",
    "feature-21",
    "48c04f62-1f03-4bd9-827c-5a8ad5dd078e",
    "8f31532b-caad-43e4-8604-56e55a3da8a1",
    "eced4219-15bd-4cd3-a1e1-34f946d6c79b",
    "b04379de-ad8c-499b-842d-6f6841515577",
    "7b979a1a-2f6a-40be-99ca-b9f2964a1f5d",
    "c978a680-b006-4a86-b758-004fb427aafc",
    "82898f2c-fc9b-4911-b02d-a42421a782e9"
  ]
}
```

`6c263544-4e62-442c-b65f-8b1f0b439749` is inspected only at the call and the test title. Its expects were not read. Counted inspected because `assertUnderUsageCap` and the IPC writer were opened. It is not accepted.

## Remaining unopened

None. All 93 data rows have a source inspection. None is accepted.

```json
{"remainingRows":[],"remainingCount":0}
```
