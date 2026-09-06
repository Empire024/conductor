# Version 0.1.3

## Tab performance popover

- Make the tab-count indicator clickable.
- Open a compact dropdown upward into the window.
- Show whole-suite performance at a glance, with a per-tab breakdown.
- Keep measurement lightweight and make unusually expensive tabs easy to identify.

Status: implemented after the installed version was confirmed.

## Debug and interface polish

- Add optional in-memory debug logging and a simple copy-ready issue report.
- Let the debug console collapse or detach into a native window.
- Capture an unobstructed workspace screenshot, annotate it, and save it as PNG.
- Replace oversized workspace actions, including **New workspace**, with compact tool-style controls.
- Replace the reasoning-effort dropdown with a polished stepped slider that previews its label and commits once per interaction.
- Show real autosave state, an exact last-saved tooltip, and a manual save action.
- Add soft/minimal/off agent sound profiles for completion, questions, and required input.
- Remove verbose launcher and empty-state filler from work surfaces.
- Use GitHub Releases as the built-in update source and surface updates in the bottom status bar.
- Make debug and window expand/restore controls stateful; detach the debug console by dragging its header.
- Prevent stale Codex PTY exits and configuration rerenders from tearing down replacement sessions.

## Post-0.1.3: sub-agent visibility and steering

- Show a tiny agent-tree indicator whenever a parent agent has active sub-agents.
- Expand it into a compact live view of each sub-agent's status, current task, and latest activity.
- Let the user inspect a sub-agent without replacing the parent conversation.
- Support direct steering prompts to a selected sub-agent, with clear parent/child context.
- Keep the indicator quiet when no delegation is active and preserve the work-focused interface.

## Post-0.1.3: reversible agent history

- Attach a recoverable workspace/Git checkpoint to every user message and agent turn.
- Let the user reopen an earlier message exactly as it was, then edit it and branch from that point.
- Never destroy newer work when rewinding; preserve it as a named branch or recoverable checkpoint.
- Detect sibling agents touching the same files before an edit is applied.
- Coordinate saves through the owning agents and offer an agent-assisted merge when concurrent edits overlap.
- Make file provenance, pending edits, conflicts, and the eventual merge visible without leaving the conversation.

## Later: model-aware process and usage tracking

- Extend the tab-performance and process views with current model usage.
- Attribute usage to the project, workspace, parent agent, and sub-agent that caused it.
- Explain whether usage comes from active prompts, delegated work, retries, background tasks, or resumed sessions.
- Make concurrent project activity and likely cost drivers understandable at a glance.
