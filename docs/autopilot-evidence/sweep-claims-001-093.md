# Sweep claims 001–093

Source sweep only, 2026-09-24. Claim matrix rows 1–93, matched to `feature-list.md` by the same id rule as `parseProjectTasks` (`conductor-task` id, otherwise sha256 of kind plus title). Every matched row is `[x]` / `[Implemented]` except where noted. No tests, smokes, or builds were run. A cited assertion was read; it was not re-executed. Nothing here is acceptance.

`docs/autopilot-evidence/repository-inventory.md` was not edited. Matrix and backlog were not edited.

Coverage: 93 rows inspected. 0 rows not opened. Follow-up opened the implementing source that rows 6, 84, 87, and 90 had left out. Findings 3 and 4 now match that source. No row is accepted. No new concrete contradiction was recorded.

## Reliability findings

1. **Row 66 is not a reopened defect.** `feature-list.md:112` reported Claude Code 2.1.265 rejected as newer than the then-baseline 2.1.263. Current `claudeCompatibility` (`src/main/providers/claude.ts:24`) supports the baseline `2.1.278` (line 15) and any newer 2.x (lines 28–29). Older 2.x and other majors are refused (`claude.ts:157`). `claude.test.ts:118` expects `2.1.280` to connect unverified; line 132 expects `2.1.263` to throw `below the tested 2.1.278 bridge baseline`. Raising the baseline does not recreate the old “newer than baseline” rejection. `2.1.265` is now an obsolete name for a version older than today’s baseline, not proof the original bug remains. This session’s `claude --version` printed `2.1.281 (Claude Code)`, which the same comparison accepts as newer unverified 2.x. The unpause UI was not opened.

2. **Source agrees, not acceptance — diagnostic leak, editor overwrite, false complete check, scroll yank, foreground Bash roster, background output, task sort, binary open, Escape stop.** Details in the inspected rows. Each still needs a live UI or restart check.

3. **Row 90 checklist note is not a source contradiction.** `feature-list.md:164` still says a previous done mark was premature and the send button had not been redesigned. The control now in source is `StructuredSendButton` (`StructuredSendButton.tsx:13`): one button, three glyphs, stop and resume states. Whether that is the redesign the note asked for is not decided here.

4. **Row 84 queue label is implemented, not acceptance.** `assignmentStatus` (`project-task-assignment-status.ts:5`) does not return the bare word Queued. A queued assignment reads `Queued in agent tab. It is sent as soon as the turn already running there finishes.` After the tab’s queue drains, or when status is `submitted`, it reads `Sent to agent tab`. `project-task-assignment-status.test.ts:6` and line 10 lock those two strings. The dispatcher test at `project-task-dispatch.test.ts:100` is a separate path.

## Inspected rows

### 1. `local-file-processing-e2e` — `feature-list.md:7` — inspected

Claim text already limits short-segment model reliability and points at `docs/local-file-execution.md`. That doc, lines 23–24, says Ornith still guessed schemas and dates, and tool repairs did not remove those failures.

Source: completion stays blocked without a validated artifact (`src/main/local-models/agent.ts:732`).

Test: `src/main/local-models/processing-workflow.test.ts:30` expects `result.failed` false for an observed plan; lines 35–38 expect outcomes `matched, ambiguous, not_found, matched`, date `2026-04-23`, and amounts `85000.00 CZK` / `-1200.00 CZK`. Line 50 expects a tampered plan to fail with `result` undefined.

Pending runtime: an Ornith or UI session. Not opened. The done mark includes the reliability limit, so that sentence is not a contradiction.

### 4. `afcfe007150e1a7785cc-0` — `feature-list.md:10` — inspected

Word-wrap toggle. `src/renderer/src/panes/CodePane.tsx:31` reads `localStorage['conductor.editorWordWrap']`, default on. Line 456 is the toggle button (`Alt+Z`). Line 501 sets Monaco `wordWrap` to `on` or `off`.

No unit test located (search was `wordWrap` / `editorWordWrap` under `src/renderer`). Row 3 is inspected below.

### 6. `3975aa45fd0742971c7a-0` — `feature-list.md:12` — inspected

`StructuredAgentPane.tsx:524` defines `stop` as `structured.interrupt`. Lines 527–530: Escape, when focus is inside the pane, the phase is active, and no dialog is open, calls `stop(true)`. No test asserts that listener.

The same button changes glyph. `sendButtonIntent` (`StructuredSendButton.tsx:8`) returns `stop` when a turn is active and the draft is empty, `resume` when the conversation needs resume and there is no draft to send, and `send` otherwise. An active turn with a draft stays `send` and is labeled `Queue message` (line 10). CSS shows only the glyph for `data-state` (`StructuredAgentPane.css:231`). Test `StructuredSendButton.test.ts:49` expects active with no draft to be `{ state: 'stop', label: 'Stop' }`. Line 52 expects active with a draft to stay `send`. Line 55 expects `needsResume` to be `resume`. Line 64 expects the active-draft label `Queue message`. Line 19 expects one button that still contains all three glyph classes.

### 28. `4117499719ef1b7a3f61-0` — `feature-list.md:36` — inspected

`src/main/providers/claude.ts:750` drops lines matching `^\s*\[ede_diagnostic\]`.

Test `src/main/providers/claude.test.ts:538` feeds the split diagnostic and then an `error_during_execution` whose error is `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`. Lines 546–548 expect phase `interrupted`, zero error items, and zero text items.

Pending runtime: a live Claude stop. Source agrees with the claim.

### 29. `afb1e8763a49cd0ccb66-0` — `feature-list.md:38` — inspected

`writeEditorFile` (`src/main/editor-files.ts:17`) returns `saved` when content already matches (line 19). If `expectedContent` is missing or the disk contents differ, it returns `conflict` and does not replace the file (line 20). A second read after the temp write repeats that check (line 31). `saveEditorCopy` (line 49) writes a new `*.recovered-*` file with flag `wx`.

