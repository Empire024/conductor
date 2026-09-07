# Feature-list delivery

Recorded 2026-09-07. All items in `feature-list.md`, plus Ctrl+E and the download-loader request, are implemented and validated. The source version stays unchanged; pushing this tested state to main lets the release workflow choose the next patch. Publication must be verified after the push.

## Behavior

- Automatic selection copying is confined to terminals. Chat and editors retain ordinary selection and explicit copy controls.
- Conversation spacing is compact, long prose wraps, and wide code stays within its own horizontal scroll area. Editors have a persistent word-wrap toggle and Alt+Z. The composer has a subtle focus border and a compact send control.
- Escape stops the focused active conversation. Send becomes Stop when the running composer is empty, or Queue when a follow-up is typed; interrupted conversations show Resume. Queued text, settings and attachments are journaled, dispatched once after completion, retained through interruption/restart, and recoverable into the draft.
- Chat/CLI transfers ownership of the exact native conversation: Codex uses `resume <native-id>` and Claude uses `--resume <native-id>` (or one reserved UUID for a new conversation). Processes are stopped before ownership changes. CLI history is reconciled on return to Chat. Active work and queued messages must be resolved before switching; Codex Plan mode must be turned off first.
- Modals dismiss on an outside click. Repeated menu triggers toggle closed. Attach opens and focuses searchable file suggestions, then returns focus to the composer.
- Explorer shows every loaded project, with other roots initially collapsed. Root chevrons work; project rename appears in the root heading and dismisses when focus leaves. Projects and workspaces can be dragged into a persisted order; workspaces have sidebar close buttons.
- Right-clicking the day/night control opens the theme menu. Provider/model controls show the actual provider marks; icon attribution and the MIT license are included with packaged resources. Active status rotates through Thinking, Spelunking, Working and Considering.
- Files have persistent tabs, dirty dots, editor/preview/browser modes, new-file creation, close buttons, middle-click closing and Ctrl+W within the file editor. Browser mode has a globe cue. Agent file links and tool/change file controls support click for editor, Ctrl-click for embedded browser, and Ctrl+Shift-click for external browser.
- Ctrl+E searches every registered loaded project without changing the active workspace, including detached windows, focused browser guests, and a project with no open workspace. Search skips dependency/build folders and links, caps traversal at 50,000 files / 10,000 directories per project and shows up to 100 matches. File mutations invalidate its short-lived cache.
- Save / Don't Save / Cancel protects dirty editors when closing a file, workspace, project, window or the app, including updater restarts. Drafts survive inactive workspaces and folder moves. Cancel leaves a downloaded update ready for a later restart.
- Version controls in the main and detached windows check for updates, show the last-check tooltip and confirm an up-to-date version. Downloads show thin determinate progress, or a calm indeterminate indicator until a real percentage arrives. Startup checks, periodic installed-window discovery and optional automatic downloads remain in the existing updater flow.

## Validation

- `npm.cmd test`: 45 Vitest files / 291 tests and 13 Node tests passed (304 total). Coverage includes queue persistence/dispatch, exact CLI identities, Claude native-history reconciliation, project ordering, editor-draft remapping, preview path isolation and cancelling an update restart.
- `npm.cmd run build`: TypeScript and production main/preload/renderer bundles passed.
- `node scripts/smoke-backlog.mjs`: 20 actual Electron check groups passed, using the production UI, IPC, SQLite, Monaco, browser guests and a synthetic PTY. [Results](evidence/backlog/results.json).
- `node scripts/smoke-composer-drafts.mjs` and its `--provider=claude` variant: eight groups each passed, including detached Ctrl+E, exact drafts, restart recovery and controlled acknowledgement races. [Codex](evidence/composer-drafts/codex.json), [Claude](evidence/composer-drafts/claude.json).
- The [download dialog](evidence/backlog/downloading-update.png) was captured from Electron after paint and visually inspected.

Native provider inference was not run and no live allowance was reset. Provider traffic used offline protocol fixtures; the native CLI pane used an actual Windows PTY with a Node echo fixture. External-browser launching and native save-dialog decisions were intercepted in that isolated app; destination URLs and exact disk bytes were asserted. Native clipboard access is unavailable on the isolated desktop, so terminal-only automatic copying was source-audited rather than reported as a native clipboard pass.

Monaco 0.52.2 can reject its pending word-highlighter delay with `Canceled` when an editor closes. The smoke record retains that exact dependency teardown stack separately and fails for every other renderer exception. No global application error suppression was added.

The broader native-extension parity work and future roadmap in the existing handoffs are separate from this feature list. Their earlier live-validation limits still apply.
