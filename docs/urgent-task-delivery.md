# Urgent tasks delivery - 2026-09-08

The five items from the temporary urgent-tasks.md handoff are preserved in feature-list.md, including original evidence and acceptance criteria. They retain stable task IDs and the owning conversation marker. The temporary file was removed only after the real Project tasks API and installed panel displayed the migration.

## Runtime failure

The Codex sandbox setup log reported Windows error 5 from SetNamedSecurityInfoW while refreshing the workspace write rule and the protected .git rule. The workspace root and .git directory were owned by CodexSandboxOffline; the owner's inherited Modify rights did not permit rewriting their security descriptors. A repair limited to ownership of those two directories restored normal sandboxed shell startup without changing their DACLs or Codex's configured sandbox mode.

Existing descendants also lacked the native per-workspace capability rule. Automatic approval review rejected the persistent inheritance refresh pending explicit owner authorization. No inheritance repair has run. The prepared script validates workspace boundaries and junction targets and preserves existing owners, explicit permissions and protected ACLs. The runtime task remains open until ordinary writes in existing src/scripts/artifacts folders work and protected metadata writes remain denied. See codex-windows-sandbox-repair.md for diagnosis and repair evidence.

## Live coworker visibility

The installed API was reachable once command execution was available: tools.list, app.state, agents.list, agents.snapshot and agents.history returned native state. Claude was observed running in Workspace 1, agent_mtspoduk_c88in1p, tab pane_mtspoduk_0df6pg1. This was an actual API observation, distinct from its injected briefing.

Inspection responses now identify their observation time, project/workspace/tab, latest event time and native phase. Snapshots retain active tools and recently updated results even when a tool began more than 60 items ago. Briefings identify lease heartbeat/expiry and message timestamps and explicitly describe older intent messages as recorded coordination. Existing control authority and workspace restrictions are preserved.

## Project tasks

The handoff was migrated through files.read/files.write using an exact expected-content comparison. tasks.list returned each of the five unique markers, and tasks.update changed the migration task title while retaining its claim. An installed-app screenshot verified all five cards and their owner/status in the Project tasks panel. Original unrelated tasks and Claude's claims were preserved.

The coordinated Project tasks upgrade adds task history, source-control review, idea cards and author provenance. Equal task base/head commits now show an empty change range instead of an unrelated previous commit. Two real temporary-repository tests cover both equal and distinct commit boundaries.

## Claude permissions

Permission requests expose distinct Allow for this session and Switch to auto-mode choices alongside Allow once, Deny and Cancel turn. Reusable grants use native tool-specific session rules or Claude's offered session-only acceptEdits scope. The displayed scope makes the broader edit grant explicit. That temporary Edit mode expires when the runtime changes, including resume, app restart and CLI handoff, restoring the previous permission mode. Requests without a safe reusable scope explain why session approval is unavailable. Mandatory approvals remain effective.

Switching to Auto waits for the native provider acknowledgement before updating the session/composer mode and resolving the current request. A definite provider refusal keeps the approval available for another decision. Transport uncertainty never triggers an automatic duplicate answer. Cancellation during mode switching does not resurrect an expired request, and native error echoes preserve denial/cancellation outcomes.

## Follow-up task reports and assignment

The owner reported that 0.1.18 could neither add nor edit a report containing line breaks. The task form was a textarea, while the backend rejected every carriage return and newline. Reports now round-trip paragraphs, lists and headings through marked Markdown continuation lines. Status changes, renames and removal preserve the task identity, claim and adjacent content. The form uses Enter for a newline and Ctrl/Command+Enter to save, including an IME composition guard.

The owner's revised steering report is recorded under its original task marker, and the selection/assignment request is tracked separately. Task circles select items without completing them. Completion uses the existing status selector. Selected tasks can go to an open conversation, a new agent with chosen model and effort, or a visible Auto Fixer that chooses suitable models and efforts and delegates to visible coworker tabs.

Steering remains visibly pending until the native provider confirms consumption at the next tool boundary. Escape interrupts and expedites confirmed unconsumed steering; Stop retains it for recovery. Explicit Queue actions wait for the next turn, and neither action submits an unsent composer draft. Five Electron steering checks passed, including reload persistence and exact-once delivery.

## Verification and delivery

The isolated release snapshot, excluding the unrelated memory experiment, passed 532 Vitest tests across 65 files and 26 Node tests (558 total), plus npm.cmd run build. Seven Electron permission checks cover session scope, repeated grants, temporary-mode expiry, synchronized panes, native refusal and mandatory approvals. Six Electron app-control checks cover scoped native control, detached identity, file refresh/conflicts and owner release.

A separately guarded real Claude acceptance run verified a native session-approved Write could repeat without another prompt, Auto changed the actual and visible mode, mandatory Bash approvals persisted, Deny blocked its command, and Allow once executed its command. The fixture's settings remained unchanged and only its intended proof file was created. Both charged attempts are retained in the local evidence, with two submitted prompts and $0.2447334 reported aggregate provider cost; no further live attempt is authorized by that guard.

Nine Electron task-dispatch checks cover the exact multi-line report, edits, selection, stale revisions, existing/new agent targets, real scoped Auto delegation and uncertain outcomes. Seven task-image checks per provider preserve image context and legacy Markdown; six autoscroll checks ensure cancelling scroll cannot activate the underlying task or permission action. Task handoff history records the actual acting agent separately from its assignee.

All 26 backlog Electron checks passed. The backlog smoke fixture now selects a model actually returned by its runtime catalog and exercises supported steering/queue behavior. Its update-button hover check also identified and corrected insufficient Nord day contrast.

Unrelated pre-existing memory experiments and session artifacts remain outside the release commit. Routine version selection and release tagging belong to the GitHub workflow. Delivery requires the commit-specific release workflow to succeed and publish the installer, blockmap and latest.yml; release discovery is then checked against the real GitHub provider without downloading or installing an update.
