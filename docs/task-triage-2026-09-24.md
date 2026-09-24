# Task list triage — 2026-09-24

Source: `feature-list.md` at 2026-09-24 16:40, 36 open or in-progress items (205 done items not reviewed), plus three web-app notes the owner added at 16:45.
Related items are merged into one work item each, ordered by how urgently they need repair:
first what loses work or blocks the app, then what wastes tokens or the owner's time, then
performance and scale, then UX, then large features. Each work item lists the `conductor-task`
ids it absorbs, so the checklist markers and history stay traceable. `feature-list.md` itself is
not rewritten yet, because two coworkers are editing their items in it; apply this plan there once
the performance item (141e0a02) is checked off.

## In progress (leave running)

| Item | Owner | Note |
| --- | --- | --- |
| Renderer typing performance — `141e0a02` | agent_mufqqnsx_20iyb09 (Opus 5.5) | Benchmark, draft hot path, inactive-tab suspension, paste folding, recovery checkpoint. **Gate for everything below.** |
| Scheduled tasks — `ea74d128` | agent_mufqqll9_g07493l (Opus 5.5) | Agent-created scheduled tasks, per-task scripts, local-first tiering, night/idle gate, updater rebuilt as actionable intel. |

Both coworkers lost their tabs to the P0-1 bug below and are running without tabs; check
their commits when they finish.

## P0 — loses work, freezes the app, or stalls unattended runs

1. **Layout writes from stale closures drop live tabs (CLI toggle regression)** — `764a7740` (regression part).
   Chat → CLI → Chat on a controller tab removed its coworker tabs from the layout. Their agents kept running
   with no tab and could not be listed, steered, approved or resumed. Root cause and fix list are recorded
   in the item. Fix: every layout writer reads the latest layout; main refuses a layout write that drops a
   running agent's tab; a way to reattach an orphaned running agent; regression test.
2. **Invisible Usage view blocks every click** — `88138288`.
   The app looked crashed until Ctrl+Tab showed an open Usage view; closing it restored input. Some overlay
   or modal stays mounted without being visible. Find it and make sure it is either visible or not capturing clicks.
3. **Continue on the next best model when a provider refuses a turn** — `fb515071`.
   "Fable 5.1's safeguards flagged this message … `[reasoning_extraction]`" ends the turn. Conductor should
   detect this refusal class and continue the same conversation on the next model in the frontier ladder
   (e.g. Opus 5.5), noting the switch in the chat, as it already does for usage limits.
4. **Quit/restart handling for unattended and wizard tabs** — `wizard-answers-quit-dialog` (priority high), `19c298e4`, `988100e6`.
   - The native "Work is still running" dialog blocks a wizard. Suppress it for quits and restarts the wizard started itself, and let the wizard answer a dialog that is already open (`app.quit.confirm`, pending state in `app.state`).
   - The dialog counts tabs that have been idle for a long time as running work (`19c298e4`). Count only turns that are really running or waiting.
   - After a restart the *owner* started, a wizard tab was brought back and told to continue (`988100e6`). Only resume wizards whose own `app.restart` / `app.update.install` caused the restart.
5. **Message queue: merge queued messages into one turn; allow unsending** — `9fb1c9c5`, `f15c9164` (its screenshot: four short queued lines "75%", "of fable usage", "not total weekly", "total weekly is different" sent as four turns), `2ad233c6`.
   Messages queued while a turn runs go as **one** combined turn instead of one each, so the owner no longer has to press Esc and type "continue". A queued message can be removed with an X or a shortcut before it is sent.

## P1 — autonomy friction and wasted tokens

6. **Rollback to a known-good version** — `22fc5f94` (priority high).
   A couple of clicks back to the last working build, with the CLI versions and model catalog it was verified
   with. The scheduled model-checker (`ea74d128`) should record each good combination as a restore point.
   Start it after `ea74d128` lands, since it uses its evidence.
7. **`app.update` from a coworker in Auto runs without the owner dialog** — `app-update-no-dialog-in-auto`.
   Still open: `tools.list` still says the owner confirms each build unless the conversation is pre-authorized.
8. **First-class local model server control** — `local-server-stop-control`.
   `local.servers` / `local.stop` do not exist yet (checked in `tools.list` today). Name them in the machine-limits briefing line.
