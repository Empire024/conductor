# Conductor Autopilot master backlog

## Live operational summary

- Updated: 2026-09-23 23:54 UTC (2026-09-24 local). Controller: `agent_muer8ymv_5sx2164`; workspace `session_muer689g_gcuiloy`.
- Objective: complete the evidence-based Conductor sweep, then resolve reliability blockers through bounded Grok work, cheap local labor and selective Opus review.
- Running: S1 repository inventory on local Qwen 3.6 35B-A3B. Dispatching Grok baseline and core completed-claim audit.
- Active worker: `agent_muerczw7_p9xz3df`, tab `tab_muercyyx_hgsngej`, allowed write only `docs/autopilot-evidence/local-inventory.md`. Prior dispatch `agent_muercefs_o04vmv5` was rejected before execution because local read-only mode is unsupported.
- Grok workers: S2 baseline `agent_muerh0kt_k3ncw1b` / `tab_muerh09q_69l97eo`; S3a core claims `agent_muerh3f2_2ehll4v` / `tab_muerh30z_yo5mg2c`. Both accepted on Auto. S2 owns heavy-check slot after controller's initial documentation delivery; S3a is source/evidence review only.
- Verified completions: none. Initial control reads succeeded; these are inventory evidence, not product acceptance.
- Claims to verify: 314 checklist items: 279 done claims, 32 todo, 3 doing. All 279 done claims remain unverified until recorded against their acceptance requirements. No false-completion has yet been independently established or reopened.
- Blockers: existing smoke-slot grant is stale (2026-09-21) and belongs to another agent/script; no Electron smoke authorized by that grant. Grok quota telemetry is still a capability gap, but no longer blocks dispatch.
- Provider usage: Astra/Codex 78% weekly consumed at 23:51:33 UTC; hard stop 95%. Claude account 46% at 23:50:33; hard stop 60%. Fable-specific bucket 74% is separate, not universal Claude allowance; do not use Fable. Grok percentage unknown. **Owner override (2026-09-24): use Grok until it reports it cannot work anymore; this supersedes Grok's 95% ceiling and unknown-quota dispatch block.** Do not blindly retry exhaustion. Astra/Claude ceilings remain unchanged.
- Owner clarification: investigate whether Grok itself exposes the ceiling. Continue while unknown under the override; use the original 95% threshold if an authoritative percentage becomes available. Never infer quota from context tokens or dollar spend.
- Local compute: one existing llama-server PID 31984, model `local/qwen3.6-35b-a3b`, port 51436, started 23:35:45 UTC. Reuse it; no downloads, installs, second server, or model switch while in use. Machine profile read.
- Capability gaps: G1 quota read/enforcement in app control; G2 local-server inventory/stop API (existing checklist task); G3 local read-only dispatch is advertised but rejected; G4 indexed file search returns recovery/artifact copies before source files.
- Repository: initial HEAD `e3aa6645beb0ce3682c1aa5bc33e24d717e5a423`, main ahead 29. Preserve pre-existing `feature-list.md`, `src/main/agent-control.ts`, and owner-authored untracked `docs/autopilot-brief.md`. Controller owns this backlog and audit evidence only. Use scoped `git.ship`, never publish.
- Next actions: finish S1; obtain Grok usage; dispatch S2 baseline and S3 completed-claim audit; inspect current durable-job review findings as P0 candidates; independently verify; commit each material checkpoint. Handoff before controller context becomes expensive.

## Operating and evidence rules

Read `docs/autopilot-brief.md` in full before resuming. Controller coordinates and verifies; Grok implements; Opus reviews sparingly; local models do bounded cheap work. Never interpret a report or existing checkmark as completion. Inspect diff, reproduce failures, run relevant checks, verify actual UI/workflows, and prove restart persistence for lifecycle changes. Unrun checks remain unrun. No `npm run dev`, visible smoke windows, publishing, version edits or external messages. Native agents open on Auto; local contracts restrict write scope. No more than four native coworkers; builds and smokes serialized.