Test `src/main/editor-files.test.ts:31` expects `writeEditorFile(path, 'old local edit', 'original').status` to be `conflict`. Line 57 expects the same for `'stale edit'`.

Pending runtime: the restart-to-update path that overwrote `feature-list.md`. The close dialog and update installer were not opened. The helper refuses a stale write; that does not prove the restart path calls it.

### 46. `bug-44` — `feature-list.md:70` — inspected

`RemoveProjectDialog` (`src/renderer/src/components/RemoveProjectDialog.tsx:27`) says local files stay on disk and can be opened again. The confirm button calls `onRemove` (line 33). `App.tsx:776` calls `projects.remove`, and line 790 toasts that files remain at the project path.

No dialog unit test located. Pending runtime: whether the dialog appears and the list row disappears. Disk delete is still refused by this copy; the claim’s “files stay on disk part is broken” is the wording this dialog now states on purpose. Whether that satisfies the bug is a UI check.

### 51. `fc81684cfbe2940db489-0` — `feature-list.md:80` — inspected

`claudeTaskKind` (`src/main/providers/claude.ts:47`) maps `local_bash` to `shell` and only `local_agent` / `local_workflow` / `remote_agent` to `agent`. Lines 618–620 keep a background Bash task on the tool row.

Test `src/main/providers/claude.test.ts:666`: a `task_started` with `is_backgrounded: false` and `task_type: 'local_bash'` produces `subagents(f)` length 0 (line 671). Line 676 expects the same length 0 for a background Bash task, and line 683 expects the Bash tool row `status: 'completed'`.

Pending runtime: a live Claude roster. Source agrees with the foreground-mislabel part of the claim.

### 52. `bug-51` — `feature-list.md:82` — inspected

`src/main/providers/claude.ts:627` reads `output_file` for a background shell and `updateTool` writes `output` (lines 631–634). Comment at 620: `output_file` is not identity.

Test `src/main/providers/claude.test.ts:892` expects the Bash tool `output` to be `Native background command completed successfully` and no subagent item. `src/main/providers/claude-task-output.test.ts:13` expects a 40k file to come back as 32,000 characters ending in ` finished`, and a foreign session to set `outputError` matching `/belong/`. `StructuredAgentTelemetry.test.ts:16` expects rendered HTML not to contain `0 tools` for an agent whose `activity` is empty.

Pending runtime: the roster the owner saw. The “0 tools” string is suppressed in that markup test even with empty activity, which hides the label; it does not assert that command output is visible in the roster. Output is attached to the Bash tool row in the adapter test.

### 66. `1a1038af-b33f-4dd1-a708-a88eafa62c79` — `feature-list.md:110` — inspected

Not a contradiction of the original bug. See finding 1. Continuation text is `feature-list.md:112`. The reported failure was a CLI newer than baseline 2.1.263. Current source accepts newer 2.x. Installed CLI read this session: 2.1.281.

### 75. `2f1c8d64-9b3e-4c07-9a5f-1d0e7b2a4c58` — `feature-list.md:130` — inspected

`src/renderer/src/panes/file-view-routing.test.ts:20` expects `opened('clips/demo.mp4').mode` to be `preview` and `previewKindFor` to be `video`. Line 45 expects `vendor/tool.exe` to be `binary`. Line 57 expects the IPC-wrapped `BinaryFileError` to surface as text, not an editor decode.

The main-process refusal function and the right-click “open as text” menu were not opened. Pending runtime: click a video in the tree. The routing helper agrees with the claim’s video case.

### 78. `77d9a4c4-1baf-41a5-8ff1-c091b71b1e1d` — `feature-list.md:136` — inspected

`followsBottomAfterScroll` (`src/renderer/src/panes/conversation-scroll.ts:49`) uses a tight return threshold once following is already off. The comment at lines 43–47 names the “stutters and won't let us leave bottom” yank. `StructuredAgentPane.tsx:806` sets `nearBottom` false on an upward wheel. Line 811 writes it back through `followsBottomAfterScroll`.

Test `conversation-scroll.test.ts:23` expects `followsBottomAfterScroll(true, geometry(80))` false. Lines 32–33 expect a released follow to stay false at 50px and at 5px (the regression called out in the comment at line 29).

Pending runtime: a streaming Claude or Codex turn. The helper agrees. The wheel listener was read; it was not executed.

### 79. `7a09125f-f1fb-48c1-bd7e-cd3fcf214920` — `feature-list.md:138` — inspected

`resolveActivityPhase` (`src/renderer/src/attention.ts:82`) returns `working` when phase is `complete` and subagent work is active. `App.tsx:213` says the tab strip, sidebar, and dots read `correctedActivityPhases`. Line 217 calls `resolveActivityPhases` when `subagentActiveIds` is non-empty; otherwise it keeps the raw map.

Test `attention.test.ts:151` expects `resolveActivityPhase('complete', true)` to be `working`, and line 155 expects `('complete', false)` to stay `complete`.

Pending runtime: how `subagentActiveIds` is filled while a parent turn is also running. If that set is empty, line 217 does not correct the checkmark. That caller was not opened.

### 84. `b54caf0b-551b-49fe-8146-e587b025e1f2` — `feature-list.md:150` — inspected

`project-task-dispatch.test.ts:96` sends selected tasks once to an existing tab. Line 100 expects `assignments[0].status` `submitted`. Line 101 expects one submission. Line 118 expects `failed` and the task left `todo` when the steer receipt is `uncertain` (line 123).

The dialog renders `assignmentStatus` (`ProjectTaskAssignment.tsx:150`). `project-task-assignment-status.ts:3` says a bare Queued reads as broken. Line 8 returns `Queued in agent tab. It is sent as soon as the turn already running there finishes.` Line 7 returns `Sent to agent tab` for `submitted` or once `delivered` is true. `ProjectTaskAssignment.tsx:90` watches assignments whose status is `queued` and marks one delivered when that session’s `queuedPrompts` becomes empty (line 97). Test `project-task-assignment-status.test.ts:6` expects the waiting sentence, and line 10 expects `Sent to agent tab` when `delivered` is true.

