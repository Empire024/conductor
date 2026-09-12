Go through feature-list.md and implement everything.

[Attached file: feature-list.md] Bug list:

[Implemented] Double clicking to copy will only work inside terminals.

[Implemented] Bug with long text going over parts of UI like scrollbar & cursor position

[Implemented] Add button to easily toggle breaking of words inside editors based on current tab/window size

[Implemented] Selecting 'Message codex' shows a nasty outline around the boxy textbox.

[Implemented] Stopping needs to be possible via hitting ESC. The stop and resume icons should replace the send icon unless another message is being queued.

[Implemented] Bring back CLI switcher

[Implemented] Clicking outside of modals needs to close them. Clicking on the same icon that opens dropdown needs to close that dropdown (such as ... icon)

[Implemented] Clicking attach content should automatically open the textbox that should have autocomplete capabilities

[Implemented] a - In explorer, clicking on down arrow on project name does nothing - should open/close it. Double clicking it opens a rename menu, which should go away when clicking away, and should be where the conductor title is, not where it's currently mispossitioned.

[Implemented] b - Explorer needs to also show other projects files currently loaded in session (but closed by default)

[Implemented] Projects need to be able to be ordered (dragged) around in the view vertically

[Implemented] Going from one project to another removes what we had written in our Message Codex textbox - fix

[Implemented] Workspaces need to be able to be closed from the left menu as well as dragged and ordered like projects.

[Implemented] CTRL+E arrow keys don't work properly, they should be able to immidiately list through list of files.

[Implemented] For models that don't have Effort, don't even display it

[Implemented] Trying to change into CLI view shows error

[Implemented] Clicking Browser then clicking it again should close it.

[Implemented] I dislike the '+ Add agent' button design still, text is too large compared to all other parts of the theme, make it uppercase and smaller font style at least.. fix also 18 and 19

'Attached file' text is for some reason a part of the visible prompt.. full text of file.

Multiple messages need to be possible to be queued. Also, queuing messages seems to be broken currentrly.. Also never show just 'default' always show which model we're running - I wanna see literallly GPT 6 Astra xhigh if that's what i'm running. No random auto letting me know nothing..

Codex seems nice, but Claude repats messages, asks for permissions even when granted already during session in Conversation settings..

Bring back the 'Auto / Plan / Edit etc' modes selector for models that support it -> move it from conversation settings to the actual chatbox bottom bar

even though im scrolled all the way to the bottom, i have to click 'new messages' to see the latest messages.

the tab name plus chat/cli & stop + conversation settings bar takes up too much vertical space. minify while keeping design super clean and UX friendly.

'Inspect exact request and scope' is annoying, it can be there maybe as a little link somewhere or icon, but not first thing we see.. Also, beautify the 'Claude needs your input' part, currently it's ugly checkboxes.

Visual line between tab windows seems useless, just takes up space, keep resize functionality while removing visual bar.

Stopping during use shows ugly '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use' message.

Huge bug -> auto-saving files when closing can over-write with old file somehow, at least it happened to me..

Feature list:

[Implemented] Beautify the 'send' button.

[Implemented] Right clicking night/day will open simple dropdown where you can choose the theme also.

[Implemented] Files that are currently open in the browser should have some sort of visual cue of that.

[Implemented] version number in bottom right corner should be clickable to try to update (hover will tooltip Check for updates (last checked xxx)) and show a (Check) Latest version already installed if the run comes back as latest.

[Implemented] To open files, make sure we visually see whether we've made changes or not, and if we try to close the Conductor, ask to save the files or close or cancel.

[Implemented] Show actual model logos to really differentiate between them

[Implemented] Add Spelunking, and all the other words instead of just 'Working'.

[Implemented] For files we get from agents, click is open in text, ctrl click is open in browser, ctrl shift click is open in external browser

[Implemented] Add 'tabs' to files as well i.e. make it easy to create another file from tab view also and close it the same way as other tabs.

[Implemented] Reduce spacing between messages in the Codex view to use space more efficiently while keeping the conversation easy to read.

[Implemented] Ctrl+E opens a searchable file picker across all projects loaded in Conductor, including detached windows and when no workspace is open.

[Implemented] Replace the downloading-update loader with a calm, thin progress indicator and readable status.

