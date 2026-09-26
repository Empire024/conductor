# Agent roster: the roles Conductor's own work runs

Orchestration → **Agents** lists these (source: `src/shared/agent-roster.ts`, seeded by
`src/main/orchestration-store.ts` into a project that holds the role's first brief). **Start** on a
card opens a tab on the role's provider, model, effort and permission and sends its instructions
plus the goal you type (no goal: it reads its brief and asks). A cloud role needs a goal. The owner
may rename an entry or change its model; the brief text is kept current by Conductor.

A controller or wizard that opens a role itself with `tabs.open` uses the same settings. Open the
Approval reviewer with `permission: 'read-only', exactPermission: true`: on Claude that is plan mode
(it reads and searches, changes nothing). Never open it on Ask under a wizard: every tool call of an
Ask coworker is sent to a fresh stronger-model review.

| Role | Model · effort · mode | Brief | When to use |
|---|---|---|---|
| Swarm orchestrator | Claude opus[1m] · high · Auto (wand on = wizard) | docs/swarm/orchestrator.md, docs/swarm/worker-rules.md | A batch of owner items: plan, partition, dispatch ≤4 fixers, verify, ship, publish once |
| Fixer | Claude opus[1m] · high · Auto | docs/swarm/worker-rules.md | One bounded item group with owned files |
| Verifier | Claude opus[1m] · high · Auto | docs/verification/verifier-brief.md, .conductor/loops/verify.md | After delivery: adversarial check against the owner's words (verify loop v3) |
| Verifier runner | Claude sonnet · low · Auto (the effort docs/verification/verifier-brief.md dispatches it at) | .conductor/loops/verify.md | Re-run committed smokes unchanged, collect logs; no verdicts |
| Architect | Codex gpt-6-astra · high · Auto (alternate Claude opus[1m]) | .conductor/loops/batch-delivery.md | The contract step of batch delivery and task triage: failing tests, acceptance commands, allowedPaths |
| Code reviewer | Claude opus[1m] · high · Auto, a fresh tab (alternate Codex gpt-6-astra) | .conductor/loops/batch-delivery.md | The locked review step: reads the batch’s git diff once within allowedPaths, approves or lists changes |
| Approval reviewer | Claude opus[1m] · high · Read only (plan mode; never Ask) | src/main/approval-review.ts, docs/approval-upgrade-brief.md | Automatic under a wizard (one review per held approval); by hand to re-review |
| Updater | local qwen3.6-35b-a3b · Edit | .conductor/loops/update-readback.md, docs/conductor-local-updates.md | Build the local update, read it back, verify after install |
| Loop runner | Claude sonnet · medium · Auto | docs/logic-loops.md | Run a saved `.conductor/loops` procedure (loops.run / loops.record) |
| Loop improver | Codex gpt-6-astra · high · Auto | docs/logic-loops.md | Propose loop changes from metrics (loops.propose / loops.apply) |
| Overseer | Claude opus[1m] · medium · Auto | docs/overseer.md, scripts/overseer.mjs | Unattended goal loop: launch and watch scripts/overseer.mjs |
| Recovery agent | Claude opus[1m] · high · Auto | docs/recovery-mode.md | Conductor did not come back after an update or restart |
| Project controller | Claude opus[1m] · high · Auto | docs/swarm/project-controller.md | Work in another open project (haftheme-style), incl. the Mac node |
| Autopilot controller | Codex gpt-6-astra · high · Auto | docs/autopilot-brief.md | Long durable sweep; resume from docs/autopilot-backlog.md |
| Local model helper | local qwen3.5-9b · Edit | docs/local-assist.md | Bounded reading/churn that saves frontier tokens |
| Cloud coworker | Claude Code cloud, claude-opus-5-5 · high | docs/cloud-coworker.md | Work off this machine on the GitHub repository |
| Auto Fixer | Claude (owner's choice) | built in (`AUTO_FIXER_INSTRUCTIONS`) | Project tasks: pick a model per task, dispatch, review |
