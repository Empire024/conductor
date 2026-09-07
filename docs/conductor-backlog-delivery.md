# Feature-list delivery

Recorded 2026-09-07. The original bug items 1?12 and feature items 0?11 are implemented and validated. The follow-up delivery for bugs 13?17 is recorded below; later backlog additions remain pending. The source version stays unchanged; pushing this tested state to main lets the release workflow choose the next patch. Publication must be verified after the push.

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

## Bug items 13?17 ? 2026-09-07

- **13:** Ctrl+E starts its initial search immediately, retains arrow presses received while results load, scrolls the selected file into view, and prevents a stationary pointer from resetting keyboard selection. Enter opens the selected file while search retains focus.
- **14:** Codex and Claude retain the selected model's effort metadata. The control disappears for models without effort; changing models clears an incompatible setting. Claude's default alias remains supported, and Codex no longer carries another model's default effort into a model without reasoning. Claude metadata fields follow the [official ModelInfo contract](https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo).
- **15:** A native Codex metadata probe reproduced `list_turns is not supported yet` on a fresh paginated conversation. Saving its existing Conductor title materializes that exact thread before handoff. Native CLI arguments omit inherited/default placeholder values and preserve approval policies via config. A PTY startup failure releases CLI ownership and restores Chat for recovery.
- **16:** The Browser footer button toggles its sidebar open, closed and open again. Explicit Open Browser commands still open it.
- **17:** Add agent uses 8px uppercase type and a smaller plus icon. Its selector now takes precedence over the hub's inherited button font rule.

Validation for this delivery: `npm.cmd test` passed 299 Vitest tests plus 13 Node tests (312 total); `npm.cmd run build` passed. The production Electron backlog smoke passed 24 check groups, including all five fixes. [Results](evidence/backlog-13-17/results.json). [Add agent screenshot](evidence/backlog-13-17/add-agent.png) was visually inspected.

Both installed native CLIs also passed an isolated empty-conversation Chat ? CLI ? Chat check with the same native ID and zero user prompts or inference submissions: [Codex](evidence/backlog-13-17/native-codex.json), [Claude](evidence/backlog-13-17/native-claude.json). The offline fixture now reproduces Codex's unmaterialized-history error and persists metadata across its process restart. No live allowance was reset. Release publication is verified after pushing the tested commit to main.