Every entry below records title, problem, expected behavior, area/files, priority, dependencies, assignee, state, attempts, verification requirements, blockers, changes and final result. Imported checklist claims retain their original IDs and ownership; use fresh `tasks.list` revision and `tasks.update` only after evidence justifies a change. Do not overwrite another agent's edits. A lower-priority prerequisite may run first.

Evidence: initial control snapshots are in `artifacts/autopilot/{app.state,tasks.list,git.status,jobs.list,agents.list,models.list}.json` (machine-local, not committed). Durable audit reports belong under `docs/autopilot-evidence/`. Never place credentials in reports. The source checklist remains the full product specification for imported entries.

## Grok trust table

No prior success is inferred. Initial policy: independently verify every task, request an Opus sample for the first accepted change in each category when the Claude quota permits; retain mandatory strong review for critical risk. After three independent passes in a category without regression, sample roughly one in three ordinary changes; after ten, roughly one in five. A regression resets the category to frequent sampling. These are sampling policies, not substitutes for tests or workflow evidence.

| Category | Independently passed | Failed/reopened | Trust | Opus sampling / risk |
| --- | ---: | ---: | --- | --- |
| React/UI | 0 | 0 | unmeasured | first change, then evidence-based taper |
| Electron/main process | 0 | 0 | unmeasured | first change; critical lifecycle always strong review |
| Persistence/database | 0 | 0 | unmeasured | migrations/data loss always strong review |
| Agent orchestration | 0 | 0 | unmeasured | concurrency/lifecycle always strong review |
| Model-provider integrations | 0 | 0 | unmeasured | first change; auth always strong review |
| Terminal/PTY | 0 | 0 | unmeasured | first change; process ownership strong review |
| Networking/remote control | 0 | 0 | unmeasured | remote execution/auth always strong review |
| Tests | 0 | 0 | unmeasured | first change; inspect whether assertions prove behavior |
| Refactors | 0 | 0 | unmeasured | first change; no behavior drift |
| Build tooling | 0 | 0 | unmeasured | first change; delivery integrity strong review |
| Security-sensitive code | 0 | 0 | unmeasured | always strong review |

## Sweep and capability tasks

### S1 — Repository and TODO inventory
- Priority/state/assignee: P1 / running / `agent_muerczw7_p9xz3df` (local Qwen 3.6 35B-A3B).
- Problem: subsystem coverage and actionable code markers are not inventoried.
- Expected: concise file/line inventory across every section-1 subsystem, with unknowns distinguished from defects.
- Area/files: `src/`, `scripts/`; report `docs/autopilot-evidence/local-inventory.md` only.
- Dependencies: existing local server; no cloud quota dependency.
- Attempts: first local dispatch requested read-only and failed `Execution sandbox unsupported by this provider`; changed to bounded report-only contract, accepted. No cloud escalation.
- Verification: controller independently samples referenced files/lines and reconciles coverage; inventory is not proof of feature completion.
- Failures/blockers: local read-only mode unsupported; bounded contract is the available alternative.
- Changes/commits: none yet. Final verification: pending.

### S2 — Reproducible test/typecheck/build baseline
- Priority/state/assignee: P0 / dispatched / Grok `agent_muerh0kt_k3ncw1b`.
- Problem: historical green checks do not prove current checkout health.
- Expected: timestamped typecheck, full tests/script tests and production build results, exact commands, exit codes and logs; separate failures from concurrent edits.
- Area/files: `package.json`, Vitest/TypeScript/build config, source tests, `docs/autopilot-evidence/baseline.md`.
- Dependencies: serialize heavy work and delivery; preserve other edits.
- Attempts: package scripts read through files.read; no checks run yet.
- Verification: inspect actual logs and changed-file snapshot; reproduce unique failures before repair. Do not launch Electron.
- Failures/blockers: waits for controller documentation delivery before heavy checks. Changes/commits: none. Final verification: pending.

