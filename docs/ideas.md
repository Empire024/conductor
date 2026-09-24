# Ideas

An idea is a durable record of something the owner jotted down: capture takes a few seconds and
asks for nothing but text; Conductor keeps it, ties later work back to it, and lets a local model
make small, bounded progress on untouched ones at night. Spec: feature-list item `9b15feab`.

Contract: `src/shared/ideas.ts`. Store and service: `src/main/ideas/`. Desktop view:
`src/renderer/src/components/ideas/`. Phone screen: `#/ideas` in `src/phone/app.js`. Incubator:
`src/main/schedule-builtins/idea-incubator/`.

## Data model (SQLite, `conductor.db`, `src/main/ideas/store.ts`)

- `ideas`: `id`, `text` (the owner's current note), `original_text` (the text of the first
  sitting: edits within 10 minutes of creation coalesce into it, then it is frozen), `title`
  (inferred from the first line, never asked for), `status`, `worked_on`, `captured_from`
  (`desktop` / `phone` / `agent`), `tags`, `created_at`, `updated_at`, `last_explored_at`.
  Ideas are global, not project-scoped: a project is a link.
- `idea_links`: `(idea_id, kind, target_id)` unique; kind is `project`, `agent-session`,
  `task` (`projectId:taskId`), `memory`, `artifact` (path or URL) or `job`; every link carries
  provenance `created_from_idea_id`, `created_by_agent_session_id`, `created_by_job_id`.
- `idea_events`: the timeline (`created`, `edited`, `status`, `linked`, `worked-on`,
  `exploration-started`, `explored`, `exploration-stopped`, `section`, `note`) with an actor.
- `idea_sections`: agent-generated content (`brief`, `note`), with a structured brief (concept,
  open questions, next step, related memory ids, observations) and who wrote it (model, machine,
  job or conversation). The owner's `text` is never written by an agent.
- `idea_explorations`: one row per local exploration, pointing at its durable job; it survives a
  restart and is reconciled against the job on launch.
- `idea_settings`: the incubator's settings.

Statuses: Inbox (new capture), Untouched, Exploring (a job is running), Active (someone worked
on it), Parked, Converted, Archived. **Worked on** turns true when a conversation, task or project
is linked because of the idea; a local exploration is tracked separately (`last_explored_at`), so
"explored once, never followed up" stays visible.

## Capture

- **Desktop:** `Ctrl+Alt+I` is registered with Electron `globalShortcut` (not in a
  `CONDUCTOR_TEST_USER_DATA` launch, which must never take the owner's keys or focus). It raises
  the window and opens Ideas with the cursor in a new note. The note is created on the first
  keystroke and autosaved (debounced); there is no form.
- **Entry point:** a lightbulb in the title bar and a palette command, *Ideas*. Ideas are
  project-independent, so they do not belong in the project sidebar's utility drawers or in a
  project's launcher; the title bar is the one place visible with or without a project. The
  view covers the main stage as its own section and keeps the workspace mounted underneath
  (terminals and conversations are not unmounted); Esc or the close button returns.
- **Phone:** `#/ideas` opens straight into a full-screen editor with the keyboard up; list,
  search and the idea's actions sit on a bottom bar. API (authenticated like every phone route,
  `src/main/ideas/phone.ts`): `GET /api/ideas?search=&status=`, `POST /api/ideas {text}`,
  `GET /api/ideas/:id`, `POST /api/ideas/:id {text?, status?}`, `POST /api/ideas/:id/explore`,
  `POST /api/ideas/:id/task {projectId}`, `POST /api/ideas/:id/work {projectId}`.

## Related work

- **Work on this idea** opens a visible agent tab in a chosen project and submits a brief built
  from the original note, the current text, the latest brief, related memories and prior work
  (`src/main/ideas/context.ts`). The tab's session and the project are linked with
  `createdFromIdeaId`, and the brief tells the agent its idea id so it can record what it makes.
- **App control** (`src/main/ideas/control.ts`): `ideas.list`, `ideas.get` (read);
  `ideas.capture`, `ideas.link`, `ideas.note`, `ideas.explore`, `ideas.work` (mutation). A
  local model and a read-only or planning conversation may only read. `ideas.link` records a
  file, memory, task or conversation with the caller's session as provenance.
- **Create task** adds a Project task (`kind: idea`) to the project's `feature-list.md` and links it.

## Bounded local exploration (`src/main/ideas/explore.ts`)

- An exploration is a durable job (`jobs` service, docs/durable-jobs.md) on a **local** model
  only: the loaded one, else the first configured one. It never escalates; a job that stops
  records why, and the view offers *Work on this idea* with Claude or Codex as the owner's choice.
- The job runs in the idea's linked project (else the Conductor checkout, else the first desk
  project) with `isolateWorktree: false` and read-only stages (`research`, then `report` for the
  Explore intensity), so it writes no files and needs no checkpoints. Budgets: 2 attempts per
  stage, 20 minutes (Light) or 45 minutes (Explore) elapsed.
- Related memories are chosen deterministically (token scoring over every project's memories,
  without bumping recall counts) and handed to the model with their ids.
- When the job completes, the final stage's answer is parsed into a brief section; memory links
  are recorded for the ids it cites. A blocked job is cancelled (an unattended exploration never
  waits for approvals) and the exploration is recorded as stopped with the reason.

## Idea Incubator (`src/main/schedule-builtins/idea-incubator/`)

A built-in scheduled task (kind `idea-incubator`, timing `night`, checked hourly) seeded on the
Conductor checkout's project, else the first desk project. It is dispatched by kind to its own
executor, not the script pipeline. Each run starts explorations for the oldest untouched ideas
(Inbox or Untouched, never worked on, never explored, idle for 10 minutes, some text) until
`maxPerNight` (default 3) have started in the last 20 hours, at the configured intensity (Light).
The schedule gate already keeps it off a busy machine and away from the owner's active hours.
Pausing the task, or `enabled: false` in the Ideas settings, stops it.

## Next steps (out of the MVP)

- Device selection beyond "this machine" (Run on: laptop, Mac, automatic by load and VRAM).
- Related-idea discovery and merging (with the owner's confirmation).
- Resurfacing reminders ("3 ideas worth revisiting") with snooze and never-remind.
- Inbox classification suggestions (task / reminder / duplicate), mention detection in later
  conversations, search across descendants' content, Develop intensity, and Convert to project.