### 87. `71d97bf1-b4b0-4c7b-af24-c0985a5f3cea` — `feature-list.md:156` — inspected

`ProjectBacklogPane.test.ts:66` says sort is view-only and `feature-list.md` keeps on-disk order. Line 76 expects `sortProjectTasks([low, normal, high])` ids `['high', 'normal', 'low']` even when low was added last. Line 83 expects same-priority order `['newest', 'middle', 'oldest']`.

The move control on a row is `PriorityPicker` (`ProjectBacklogPane.tsx:344`). It calls `edit({ type: 'update', id, priority })`. There is no `draggable` or drop handler on a task article. No test asserts the picker. Newest-within-priority is the order function; priority is the field a person or agent can change.

### 90. `46f70c53-7942-4489-90f0-2f4a4584fdea` — `feature-list.md:164` — inspected

The checklist title still says an earlier done mark was premature and the button had not been redesigned. The composer control is `StructuredSendButton` (`StructuredSendButton.tsx:13`): one button, send/stop/resume glyphs kept mounted, orbit while busy. Stop styling is `StructuredAgentPane.css:219`. Test `StructuredSendButton.test.ts:14` expects one button containing all three glyph classes for each state. That does not decide whether this is the redesign the checklist note asked for.

### 2. `61d369b3addc35908ae2-0` — `feature-list.md:8` — inspected

Double-click in xterm selects a word and `onSelectionChange` copies it. `RuntimeTerminal.tsx:247` copies any non-empty terminal selection. `NativeCliPane.tsx:22` does the same. `styles.css:33` sets `body { user-select: none }`. `.sa-timeline` is `user-select: text` (`StructuredAgentPane.css:20`) and has no selection-change copy. No test asserts copy-on-select. Source still auto-copies only from the two xterm hosts.

### 3. `762ca713c6df532bdd48-0` — `feature-list.md:9` — inspected

`src/renderer/src/backlog.css:1` is the shared bounded-text sheet. Line 3 sets `.sa-timeline` to `overflow-x: hidden` and `scrollbar-gutter: stable`. Line 4 wraps `.sa-markdown` with `overflow-wrap: anywhere`. Line 5 keeps pre blocks in a horizontal scroller (`overflow-x: auto`, `white-space: pre`). Line 9 gives the composer textarea `overflow-wrap: anywhere` and `scrollbar-gutter: stable`. No unit test for this sheet. The gutter reservation is the source answer to text sitting under the scrollbar.

### 5. `eb1a6d7ad2b8cbdb8d3d-0` — `feature-list.md:11` — inspected

The composer form is `sa-composer agent-prompt-surface` (`StructuredAgentPane.tsx:833`). `backlog.css:7` sets `.sa-composer textarea`, including `:focus` and `:focus-visible`, to `outline: none`. That beats `.structured-agent-pane :focus-visible` (`StructuredAgentPane.css:5`). `backlog.css:8` changes the border on `:focus-within`. `AgentPrompt.css:4` still adds a 2px box-shadow on `.agent-prompt-surface:focus-within`. The browser outline on the textarea is cleared; a focus ring on the surface remains. No test asserts the outline.

### 7. `618e4362054dea370467-0` — `feature-list.md:13` — inspected

`StructuredAgentPane.tsx:777` renders Chat and CLI. CLI is disabled while historical, not ready, a turn is active, or a prompt is queued. `RuntimeTerminal.tsx:107` omits `onRequestCli` for `local`. For other providers, line 110 calls `nativeCli.ensure` and switches to CLI, or toasts the rejection. `NativeCliManager.ensure` (`native-cli-manager.ts:53`) rejects while a Chat switch is in flight, throws `The provider CLI is unavailable` (line 66), and throws `Turn off Plan mode before switching to the Codex CLI.` (line 67). Test `native-cli-manager.test.ts:35` expects a PTY throw to reject, call `cancelCli`, and allow a second `ensure` to resolve `available: true`.

### 8. `d49c88417acaa7f98cf8-0` — `feature-list.md:14` — inspected

Backdrop dismiss: `CreateProjectDialog.tsx:34`, `RemoveProjectDialog.tsx:11`, `CommandPalette.tsx:49`, `SettingsPanel.tsx:76`. Sidebar menu: `Sidebar.tsx:208` closes on mousedown unless the target is `.project-more` or `[data-project-menu-trigger]`. Line 224 closes when the same project’s menu button is clicked again. Explorer `…` toggles at `ExplorerSidebar.tsx:748` (`setMenu(null)` when that project menu is already open). No test asserts the backdrop or the second click.

### 9. `4c5e90b92f692c7db58c-0` — `feature-list.md:15` — inspected

`StructuredAgentPane.tsx:870` toggles `addFileOpen`. Line 893 mounts `FileAttachmentInput`, which focuses its input on mount (`FileAttachmentInput.tsx:12`) and is a combobox (`line 38`) with arrow selection (`line 43`). `/attach` also opens it (`StructuredAgentPane.tsx:762`, command listed in `composer-commands.ts:6`). No test asserts the attach picker.

### 10. `61d69e84db6f04ef99dc-0` — `feature-list.md:16` — inspected

Local explorer project row (`ExplorerSidebar.tsx:753`) toggles `rootCollapsed` on click (line 754) and starts rename on double-click (line 757). Escape clears the rename input (line 776). Blur outside the rename form clears it (line 772). Remote explorer row toggles on click (`line 251`). No test asserts the chevron or the rename dismiss.

### 11. `17d28dec9cc451716e65-0` — `feature-list.md:17` — inspected

`WorkspaceSidebarPanel.tsx:66` renders one `ExplorerSidebar` per loaded project and passes `defaultCollapsed={item.id !== project?.id}`, so the active project is open and the others start collapsed. No test asserts that flag.

### 12. `08187ebc92d5a6e5e266-0` — `feature-list.md:18` — inspected