We need a way to see subagents -> How many are called, whats their status, etc.

We need to see how many tokens Working & Spelunking is taking up in real time, also add available usage breakdown findable in each tab under View usage text link

Implementation and validation: backlog delivery record.

I’ll check the list against the current code, implement what’s missing, then test, build, and publish through the app’s update channel. I’ll give the file overwrite report extra attention because it risks losing work.


PowerShell
Run Get-Location; git status --short; rg --files -g AGENTS.md -g feature-list.md -g package.json -g '*backlog*' -g
completed

PowerShell
Run Get-Content AGENTS.md; Get-Content package.json; Get-Content feature-list.md; Get-Content docs/conductor-backl
completed

PowerShell
Run rg --files src scripts .github; git diff --stat; git log -6 --oneline
completed
/root/editor_safety
running

PowerShell
Run Get-Content AGENTS.md; rg -n "saveFile|writeFile|onClose|closeEditor|auto.?save" src
completed
/root/provider_reliability
running

PowerShell
Run Get-Content AGENTS.md; rg --files src/main/providers; rg --files src/main | rg 'structured|session'; Get-Conte
completed
/root/usage_subagents
running

PowerShell
Run Get-Content src/renderer/src/panes/EditorPane.tsx; Get-Content src/renderer/src/lib/editor-drafts.ts; Get-Cont
completed

PowerShell
Run rg -n "file:|files:|draft|readFile|writeFile" src/preload/index.ts src/shared/types.ts src/main/index.ts src/r
completed

PowerShell
Run Get-Content AGENTS.md; rg --files src | Select-Object -First 120
failed

PowerShell
Read structured-sessions.ts
completed

PowerShell
Read claude.ts
completed

PowerShell
Run rg -n 'userMessage|tokenUsage|subagent|agentTool|model|default|attachment|queue|diagnostic' src/main/providers
failed

PowerShell
Run rg --files src/renderer/src src/shared scripts -g '"'!assets/**'"'; rg -n 'Inspect exact|needs your input|New
completed

PowerShell
Run Get-Content .github/workflows/release.yml; Get-Content scripts/smoke-backlog.mjs -TotalCount 180; git diff --
completed

PowerShell
Run Get-Content src/renderer/src/panes/StructuredUsageDetails.tsx; Get-Content src/renderer/src/panes/StructuredUs
completed

PowerShell
Run Get-Content src/renderer/src/panes/FilePane.tsx; rg -n \"EditorDraft|files:|checkpointDraft|flushDraft|write\\
completed

PowerShell
Run '$lines = Get-Content src/main/index.ts; $lines[350..425]; $lines[765..780]; $lines[895..930]; rg -n "files'"\
completed

PowerShell
Run Get-Content src/main/providers/claude.ts -TotalCount 260
completed

PowerShell
Run Get-Content src/shared/structured-agent.ts; Get-Content src/main/structured-sessions.ts | Select-Object -Skip
completed

PowerShell
Run Get-Content src/main/providers/claude.ts | Select-Object -Skip 260 -First 245
completed
The delivery record covers the items marked implemented; bugs 18–27 and features 12–13 are still pending. I’ve split the work across file-save safety, provider reliability, and usage/subagent visibility while I handle the chat controls and layout. There are also existing memory-system edits in the working tree, which I’ll preserve.


PowerShell
Run Get-Content src/renderer/src/panes/StructuredAgentPane.tsx -TotalCount 260; Get-Content src/renderer/src/panes
completed

PowerShell
Run Get-Content src/shared/structured-agent-reducer.ts; Get-Content src/renderer/src/panes/StructuredAgentPane.tsx
completed
/root
running

PowerShell
Run Get-Content src/shared/structured-agent.ts -TotalCount 160; Get-Content src/main/providers/claude.ts | Select-
completed

PowerShell
Run Get-Content src/renderer/src/panes/StructuredAgentPane.tsx | Select-Object -Skip 260; Get-Content src/renderer
completed

PowerShell
Run Get-Content src/renderer/src/panes/CodePane.tsx; $lines = Get-Content src/shared/ipc.ts; $lines[80..130]; $lin
completed

PowerShell
Run Get-Content src/main/database.test.ts; Get-Content vitest.config.ts; $lines=Get-Content src/renderer/src/layou
completed
/root/provider_reliability
running
/root/editor_safety
running
/root
running
/root/provider_reliability
running
/root
running
/root/usage_subagents
running
/root/usage_subagents
running

PowerShell
Run Get-Content src/main/providers/claude.test.ts -TotalCount 170; Get-Content src/main/providers/claude-transport
completed

PowerShell
Run Get-Content src/renderer/src/panes/StructuredAgentPane.css; Get-Content src/renderer/src/backlog.css; rg -n 's
failed
/root/provider_reliability
running

PowerShell
Run $lines=Get-Content src/main/database.ts; $lines[140..220]; $lines[432..482]; Get-Content src/main/database.tes
completed

PowerShell
Run Get-Content src/renderer/src/components/WorkspaceFiles.tsx; rg -n "editor|code-error|code-toolbar|code-recover
completed

PowerShell
Run rg -n 'permissionSuggestions|updatedPermissions|acceptEdits|ede_diagnostic|stream_event' docs scripts src/main
completed

PowerShell
Run rg -n 'effectiveSettings|defaultReasoningEffort|models:' src/main/providers -g '*.ts' -g '"'!generated/**'"' -
completed

PowerShell
Run rg -n 'turnId|emit\\(' src/main/providers/claude.ts | Select-Object -First 65; Get-Content src/renderer/src/pa
completed

File change
C:\Claude\conductor\src\renderer\src\panes\conversation-scroll.ts
completed

C:\Claude\conductor\src\renderer\src\panes\conversation-scroll.ts
applied
/** Ignore selections in editors and other panes when following this conversation. */
export function hasTimelineSelection(element: HTMLElement | null, selection: Selection | null): boolean {
  return Boolean(element && selection?.toString() && (element.contains(selection.anchorNode) || element.contains(selection.focusNode)))
}

