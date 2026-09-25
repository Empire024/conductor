# Idea autopilot

"Run this idea" lets Conductor carry out a whole idea over days: it plans in stages, opens and
steers the agents for each stage, keeps recurring work in a logic loop fired by a scheduled task,
and stops for the owner before anything outward-facing or irreversible. Spec: feature-list item
`idea-autopilot` (owner, 2026-09-25).

Contract: `src/shared/idea-runs.ts`. Main process: `src/main/idea-runs/`. Desktop: the Autopilot
section of an idea's details (`src/renderer/src/components/ideas/IdeaRunPanel.tsx`). Phone:
`#/idea-runs` in `src/phone/app.js`. Smoke: `scripts/smoke-idea-autopilot.mjs`.

## How a run goes

1. **Run this idea.** In the Ideas view (details → Autopilot) pick the project, the planner (Claude
   Opus by default, or Codex Astra) and optionally *Dry run*, then *Run this idea*. App control:
   `ideas.run({ideaId, planner?, model?, dryRun?})` in the caller's project. One run per idea at a
   time.
2. **Plan.** A visible planner tab gets the idea and the rules and answers with one
   ` ```idea-run-plan ` JSON block: stages, each with a goal, done-criteria, an agent
   (provider/model/effort), a budget (minutes, turns, euros), the action types it expects to need
   approved, whether it makes media, and for recurring work a `recurrence` (every N minutes,
   T times, loop steps). Conductor normalizes the draft (`plan.ts`) and says what it changed:
   - anything public (a `public` stage, or one expecting publish / message / create-account) comes
     after a `brand-check` stage; one is inserted when the draft has none;
   - a public stage always has `publish` as a checkpoint;
   - weekly caps can only go below the owner's defaults (Claude 85%, Codex 95%);
   - budgets are clamped; stages without done-criteria get the goal as their criterion;
   - a request to strip or hide AI disclosure is refused and the refusal shown.
   The plan waits for the owner: status *Plan waiting for you*, phone notification. Nothing runs
   until *Approve plan* (owner only).
3. **Stages.** One at a time. The controller opens a visible agent tab per stage (model resolved
   against `models.list`; a substitution is recorded) and sends a stage brief: goal, done-criteria,
   budget, the rules, earlier stages' summaries and the idea. Each turn ends with one
   ` ```idea-run-report ` JSON block: status `done` / `continue` / `blocked`, summary, artifacts,
   decisions, proposed outward actions, and money spent. Artifacts are linked to the idea with the
   stage conversation as provenance; decisions go on the timeline.
4. **Recurring stages** become a logic loop (`.conductor/loops/idea-<stage>-<run>.md`, docs/logic-loops.md)
   with the plan's steps, `trigger: [schedule:<id>]` and the run's weekly caps locked as its budget.
   The project's **Idea autopilot** scheduled task (kind `idea-run`, timing `idle`, created on first
   use and tightened to the shortest recurrence) fires due occurrences. Each occurrence is a
   `loops.run`, an occurrence brief to the stage agent listing the loop steps, and, when it reports
   `done`, a `loops.record` per step. A report may carry `loop.adjust` (a step's model or effort):
   Conductor proposes it with `loops.propose` and applies it with `loops.apply` when it is auto-safe
   (the loop's version goes up); anything else waits in the Logic loops section for the owner.
   Pausing the scheduled task pauses every recurrence in that project.
5. **Done.** When every stage is done the run completes and the phone hears about it.

## Owner checkpoints

Action types (`IDEA_ACTION_TYPES`): create-account, publish, message, purchase, order, spend,
external (anything else outside). Agents never do these themselves: they propose them in the
report's `actions` with the exact content (post text and file, account name, recipient, order
lines, amount). For each action Conductor (`policy.ts`):

- **refuses** it outright when it would strip or hide AI disclosure (the provenance rule), and tells
  the agent why;
- **answers from a standing rule** when the owner set one for that type on this run;
- otherwise **pauses**: the stage waits, the run shows *Waiting for you*, and a phone notification
  (kind `attention`, opens `#/idea-runs`) carries the action. The owner answers on the phone or in
  the desktop panel: *Approve*, *Deny*, or *Always approve this type* (a standing rule for the rest
  of the run). App control: `ideas.run.decide({checkpointId, decision, standing?, note?})`, from the
  owner's own credential only; a wizard tab steers but does not sign.

When a stage's checkpoints are all answered, the decisions go back to its agent in one turn: an
approved action is to be done exactly as shown and nothing more; a denied one is not done. In a
**dry run** nothing is ever performed, even when approved: agents describe what they would do.
Approved purchases, orders and spend count against the stage's money budget.

## Rules every brief carries

- **Provenance.** Generated or AI-edited images, video and audio keep their AI labels, C2PA
  content credentials and metadata, and are published with the platform's AI-content label (EU AI
  Act Art. 50, Instagram/Meta and TikTok policies). No step strips or forges AI disclosure.
