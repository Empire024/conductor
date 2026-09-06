# Conductor architecture

## The important boundary

The layout tree never owns a provider process.

```text
SQLite session                         Runtime registries
┌──────────────────────────┐           ┌──────────────────────────┐
│ SplitNode                │           │ terminalId -> node-pty   │
│  ├─ PaneGroup            │ resource  │ agentId    -> provider   │
│  │   ├─ Claude tab ──────┼──────────>│ browserId  -> web view   │
│  │   └─ Codex tab ───────┼──────────>│                          │
│  └─ PaneGroup            │           │ Survives view movement   │
│      └─ Terminal tab ────┼──────────>│ and inactive sessions    │
└──────────────────────────┘           └──────────────────────────┘
```

A drag/drop operation changes only the tree. React may remount an xterm view after a move, but the PTY remains in the main-process registry and the view reattaches by resource ID. The same rule applies to future browser views and editors with live language-service state.

## Processes

### Electron main

- Owns SQLite, filesystem access, dialogs, PTYs, and agent provider adapters.
- Validates file paths against the selected project before any read or write.
- Broadcasts runtime data/status to renderer windows.
- Persists bounded raw transcripts and structured events.

### Preload

- Exposes a small typed `window.conductor` capability surface.
- Keeps Node and Electron APIs out of the renderer.
- Provides unsubscribe functions for every streaming channel.

### Renderer

- Owns only view state and the serializable workspace tree.
- Writes atomic recovery checkpoints after layout changes and synchronously flushes the latest refs on page hide/window close.
- Keeps inactive tabs mounted where useful and safely reattaches remounted xterm views.
- Bundles Monaco and its workers locally; no editor CDN is required.

## Recovery contract

- A recovery checkpoint contains every workspace in the active project plus the active project, active workspace, and focused pane IDs.
- Layout JSON includes split ratios, active tabs, pane resource IDs, browser URLs, maximized pane, and recently closed tabs.
- Monaco drafts live in a separate `editor_drafts` table and are restored as dirty buffers with a visible recovery badge.
- Primary-to-secondary tab movement writes the source layout and secondary-window record in one SQLite transaction.
- SQLite runs in WAL mode. On startup, stale `starting`, `running`, and `waiting_input` runtime rows become `exited`; pending usage-limit continuations remain intact.
- If only the renderer crashes, Electron reloads it from the latest checkpoint and the main-process PTYs remain alive. A full process or machine restart recreates PTYs and replays their bounded transcripts.

## Layout invariants

- Every leaf is a `PaneGroup` with one or more tabs.
- Every `SplitNode` has exactly two children and two percentage sizes.
- Removing the final tab in a branch collapses its parent split.
- Removing the final tab in the entire workspace creates one launcher pane.
- Moving a tab removes it first, collapses the source branch if needed, then docks it at the still-stable target group ID.
- Maximize stores a group ID and renders that leaf; it never mutates the underlying tree.
- Layout templates mint fresh group, split, pane, terminal, and agent IDs when instantiated.

The reducer is kept framework-independent in `layout-operations.ts` and covered by unit tests for split, collapse, group, split-back-out, and template identity behavior.

## Providers

`AgentManager` implements provider descriptors for:

- Codex: `codex`, resume with `codex resume --last`.
- Claude Code: `claude`, resume with `claude --continue`.
- Qwen Code, Kimi Code, and Gemini CLI, with provider-specific discovery, model flags, and install links.

Both run inside ConPTY, preserving their native interactive interfaces. Provider output is simultaneously:

1. sent raw to xterm;
2. appended to a bounded transcript;
3. interpreted by xterm, then reduced from the emulated screen into clean, durable conversation events.

The main process distinguishes PTY liveness from task activity. A provider is marked working only after a Conductor composer submission or an Enter committed in raw CLI mode; unsolicited TUI redraw, cursor paint, and resize output cannot arm activity. Stable output fingerprints suppress repeated spinner/clock repaints. A small provider-aware screen extractor runs after xterm has applied cursor motion and row overwrites, so full-screen CLI chrome never becomes duplicated chat prose. The renderer builds a deduplicated visual timeline over those durable events while retaining the exact PTY transcript behind the Chat/CLI switch.

Provider-specific command construction and future parsers remain in the main-process adapter layer. The pane has no provider branching beyond a provider identifier.

## SQLite today

The local database now stores projects, sessions and layouts, secondary windows, terminal/agent runtime metadata, bounded transcripts, normalized events, layout templates, editor drafts, usage-limit continuations, human-inspired memories, persistent agent profiles, tasks, routines/runs, and structured project-wide collaboration messages/file leases.

## Next vertical slices

1. Git status/diff panes and task-isolated worktree creation.
2. Scheduled routine execution, skills discovery, MCP connection management, and effective permission grants.
3. Chromium console/network capture and Playwright permission gating.
4. Parallel Codex/Claude/Qwen/Kimi worktrees, cross-review, comparison, and selective integration.

The event table is intentionally in the first slice because task timelines, routine recovery, audit history, and inter-agent handoffs all depend on the same append-only record.