`Sidebar.tsx:352` makes each project row draggable. Drop at lines 356 rebuilds the id list and calls `onReorderProjects`. `database.ts:548` `reorderProjects` persists `projectOrder`. Test `database.test.ts:398` expects the saved order `[a.id, b.id]` after reopen, and line 409 expects a duplicate id list to throw `list changed`. Line 411 expects a newly added project to land after the saved order.

### 13. `1fb7e48d815ffe9d0f34-0` — `feature-list.md:19` — inspected

`composerDraftKey` is project id plus session id (`composer-draft-store.ts:12`). `useComposerDraft` (`use-composer-draft.ts:9`) subscribes to that key. Test `composer-draft-store.test.ts:24` writes three drafts and, after a new store on the same storage, expects the first message and attachment unchanged and the other two keys to keep `Second project` and `Second workspace`.

### 14. `cddd40a89f086e8f3e21-0` — `feature-list.md:20` — inspected

`Sidebar.tsx:414` drags a workspace row. Drop calls `onReorderSessions`. Close is the X at line 431, and the context menu calls `onCloseSession` (line 273). `database.ts:553` persists `sessionOrder:` plus project id. `database.test.ts:405` reorders two sessions and line 408 expects that order after reopen.

### 15. `1d976137753455e51f90-0` — `feature-list.md:21` — inspected

Ctrl+E toggles the file picker (`WorkspaceFiles.tsx:142`) and the picker label shows `Ctrl E` (`FilePicker.tsx:58`). Arrow keys `preventDefault` and move the selection, including while a search is busy, via `pendingSelection` (`FilePicker.tsx:42`). Changing the query resets the index to 0 (line 56). No test asserts the arrows.

### 16. `11b3542d4d6952a6e53f-0` — `feature-list.md:22` — inspected

`StructuredComposerControls.tsx:103` renders the effort slider only when `efforts.length > 0`. Line 57 clears a stored effort when the model has no supported choices. Test `StructuredComposerControls.test.ts:42` expects no `type="range"` with no capabilities, a range when the provider has efforts and no model list, and no range for `model-two`, whose catalog effort list is empty (`line 13`).

### 17. `ac2673ced741ed3dae6e-0` — `feature-list.md:23` — inspected

See row 7. A failed `nativeCli.ensure` is caught and toasted (`RuntimeTerminal.tsx:110`) and does not call `changeView('cli')`. `native-cli-manager.test.ts:41` expects `PTY unavailable` to reject and `cancelCli` so the next `ensure` can start. Plan mode throws before spawn (`native-cli-manager.ts:67`).

### 18. `5ba19156e4b7c629cf3d-0` — `feature-list.md:24` — inspected

`toggleBrowserTab` (`browser-tab.ts:27`) closes the browser tab when it is the active tab (line 31), focuses it when it exists but is hidden (line 35), and otherwise adds one. Test `browser-tab.test.ts:20` expects a second toggle to make `browserTabOpen` false and `closedTab.kind` `browser`. Line 30 expects a hidden browser tab to be focused instead of duplicated.

### 21. `3027f35ddc75e8b96b16-0` — `feature-list.md:27` — inspected

`structured-sessions.ts:596` appends to `queuedPrompts`. The pane lists every queued prompt (`StructuredAgentPane.tsx:842`). Test `structured-sessions.test.ts:757` queues `second` then `third` while `first` is in flight and expects `queuedPrompts` texts `['second', 'third']` (line 763), then after finish expects submissions `['first', 'second']` and the remaining queued text `third` (lines 766–767). Model label: `reported` treats `default` and `auto` as absent (`composer-settings.ts:19`). `modelDisplayName('gpt-6-astra')` is `GPT-6-Astra` (`composer-settings.test.ts:36`). An undiscovered Claude model is labeled `Account default`, not the word Default (`line 24`). `StructuredComposerControls.test.ts:40` expects a settings model of `default` to render `Model One`, the catalog default, and not `Default`.

### 22. `4e4087c29db684288883-0` — `feature-list.md:30` — inspected

Repeated assistant text: stream deltas share one item id (`claude.ts:717` and `736`). The final assistant message emits the same id as a snapshot and adds it to `completedBlocks` (lines 499–504), so a later delta for that id is dropped (line 728). Duplicate wire uuids return at line 460. Test `claude.test.ts:203` streams `ha` twice, then the final `haha`, and line 220 expects one text item whose text is `haha`. Two distinct final text blocks stay two items (`claude.test.ts:878`). Session permission: `allow-session` for offered Edit mode calls `set_permission_mode` acceptEdits (`claude.ts:323`) and stores `temporaryPermission` (line 336). Test `claude.test.ts:1028` expects only one `set_permission_mode` after a second submit on the same runtime. A different runtime launches with `manual` (line 1031). The adapter does not suppress a later `can_use_tool` by itself; the mode switch is what the test locks.

### 65. `c17c6c3c-5c82-4c03-b3d5-9bae9d1ff925` — `feature-list.md:108` — inspected

`ProjectBacklogPane.tsx:225` says the drawer unmounts on close or project change, so the draft is outside React state. Key is `conductor.tasks.draft.` plus project id (line 231). `keepDraft` writes on each edit (line 264). Reload on `project.id` change reads it back (line 271). Test `ProjectBacklogPane.test.ts:165` seeds that key with title `Investigate the crash` and an image, and line 168 expects the rendered title, the chip, and `Screenshot.png`.

### 70. `951e6ca7-f503-4096-a572-0fe57d259fb6` — `feature-list.md:120` — inspected

`structured-store.ts:333` skips a session with no items and no title. Test `structured-store.test.ts:135` expects `history('project')` to be `[]` while the snapshot has empty items and an empty title, then line 140 expects history only after a user text event. Line 143 expects a titled session with no items to appear. An untitled empty registration stays out (line 148).

### 93. `29eb4e9b-956b-42bb-89d5-dcf01fb0605e` — `feature-list.md:172` — inspected