9. **Show app-control activity in the UI without spending tokens** — `44a4ba26`.
   Render each control call a tab makes (steering tabs, dispatches, restarts, ships) as compact activity rows
   from the control log, not from model output.
10. **Faster `git.ship`** — `ship-delivery-speed`.
    Still around 2.5–4 min per delivery (today's 818c29b delivery: about 2.5 min). Parallel test/build, affected-test selection, incremental typecheck.

## P1 — performance and scale (after `141e0a02`)

11. **Task list and chat history load only what is visible** — `3bbf4893`, `9afebc80`, `24e307fa`.
    Done tasks hidden by default and archived after 14 days; long task bodies collapsed with click to expand; chat
    history loads in pages as you scroll up; one-click "copy whole transcript" served from the store, not the DOM;
    fast in-chat search.
12. **Processes tab as a light control board** — `2c712217`.
    Scope to all open projects but only recent and active tabs (e.g. last 24 h or running/waiting), grouped by
    project and flagging what needs attention; no loading of two-week-old sessions.

## P2 — UX

13. **Tab groups** — `96d8efee`, `53cd24fb`.
    Closing a controller tab closes its coworker group by default ("Close this tab only" in the context menu).
    Coworker groups can be dragged into a side-by-side split.
14. **CLI as a drawer under Chat** — `764a7740` (feature part).
    Live native CLI in a bottom drawer while Chat stays visible; toggling never restarts the process. Do it
    after P0-1 has fixed the layout writes.
15. **Web app on phone** — `f0f8aaf7`, `3775a5ec`, `e0e64ce7`, `32920a68`, `fb7fbf10`.
    - The composer stays visible above the on-screen keyboard (visualViewport).
    - The owner chooses which notifications arrive. Default: controller tasks done and anything that needs the owner; not every coworker finishing.
    - Claude's `thinking_tokens` rows stack up one under another (`e0e64ce7`). Collapse them into one animated "working" line, the same as the desktop's rotating status words. This is the cheapest fix of the group; do it first.
    - New conversation (`32920a68`): a bare text box first, settings folded away, with sensible defaults. Pick the provider with the most usage left and a mid-tier model (e.g. Sonnet or GPT-5.6-Terra), not a frontier one, since phone tasks are usually lighter.
    - Tasks (`fb7fbf10`): send the phone only tasks worth showing (open ones, not archived; reuses P1-11's archiving and paging). Give tasks their own section, separate from "New", listing tasks per project with a quick add. Depends on P1-11.
16. **Resizable projects/files sidebar** — `fe4662b9`.
17. **Priority and weight visible on tasks** (hover at least) — `5a68facc` (low).
18. **Icons** — `feature-file-type-colors`, `4ab12812`.
    VS Code file-type colors/icons everywhere files appear; a distinct icon per local model. The claim on
    `feature-file-type-colors` (agent_mtu4f5v5_4ia8e4w) is stale; release it.

18a. **Durable jobs become an option of a local-model conversation, not a menu tab** — owner note 2026-09-24 (no checklist marker yet).
    Today it is its own sidebar utility panel (`'jobs'` in `SidebarUtilityPanel`, src/renderer/src/components/Sidebar.tsx:96;
    "Durable jobs" in src/renderer/src/App.tsx:291; src/renderer/src/components/DurableJobsPane.tsx). It should be
    a mode chosen for a local model where the model is picked, e.g. a "Run as durable job (overnight, staged, resumable)" toggle
    in the local-model composer/launcher. Its progress, pause, resume and cancel then show inside that conversation's
    tab, reusing DurableJobsPane's pieces. Remove the sidebar entry (keep `jobs.*` in app control) and migrate the saved
    `utilityPanel === 'jobs'` choice. This fits with the scheduled tasks (`ea74d128`), which run their local churn through the
    same job machinery; coordinate so both don't design their own job UI.

## P3 — large features and verification

19. **Ideas / Notes system** — `9b15feab` (heavy).
    Build after `ea74d128`: its incubator needs the same idle/night scheduling and local-first job model.
    The MVP stays as the item states: frictionless capture, durable Ideas, related-work tracking, bounded local exploration.
20. **Durable jobs verification** — `durable-jobs-verification`.
    Remaining runs: real-model fault cases and the 6-hour soak. Run overnight through the scheduled-task system once it exists.

## Verify and close, or park (not nonsense, but likely superseded)

| Items | Why |
| --- | --- |
| `approval-auto-refusal-evidence`, `codex-auto-owner-escalation` | 2026-09-22 source repairs whose "native acceptance pending" was followed by commits 09f5963 (Codex Auto escalations kept as owner cards), f5e0afb and ddb4f23. One check against the installed app, then close. |
| `invoicing-approval-review`, `invoicing-bounded-recovery`, `invoicing-runtime-budget`, `invoicing-evidence-telemetry` | An Astra controller's program from the invoicing sibling project (agent_mucxgir3_mmkk8m6, 2026-09-22), blocked on a "mutation broker" design. The owner decides whether it continues; otherwise park it as one idea and release the stale claims. |

## Cleanup done in this pass

- `f15c9164` ("to add to refine way we queue messages task") is an addendum, not a task. It is folded into P0-5.
- The block of numbered "[Implemented]" features under `88138288` is an old section header, not part of that bug; move it out when the list is rewritten.
- No item was dropped as nonsense. Every open item describes a real problem or a request the owner made.

## Suggested run order after `141e0a02` is checked

1. P0-1 and P0-2 together: both are renderer state bugs.
2. P0-5, then P0-3 and P0-4: all touch structured sessions and the wizard/restart path.
3. P1-11 and P1-12, reusing the perf benchmark.
4. P1-7 to P1-10 in one control-API batch, then P1-6 after `ea74d128`.
5. P2 as cheap Sonnet coworkers, then P3.

## Execution plan: quality first, least token churn

Budget on 2026-09-24 16:44: Claude weekly 53% (cap 75%, resets 2026-09-28 09:00), five-hour 27%, Fable weekly 79%.
Codex/Astra has not reported yet (limit: 95%). The two running Opus xhigh coworkers are the largest unknown draw.
Record Claude weekly before and after them, and size the rest of the plan from that difference.

### Roles

| Role | Model | Effort | Does | Never does |
| --- | --- | --- | --- | --- |
| Architect / reviewer | Claude Opus 5.5 (`opus[1m]`) | high (xhigh only for P0-1 and P0-5 root causes) | Writes each batch's contract: failing tests plus the exact acceptance criteria. Reviews the final diff once, read-only. | Explores the repo broadly or runs test loops. |
| Implementer | GPT-6 Astra | high | Makes the failing tests pass inside the contract's allowedPaths; one batch per tab. | Chooses scope. |
| Churn | Local Qwen 3.6 35B-A3B (one server; docs/machine-profile.md) | – | Durable jobs with a contract (allowedPaths plus acceptance command): run suites and benchmarks, summarize failures to under 40 lines, mechanical tables (file-type icon map), apply this triage to feature-list.md, the durable-jobs soak. | Design or cross-file refactors. |
| Cheap UI | Claude Sonnet 5 | medium | P2 items with an exact spec. | Anything in main/ or IPC. |
| Controller | This wizard tab (Opus 5.5) | – | Dispatches work, checks usage between batches, runs `git.ship`, `app.update` and restarts. | Implements. |

### Technique (where the token savings come from)

1. **Contract first, tests first.** Opus spends a short, bounded turn writing a failing test and the acceptance criteria. Astra then works against something it can check, not against prose, so there is no guessing and no rework.
2. **One batch per fresh tab, grouped by shared files.** Items that touch the same files go to one worker in sequence, so the code is read once. A new tab every one or two batches keeps context from growing.
3. **Local model loops, frontier models decide.** Test runs, benchmarks and log reading happen in local durable jobs; Astra and Opus only see the summary.
4. **One review per batch.** Opus reviews the final diff once, with `git diff` limited to the batch paths, not every intermediate step.
5. **Budget gates.** Before each dispatch the controller reads `usage.limits`. Claude weekly at 70% or more: Opus is used only for review; at 73%: Claude work stops and Astra plus local finish the work. Astra stops at 95%.
6. **Ship locally per batch, publish once** at the end; one `app.update` per two or three batches, not per item.

### Batches, fastest wins first

| # | Batch | Items | Contract (Opus) | Build | Why it is cheap |
| --- | --- | --- | --- | --- | --- |
| B1 | Renderer state bugs | P0-1 (stale layout writes), P0-2 (invisible Usage overlay), web `thinking_tokens` collapse | Opus xhigh (root cause already recorded) | Astra | Root cause known, small surface, renderer only |
| B2 | Wizard and restart path | P0-4 (quit dialog, idle-tab count, resume only own restarts), P1-7 (app.update without dialog in Auto) | Opus high | Astra | Same files: index.ts, agent-control.ts, update-manager |
| B3 | Structured sessions | P0-5 (merge queued messages into one turn, unsend), P0-3 (refusal → next model) | Opus xhigh | Astra | Same adapter/queue path; the fallback reuses the usage-limit continue path |
| B4 | Control API additions | P1-8 (`local.servers` / `local.stop`), P1-9 (app-control activity rows) | Opus high | Astra; local runs smokes | Additive methods, well-bounded |
| B5 | Scale | P1-11 (task/chat paging, archive, transcript copy, search), P1-12 (Processes board), web tasks `fb7fbf10` | Opus high | Astra; local runs perf-input.mjs before and after | Reuses the perf coworker's benchmark |
| B6 | UI polish | P2-13, 16, 17, 18, web composer defaults, sidebar resize | Opus writes one spec for all | Sonnet 5 (2–3 tabs); local builds the icon table | Many small, independent items |
| B7 | Jobs and rollback | 18a (durable jobs as a local option), P1-6 (rollback), P2-14 (CLI drawer) | Opus high | Astra | Needs `ea74d128` landed first |
| B8 | Ideas MVP | P3-19 | Opus writes the architecture as a contract in parallel modules | Astra modules; local incubator tests | Largest item; do last, when the weekly window resets |
| B9 | Verification | P3-20 soak, invoicing/approval verify-and-close | – | Local durable job overnight; Astra reads the result | Runs unattended |

If the Claude budget runs short, B8 waits for the 2026-09-28 reset. Astra can then implement B7 without an Opus contract, using this document as the spec, and Opus reviews it after the reset.

### Update and read-back loop (Qwen)

After each batch is shipped (`git.ship` delivered), the local Qwen tab builds the update, reads it back and reports.
The frontier parent spends tokens only when something went wrong.

1. **Authorize once.** The wizard controller calls `app.update.authorize` for the Qwen tab, so its builds need no owner dialog.
   The clearance lives in memory and lapses when the wizard tab closes.
2. **Build.** Qwen calls `app.update` and polls `app.update.status` about once a minute until it is no longer running.
   Both methods are already in `LOCAL_CONTROL_METHODS` (src/main/local-models/tools.ts:40).
3. **Read back.** Qwen checks the status result: state, version, exit code and the log tail. On failure it also reads the full
   build log and extracts the first error with its file:line and the failing stage (tsc, electron-vite, electron-builder, signing).
4. **Report in a fixed format**, as the last line of its turn:
   - `UPDATE OK <version>`, or
   - `UPDATE FAILED <stage>` followed by at most 20 lines: first error, file:line, likely cause, and the commit it built.
5. **Parent wake-up without polling tokens.** The controller runs a shell watcher (no model turns) on the Qwen tab's
   `agents.status`, and wakes the parent only on `UPDATE FAILED`, or when the turn stops without a report.
   On `UPDATE OK` the wizard downloads the update and runs `app.update.install({force:true})`.
6. **After the restart**, the wizard sends Qwen one message: "verify". Qwen confirms that `app.update.status` / the running version
   matches the build, runs the batch's focused tests in its sandbox, and reports `VERIFIED <version>` or
   `REGRESSION <test> <first failure>` in the same format. A regression goes back to the batch's Astra implementer with
   Qwen's summary, not the raw output.

Gap to close in B4: a local model cannot yet *push* a message to the conversation that opened it; the parent has to poll.
Add `agents.report({text})` to `LOCAL_CONTROL_METHODS`, limited to the tab's own controller (the AgentControl.linkFor ownership rule),
a length cap (~2,000 characters), and no other target. The watcher in step 5 is then no longer needed.

## Added: Logic loops (`logic-loops`, priority high)

Spec: docs/logic-loops.md. Seed loops: `.conductor/loops/task-triage.md`, `batch-delivery.md`, `update-readback.md`,
which record this document's procedure. Phase v0 costs nothing: the loop files exist, and the Auto Fixer's
instructions point to them. Run it right after B1. v1 (control methods, metrics, budget gate) is batch **B2.5**,
because every later batch then runs through `batch-delivery` and produces the metrics that refine it.