export function isAtConversationBottom(element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80
}

Click to expand diff
/root/provider_reliability
running
/root
running
/root/provider_reliability
running

PowerShell
Run & 'C:\\Users\\stilj\\.local\\bin\\claude.exe' --help | Select-String -Pattern 'permission-mode|permission-prom
failed

PowerShell
Run Get-Content src/renderer/src/panes/StructuredAgentRenderers.tsx -TotalCount 45; Get-Content src/shared/ipc.ts
completed
/root
running
/root/editor_safety
running
/root/provider_reliability
running
I found two direct causes of the reported behavior: the queue has only one slot, and the chat can remain in a paused reading state after scrolling back to the bottom. The save investigation also found that closing a clean editor can checkpoint old text and later mistake it for an edit. I’m fixing those paths and adding regression checks.


PowerShell
Run @'
completed

PowerShell
Run @'
completed

PowerShell
Run @'
completed

PowerShell
Run @'
completed

PowerShell
Run Get-Content src/renderer/src/agent-models.ts -TotalCount 100; Get-Content src/renderer/src/panes/StructuredAge
completed

PowerShell
Run Get-Content src/main/providers/claude.test.ts | Select-Object -Skip 165 -First 70; rg -n 'usage|tokenUsage|sub
completed

PowerShell
Run @'
completed
/root
running

PowerShell
Run @'
completed

PowerShell
Run @'
completed

PowerShell
Run Get-Content src/renderer/src/panes/StructuredAgentRenderers.test.ts | Select-Object -First 40; rg -n 'function
completed

PowerShell
Run @'
completed
/root
running

PowerShell
Run rg -n "cancel-queued|cancelQueued" src/main/index.ts src/preload/index.ts; rg -n "flush-editors|resolveUnsaved
completed

PowerShell
Run @'
completed
/root/provider_reliability
running

PowerShell
Run @'
completed

PowerShell
Run npx.cmd vitest run src/renderer/src/panes/usage-summary.test.ts src/renderer/src/panes/StructuredUsageDetails.
completed

PowerShell
Run npm.cmd run typecheck
failed

PowerShell
Run @'
completed

PowerShell
Run @'
completed
/root
running

PowerShell
Run npm.cmd exec vitest run src/main/providers/claude.test.ts src/main/providers/codex.test.ts src/main/structured
failed