`StructuredAgentPane.tsx:747` saves composer changes on the conversation before a message is sent. `updateSettings` calls `structured.saveSettings` (line 756). On mount, line 254 replaces React settings from the snapshot, including `effort`, and only rewrites `model`. Test `structured-sessions.test.ts:1325` saves `model: 'opus', effort: 'low'`, expects that on the snapshot (line 1328), reopens the database, and expects the same pair (line 1332) with no adapter start (line 1329). `StructuredComposerControls.tsx:57` clears effort when the selected model reports no supported choices; that is a different path from the project switch.

### 19. `1b0166f85f6a1dd9a5fb-0` — `feature-list.md:25` — inspected

`OrchestrationHub.tsx:217` is the Add agent button. `OrchestrationHub.css:173` sets it to 8px, weight 600, letter-spacing `.07em`, and `text-transform: uppercase`. No test asserts that rule.

### 20. `28935c0dcff13a2712b9-0` — `feature-list.md:26` — inspected

Composer attachments render as chips of `attachment.name` plus an optional line range (`StructuredAgentPane.tsx:845`). A long paste is a chip, and the inspect dialog says pasted text is sent as attached context rather than inline (line 850 and the dialog at line 897). Sent messages list attachment names, not a dumped file body, in `StructuredAgentRenderers.tsx` around the `sa-message-attachments` block. No test asserts that the prompt text excludes file bytes.

### 23. `442ddec628ae56639d9a-0` — `feature-list.md:31` — inspected

`StructuredComposerControls.tsx:78` puts `ConversationModeControl` in the composer when more than one mode exists. The control shows an icon and the mode label (`ConversationModeControl.tsx:16` and `38`). `composer-settings.test.ts:70` expects Codex modes `Ask`, `Read only`, `Edit`, `Auto`. Line 77 expects plan to be appended, not to replace those modes. Line 80 expects an empty list when the provider offers none.

### 24. `33b507078309e0c53f94-0` — `feature-list.md:32` — inspected

While following the bottom and nothing is selected, new items set `scrollTop` to `scrollHeight` (`StructuredAgentPane.tsx:292`). Otherwise a newer sequence sets `newOutput` (line 294). The button is `New output · Jump to latest` (line 831) and `jumpToLatest` clears that flag (line 728). `conversation-scroll.test.ts:18` expects following to stay on inside the 80px band. No test renders the jump button.

### 25. `4d6670abaa9083a64ddb-0` — `feature-list.md:33` — inspected

The session bar is forced to 25px (`StructuredAgentPane.css:283`). Its buttons are 22px (line 284) and the Chat/CLI switch is 22px with 20px buttons (lines 285–286). No test asserts those heights.

### 26. `79f19b99d1a7b2af9399-0` — `feature-list.md:34` — inspected

Raw request JSON sits behind a collapsed summary titled `Request details`, with tooltip `Inspect exact request and scope` (`StructuredAgentRenderers.tsx:465` and `566`). A resolved question heading is the question text, not `Claude needs your input`. Test `StructuredAgentRenderers.test.ts:447` expects `<span>Pick one</span>`, not `<span>Claude needs your input</span>`, and `<small>Answered</small>`.

### 27. `5f25fc8c4ea21d1df19b-0` — `feature-list.md:35` — inspected

`backlog.css:109` gives `.split-gutter` zero flex basis so it does not consume a layout stripe. Line 110 hides the gutter bar (`display: none`). The hit area is the `::before` inset of 4px (lines 111–112). `styles.css:418` still sets `flex: 0 0 7px` on the same class; the later sheet is what zeroes the basis. No test asserts the gutter.

### 30. `3e344eafaa673dcfc178-0` — `feature-list.md:40` — inspected

`FilePicker.tsx:56` sets `selected` back to 0 on every query change. Arrow keys move `pendingSelection` while busy (lines 42–45) and line 39 scrolls the selected row into view. No test asserts either path.

### 31. `3882fb2f7f37f2066f6c-0` — `feature-list.md:42` — inspected

`App.tsx:937` `restoreWorkspace` calls `sessions.restore`, then `showRestoredWorkspace` (line 927), which toasts `Brought back ${name}`. Empty history toasts `No closed workspace to bring back` (line 943). Ctrl+Shift+Z is bound at line 951. The shared menu item is `Bring back workspace` with that shortcut (`WorkspaceSessionMenu.tsx:43`). `workspace-restore.test.ts:19` expects the same pane id, transcript, and draft after `database.restoreSession`.

### 32. `42a1f136ee7a07bd9b2d-0` — `feature-list.md:44` — inspected

The ready label is `Restart to update` (`AppUpdateButton.tsx:31`). `styles.css:775` sets a hover border and background on `.statusbar-update:hover:not(:disabled)`. `backlog.css:122` sets a separate hover for `.statusbar-update.ready`. Test `AppUpdateButton.test.ts:17` expects `isUpdateActionVisible` true for phase `ready`. No test asserts the hover rule.

### 33. `eb6c8a387e08beabf9f7-0` — `feature-list.md:46` — inspected

Sidebar workspace double-click calls `renameSession` (`Sidebar.tsx:423`). The same `WorkspaceSessionMenu` is used from the sidebar (`Sidebar.tsx:273`) and the workspace bar (`SessionBar.tsx:113`). Its items are Rename, New, Bring back, and Close (`WorkspaceSessionMenu.tsx:41`). The file comment at line 17 says the two surfaces share those actions. No test asserts the menu.

### 34. `f681a5cc5d2ac2b257a8-0` — `feature-list.md:48` — inspected

New file does not open a dialog. `beginCreate` (`ExplorerSidebar.tsx:479`) sets an inline `createTarget` defaulting to `untitled.txt`. The form is `explorer-create-bar` (line 785). Focus selects the name and leaves the extension (`lines 792–794`). Escape clears it (line 797). No test asserts creation.

### 35. `48a0ead3daf7e120af3f-0` — `feature-list.md:50` — inspected

