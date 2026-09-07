# Conductor

Conductor is a Windows-first, local orchestration desk for Codex, Claude Code, Qwen Code, Kimi Code, Gemini CLI, PowerShell, browsers, and project files. Runtime processes are persistent resources; tabs are movable views, so reorganizing the desk does not restart an agent or terminal.

![Conductor workspace](artifacts/workspace-smoke-final.png)

## Install or run

Requirements: Windows 10/11, Node.js 22+, Git, and at least one supported coding-agent CLI.

```powershell
cd C:\claude\conductor
npm.cmd install
npm.cmd run dev
```

Build and package the Windows application:

```powershell
npm.cmd run build
npm.cmd run dist:win
```

`release\Conductor-Setup-0.1.3.exe` is a one-click, per-user installer. It creates a desktop shortcut and a Start Menu entry named **Conductor**, so Windows Search can launch it like a normal application. Starting it again focuses the existing main window.

### Publishing updates

Installed builds use GitHub Releases only as their update transport. They check shortly after startup and every two minutes. A highlighted **Update pending** action appears in the bottom bar, and the startup prompt can enable automatic downloads. Downloaded updates install on normal app exit or immediately through **Restart to update**. Every tested push to `main` is automatically assigned the next patch version and published with its installer, blockmap, and `latest.yml`; that release is the definition of done for an agent task. `CONDUCTOR_UPDATE_URL` remains available as a development-only feed override.

Before installing, Conductor asks every window to synchronously checkpoint its layout, saves the normal bounds and maximized state of the main and detached windows, and stops all terminal and agent processes. The silent NSIS installer relaunches Conductor and restores those windows in place.

Conductor discovers `codex`, `claude`, `qwen`, `kimi`, and `gemini` on `PATH`. Override discovery with `CONDUCTOR_CODEX_PATH`, `CONDUCTOR_CLAUDE_PATH`, `CONDUCTOR_QWEN_PATH`, `CONDUCTOR_KIMI_PATH`, or `CONDUCTOR_GEMINI_PATH`. Missing providers show a direct setup link in the app.

## Current vertical slice

- Clicking project `+` immediately creates a usable `Untitled project` under `%USERPROFILE%\Conductor`, selects it, and opens its name inline with the text selected. Naming is optional; collisions receive a numeric suffix. Change the managed root in Settings.
- Move a project, including all files, from its ellipsis/right-click menu; its stable project identity keeps SQLite session state associated after the move.
- Recursive horizontal/vertical splits, persisted ratios, minimum sizes, wide pointer-captured gutters, live feedback, and divider double-click reset.
- Tab groups inside every split. Dragging renders the tab itself, shows only valid docking choices, live-reflows the destination, and animates the final snap.
- Center drop groups tabs; edge drop splits them. Dragging a maximized tab restores the exact prior layout first.
- A tab can become a persistent secondary Conductor window. It retains the same agent/PTY resource and starts with its workspace side panels closed; those panels remain available from the activity rail.
- Header X, tab X, middle-click close, right-click menu at the pointer, and retrieval of recently closed tabs. Pane-level and runtime overflow menus share one soft menu system instead of competing styles.
- `Ctrl+W` closes the focused tab, then an empty workspace; it never closes the whole application. Zero tabs and zero workspaces are valid states.
- Multiple persistent project workspaces, polished workspace pills, named layout templates, and inline rename with double-click or `F2`.
- Real ConPTY-backed PowerShell sessions through `node-pty`.
- Real Codex, Claude Code, Qwen Code, Kimi Code, and Gemini CLI provider adapters with provider-local resume and model flags.
- Each agent tab displays populated model and reasoning-effort selectors. The visual composer remembers Manual, Edit, Plan, or Auto independently for each provider, so a new Codex, Claude, Qwen, Kimi, or Gemini tab starts in that provider's last-used mode.
- Agent tabs default to a rendered coding conversation: user turns, provider responses, commands, tools, changed-file links, questions, artifacts, findings, failures, and completion are presented as a calm work log. A labeled Chat/CLI switch reveals the untouched live provider terminal without restarting the session.
- Every visual agent view has a bottom-anchored composer that submits into the real provider PTY. Switching between Chat and CLI preserves the conversation, scroll position, and unsent draft. Directory-trust prompts become explicit in-app actions instead of leaking numbered terminal-menu text into the conversation; users can trust once or persist auto-trust for that project, then revoke it from the agent menu.
- `Ctrl+C` copies a terminal selection; with no selection it interrupts the provider, without reaching Electron's window shortcuts.
- Workspace-level and per-agent automatic usage-limit continuation. Parsed reset times persist in SQLite and resume after an app restart. Animated clock state is visible on its workspace pill.
- A smooth tab activity indicator transitions from working to completed, waiting, limited, or error state. Waiting-for-input/approval tabs show an animated attention bell, and the owning workspace carries the same badge until the agent resumes.
- The status-bar tab count opens a lightweight, upward performance meter with suite CPU, memory, responsiveness, process totals, and a per-tab UI footprint breakdown.
- Optional in-memory debug logging includes a collapsible console, a detachable debug window, unobstructed UI screenshots with issue descriptions, and a copy-ready local issue report.
- Autosave reports only after SQLite acknowledges the checkpoint; hover shows the exact save time and clicking saves immediately.
- Agent notifications offer Soft chimes, Minimal tones, or Off, with distinct low-volume cues for completion, questions, and required input.
- Memory, Processes, and Automation are left/right-dockable workspace regions, not coding tabs. Automation combines agents, tasks, and routines. These regions consume real layout space rather than covering code, expose a forgiving resize gutter, and remember their chosen width. The process view separates static live/ready runtimes from genuinely active work, waiting input, limits, and finished runs; double-clicking a process focuses or reopens its runtime tab.
- Human-inspired project/agent memory stores distilled episodic, semantic, and procedural gists with cues, salience, confidence, reinforcement, recall counts, and long decay horizons. Raw conversations are not copied into memory.
- A SQLite-backed coworker channel tracks per-file read/edit/create/delete intent across every agent on a project. Agents receive current ownership and recent teammate activity before acting, conflicting writes are surfaced, and leases are released or expire safely.
- Persistent agents, task queues, and linear routines are available in the orchestration dock. Routine steps retain state and unlock in order across restarts.
- Runtime tabs are deliberately limited to agents and PowerShell. Explorer files, Monaco documents, previews, and Browser remain dedicated workspace surfaces instead of becoming disposable chat-style tabs.
- The Explorer activity-bar view replaces the project sidebar when selected. It auto-refreshes, preserves expanded folders, filters files, creates files and folders inline, supports F2 rename, drag/drop and contextual moves, and sends deletions to the Recycle Bin. Text, Markdown, images, PDF, audio, and video open in an editor or purpose-built preview.
- Monaco editing includes save, language detection, and clickable file/line references from agent terminals.
- Browser views use Electron's sandboxed Chromium `webview`, with persistent cookies, native navigation, reload, failure state, DevTools, and a mobile-first responsive frame with one-click phone, tablet, laptop, desktop, custom-size, and rotation controls.
- The Conductor logo opens a familiar File menu for creating/opening projects and workspaces, opening runtime tabs, closing the active workspace, and entering Settings. Removing a project from Conductor deletes only its local orchestration metadata; its folder and files remain untouched.
- Project chevrons exclusively expand/collapse the workspace tree. Clicking the already-active project name is inert, while double-click and `F2` remain dedicated to renaming.
- Night Owl, Obsidian, and Nord themes each have day/night variants. Auto is an independent time-of-day switch, and UI zoom persists.
- Selected text in normal UI, Monaco, and xterm is copied with visible confirmation.
- SQLite-backed projects, workspaces, layouts, secondary windows, PTY metadata, transcripts, memory, continuation timers, and normalized agent events.
- Crash recovery checkpoints preserve the last active project/workspace, focused pane, tab groups, split sizes, selected tabs, browser URLs, closed-tab history, maximize state, and unsaved Monaco drafts. Normal window close flushes synchronously; a renderer crash reloads while main-process runtimes remain attached.