PowerShell
Run rg -n 'permission-mode|acceptEdits|settings.permission' src/main --glob '"'!providers/generated/**'"'; npm.cmd
failed
/root/provider_reliability
running

PowerShell
Run Get-Content src/renderer/src/panes/StructuredAgentRenderers.tsx | Select-Object -Skip 104 -First 45; rg -n 'sa
completed
/root/provider_reliability
running

PowerShell
Run @'
completed
/root/usage_subagents
running

PowerShell
Run '$telemetryPath = '"'src/renderer/src/panes/StructuredAgentTelemetry.tsx'
completed
/root
running
/root/usage_subagents
running

PowerShell
Run Get-Content src/main/native-cli-manager.test.ts -TotalCount 100; Get-Content src/main/structured-sessions.test
completed

PowerShell
Run git status --short; Get-Content .gitignore; Get-Content src/renderer/src/panes/usage-summary.ts -TotalCount 20
completed

PowerShell
Run rg -n 'delay|queue|flood|long|question|SYNTHETIC|stop|waiting' scripts/fixtures/fake-codex.mjs scripts/fixture
completed

PowerShell
Run rg -n 'OFFLINE|synthetic|fixture' src/main/structured-sessions.ts scripts/smoke-structured-agents.mjs scripts/
completed

PowerShell
Run Get-Content scripts/fixtures/codex-app-server.mjs; Get-Content scripts/fixtures/claude-runtime.mjs | Select-Ob
failed
/root/provider_reliability
running

PowerShell
Run @'
completed

PowerShell
Run npx.cmd vitest run src/renderer/src/panes/StructuredComposerControls.test.ts src/renderer/src/panes/Structured
failed

PowerShell
Run @'
completed

PowerShell
Run @'
completed

PowerShell
Run $fixturePath = '"'scripts/fixtures/codex-app-server.mjs'
completed
The composer now has supported modes, resolved model and effort labels, and multiple queue entries. I’ve also reduced the header height and moved request details below the answer choices. The focused renderer tests pass. For the full build, I’m preparing a checkout that excludes the unrelated memory edits, which currently have type errors.


PowerShell
Run git worktree add --detach .smoke-backlog-delivery HEAD
completed

PowerShell
Run git diff -- src/shared/models.ts src/main/database.ts; Get-Content src/main/providers/claude.ts | Select-Objec
completed

PowerShell
Run npm.cmd run typecheck
failed

PowerShell
Run rg -n "invalidateProjectFiles|save-copy|read-for-editor|cancel-queued|flush-draft" src/main/index.ts; git diff
completed
/root
running

PowerShell
Run @'
completed

PowerShell
Run @'
completed

PowerShell
Run npm.cmd run build
completed

PowerShell
Run @'
completed
/root/editor_safety
running
/root
running
/root/usage_subagents
running

PowerShell
Run Get-Content scripts/smoke-telemetry.mjs -TotalCount 200; Get-Content src/renderer/src/panes/StructuredAgentTel
completed

PowerShell
Run git diff -- src/renderer/src/panes/StructuredUsageDetails.test.ts; Get-Content src/main/providers/generated/co
completed
/root/usage_subagents
running
/root/editor_safety
running

PowerShell
Run Copy-Item -LiteralPath scripts/smoke-telemetry.mjs -Destination .smoke-backlog-delivery/scripts/smoke-telemetr
failed

PowerShell
Run node scripts/smoke-backlog.mjs
completed

PowerShell
Run @'
completed

PowerShell
Run Copy-Item -LiteralPath C:/Claude/conductor/scripts/smoke-telemetry.mjs -Destination C:/Claude/conductor/.smoke
completed

PowerShell
Run Get-Content src/main/structured-sessions.ts | Select-Object -Skip 70 -First 230; git diff --stat
completed

PowerShell
Run npm.cmd exec vitest run src/main/providers/claude.test.ts src/main/structured-sessions.test.ts src/shared/stru
completed

PowerShell
Run Get-Content scripts/smoke-backlog.mjs | Select-Object -Skip 176 -First 70; Get-Content scripts/fixtures/codex-
completed

PowerShell
Run git diff --stat -- src/main/providers src/main/structured-sessions.ts src/shared/structured-agent.ts src/share
completed

PowerShell
Run [Convert]::ToBase64String([System.IO.File]::ReadAllBytes('C:\\Claude\\conductor\\.smoke-backlog-delivery\\arti
completed

PowerShell
Run @'
completed

PowerShell
Run [Convert]::ToBase64String([System.IO.File]::ReadAllBytes('C:\\Claude\\conductor\\.smoke-backlog-delivery\\arti
completed

PowerShell
Run [Convert]::ToBase64String([System.IO.File]::ReadAllBytes('C:\\Claude\\conductor\\.smoke-backlog-delivery\\arti
completed
/root/provider_reliability
running

PowerShell
Run npx.cmd vitest run src/main/editor-files.test.ts src/main/editor-drafts.test.ts src/renderer/src/panes/editor-
completed

PowerShell
Run Get-Content scripts/smoke-backlog.mjs -TotalCount 50; Get-Content .smoke-backlog-delivery/src/renderer/src/pan
completed

PowerShell
Run $lines=Get-Content scripts/smoke-ui.mjs; $lines[128..133]; $lines[191..197]; rg -n "--panel" src/renderer/src/
completed
/root
running

PowerShell
Run Get-Content scripts/fixtures/codex-app-server.mjs | Select-Object -Skip 154 -First 82; Get-Content scripts/smo
completed
The production Electron checks passed for live token updates, subagent status changes, usage details, and both scroll cases: following new output at the bottom and resuming it after scrolling back down. The existing 24-group backlog smoke also passed. Visual review caught one more “default” label in the outer tab header; I’m fixing it too.

/root
running

PowerShell
Run $telemetryFiles = @('"'src/renderer/src/panes/StructuredUsageDetails.tsx', 'src/renderer/src/panes/StructuredU
completed

PowerShell
Run @'
completed

PowerShell
Run Get-Content src/renderer/src/layout/PaneWorkspace.tsx | Select-Object -Skip 270 -First 48; Get-Content src/ren
completed
/root
running

PowerShell
Run @'
completed
Implemented subagent roster/counts, live reported tokens, and per-tab View usage with reasoning, cache, context, cost, and account limits.

Validation: 19 targeted tests and six production Electron smoke checks passed. Three screenshots inspected and saved under artifacts/backlog-followup.

Also verified bottom scrolling follows new messages and resumes automatically when returning to the bottom. Outer tab header still showed default; flagged for root integration. No commits made.

/root/usage_subagents
completed
/root/usage_subagents
running
/root
running

PowerShell
Run rg -n -i "default|auto|model|effort" src/renderer/src/panes/NativeCliPane.tsx src/renderer/src/panes/RuntimeTe
completed

PowerShell
Run Get-Content src/main/providers/claude.ts | Select-Object -Skip 410 -First 34; Get-Content src/main/providers/c
completed

PowerShell
Run Get-Content src/main/structured-sessions.test.ts | Select-Object -Skip 328 -First 125; Get-Content src/main/pr
completed
/root/provider_reliability
running

PowerShell
Run @'
completed

PowerShell
Run Get-Content src/renderer/src/panes/RuntimeTerminal.tsx | Select-Object -Skip 105 -First 55; Get-Content src/re
completed

PowerShell
Run [Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\\Claude\\conductor\\artifacts\\backlog-followup\\telemet
completed

PowerShell
Run Get-Content scripts/fixtures/fake-claude.mjs -TotalCount 63; Get-Content src/main/providers/claude.ts | Select
failed

PowerShell
Run Get-Content src/renderer/src/panes/RuntimeTerminal.tsx | Select-Object -First 106; rg -n '\\{model\\}|props.mo
failed

PowerShell
Run @'
completed
/root/provider_reliability
running

PowerShell
Run rg -n -i 'default|model|effort' src/renderer/src/panes/ProcessDashboardPane.tsx src/renderer/src/components/Or
completed

PowerShell
Run @'
failed
/root
running

PowerShell
Run @'
completed

PowerShell
Run rg -n "app.evaluate.*(readFile|writeFile|require)|node:fs/promises|globalThis.__.*fs" scripts | Select-Object
completed

PowerShell
Run @'
completed

PowerShell
Run @'
completed

PowerShell
Run node scripts/smoke-editor-safety.mjs
running