`isConversationActivity` (`StructuredAgentRenderers.tsx:60`) drops session and usage events, runtime heartbeats, ordinary subagent rows, and provider diagnostic notices (line 69). `LocalStopCard.test.ts:38` expects a completed local stop report to be omitted and a `round_limit` report to stay. `session-archive.ts:159` redacts secrets in exported archives. No test was opened for that redact helper. `session.md` itself was not opened.

### 36. `bug-34` — `feature-list.md:55` — inspected

A historical conversation shows `Previewing saved conversation` and a `Resume this conversation` button (`StructuredAgentPane.tsx:803`). A stopped runtime shows `banner` with `Resume conversation` (line 804). No test asserts those banners.

### 37. `bug-35` — `feature-list.md:56` — inspected

Mode icons are in `modeIcons` (`ConversationModeControl.tsx:16`) and rendered at line 38. `ProviderIcon` (`ProviderIcon.tsx:11`) maps Codex/GPT to the OpenAI mark, Claude names to the Claude mark, and local to Qwen. The session bar renders it at `StructuredAgentPane.tsx:776`. No test asserts the icons.

### 38. `bug-36` — `feature-list.md:57` — inspected

`StructuredComposerControls.test.ts:62` expects the effort control HTML not to contain `Not reported` and not to contain `>Account default<` when no effort was saved. The legacy prompt still has the string `Model not reported` for a `default` or `auto` id (`AgentPrompt.tsx:155` and `AgentConversation.tsx:183`). No test asserts those two legacy strings are absent.

### 39. `bug-37` — `feature-list.md:59` — inspected

`isDotEntry` is a name starting with `.` (`explorer-order.ts:3`). `orderExplorerEntries` sorts dot entries after other entries (line 8). `ExplorerSidebar.tsx:148` inserts the heading `Configuration & hidden` before the first dot entry in a run. No test asserts that order.

### 40. `bug-38` — `feature-list.md:60` — inspected

The attach picker is taken out of flow: `.sa-composer > .sa-file-attachment` is `position: absolute; bottom: calc(100% + 7px)` (`StructuredAgentPane.css:352`). Arrow keys move the suggestion index (`FileAttachmentInput.tsx:43`). No test asserts the overlay.

### 41. `bug-39` — `feature-list.md:61` — inspected

`navigation.css:2` sets `.pane-group.focused` border to `var(--border)` and a plain shadow. Line 3 hides the header dot. `styles.css:942` still sets that same selector to `var(--accent-muted)`. `navigation.css` is imported from `PaneWorkspace.tsx:6`, after the global sheet. The composer focus ring remains the 2px box-shadow on `.agent-prompt-surface:focus-within` (`AgentPrompt.css:4`). No test asserts the pane border.

### 42. `bug-40` — `feature-list.md:62` — inspected

`computeMarkers` (`AgentControlLinks.tsx:15`) puts one marker inside each linked tab header. The test title at `AgentControlLinks.test.ts:9` calls these badges the replacement for the cross-content cable. Line 10 expects two markers, and lines 19–22 expect each marker’s x/y to stay inside its tab header rect. Line 34 expects a controller marker when the other tab has no rect. Line 44 expects no markers when neither tab is in the window.

### 43. `bug-41` — `feature-list.md:64` — inspected

A user message with `origin` renders the other tab’s label and a link, not `You` (`StructuredAgentRenderers.tsx:590`). `structured-sessions.ts:670` copies `input.origin` onto that user text event. No test asserts the coordinated label.

### 44. `bug-42` — `feature-list.md:66` — inspected

The final assistant message emits one item id per text block and marks it complete (`claude.ts:499`). Later deltas for that id are dropped (`claude.ts:728`). Test `claude.test.ts:220` expects one text item, `haha`, after two streamed `ha` deltas plus the final message. Two separate final text blocks stay two items (`claude.test.ts:878`).

### 45. `bug-43` — `feature-list.md:68` — inspected

Questions can collapse to a bottom dock (`StructuredAgentRenderers.tsx:520`). The timeline passes `dockedQuestion` (`StructuredAgentPane.tsx:819`). Scroll-follow is the same `followsBottomAfterScroll` path already cited for row 78. No test asserts the dock.

### 47. `bug-45` — `feature-list.md:72` — inspected

`useAnimatedCount` (`use-animated-count.ts:3`) eases a rising token count over 260ms and jumps immediately when reduced motion is set or the value falls. `StructuredAgentTelemetry.tsx:16` uses it for output tokens. No test asserts the interpolation.

### 48. `174e52947721688d03ed-0` — `feature-list.md:74` — inspected

The effort track fills to `--effort-progress` (`AgentPrompt.css:36`). At 100% the ticks take the charged animation (`lines 46–48`). `StructuredComposerControls.test.ts:53` expects `--effort-progress:67%` for medium of four levels. No test asserts the 100% animation.

### 49. `bug-47` — `feature-list.md:76` — inspected

`navigation.css:5` hovers the active tab, the session tab, the session-tree button, the file tab, and the project row, and line 4 transitions background, color, and border over 140ms. The day/night switch thumb transitions in `appearance.css:139`. No test asserts those rules.

### 50. `bug-49` — `feature-list.md:78` — inspected

The question form submits on Enter when the target is an `HTMLInputElement` and Shift is not held (`StructuredAgentRenderers.tsx:523`). The form also submits on its submit event (same line). No test asserts the key.

### 53. `bug-52` — `feature-list.md:84` — inspected

`StructuredComposerControls.tsx:52` says the composer commits the effort it is showing. The effect at line 58 calls `onChange` when the resolved effort differs from the saved one. Line 57 clears effort when the model offers none. Test `StructuredComposerControls.test.ts:62` expects the HTML not to contain `Not reported`, and line 64 expects `onChange` not to run when no effort is saved.

### 54. `bug-53` — `feature-list.md:86` — inspected