- **Brand and copyright.** A brand/copyright check stage precedes anything public; inspiration is
  fine, copying another brand's name, logo, characters, trade dress, music or footage is not.
- **Checkpoints.** As above.

## Budgets

- **Per stage:** minutes (from the stage's first turn, per occurrence for a recurring stage),
  turns, euros. Over budget, the running turn is interrupted and the run pauses with the reason;
  *Resume* gives the stage one more budget of the same size.
- **Weekly caps:** before every stage start, occurrence and follow-up turn the controller reads
  `usage.limits` (the provider's current weekly window); at or above the run's cap (Claude 85%,
  Codex 95% unless the plan set lower) the run pauses until the owner resumes it after the reset.
  A provider with no reported weekly window is allowed; a local model is never capped. A loop's own
  budget (`claudeWeeklyMax`, `codexWeeklyMax`) pauses an occurrence the same way.

## Timeline and state

Every step is an `autopilot` event on the idea's timeline: run started, plan ready (with
Conductor's changes), plan approved, stage started (with model substitutions), decisions, artifacts
(as links), checkpoints and who answered them, standing rules, phone notifications with what
happened to them, loop occurrences and step outcomes, loop version changes, pauses and their
reasons, stage done, run completed. Stage conversations and the planner are linked to the idea.

Runs live in `conductor.db` (`idea_runs`, `idea_run_stages`, `idea_run_checkpoints`,
`idea_run_rules`). The controller ticks every 5 s (1.5 s in a test launch) and picks up where it
was after a restart: a turn that never reported is asked again, within the stage's turn budget.
Three failed ticks in a row pause the run with the error.

## App control

| Method | Who | What |
| --- | --- | --- |
| `ideas.run({ideaId, planner?, model?, dryRun?})` | any agent that may change ideas | start a run in the caller's project; returns it in `planning` |
| `ideas.runs({ideaId?, runId?})` | everyone | runs with plan, stages, checkpoints, rules |
| `ideas.run.approve({runId})` | owner credential | approve the plan |
| `ideas.run.decide({checkpointId, decision, standing?, note?})` | owner credential | answer a checkpoint |
| `ideas.run.pause({runId})` | any agent that may change ideas | pause |
| `ideas.run.resume({runId})` | owner or wizard | resume |
| `ideas.run.stop({runId})` | any agent that may change ideas | stop for good |

A local model and a read-only or planning conversation only read. Phone:
`GET /api/idea-runs` (pending checkpoints and runs), `POST /api/idea-runs/checkpoints/:id
{decision, standing?, note?}`, `POST /api/idea-runs/:runId/approve|pause|resume|stop`.

## Testing

`src/main/idea-runs/idea-runs.test.ts` covers plan normalization, the provenance and standing
rules, report parsing, budgets and caps, the loop file and its auto-safe adjustment, model choice,
the controller end to end (plan, approval, three stages, a scheduled occurrence, a checkpoint, a
loop advance, the timeline), the weekly-cap and time-budget pauses, and app-control authority.

`scripts/smoke-idea-autopilot.mjs` runs a harmless dry-run idea ("Paperface Club") in a parked
instance on fixture agents: in a test launch every idea-run prompt starts with
`SYNTHETIC IDEA-RUN <key>` and `scripts/fixtures/fake-claude.mjs` answers it from the scenario file
named by `CONDUCTOR_TEST_IDEA_RUN_SCENARIO`. It clicks *Run this idea* and *Approve plan*, fires the
scheduled task, answers the checkpoint on a paired phone's `#/idea-runs`, and checks the loop's v2,
the linked artifact and all timeline steps. Evidence: `artifacts/verification/2026-09-25-idea-autopilot/`.

## Running a real idea

The autopilot never creates an account, posts, messages anyone or spends without the owner's
approval of that exact action, but it can only do what its agents can reach. For the owner's
Instagram mask-brand idea (`idea_mugx6gkj_dpiqsfm`) that means, from the owner:

- **Accounts the owner creates or approves:** an Instagram professional (business/creator) account
  and a Facebook page for it; a Shopify store (plan and payment method); a domain if wanted.
- **API access:** a Meta app with Instagram Graph API publishing and comment permissions (content
  publishing and comment moderation need app review), or approved computer use on a logged-in
  browser session instead (Codex Astra, used sparingly as the idea asks); Shopify Admin API
  access token for the store.
- **Media generation:** keys and credit for the video/image models the plan picks (for example a
  video model API such as Runway, Veo or Kling, and an image model for the logo), with their
  outputs kept labeled as AI-generated.
- **Spend limits:** a euro budget per stage for generation credit, ads and samples, and the order
  budget for stock; purchases and orders always pause for approval.
- **Decisions:** the brand name and logo after the brand/copyright check, and which supplier to
  order stock from when the run says the numbers justify it.

One part of that idea is refused by design: stripping the AI markers from the videos before
uploading. The run keeps the labels and metadata, and posts with the platform's AI label on.
