# Threads without a project — t3code adoption, first slice (CLOUD)

Cloud-only implementation commissioned by the owner; Sol integrates it locally. Branch
`claude/cloud-thread-adoption-t3code-yt2ywb`, cut from `origin/main` at `3f95349`
(2026-10-28). **The owner's checkout is ~92 local commits ahead of that base, so nothing here claims
parity with the installed app**; see *Integration notes* before shipping.

The feature-list task `c85d40b6-ad59-4cfb-b644-3700c9ff1674` is **not in this checkout's
`feature-list.md`** (it was added in the commits not yet pushed to `origin/main`), so I could not
read it. I worked from the commission text: "new tab/thread without requiring the owner to choose or
create a project, in a smart thread view inspired by the t3 sidebar and the Conductor phone UI". Sol
should check the task's wording against what is listed below. `feature-list.md` was not edited.

## Reference: pingdotgg/t3code, pinned

- Commit **`dd148481531a0a090780a2ade20588566db099a2`** (2026-10-29, "perf(server): idle servers run
  100x fewer background queries…"). It is a shallow, read-only clone; nothing was pushed there.
- What t3code does, and what Conductor took from it:

| t3code (path at the pinned SHA) | What it does | Conductor in this slice |
|---|---|---|
| `apps/server/src/project/ManagedProjectFolders.ts:253-297`, `packages/contracts/src/rpc.ts:408` (`projects.ensureScratch`) | "No project" is a hidden scratch project rooted at `<baseDir>/scratch` | **Adopted.** The *General* project is a real local project, made on first use under the projects root (`src/main/general-threads.ts`) |
| `ManagedProjectFolders.ts:317-342` | One folder per scratch thread (`<date>-<words>-<id>`) | **Not yet.** All General threads share one folder (ranked improvement #1) |
| `packages/contracts/src/orchestrationV2.ts:3348-3354`, `apps/server/src/project/ScratchThreadPromotion.ts:57-129` | "Turn into project" adopts the folder in place, so the working directory never changes | **Adopted** as *Turn General into a project…* (renames the row only) |
| `Orchestrator.ts:4050-4063` | Refuses to move a thread whose working directory is not the target's root | **Same rule.** A started thread is never re-rooted; *Continue in project* opens a new thread with a drafted handoff instead |
| `apps/web/src/components/NoProjectsHero.tsx:30-53` | "What should we work on?" with **Start without a project** and **Add project** | **Adopted** (`EmptyState.tsx`) |
| `apps/web/src/components/Sidebar.logic.ts:167-178`, `:1073-1175` | Sidebar sections by state (pinned, active, working, snoozed, settled), with a priority-ordered status pill | **Partly adopted.** Threads are grouped *Needs you / Working / Today / Earlier* and carry a state pill; pin, settle and snooze are later work |
| `apps/web/src/timestampFormat.ts:231-254` | Compact relative age on each row | **Adopted** (`threadAge`) |
| `Sidebar.logic.ts:989-1021` | Searches titles first, then messages | **Partly adopted.** Searches title, project, workspace and last message only |
| `packages/shared/src/keybindings.ts:147-239` (`mod+alt+n` = `chat.newWithoutProject`) | Shortcut for a new thread without a project | **Adopted:** Ctrl+Alt+N, plus a palette entry |
| `apps/web/src/components/chat/useComposerMenuItems.ts:213-274`, `apps/server/src/provider/Drivers/ClaudeSkills.ts:451-479` | One slash menu holding built-ins, provider commands and `/skill:name` discovered from `.claude/skills` | **Not changed.** Conductor already has `src/shared/slash-commands.ts`; see ranked improvement #7 |
| `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1723`, `RestartContinuation.ts` | Durable native resume references, with "Continue where you left off" after a restart | **Unchanged.** Conductor's own resume and continuation path already does this; General threads use it as is |

## What changed (adoption 1)

1. **First launch / no project.** The empty state now asks *What should we work on?* and offers
   **Start without a project** before **New project**. The sidebar's Threads section says *No open
   threads. Start one — no project needed.*
2. **New thread** (empty-state button, the Threads `+`, **Ctrl+Alt+N**, or the palette entry *New
   thread without a project*):
   - Main ensures the General project (`threads:new-general`).
   - The window loads it and shows a launcher in its workspace. The owner picks an agent and types;
     nothing asks for a project.
   - A second new thread reuses General. Two clicks at once still make only one General.
3. **Internal anchor, user-facing "no project"**:
   - General is an ordinary local project row. Its folder is `<projectsRoot>/General`, made by the same
     path as the owner's *New project* (`addLocalProject`): backlog, file watcher and remote sharing
     come with it.
   - The settings key `generalThreadsAnchor` = `{projectId, path}` remembers it.
   - Lists sent to the window carry `general: true` (`ProjectRecord.general`, never stored). The row
     shows a dashed-message glyph and a tooltip that reads *Threads started without a project*.
4. **Working-directory safety**:
   - The agent's working directory is `project.path`, exactly as for any project (`tab-keep-alive.ts`).
     Every project-scope guard therefore applies unchanged.
   - `safeGeneralFolder` refuses a drive root, the home folder, the projects root, or any folder above
     them, both for a stored anchor and for whatever the project maker returns. Conductor never starts
     threads in a folder that would hand an Auto agent everything under it.
5. **Restart and resume**:
   - Layouts, agent specs and journals belong to the General project like any other, so they restore
     and resume through the existing paths.
   - If the folder is deleted behind Conductor's back, it is made again at the same path, so Claude's
     working-directory-keyed resume still finds its transcript.
   - If General is removed from Conductor, it comes back on its old folder instead of as *General 2*.
6. **Joining a project later** (*subsequent project association*):
   - **Turn General into a project…** (the Threads `⋯` menu, `threads:promote`): the row is renamed and
     the folder, working directories and threads stay put. The anchor is cleared, so the next new thread
     makes a fresh General.
   - **Continue in project ›** (right-click a General thread, `threads:handoff`): opens a new thread with
     the same provider in the chosen local project. Its composer is pre-filled through `seedDraft` with
     a handoff: the title, the old folder, and the last six messages clipped to 600 characters each.
     It is left **unsent**, and the General thread is untouched.
   - A started thread is never moved to another working directory: a native CLI resumes from the folder
     it began in (claude `--resume`), so moving it would lose the conversation on the next restart.
7. **Smart thread view** (`ThreadList.tsx` above Projects; the view is built in main by
   `buildThreadView` from `PhoneAccessService.phoneState().sessions`, the same source the phone uses):
   - It lists every open conversation in every project, grouped *Needs you* (attention, failed,
     disconnected), *Working* (working, usage limit), *Today*, *Earlier*.
   - Within a group a wizard comes first, then the newest.
   - A coworker that does not need the owner is folded into its controller's row (*+N coworkers*), so a
     swarm does not bury the conversation the owner is in. A coworker that needs the owner is always
     listed.
   - Each row shows a state pill (Approval / Question / Working / Limit / Failed / Disconnected) or an
     age, plus the project, or *General* with its glyph.
   - Search appears once there are more than six threads.
   - The view refreshes on the window's phase changes, a 5-second poll while visible, and window focus.
   - Clicking a row focuses the tab through the existing `agentControl.focusTab`, across projects.

## Evidence

### Typecheck, unit tests and build

- `npx tsc --noEmit` passes; `npx electron-vite build` passes.
- New tests, all passing:
  - `src/shared/threads.test.ts` (8): bucket order, open-only listing, swarm folding with
    attention exempted, wizard first, search, the row cap, age labels, state labels, handoff clipping
    and caps, anchor parsing.
  - `src/main/general-threads.test.ts` (7, real SQLite and real folders):
    - first launch;
    - **restart**: the database is closed and reopened, giving the same General, the same workspace,
      and the agent tab still in the saved layout;
    - two concurrent ensures make one project;
    - a deleted folder is made again at the same path;
    - a removed General comes back on the same folder, and a fresh one is made when the folder is
      also gone;
    - an anchor in the home folder is refused, as is a maker that returns the projects root;
    - promote renames in place, the agent's working directory is unchanged, and the next General is
      `General 2`.
  - `src/main/threads-ipc.test.ts` (3): handoff uses top-level messages only and continues only a
    General thread into another open project; every channel checks the sender; project-change
    broadcasts; dispose removes the handlers.
  - `src/renderer/src/components/ThreadList.test.ts` (3): the empty state offers the thread first,
    the old single action stays without a handler, and the Threads section renders.
- Full `vitest run` on Linux: see *Full suite* below.

### Real app, Linux container (Xvfb), built `out/` — 10/10 PASS

Linux is not the owner's platform, and `scripts/verify-kit.mjs` is Windows-only (its process accounting
uses Win32_Process). So I drove the built app directly with Playwright's Electron launcher and the
same parked environment: `CONDUCTOR_TEST_USER_DATA` (a fresh profile), `CONDUCTOR_PROJECTS_ROOT` and
`CONDUCTOR_OFFLINE_TESTS=1`. The provider was a synthetic Claude fixture that replies with its own
working directory. The driver is
[`t3code-cloud-threads/linux-threads-run.mjs`](t3code-cloud-threads/linux-threads-run.mjs) and the raw
verdicts are in [`results.json`](t3code-cloud-threads/results.json).

| Check | Result |
|---|---|
| First launch with no project: the empty state offers *Start without a project* | PASS — 0 projects |
| Click it: General is made at `<root>/projects/General`, marked, active, with a launcher | PASS |
| A Claude turn in General runs **in the General folder** | PASS — reply: "working in /tmp/…/projects/General" |
| The thread is listed as a General thread (Today, done) | PASS |
| Ctrl+Alt+N again reuses General | PASS — still 1 project |
| Quit and relaunch on the same profile: same General, thread still listed with its turn | PASS — 2 text items kept |
| Handoff drafted for project *Brand*, with the same provider | PASS — 412 characters, claude |
| *Continue in project › Brand* from the context menu: Brand is active and the draft is seeded | PASS |
| *Turn General into a project*: same id and folder, the thread still answers, next General is `General 2` | PASS |

Screenshots: [first launch](t3code-cloud-threads/1-first-launch.png) ·
[thread in the Threads view](t3code-cloud-threads/3-thread-in-sidebar.png) ·
[continued in Brand with the drafted handoff](t3code-cloud-threads/5-continued-in-brand.png).

### Parked smoke for Windows (written, **not run here**)

`scripts/smoke-cloud-threads.mjs` covers the same scenario through verify-kit in spawn mode. It
restarts with a real `app.restart` and relaunch, not quit-and-launch. Run it with
`node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-cloud-threads.mjs`; evidence goes
to `artifacts/cloud-threads/`. It could not run in this container because verify-kit refuses
non-Windows hosts.

### Full suite

FULL_SUITE_PLACEHOLDER

## Limitations (truthful)

- No run on Windows or against the installed app. The parked smoke is unrun, and no `app.update` was
  done (cloud session).
- A project created through app control (`projects.open`) reaches an *already open* window only after
  a reload. This was already the case and verify-kit's `openProject` works around it the same way;
  this slice did not change it.
- Continue in project offers **local projects only**. A project on a paired machine runs its threads
  there, and that path was not exercised.
- All General threads share one folder. Two General threads writing the same file name will collide
  (t3code avoids this with one folder per thread; ranked improvement #1).
- The Threads view lists **open** conversations only; closed ones stay in the existing history.
- The thread view polls `phoneState()` every 5 s while visible and expanded. This is the same
  computation the phone polls, with no push channel yet (ranked improvement #5). On an owner-scale
  profile it should be measured before shipping.
- Phone UI: General threads appear there as project *General*, but the phone's new-tab sheet still
  needs a project. It does show General once General exists.
- General is made through the same `addLocalProject` path as *New project*, so a paired machine sees
  MAIN's General as an ordinary remote project called "General", without the marker. Hiding it there,
  or marking it, is a decision for the owner.
- Ctrl+Alt+N matches the key produced, not the physical key, and ignores AltGr. On a layout where
  Ctrl+Alt+N itself produces a character (Windows treats Ctrl+Alt as AltGr), only the palette entry
  and the `+` button work. Not tested on the owner's keyboard.

## Ranked improvements (next slices)

Estimates are for one engineer, including tests and a parked smoke.

| # | Improvement (UX / skills / commands) | Why | Estimate |
|---|---|---|---|
| 1 | One folder per General thread (t3 `ManagedProjectFolders`), with *Turn into project* adopting that one folder | Threads stop sharing files; promotion can be per thread. Needs a thread-level working-directory override in `AgentSpec` and file scope | 2–3 days |
| 2 | Unread-aware *Done* / *Failed* pills and *Mark unread*, from the existing `tab-seen.ts` | Today a finished thread looks the same whether or not the owner has seen it | 1 day |
| 3 | Pin / Settle / Snooze sections, drag between sections, with Undo (t3 `Sidebar.logic.ts:222-421`) | Lets a long-lived owner inbox be kept tidy | 2–3 days |
| 4 | Push updates (`threads:changed` published on phase or title change, like `attention:changed`) instead of the 5 s poll | Removes polling cost; the list updates at once | 1 day |
| 5 | Thread keyboard: Alt+Shift+[ / ] for previous/next thread, Alt+1..9 to jump (Ctrl+digit is already tabs) | Moves between threads without the mouse | 0.5 day |
| 6 | *New thread in…* palette picker that carries over the current model, effort and mode (t3 `useHandleNewThread.ts:116-136`) | One step from any context | 1 day |
| 7 | Discovered skills in the composer's `/` menu as `/skill:name` (t3 `useComposerMenuItems.ts:240-274`, `ClaudeSkills.ts`); Conductor today routes `/skills` to the connections view | Makes skills usable without knowing their names | 1–2 days |
| 8 | Message-history search in the Threads view, using `structured-message-search` | Finds a thread by what was said | 1 day |
| 9 | Phone: *New thread without a project* in the new-tab sheet, through `threads:new-general` | Matches the desktop on the phone | 1 day |
| 10 | App-control `threads.new` / `threads.list` for agents (coordinate with the tools.timings owner on `agent-control.ts`) | Lets a wizard start General threads | 0.5 day |
| 11 | Continue in project for remote projects, and an in-place move for runtimes whose resume is not tied to the folder (Codex thread id), after a provider probe | Completes association | 2 days |
| 12 | *Unsent draft* rows for a launcher or empty agent tab (t3 `SidebarDraftBlock.tsx`) | Shows unsent drafts in the list | 0.5–1 day |

## Exact changed paths

New:
- `src/shared/threads.ts`, `src/shared/threads.test.ts`
- `src/main/general-threads.ts`, `src/main/general-threads.test.ts`
- `src/main/threads-ipc.ts`, `src/main/threads-ipc.test.ts`
- `src/preload/threads.ts`
- `src/renderer/src/components/ThreadList.tsx`, `ThreadList.css`, `ThreadList.test.ts`, `EmptyState.css`
- `scripts/smoke-cloud-threads.mjs`
- `docs/perf-evidence/t3code-cloud-threads.md`, `docs/perf-evidence/t3code-cloud-threads/*` (driver,
  results, 3 PNGs)

Modified (each is a small addition):
- `src/main/index.ts`: two imports and two module variables. `GeneralThreads` and `registerThreadsIpc`
  are wired just before the `projects:list` handler, `projects:list` now marks General, and there is
  one dispose entry.
- `src/shared/models.ts`: `ProjectRecord.general?: true`.
- `src/shared/ipc.ts`: `threads` on `ConductorBridge`.
- `src/preload/index.ts`: the `threadsBridge` import and entry.
- `src/renderer/src/App.tsx`: the `pendingThread` state; `newThread`, `openThread`,
  `continueInProject` and `promoteGeneral`; the pending-thread effect; Ctrl+Alt+N; the palette entry;
  the `threads` prop on Sidebar; `onNewThread` on EmptyState.
- `src/renderer/src/components/Sidebar.tsx`: the `threads` prop, `<ThreadList>` above Projects, and
  the glyph and tooltip on the General row.
- `src/renderer/src/components/EmptyState.tsx`: rewritten (still about 20 lines).
- `src/renderer/src/panes/use-composer-draft.ts`: `seedDraft`.

Not touched: `feature-list.md`, `agent-control.ts`, any tool-timing module or `tools.timings`, audio,
other projects (miron).

## Integration notes for Sol

- **Fetch** `claude/cloud-thread-adoption-t3code-yt2ywb` and **merge or cherry-pick** onto the local
  `main`. Do not reset to it: it lacks the 92 local commits.
- Likely conflict points are the hot files above, all small hunks:
  - `App.tsx`: the palette list, the Sidebar props, the EmptyState line, and the new block placed just
    before `openJobTab`.
  - `Sidebar.tsx`: the imports, the end of the props interface, the Projects section start, and the
    project-row button.
  - `index.ts`: the imports after `session-archive`, the variables after `disposeLogicLoopsIpc`, the
    dispose list, and just before `projects:list`.
  - In each case, keep both sides.
- Check after merging:
  - Ctrl+Alt+N is still free in the local `App.tsx` and main menus.
  - `phoneState()` still returns `sessions` with `tabId`, `controllerId`, `wizard` and `state`.
  - `agentControl.focusTab` still has the same signature.
  - `ProjectRecord` still has no other `general` field.
- Ship: `git.ship({message, paths:[…the paths above…]})`, then `app.update({commit,
  smoke:["smoke-cloud-threads"]})` alongside the other cloud worker's tools.timings batch.
- Measure the Threads poll on the owner-scale profile (`scripts/owner-scale-profile.mjs`). If
  `phoneState()` is heavy there, raise `POLL_MS` in `ThreadList.tsx` or do ranked improvement #4 first.