`autoscroll.ts:1` installs middle-click autoscroll for scrollable surfaces and excludes `.xterm`, `.monaco-editor`, inputs, textareas, and selects (line 30). Test `autoscroll.test.ts:6` expects speed 0 inside the dead zone, a positive speed at 40px, and a cap of 3200. No test asserts tab-strip middle-click-to-close.

### 55. `bug-54` — `feature-list.md:88` — inspected

`PaneWorkspace.tsx:228` renders `kind === 'tasks'` as `ProjectBacklogPane`. The `Unavailable` pane at line 243 is the fallback for a kind that matched none of the branches above it. No test asserts the tasks branch.

### 56. `8d608499-2169-4667-ad20-17d85edcea36` — `feature-list.md:90` — inspected

`StructuredSendButton.tsx:12` keeps send, stop, and resume glyphs mounted. The stop state adds `sa-stop`. `StructuredAgentPane.css:234` shows the orbit while `data-busy` is true and line 236 rotates it. No test asserts the animation. Image upload on the bug form was not opened.

### 57. `aab154cf-753f-430d-9322-705aef5811e2` — `feature-list.md:92` — inspected

An accepted steer shows `Message will be sent after the next tool use. Esc interrupts and sends now.` (`StructuredAgentPane.tsx:837`). The composer placeholder while steering is `Message after the next tool use` (line 849). No test asserts those strings.

### 58. `1683e42e-fad9-4114-bb08-76df967f1c4c` — `feature-list.md:94` — inspected

Same marker helper as row 42. `AgentControlLinks.test.ts:9` names the badges as the replacement for the cross-content cable, and lines 19–22 expect each marker inside its tab header rect.

### 59. `1cf21b4b-06ff-45d9-a60d-9728358c141f` — `feature-list.md:96` — inspected

`StructuredAgentRenderers.tsx:590` renders `You` only when a user message has no `origin`. With `origin` it renders that label. See row 43 for where `origin` is copied onto the event. No test asserts the split.

### 60. `af404d03-5374-42b2-ae5e-b20ac7f62608` — `feature-list.md:98` — inspected

`submitTaskShortcut` (`ProjectBacklogPane.tsx:145`) submits only for Ctrl/Cmd+Enter. The new-task textarea title is `Ctrl+Enter to add; Enter for a new line` (line 381). `ProjectBacklogPane.test.ts:154` expects that title in the markup. The add control is one button row, not a separate “button + add task” pair; that second half of the claim was not given a distinct control to open.

### 61. `d38cfabb-a246-4fa7-8e20-68f391a9d557` — `feature-list.md:100` — inspected

Ctrl+T calls `openInFocused('launcher')` (`App.tsx:1278`). `openInFocused` adds a launcher even when the focused tab is already a launcher (lines 1029–1033). A non-launcher key replaces a focused launcher (line 1031). No test asserts the second Ctrl+T.

### 62. `238d9c49-d5d9-480c-9b62-6ce2a677dca6` — `feature-list.md:102` — inspected

`TAB_CHORD` maps `c` to Claude, `x` to Codex, and `q` to Qwen (`tab-keyboard.ts:17`). The chord stays armed for `CHORD_TIMEOUT_MS` of 1600 (`line 29`, armed at `App.tsx:1237`). `App.tsx:1292` also accepts those keys while the focused tab is a launcher, after the timer. No test asserts the key map.

### 63. `9c001aa5-d476-4b8b-b984-dd3029d1a65b` — `feature-list.md:104` — inspected

An empty Ctrl+E query lists recent files (`FilePicker.tsx:33`). A typed query passes `activeProjectId` and `recentPaths` (line 34). `project-file-search.ts:9` adds 100 for the active project and 50 for a recent path. Test `project-file-search.test.ts:45` expects the active project’s `widget.ts` first. Line 50 expects a recent path first. Hidden files stay out unless `showHidden` is set (the same test file, line 40).

### 64. `828e9195-e5a2-4033-b1a6-655acaf7dddd` — `feature-list.md:106` — inspected

`Sidebar.tsx:233` says Explorer and Project tasks are independent surfaces and picking Explorer must not close Project tasks. Explorer is a sidebar mode (`line 111`). Project tasks is a utility (`line 113`). No test asserts that they stay open together.

### 67. `43792807-720b-465d-8ce4-76d97e9c1b23` — `feature-list.md:114` — inspected

The explorer pane header is the word Explorer (`WorkspaceSidebarPanel.tsx:64`). Each project name is a row under that header (line 66). No test asserts the header.

### 68. `e1944766-e712-4557-be92-6c1c645216da` — `feature-list.md:116` — inspected

Ctrl+Shift+Arrow calls `nudgeFocusedGroup` (`App.tsx:1338`). That calls `resizeFocusedGroup` (`tab-keyboard.ts:91`), which adds or subtracts 5 percent on the matching split axis and writes it through `resizeSplit` (line 104). Test `tab-keyboard.test.ts:86` expects `down` on a horizontal-only split to return the same layout. Line 92 expects forty `left` nudges to clamp at 10/90 rather than collapse. No test asserts down-then-up on a vertical split.

### 69. `2dc5f9b0-b091-458b-8812-979fed7209a0` — `feature-list.md:118` — inspected

`layout-operations.test.ts:178` expects `applyTabDrop` with a bar target to reorder tabs inside that bar (`['b', firstId]` at line 184). No test was opened for the drag-preview paint.

### 71. `570d94d7-2dc1-46cb-a5cc-2c6cee0bbd35` — `feature-list.md:122` — inspected

Each activity row uses `content-visibility: auto` and `contain-intrinsic-size: auto 90px` (`StructuredAgentPane.css:21`). No test asserts that rule.

### 72. `ea118d5a-abcc-4517-9fb3-f136e6d64346` — `feature-list.md:124` — inspected

A project row shows a bell for `attention` and an activity dot otherwise (`Sidebar.tsx:396`). `attention.test.ts:150` expects `resolveActivityPhase('complete', true)` to be `working`. No test renders the sidebar dot.

### 73. `5ffb5869-37cd-4a5a-8fa6-82562e268e3b` — `feature-list.md:126` — inspected

