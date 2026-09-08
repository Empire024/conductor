# Remaining feature-list delivery ? 2026-09-08

This delivery covers all unfinished items present in feature-list.md: bugs 34?45, 47, 49, 51 and features 15?18. Existing completed entries and their descriptions are preserved.

## Changes

| Items | Result |
| --- | --- |
| 34 | History opens as a labeled preview, with Back and explicit Resume. Reconnection completes before sending is enabled; the active native conversation follows its tab. |
| 35?36 | Mode icons occupy fixed space. Every new conversation selects a concrete model; reported native Claude identity and effort resolve its model alias. Usage details identify the conversation model. |
| 37 | Hidden/configuration files are grouped and visually distinguished in Explorer. |
| 38 | File attachment autocomplete overlays the conversation, retains layout, and commits the latest query result with Enter. |
| 39 | Focus remains visible in the composer without an accent outline around the entire pane. |
| 40?41 | Agent delegation uses visible native tabs and normal messages, requests, approvals and output. Persistent controller relationships draw cables between visible headers and provide exact links and a disconnect control across detached windows. |
| 42 | Claude text IDs use visible text-block ordinals, so omitted thinking blocks cannot duplicate the streamed/final reply. A conservative repair removes the corresponding historical duplicate stream rows. Intentionally repeated blocks remain intact. |
| 43, 49 | Streaming follows the bottom without displacing a reader. New questions reveal their beginning. Enter submits complete answers; Shift+Enter retains multiline input and IME composition is respected. |
| 44 | Project removal uses a readable confirmation dialog. Removing registration preserves the files on disk. |
| 45 | Token counts interpolate between actual reports, reset per response, respect reduced motion, and never extrapolate usage. |
| 47 | Active/inactive tab and workspace headers have hover feedback. Day/night controls and palette changes transition together and respect reduced motion. |
| 51 | Background tasks expose their reported output file and a bounded 32 KB tail. Scope, file type and missing-file errors are checked; the roster no longer describes shell tasks as zero child activity. |
| Feature 15 | Chat slash commands offer keyboard autocomplete for native discovered commands and explicit Conductor actions. |
| Feature 16 | Workspace sidebar lists tabs and shares the same tab actions. Show tab opens an always-on-top floating window and returns it to the workspace when closed. |
| Features 17?18 | A first-party, scoped local control protocol exposes app state, tabs, native sessions, files, model catalog, memory, checklist and orchestration. A router uses the existing agent/routine/task store. File writes compare disk versions; external atomic edits refresh clean editors and preserve dirty drafts with a conflict notice. |

## Validation

The integrated delivery passed **457 Vitest tests across 61 files and 13 Node tests (470 total)** and the production build. It also passed **28 Electron acceptance groups**: 9 composer (6 Codex, 3 Claude), 7 navigation, 6 telemetry, and 6 Claude-to-Codex control/live-file checks. Commands:

- npm.cmd test
- npm.cmd run build
- node scripts/smoke-composer-backlog.mjs (Codex and --provider=claude)
- node scripts/smoke-navigation.mjs
- node scripts/smoke-telemetry.mjs
- node scripts/smoke-agent-control.mjs

Provider inference is replaced by offline protocol fixtures. The real Electron renderer, preload, IPC, SQLite, HTTP control broker, native adapter/controller path, Monaco and filesystem watchers are exercised. Screenshots are visually inspected. No usage allowance is reset.

Unrelated memory-retrieval experiments remain in the shared working tree. Only the source-provenance helper required by agent-authored memory is included with this delivery; the release snapshot is tested separately before committing. Package version and release tags remain controlled by the existing release workflow.

Protocol signatures, authorization and router details: [agent control](agent-control.md).