### S3 — Audit all completed checklist claims
- Priority/state/assignee: P1 / first batch dispatched / Grok `agent_muerh3f2_2ehll4v` (core workflow claims, max 40).
- Problem: 279 completion claims have no fresh independent acceptance evidence.
- Expected: one evidence matrix row per claim: ID, area, claimed behavior, source/test evidence, runtime evidence, result (verified/failed/unverified), precise next check. Reopen only established false claims.
- Area/files: `feature-list.md`, affected source/tests/smokes; audit reports under `docs/autopilot-evidence/`.
- Dependencies: S1 and S2 inform sequencing; live checks need current smoke lease.
- Attempts: initial tasks.list captured 279 done claims. None accepted by this controller.
- Verification: inspect each result against actual behavior; source presence or passing unrelated tests is insufficient. Lifecycle claims need restart proof.
- Failures/blockers: scope needs bounded stages; Grok quota signal and runtime slots pending.
- Changes/commits: none. Final verification: pending.

### G1 — Read provider quota cheaply through app control
- Priority/state/assignee: P1 / discovery / unassigned.
- Problem: tools.list exposes no account quota method; reading usage requires expensive event retrieval, and Grok maps token spend without weekly quota.
- Expected: bounded current per-provider/model quota with observation time, reset time, source and explicit unknowns; controllers can enforce 60% Claude and 95% Astra/Grok limits before dispatch.
- Area/files: `src/main/agent-control.ts` (currently owned by another agent), provider usage APIs, `src/shared/usage-accounting.ts`.
- Dependencies: coordinate file ownership; authoritative Grok source, no fabricated quota.
- Attempts: inspected tools.list and Grok usage mapping; read recorded Codex/Claude usage via read-only SQLite; requested owner source for Grok.
- Verification: zero-turn read, model-specific buckets, stale/unknown behavior, no secrets; independent review of dispatch enforcement.
- Failures/blockers: source for Grok percentage unknown. Changes/commits: none. Final verification: pending.

### G3 — Local read-only dispatch parity
- Priority/state/assignee: P2 / reproduced / unassigned.
- Problem: local router dispatch with read-only/exactPermission is rejected despite API text advertising that mode.
- Expected: support a genuinely read-only inventory worker, or accurately advertise/reject unsupported mode before leaving an unused tab/task.
- Area/files: local capabilities/sandbox, router/agent-control dispatch, provider mode declarations.
- Dependencies: coordinate agent-control ownership; do not weaken sandbox.
- Attempts: recorded rejected `agent_muercefs_o04vmv5`; report-only contract accepted in separate worker.
- Verification: focused tests and actual local dispatch; assert forbidden writes remain impossible and failed dispatch cleanup is correct.
- Failures/blockers: root cause not investigated. Changes/commits: none. Final verification: pending.

### G4 — Relevant indexed file search
- Priority/state/assignee: P3 / observed / unassigned.
- Problem: files.list query usage returns recovery and artifact copies before active source, bloating retrieval.
- Expected: active project source ranks first; generated/recovery copies explicitly filterable without hiding requested files.
- Area/files: project file index/search, agent-control files.list.
- Dependencies: none.
- Attempts: reproduced through files.list({query:'usage'}).
- Verification: deterministic fixtures containing source, artifacts and recovery copies; active source remains findable within 100 results.
- Failures/blockers: prioritization only. Changes/commits: none. Final verification: pending.

## Imported open product tasks

These entries are planning records, not newly claimed work. Full original descriptions remain in `feature-list.md` under the matching conductor-task ID. No original owner/status has been changed.