The composer footer renders `StructuredComposerControls` and then `StructuredUsageSummary` as siblings (`StructuredAgentPane.tsx:888`). The footer is `display: flex` (`AgentPrompt.css:7`). No test asserts that order.

### 74. `f7535768-a1b8-4927-8259-7e14146c7714` — `feature-list.md:128` — inspected

The effort slider is in the footer controls, not inside the model menu (`StructuredComposerControls.tsx:104`, mounted at `StructuredAgentPane.tsx:888`). It renders when `efforts.length > 0`. Test `StructuredComposerControls.test.ts:48` expects `aria-label="Reasoning effort"` for a model that has effort choices.

### 76. `e2bfac55-af04-4111-a9dc-6367bc14d97b` — `feature-list.md:132` — inspected

`buildFileLinkMenuEntries` (`file-link-menu.ts:12`) lists Edit, Open in browser, Open in default browser, Preview, Reveal in Conductor Explorer, and Show in Windows Explorer. The timeline menu renders those entries (`StructuredAgentRenderers.tsx:269`). Test `file-link-menu.test.ts:7` expects the three click shortcuts, and line 26 expects the list to end with `reveal-explorer` then `show-os-explorer`.

### 77. `1e8e0059-2d59-482c-b06b-ebcad8e7d82d` — `feature-list.md:134` — inspected

`WorkspaceTabToggle` is a chevron button whose label is `Hide tabs` or `List tabs` (`WorkspaceTabList.tsx:27`). No “3 tabs” string was found in that file. No test asserts the toggle.

### 80. `c9cbfe5c-416d-4067-980b-e050272ca822` — `feature-list.md:140` — inspected

While output tokens are absent, `StructuredAgentTelemetry.tsx:19` renders three `<i>` dots with `aria-label="Output tokens pending"`. The visible word “Output tokens pending” is the accessible name, not a text node. No test asserts the dots.

### 81. `1117bd1d-9066-48c4-be5e-25a254357212` — `feature-list.md:142` — inspected

`toolInlinePreview` (`StructuredAgentRenderers.tsx:378`) returns the first non-empty output or stderr line, cut at 160 characters. Test `StructuredAgentRenderers.test.ts:309` expects stderr `boom` and a 500-character output to end with `…` and stay under 165 characters (line 311).

### 82. `30bc6855-f8ee-44e4-a660-d8b6f2a40946` — `feature-list.md:146` — inspected

A nested row shows `Within {name}` (`StructuredAgentRenderers.tsx:611`). `parentLabelAnchors` (line 39) marks only the first item of a consecutive run that shares a parent. Test `StructuredAgentRenderers.test.ts:361` expects `Within Reviewer #2` and a hue class. A tool parent is uncolored (line 363).

### 83. `52ae4ebf-396d-4bf3-9fe6-c406cf8899de` — `feature-list.md:148` — inspected

The error text is `.sa-error-bar` (`StructuredAgentPane.tsx:802`). Resume is a button on the following `.sa-runtime-banner` (line 804), labeled `Resume conversation`. It is not a control inside the error string. No test asserts that banner.

### 85. `f43ea848-da29-4553-b872-5eec46c1890c` — `feature-list.md:152` — inspected

The jump button dispatches `conductor:focus-process` (`ProjectBacklogPane.tsx:357`). `App.tsx:1364` says Project tasks stays open across that jump, activates the tab, and spotlights it. The handler does not call `setUtilityPanel(null)`. No test asserts the jump.

### 86. `7b965f0f-36cf-40c2-8ee7-e733427dbfbf` — `feature-list.md:154` — inspected

Same project-row bell and activity dot as row 72 (`Sidebar.tsx:396`). No separate test renders it.

### 88. `ebc30a38-8930-404d-b9c2-fdf31371e900` — `feature-list.md:158` — inspected

`spin-sync.ts:1` says the stop orbit, the top tab ring, and the left tab ring share one duration, 900ms. `spinPhaseDelayMs` anchors every spinner to the same clock (line 10). Test `spin-sync.test.ts:16` expects the delay at 450ms to equal the delay 900ms later. `StructuredSendButton.tsx:17` applies `spinPhaseStyle`.

### 89. `8dbf1e2b-299e-4236-9ac2-45d74540e97e` — `feature-list.md:160` — inspected

The attached image is the red submit error bar plus the disconnected runtime banner with Resume. Those are `.sa-error-bar` (`StructuredAgentPane.tsx:802`) and `.sa-runtime-banner` (line 804). No test asserts that pair. The screenshot was used only to identify the controls.

### 91. `a9dd0370-5280-4d12-9ea9-cee8c7821bf4` — `feature-list.md:166` — inspected

The workspace chevron is `.workspace-tab-toggle`, 15px, inside the session row (`navigation.css:14`, rendered by `WorkspaceTabToggle`). The selected-workspace mark is a 2px bar at `left: -9px` on the row (`styles.css:330`). No test asserts either rule.

### 92. `d071798e-7236-49cb-b4db-763e209eaf0d` — `feature-list.md:168` — inspected

The attached image is the repeated `Within Skill` rows. The label is `Within {name}` (`StructuredAgentRenderers.tsx:611`). Completed runs collapse to `N completed actions` (`StructuredAgentPane.tsx:828`). The same test as row 82 expects one `Within` label when a parent label is passed. No test asserts a long Skill run.

## Not opened

None. All 93 claim-matrix data rows in this band have an inspected section above.

## Checkpoints

- Rows 1–42 were inspected in earlier passes.
- Checkpoint A of this pass: rows 43, 44, 45, 47–50, 53–64 (19). Written before the last 19 were opened.
- Checkpoint B of this pass: rows 67–69, 71–74, 76, 77, 80–83, 85, 86, 88, 89, 91, 92 (19).
- Rows already inspected between those and left unchanged: 46, 51, 52, 65, 66, 70, 75, 78, 79, 84, 87, 90, 93.
- Remaining ids: none.