## Interaction map

| Action | Input |
| --- | --- |
| Split right / below | `Ctrl+Alt+Right` / `Ctrl+Alt+Down` |
| Split left / above | `Ctrl+Alt+Left` / `Ctrl+Alt+Up` |
| Command palette | `Ctrl+Shift+P` or `Ctrl+K` |
| Switch workspaces | `Ctrl+1` through `Ctrl+9` |
| Maximize / restore tab area | Double-click its header or `Ctrl+Shift+Enter` |
| Group tabs | Drag a tab to another area's center |
| Split a grouped tab | Drag it to a valid edge |
| Open tab in another window | Drag it outside the window or choose `Open as window` |
| Resize | Drag a divider; double-click to reset 50/50 |
| Close tab | Header X, tab X, middle-click, or `Ctrl+W` |
| Retrieve tab | Right-click a header and choose `Retrieve closed tab` |
| Zoom | `Ctrl++`, `Ctrl+-`, or `Ctrl+0` |
| Save file | `Ctrl+S` in Monaco |

## Persistence limits

Application state lives in `conductor.db` under Electron's per-user Conductor data directory. SQLite uses WAL mode. Terminal/agent transcripts are bounded; distilled memory can grow for years without consuming the model's context window all at once.

Processes stay alive while workspaces are inactive and while tabs move or detach. Windows cannot keep a ConPTY alive after its owning desktop process exits, so a full Conductor restart recreates shells and asks supported provider CLIs to resume their last project-scoped sessions.

Session/layout changes are committed to SQLite within roughly 100 ms and flushed synchronously when a window closes or becomes hidden. Monaco keeps a separate draft journal, so unsaved text is restored and explicitly labeled after a forced stop. SQLite WAL transactions prevent partially written layout trees; runtimes left active by a machine crash are reconciled as exited before the dashboard appears.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The UI smoke harness connects to an isolated Electron debug profile and exercises managed project creation, four-pane setup, conditional docking, live reflow, snap animation, grouped/split tabs, maximize-on-drag restore, Ctrl+C safety, Monaco, Markdown preview, the Chromium shell, workspace rename, middle-click close, closed-tab retrieval, gutter resizing, zoom, theme switching, continuation state/animation, Memory/Processes docks on both sides, secondary windows without duplicated runtimes, `Ctrl+W`, and the zero-workspace state.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for process boundaries and the subsystem roadmap.