### durable-jobs-review-fixes — Durable jobs: fix the independent Opus review findings on commits 03aed7b + 51d2fb7 (src/main/durable-jobs/): (1) an approval block never releases the LocalGenerationGate so the ne…
- Priority/state/assignee: P0 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Durable jobs: fix the independent Opus review findings on commits 03aed7b + 51d2fb7 (src/main/durable-jobs/): (1) an approval block never releases the LocalGenerationGate so the next job waits forever showing running (wiring.ts ~289-303, controller.ts ~348-352); (2) only model-call watches are started so a quiet tool run (test/build) is killed as a stall and toolCallTimeoutMs is never applied (wiring.ts ~145-167); (3) ServerSupervisor.ensureReady… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `durable-jobs-review-fixes`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### durable-jobs-verification — Durable jobs: finish verification. Done and passing: unit suites, real qwen3.6-35b-a3b 4-stage job in fresh contexts (peaks 18.9k-21.6k of 32,768, no overflow, no cloud escalation)…
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Durable jobs: finish verification. Done and passing: unit suites, real qwen3.6-35b-a3b 4-stage job in fresh contexts (peaks 18.9k-21.6k of 32,768, no overflow, no cloud escalation), stub smokes for tab close/reopen, renderer reload, pause/resume/cancel, approval->blocked, app restart with reconciliation. NOT RUN: real-model --kill-server and --restart-app faults, the approval case against the real model, stub --loop-case and --stall-case, and the… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `durable-jobs-verification`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### grok-agent-control-hunks — Commit the Grok provider hunks still uncommitted in src/main/agent-control.ts (bb9b8f2 landed the rest of Grok; the working-tree hunks are in local build 0.1.53-local.1790206266727…
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Commit the Grok provider hunks still uncommitted in src/main/agent-control.ts (bb9b8f2 landed the rest of Grok; the working-tree hunks are in local build 0.1.53-local.1790206266727 but in no commit), together with the durable-jobs createdBy hunk in the same file; stage by hunk, do not commit unrelated work.
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `grok-agent-control-hunks`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### app-update-no-dialog-in-auto — Stop asking the owner to confirm app.update from a coworker running in Auto. Building a local update only publishes "Update pending" to the local feed; it cannot install itself, an…
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Stop asking the owner to confirm app.update from a coworker running in Auto. Building a local update only publishes "Update pending" to the local feed; it cannot install itself, and only the owner credential or a wizard tab (which is trusted for exactly that) may run app.update.install or app.restart. So app.update from a native Claude/Codex coworker in Auto should just run, without the owner dialog and without needing app.update.authorize; keep … (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `app-update-no-dialog-in-auto`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### ship-delivery-speed — Speed up git.ship deliveries: a routine local delivery takes ~4 min (153 s full vitest + script tests, 72 s tsc + electron-vite). Run the test and build stages in parallel, select …
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Speed up git.ship deliveries: a routine local delivery takes ~4 min (153 s full vitest + script tests, 72 s tsc + electron-vite). Run the test and build stages in parallel, select affected tests by import graph when paths are given (full suite only on publish), skip test:scripts unless scripts/ changed, make the typecheck incremental and run it beside electron-vite, and skip the isolated-worktree copy when the tree is clean. Target: about one min… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `ship-delivery-speed`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 88138288-448e-4f07-827b-0e029b33d6fb — Encountered a bug where I thought all crashed + ctrl tab showed me Usage view was actually somehow open or something and after closing it I could use this app again - clicking anyw…
- Priority/state/assignee: P0 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Encountered a bug where I thought all crashed + ctrl tab showed me Usage view was actually somehow open or something and after closing it I could use this app again - clicking anywhere did nothing till i did ctrl tab.. fix
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `88138288-448e-4f07-827b-0e029b33d6fb`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### feature-file-type-colors — Match VS Code file type colors/icons for every language and extension (.mjs, .cjs, .ts, .tsx, .json, .css, .md, .ps1, .yml, dotfiles, ...), applied consistently in the explorer, fi…
- Priority/state/assignee: P3 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Match VS Code file type colors/icons for every language and extension (.mjs, .cjs, .ts, .tsx, .json, .css, .md, .ps1, .yml, dotfiles, ...), applied consistently in the explorer, file tabs, Ctrl+E picker and agent file links.
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `feature-file-type-colors`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 19c298e4-2bea-4164-bba3-25d73bba22d4 — Exiting Conductor still shows tabs that are actually inactive & have been for a while i.e. tasks that are not running currently..
- Priority/state/assignee: P0 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Exiting Conductor still shows tabs that are actually inactive & have been for a while i.e. tasks that are not running currently..
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `19c298e4-2bea-4164-bba3-25d73bba22d4`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### ea74d128-494c-47cf-9cc6-89aed5fecf9d — Schedules were supposed to be scheduled tasks i.e. an agent can create a scheduled task if asked & it runs automatically. Currently, it only has the model updates schedule which wa…
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Schedules were supposed to be scheduled tasks i.e. an agent can create a scheduled task if asked & it runs automatically. Currently, it only has the model updates schedule which was supposed to be just one of those scheduled tasks using the new scheduled tasks API we were supposed to be using. Essentialy, an agent can run a scheduled task for me, like gathering info, running certain code, etc. Each scheduled task can have scripts it can be runnin… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `ea74d128-494c-47cf-9cc6-89aed5fecf9d`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 3bbf4893-c6c1-4b90-91a4-a7b21bfeaf4d — archive tasks that are longer than 14 days old so we don't clutter our project tasks view (already very large)
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: archive tasks that are longer than 14 days old so we don't clutter our project tasks view (already very large)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `3bbf4893-c6c1-4b90-91a4-a7b21bfeaf4d`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 22fc5f94-c124-4d6e-a6ae-6157e1237934 — Create a version backup system allowing us to easily go back to an older version where everything was working as intended in case a version breaks something - that backup needs to …
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Create a version backup system allowing us to easily go back to an older version where everything was working as intended in case a version breaks something - that backup needs to have all models loaded in it as well - say if we update codex CLI and something stops working properly & our auto model checker schedule hasn't properly adjusted, we need to be able to, within couple clicks, get back to a working version to continue multi-agentic work.
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `22fc5f94-c124-4d6e-a6ae-6157e1237934`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 5a68facc-0abc-49c4-b0ae-8063644d4dc6 — To-do's don't show which is priority and which is weight, make sure it does on hover at least in project tasks view.
- Priority/state/assignee: P3 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: To-do's don't show which is priority and which is weight, make sure it does on hover at least in project tasks view.
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `5a68facc-0abc-49c4-b0ae-8063644d4dc6`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### fe4662b9-e2a6-4436-a753-62e7bbed9b9c — Projects & files left-side part needs to be expandable i.e. stretchable (so we can read filenames project names etc etc better
- Priority/state/assignee: P3 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Projects & files left-side part needs to be expandable i.e. stretchable (so we can read filenames project names etc etc better
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `fe4662b9-e2a6-4436-a753-62e7bbed9b9c`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### invoicing-approval-review — Invoicing swarm: permission parity repair and durable review gate implemented locally; 329 focused tests and build pass. Automatic native execution remains blocked pending an enfor…
- Priority/state/assignee: P1 / existing work, verification pending / retain source owner; no autopilot implementer assigned.
- Problem: Invoicing swarm: permission parity repair and durable review gate implemented locally; 329 focused tests and build pass. Automatic native execution remains blocked pending an enforceable mutation broker; live acceptance and delivery are unfinished. [Brief](docs/approval-upgrade-brief.md), [implementation evidence](docs/approval-upgrade-report.md). No deployment authorized.
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `invoicing-approval-review`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded doing status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### invoicing-bounded-recovery — Invoicing swarm: owner-scoped bounded observer recovery, preserve ownership and pending approvals, distinguish superseded failures, no implicit ancestor authority. [Brief](docs/app…
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Invoicing swarm: owner-scoped bounded observer recovery, preserve ownership and pending approvals, distinguish superseded failures, no implicit ancestor authority. [Brief](docs/approval-upgrade-brief.md).
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `invoicing-bounded-recovery`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### invoicing-runtime-budget — Invoicing swarm: native model effort parity, local remaining-round checkpoints and confirmed follow-up turn start. [Brief](docs/approval-upgrade-brief.md).
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Invoicing swarm: native model effort parity, local remaining-round checkpoints and confirmed follow-up turn start. [Brief](docs/approval-upgrade-brief.md).
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `invoicing-runtime-budget`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### invoicing-evidence-telemetry — Invoicing swarm: compact semantic monitoring, artifact-freeze handoff, evidence-linked attribution and actual orchestration/review/retry usage metrics. No net savings claim without…
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Invoicing swarm: compact semantic monitoring, artifact-freeze handoff, evidence-linked attribution and actual orchestration/review/retry usage metrics. No net savings claim without measurements. [Brief](docs/approval-upgrade-brief.md).
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `invoicing-evidence-telemetry`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 2ad233c6-9e4c-416c-b622-fa4bb49acadf — message needs to be able to be unsent in Conductor when still queued and not actually sent easily via clicking X or some keyboard shortcut
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: message needs to be able to be unsent in Conductor when still queued and not actually sent easily via clicking X or some keyboard shortcut
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `2ad233c6-9e4c-416c-b622-fa4bb49acadf`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### approval-auto-refusal-evidence — Approval Auto-refusal evidence: original 6 failures preserved; released source repair now passes 303 tests and build; native integration/delivery remains outstanding (agent_mucykb2…
- Priority/state/assignee: P1 / existing work, verification pending / retain source owner; no autopilot implementer assigned.
- Problem: Approval Auto-refusal evidence: original 6 failures preserved; released source repair now passes 303 tests and build; native integration/delivery remains outstanding (agent_mucykb2d_xjxx7ve): [reproduction and native boundaries](docs/approval-auto-refusal-repro.md), [isolated regression tests](src/main/providers/codex-auto-refusal.regression.test.ts). Existing implementation remains with agent_mucxgir3_mmkk8m6; no installed-app fix or deployment … (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `approval-auto-refusal-evidence`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded doing status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### codex-auto-owner-escalation — Codex Auto owner escalation: released adapter source repaired and verified (303 tests + build); pending native approvals render enabled Allow/Deny, changed arguments expire stale c…
- Priority/state/assignee: P1 / existing work, verification pending / retain source owner; no autopilot implementer assigned.
- Problem: Codex Auto owner escalation: released adapter source repaired and verified (303 tests + build); pending native approvals render enabled Allow/Deny, changed arguments expire stale cards, responses do not replay. Installed app unchanged; native acceptance/delivery pending. [Operating brief](docs/local-worker-operating-brief.md), [source/test handoff](docs/local-worker-runtime-report.md). Broker/reviewer integration remains with agent_mucxgir3_mmkk8… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `codex-auto-owner-escalation`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded doing status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 9fb1c9c5-a27d-4a2c-96f7-2cfb5cd810ce — refine way we queue messages, if one is queued and we send another, they need to be send immidiately together in one turn, right now were wasting tokens and having me bash escape s…
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: refine way we queue messages, if one is queued and we send another, they need to be send immidiately together in one turn, right now were wasting tokens and having me bash escape stopping the model altogether and having me write continue!
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `9fb1c9c5-a27d-4a2c-96f7-2cfb5cd810ce`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 2c712217-c17e-4bb7-8813-ba7738444230 — Processes tab needs to scope all projects currently open in Conductor, but can't load this much data - it's very laggy now, loading projects from 2 weeks ago. It should realistical…
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Processes tab needs to scope all projects currently open in Conductor, but can't load this much data - it's very laggy now, loading projects from 2 weeks ago. It should realistically only show recent tabs to let us keep track of what's currently happening and churning and where and in which project and what needs attention like a little control board.
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `2c712217-c17e-4bb7-8813-ba7738444230`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 4ab12812-f74e-438b-8c4d-c0d9cc34221e — each local model needs it's own custom icon as well to differentiate them properly
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: each local model needs it's own custom icon as well to differentiate them properly
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `4ab12812-f74e-438b-8c4d-c0d9cc34221e`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### f0f8aaf7-80a2-41b2-968d-58c95a89c92f — typing in web app is broken on phone , content is too way up and we can’t see text. Make it easy to see what we’re typing no matter where.
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: typing in web app is broken on phone , content is too way up and we can’t see text. Make it easy to see what we’re typing no matter where.
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `f0f8aaf7-80a2-41b2-968d-58c95a89c92f`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 96d8efee-1cf5-403b-b9e4-28c5c602421e — Closing main tab needs to close all coworkers as well. In right click, close this tab only needs to exist. Default will be close tab group
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Closing main tab needs to close all coworkers as well. In right click, close this tab only needs to exist. Default will be close tab group
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `96d8efee-1cf5-403b-b9e4-28c5c602421e`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 764a7740-1109-4a61-a343-2310bf50ebab — Clicking CLI should let us actually see what's going behind the Chat window, currently it's unavailable when Chat is open. Chat open → click CLI → show the live CLI for that same a…
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Clicking CLI should let us actually see what's going behind the Chat window, currently it's unavailable when Chat is open. Chat open → click CLI → show the live CLI for that same agent Ideally as a bottom drawer / split pane under the chat, similar to VS Code's terminal. Clicking CLI again hides it. Chat stays fully alive and visible. CLI keeps rendering stdout/stderr in real time. User can type directly into it if the underlying provider allows … (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `764a7740-1109-4a61-a343-2310bf50ebab`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### f15c9164-a4d8-49c4-89d7-bbbbca87885d — to add to refine way we queue messages task ![image.png](.conductor/prompt-images/5d3c199c-ac6a-4cb0-948c-9d331c90c0ea.png)
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: to add to refine way we queue messages task ![image.png](.conductor/prompt-images/5d3c199c-ac6a-4cb0-948c-9d331c90c0ea.png)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `f15c9164-a4d8-49c4-89d7-bbbbca87885d`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 141e0a02-adfa-4710-8600-bc1eec348e3d — There are real renderer-side performance problems that can explain laggy typing even with Qwen completely stopped. I would not blame your PC first. The two biggest ones are especia…
- Priority/state/assignee: P3 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: There are real renderer-side performance problems that can explain laggy typing even with Qwen completely stopped. I would not blame your PC first. The two biggest ones are especially convincing: Every keystroke synchronously writes the entire composer draft to localStorage. The textarea calls setMessage() on every change; that calls ComposerDraftStore.update(), which does JSON.stringify(), localStorage.setItem(), generates a revision UUID, and t… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `141e0a02-adfa-4710-8600-bc1eec348e3d`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 9b15feab-3e3b-4e9a-b23a-76ce29538e4d — # Build: Conductor Ideas / Notes System ## Goal Conductor needs a lightweight **Ideas** system that lets me capture thoughts instantly and then gradually turns those thoughts into …
- Priority/state/assignee: P3 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: # Build: Conductor Ideas / Notes System ## Goal Conductor needs a lightweight **Ideas** system that lets me capture thoughts instantly and then gradually turns those thoughts into useful, connected work. The core use case is extremely simple: > I'm outside with friends, suddenly think "what if I started this clothing company?", open Conductor on my phone, type the thought in a few seconds, close it, and forget about it. I should not have to organ… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `9b15feab-3e3b-4e9a-b23a-76ce29538e4d`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 3775a5ec-84bc-4bf9-8f2c-00a13274e007 — web app - need to select what notifications i get - currently i get notifications i dont really need like coworkers getting finished when they dont need my attention - main tasks D…
- Priority/state/assignee: P3 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: web app - need to select what notifications i get - currently i get notifications i dont really need like coworkers getting finished when they dont need my attention - main tasks Done only i
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `3775a5ec-84bc-4bf9-8f2c-00a13274e007`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 53cd24fb-8c88-495c-bbd1-4d76128e5263 — coworker tab groups need to be able to be dragged to the side, so we can see the main & the coworker tabs side to side
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: coworker tab groups need to be able to be dragged to the side, so we can see the main & the coworker tabs side to side
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `53cd24fb-8c88-495c-bbd1-4d76128e5263`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### local-server-stop-control — Stopping the local model server must be one easy app-control call for an agent, not eight tool calls: an agent that found a Conductor-started llama.cpp server (e.g. Dolphin X1 8B, …
- Priority/state/assignee: P1 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: Stopping the local model server must be one easy app-control call for an agent, not eight tool calls: an agent that found a Conductor-started llama.cpp server (e.g. Dolphin X1 8B, pid 62380, port 51438) holding the GPU spent nine actions hunting for a stop path through tools.list, the CLI and the stop script. Add a first-class control method (e.g. `local.servers` to list the running Conductor-started model servers with model, pid, port, start tim… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `local-server-stop-control`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 9afebc80-8949-4a74-bbda-3475894d2ca0 — tasks must only show a part (when long tasks are visible, we scrollll like madmen) and be able to expand / hide again on click..
- Priority/state/assignee: P3 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: tasks must only show a part (when long tasks are visible, we scrollll like madmen) and be able to expand / hide again on click..
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `9afebc80-8949-4a74-bbda-3475894d2ca0`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### 24e307fa-1777-402d-a4e3-5dad3c93441f — tasklist - done tasks are hidden by default & the archive thingy i mentioned - currently we load waay too many tasks.. same for messages, we don't need to load all of them, just lo…
- Priority/state/assignee: P2 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: tasklist - done tasks are hidden by default & the archive thingy i mentioned - currently we load waay too many tasks.. same for messages, we don't need to load all of them, just load some and then load them when i scroll up - also enable me one click to just copy the entire chat transcript without scrolling up - its what i do often anyways and thats why i scroll up to see all messages.. and allow me to search in chat super efficiently.
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `24e307fa-1777-402d-a4e3-5dad3c93441f`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.

### wizard-answers-quit-dialog — A wizard tab must be able to get past the "Quit Conductor? / Restart Conductor? — Work is still running in Conductor" confirmation. It is a native dialog.showMessageBox (src/main/i…
- Priority/state/assignee: P0 / queued, unclaimed / retain source owner; no autopilot implementer assigned.
- Problem: A wizard tab must be able to get past the "Quit Conductor? / Restart Conductor? — Work is still running in Conductor" confirmation. It is a native dialog.showMessageBox (src/main/index.ts confirmApplicationStop, reached from before-quit and from prepareForUpdateInstall when force is false), so no agent can see or answer it and an unattended overnight wizard stalls behind it. A sovereign scope (wizard tab or owner credential) should (a) never rais… (full requirements at matching source ID)
- Expected behavior: satisfy the complete source checklist description, with explicit acceptance evidence; do not narrow its requirements silently.
- Area/files: feature-list.md ID `wizard-answers-quit-dialog`; affected source/test paths to locate in S1/S3 before implementation.
- Dependencies: baseline S2 and ownership check; split broad work into bounded stages before dispatch.
- Attempts: imported current recorded todo status; historical statements are unverified, no new implementation attempted.
- Verification requirements: derive behavior-specific reproduction, targeted tests, relevant broader checks/build and actual workflow evidence; persistence/lifecycle work requires restart verification.
- Failures/blockers: source claims and existing ownership require refresh; implementation evidence not yet reviewed.
- Changes/commits: none by autopilot. Final verification result: pending.
