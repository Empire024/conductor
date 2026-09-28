# Model intelligence and routing — independent verification, 2026-09-28

Verifier: `agent_mul9d2jx_521c5r3` (Claude Opus, Auto). Controller: `agent_mul69e93_at3uf5h`. I built none of it.
Scope: `docs/model-routing.md`, `src/shared/model-routing.ts`, `src/main/model-intelligence/**`, and the wiring hunks in
`agent-control.ts`, `index.ts`, `approval-review-gate.ts`, `control-method-classes.ts`, `control-activity.ts`,
`agent-control-server.test.ts` and `docs/agent-control.md`. I ignored the unrelated local-models scraper, the Codex question
fix, the structured-sessions hunks and `feature-list.md`. I changed no product code and shipped nothing. I launched no Electron app, ran no smoke
and started no llama server.

## Verdict

**The loop works end to end over the real modules. In the running app it does not yet route well, because two
inputs the scorer depends on are never supplied by the app wiring.**
The chain discover → registry → understand task → candidates → route → execute → record → influence future routing is
really implemented and connected. Its capture path starts from the app's real broadcast observer, and my own tests
drove every step through the real store, registry, reputation, scorer, DecisionService, router and control methods on a
temp-file `conductor.db`. The *verify* step is weak: a completed turn counts as `success` unless the owner, a wizard or
the controller corrects it with `models.outcome`, or a durable-job verifier or an evaluation grader judges it.

The defects that matter for the owner's criteria:

1. **As wired, a fresh install sends high-risk difficult coding to the local model** (FAIL for that criterion in the app). The router prefers the strong model only
   when reputation or benchmark evidence says it is better. The app wires no benchmark source and puts no prices on
   CLI keys, and it has no Conductor evidence yet. So every candidate has the same 0.6 default prior, and the zero-cost local model wins
   (`Selected: local/qwen3.6-35b-a3b … 39% success … (10th percentile)`, utility 0.706 against 0.556 for Opus).
2. **In the app, a close route call never reaches a frontier decider.** `createModelIntelligence` receives no `frontier` port, so
   a close call keeps the scorer's top pick with `escalationReason: 'close call, no frontier configured'`. Escalation works when a frontier port is supplied.
3. **`decisions.get` shows no fallback and none of the route's reasons.** Those exist only in the `models.route` and `router.dispatch` response.
4. **The router ignores live VRAM and admission.** `routeLive` does not implement `localAdmission`, so the VRAM filter and the "cannot be admitted now" filter never fire.
5. **Reset and model-scoped usage windows exclude a whole provider.** `usagePercent` takes the maximum over every window, including windows already reset and model-specific windows.

## Implemented features (confirmed by reading the code and running it)

- **Store** (`store.ts`): its own `DatabaseSync` connection in WAL mode with a busy timeout, schema version 1, indexed and bounded queries, and nested
  transactions that roll back as a whole. Retention prune runs in bounded batches. Outcomes are idempotent on (source, ref, key).
- **Registry** (`registry.ts`): observations are append-or-confirm with provenance. The effective record is chosen by live listing, then authority, then recency.
  `new-model`, `new-provider`, `price`, `context`, `capability`, `availability`, `deprecated` and `removed` changes are recorded. A key becomes `retired` when every source
  has dropped it. `stale` is computed on read from `updatedAt` older than 7 days. Families link keys (`familyOf`).
- **Ingestion** (`ingest/*`): the sources are configured, runtime, latest-models, OpenRouter (8 s timeout, conditional GET, 32 MB cap) and benchmarks. Sources are
  fetched in parallel, and each source is applied in one transaction of its own. A failing source is isolated.
- **Telemetry**: capture adapters exist for a turn, a durable-job stage, a local-agent stop and an approval review. `categorize.ts` is a keyword heuristic.
- **Reputation**: a Beta posterior with 8 prior pseudo-counts and a 30-day half-life, a 10th-percentile `lower`, and priors from benchmarks, then the family, then the default. It covers the
  behaviour dimensions and the "proven" count.
- **DecisionService**: system-one, then frontier escalation on shadow mode, a system-one failure, low confidence or margin, a frontier-only choice, or high impact. The journal is
  written, and threshold overrides are kept in settings.
- **Scorer and router**: hard filters, utility, softmax with T = 0.08, exclusion of a local model that keeps failing, fallback, escalation, provider reasons and effort choice.
- **Evaluation**: suite validation and deterministic graders. Docker command graders run with `--network none`, and the outcome source is `evaluation`.
  The status moves unproven → evaluating → proven or unproven, and a Markdown report is written.
- **Control methods**: `models.registry`, `models.route`, `decisions.list`, `decisions.get`, `models.refresh`, `models.outcome` and
  `models.evaluate` are classified, have signatures and are documented. `models.list` gains `registry` and `reputation`. `router.dispatch` accepts `route`.
- **App wiring** (`index.ts` → `startModelIntelligence`): it starts in the background, a startup refresh and an hourly check for the daily pass are set up, the
  latest-models watcher runs, OpenRouter is used only outside test and offline profiles, `turnObserver` is registered on `onBroadcast`, and `withStageCapture` wraps
  the durable handoff port. The approval shadow is set through `AgentControl.setModelIntelligence`.

## Tests performed

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run src/main/model-intelligence` | 26 files passed and 1 skipped; 190 tests passed and 1 skipped (the live test) |
| `MODEL_INTEL_LIVE=1 npx vitest run src/main/model-intelligence/ingest/openrouter.live.test.ts` (once, temp store) | 1 passed; **440 OpenRouter models** ingested with prices, context, capabilities and provenance (sample `openrouter/anthropic/claude-fable-5`: $10/$50 per MTok, 1M context, family `claude-fable-5`) |
| `npx vitest run src/main/approval-review src/main/agent-control src/main/durable-jobs src/main/durable-jobs-ipc.test.ts` | 25 files passed (gate 15, shadow 3, acceptance 4, agent-control 121, endpoint 6, durable-jobs controller/store/wiring/…) |
| `npx vitest run --config .conductor-scratch/model-routing/verify/vitest.config.mts` (my tests, real modules, temp-file db) | `loop.verify.test.ts` 15/15 and `gate-shadow.verify.test.ts` 4/4 passed |
| `npm test` (full) | vitest: 408 files passed, 1 failed, 1 skipped; **4480 tests passed, 1 failed, 9 skipped**. The one failure is `src/main/database-wal.test.ts` (FX33 WAL) timing out at 5000 ms. That file and `database.ts` are unmodified in the working tree, and the test makes 3000 synchronous commits; rerun alone with `--testTimeout=60000` it passes in 4.9 s, so it is a machine-load timing flake, not a regression. `npm run test:scripts` (skipped by the `&&` after the vitest failure, run separately): 193 tests, 190 passed, 0 failed, 3 skipped |

`run_and_summarize` timed out client-side at the MCP layer, which killed its `npm test` child after about 1 minute (log
`.conductor-scratch/local-assist/2026-09-28T13-12-59-890Z-88187d.log`). I reran the suite directly with the full log in
`.conductor-scratch/model-routing/verify/npm-test.log`.

## Evidence per requirement

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| Registry: records persist | PASS | `loop.verify` "persists across reopen": dispose, then a new service on the same file keeps every record and its provenance. The "survive a restart" test also keeps decisions and reputation (mean equal to 1e-10). |
| Registry: several providers for one model coexist | PASS | `codex/gpt-5.6-sol` and `openrouter/openai/gpt-5.6-sol` are separate records in the same family, and `registry.family(CHEAP)` lists the OpenRouter key. Caveat: CLI aliases without a version (`claude/opus[1m]`, label "Opus (1M context)") get `family: null`, so they never link to `openrouter/anthropic/claude-opus-5.5`. |
| Registry: provenance retained | PASS | Per-field `provenance` names `aggregator/openrouter` or `config/configured:claude`. A `creator` observation beats the aggregator on `contextTokens`, and both values stay in `model_observations`. |
| Registry: updates neither duplicate nor corrupt | PASS | A re-refresh gives zero changes, zero observations added and identical row counts in all 7 tables. An invalid observation inside a batch throws and leaves the tables and the `model_registry` dump byte-identical. |
| Ingestion: a real external source | PASS | Live OpenRouter: 440 models into a temp store (above). |
| Ingestion: a failing source corrupts nothing | PASS | Network error, HTTP 500, invalid JSON and an empty list all end `failed`. `configured` in the same refresh stays `ok`, and table counts and the registry dump are unchanged. |
| Ingestion: changes detected | PASS | `price` (5 → 4), `new-model` and `removed` (then `retired`) are emitted. |
| Ingestion: staleness identifiable | PASS | 8 days without confirmation gives `stale: true`; a refresh gives `false`. |
| Telemetry: outcome records with success, failure, retry, cost and time | PASS (with a gap) | Rows keep `result`, `retries`, `costUsd` and `durationMs`, and they are idempotent. Turn capture always stores `retries: 0` (`turnSettled` never passes it); only durable-stage capture fills in retries. |
| Telemetry: categories queryable | PASS | `store.outcomes({category})` and `({key, category})` return only that category. |
| Telemetry: capture reached from the real observers | PASS for dispatched turns, durable stages and approval reviews; NOT WIRED for local-agent stops | Call path: provider adapter `emit` → `StructuredSessions.flush` → `broadcastEvents` → `broadcast('structured:events')` (the agent-manager `broadcast` passed in at `agent-manager.ts:320`) → `broadcastListeners` → `onBroadcast(turnObserver(...))` (`index.ts:2866`) → `service.turnSettled` → `captureTurn` → `store.recordOutcome`. It only fires for agents bound by `router.dispatch` (`agent-control.ts` `bindDispatch`); owner tabs and `tabs.open` coworkers are never captured. Durable stages: `withStageCapture(durableJobPorts(...))` (`index.ts:2763`) → `stageSettled`. Approval: gate `shadow.reviewed/answered` → `captureApprovalReview`. `captureLocalAgentStop` has no caller (the doc says so). The builders' `wiring.test.ts` drives the real `StructuredSessions` → `turnObserver` path, and I reran it (it passes). |
| Reputation: changes with outcomes | PASS | 10 successes lift the difficult-coding mean from 0.6 to above 0.8; 2 failures lower it again. |
| Reputation: categories distinct | PASS | `research` stays at the 0.6 prior while `difficult-coding` moves. |
| Reputation: small samples don't overwhelm priors | PASS | After 10 successes, 2 failures leave the mean above 0.7. Against the default prior, 2 failures leave the mean above 0.45. |
| Router: local, cheaper cloud and stronger cloud | PASS (with evidence) / FAIL (as wired) | With a price sheet and prior outcomes: a cost-priority trivial task goes to local, then to `codex/gpt-5.6-sol` with local excluded, and hard high-risk work goes to `claude/opus[1m]` with a fallback. **As wired**, CLI keys have no price and there is no benchmark source, so cheap and strong cloud are never told apart by cost or prior, and hard high-risk coding goes to local (see Verdict 1). |
| Router: high cost priority prefers cheap/local | PASS | See above. |
| Router: high-risk complex coding prefers the stronger model | PASS only with evidence or benchmarks; **FAIL as wired on a fresh install** | See Verdict 1 and D1. |
| Router: a local model that keeps failing is no longer preferred | PASS | After 6 summarization failures local is `eligible: false`, with the reason shown in the explanation. |
| Confidence escalation | PASS with a frontier port; **PARTIAL in the app** | With a fake frontier, equal candidates give `confidence 0.50 < 0.55; margin 0.00 < 0.15`, the frontier decides, both verdicts are journaled, and a clear route does not call it. The app supplies no route frontier, so the record stays unescalated with `close call, no frontier configured` (D2). |
| Feedback | PASS | `models.route` → `models.outcome({decisionId, result:'failure'})` records an owner outcome for the chosen key and category. Local expectedSuccess goes 0.391 → 0.331 → 0.287, and the 4th route picks `codex/gpt-5.6-sol`. The builders' wiring test covers the `router.dispatch` → captured turn → amended outcome variant. |
| New model | PASS (local keys only) | The new key is `unproven`. `models.evaluate` with a fake local run port and 12 exact-graded jobs (9 pass) records `evaluation` outcomes, the status becomes `proven`, and the next route's candidate has evidence of about 8 and a changed expectedSuccess. Cloud evaluation is refused as not wired. |
| Explainability | PARTIAL | `models.route` / `router.dispatch` `explanation` has the selection, provider, effort, reasons (success with evidence count, cost, exclusions, capability), fallback, escalation and confidence. `decisions.get` has the choice, provider, confidence, verdict probabilities, options with `expectedSuccess`/`expectedCostUsd` facts, outcome and linked executions, but **no fallback and no route reasons** (D3). |
| Approval shadow: gate byte-identical | PASS | `gate-shadow.verify.test.ts` compares every published event, response, journal record, persisted setting and reviewer call (UUIDs, timestamps and temp-path-derived digests normalised) with no shadow, a real shadow and a throwing shadow, for reviewer allow, deny, escalate→owner allow and escalate→owner deny. All are identical. |
| Approval shadow: a shadow failure is harmless | PASS | A throwing shadow gives an identical run. The builders' test covers a hanging and a throwing local decider. See D6 for a side effect that is not a failure. |
| Approval shadow: DecisionRecord linked to the Opus verdict | PASS | The record's verdicts are `['local-llm:fake', 'approval-reviewer:claude-opus-test']`, the choice is the reviewer's, the reviewer's outcome row has `decisionId` set, and on escalation the owner's answer becomes the decision outcome. |
| Regression | PASS | typecheck exit 0; full vitest 4480/4481 non-skipped tests pass, the one failure is an unrelated 5 s timing flake (above); test:scripts 190/190 non-skipped; the gate, agent-control and durable-jobs suites pass | typecheck exit 0; the gate, agent-control and durable-jobs suites pass (above). |
| End-to-end loop over real modules | PASS | `loop.verify.test.ts` (refresh → categorize → candidates → route → outcome → reputation → route again) and the builders' `wiring.test.ts` (the real `AgentControl` harness without Electron: refresh, route, `router.dispatch` with a zero-inference adapter, captured turn, `models.outcome`, next route, `decisions.get`). |

## Defects (for the controller to assign; none fixed by me)

**D1 — As wired, routing sends hard high-risk work to the local model** (high).
- Where: `model-intelligence/app-wiring.ts:52-57` (no `benchmarks` port; no price source for CLI keys) and `deciders/scorer.ts` `expectedSuccess`/`hardFilter`
  (nothing else carries capability).
- Repro: `loop.verify.test.ts` "APP-REALISTIC". Configured plus OpenRouter sources, no outcomes, then `models.route({features:{category:'difficult-coding',complexity:5,risk:'high'}})`.
- Expected: the strong cloud model. Actual: `local/qwen3.6-35b-a3b` (utility 0.706 against 0.556 for opus and gpt-5.6-sol; all at 39% expected success).
- Notes: the OpenRouter records carry exactly the prices and families that would help, but keys under provider `openrouter` are never offered, and `claude/opus[1m]` has
  `family: null`, so no prior flows. `capabilityRank` (in the contract) is not used by the scorer. `evidence >= 5` gates the local exclusion, so a fresh local model is
  never excluded.

**D2 — No route frontier in the app** (medium).
- Where: `index.ts:91` builds a frontier decider only from `options.frontier`, and `app-wiring.ts:48-50` never passes one.
- Repro: `loop.verify` "AS WIRED IN THE APP". Expected: a close call escalates to a frontier. Actual: `escalated:false`, `escalationReason:'close call, no frontier configured'`.
  The doc's "As wired" section admits this, but the owner's escalation criterion is only met in tests.

**D3 — `decisions.get` lacks fallback and route reasons** (medium).
- Where: `control.ts:95-99` returns `explainDecision(record)`. `router.ts` never persists `fallback`, `escalation` or `reasons`, and `store.recordDecision` stores only the `DecisionRecord`.
- Repro: `loop.verify` "decisions.get shows …" logs `{fallback:false, reasons:false}`. Expected per the owner: fallback, reasons and evidence. Actual: the choice, confidence, verdicts and option facts only.

**D4 — No local admission or VRAM filter in routing** (medium).
- Where: `agent-control.ts:1357-1370` `routeLive` omits `localAdmission`, so `router.ts:66` defaults to `{fitsVram:true, admissible:true}`.
- Expected per the doc: exclude a local model that does not fit the VRAM or cannot be admitted now (another server busy, an interactive local turn). Actual: always
  eligible, and `router.dispatch({route})` can open a local tab that then fails admission. This is mitigated only by `dispatchRouter` → `open` checking
  `localModelAvailability`, which throws instead of falling back.

**D5 — Usage windows are read wrongly** (medium).
- Where: `agent-control.ts:1363-1366` takes `Math.max(...windows.map(w => w.usedPercent))`.
- Effects: (a) windows with `state:'reset'` still count, so a provider that hit 100 % stays excluded after the reset until it reports again. (b) Model-scoped windows
  (e.g. the Claude Fable weekly window, `models` selectors) apply to every model of the provider, and the 5-hour window is compared with the *weekly* stop threshold
  (`defaultUsageStop` = `IDEA_RUN_DEFAULT_WEEKLY_CAPS`). Expected: current windows only, the matching model scope, and the right threshold per window.

**D6 — The approval shadow can start a local llama server** (medium, a side effect rather than a correctness bug).
- Where: `app-wiring.ts:47` builds `localRunner` from `createLocalModelRunner(realRunnerPorts())`. `local-assist/model-runner.ts:110-116` starts the preferred model
  (Qwen 9B, then Ornith, then Dolphin) when no server runs and no interactive local turn is busy.
- Effect: in the default shadow mode, every Opus approval review asks the local decider, which may load a model onto the GPU that nobody asked for. This is the
  same policy as `run_and_summarize`, but it is a second runner with its own start state beside local-assist's. Nothing here is visible to the owner. Expected: a
  shadow that only observes should use a server that is already running, or be opt-in.

**D7 — Turn outcomes are optimistic** (low; design).
- Where: `capture/turn.ts` gives a `completed` phase `success` with `verifier:'none'`, and `retries` is always 0 from `turnSettled` (`index.ts` of the module).
- Effect: every finished dispatched turn raises reputation unless someone calls `models.outcome`. The loop's "verify" step is manual for turns.

**D8 — Local exclusion is inconsistent at small samples** (low).
- Where: `deciders/scorer.ts:94`.
- Effect: a local model with 0 outcomes has `lower` 0.39 and stays eligible. The same model with 3 successes in 5 has `lower` about 0.43 and evidence 5, so it is excluded outright, whatever
  the cost weight. With 5 successes in 8 (a 62 % raw rate) it is excluded too (`45% on difficult-coding (7 outcomes)` in my evidence run).

**D9 — Cosmetic: a doubled local prefix.**
- Where: `modelKeyId` of a registry-form local key gives `local/local/qwen…`, in explanations, candidate ids, decision choices and probabilities
  (e.g. `local/local/qwen3.6-35b-a3b excluded: …`). Parsing still works (`parseKeyId`).

**D10 — The "proven" status comes only from evaluation** (low).
- Where: `registry.promote` has no caller, and `ReputationService.proven` is unused.
- Effect: a key with hundreds of captured outcomes stays `unproven` unless someone runs `models.evaluate`. The router does not read status, so routing is unaffected. `models.list`
  / `models.registry` show a misleading status.

**D11 — The owner's 2026-09-28 policy cannot be applied with this build** (medium).
- The policy lets the approval decider go live per kind at ≥95 % agreement over ≥30 cases, read from `decisions.list`. But `decisions.list`
  (`control.ts` `decisions.list` mapping) returns only the final `choice` (in shadow mode, the reviewer's) and `outcome`, not the system-one verdict. No agreement between the local verdict
  and the reviewer or owner is computed anywhere, so an agreement figure takes a `decisions.get` per record and manual counting.
- The policy allows cloud evaluation on every provider under caps (60k tokens per model per run, 3 evaluations and 150k tokens a day, none at or above the weekly stop).
  `startEvaluation` refuses every non-local key ("not wired yet"), and no cap settings exist.

## Remaining limitations (acknowledged in the doc or found)

- Local-agent stop capture is not wired (`captureLocalAgentStop` has no caller).
- `approval` mode `live` is not wired (it behaves as shadow). No agreement metric between the local verdict and the reviewer or owner is computed; the verdicts are only journaled.
- Evaluation covers local keys only. Command graders need docker and the sandbox image, or they are listed as not gradable.
- Outcome capture binds only `router.dispatch` coworkers, in memory (lost on restart; 1000 bindings, 7 days).
- A routed task that names another project (`projectId`) is routed on the caller's catalog (`routeTask` uses `this.routeLive(scope)`).
- The fallback for hard high-risk work can be the weakest eligible model (in my explainability run: `Fallback: local/qwen3.6-35b-a3b` for complexity 5, high risk), because the fallback is the first eligible candidate on another provider by utility.

## Mocked or unfinished in my verification

- Mocked: the OpenRouter HTTP responses (except the one live run), the frontier port (`fake-opus`), the local decider (fixed probabilities), the local evaluation run port,
  and the price sheet for CLI keys (a `conductor` source I applied, because the app has none).
- Not exercised: the real local LLM decider against llama.cpp (as instructed), docker command graders, the latest-models source against real schedule output, and Electron.

## Scratch artifacts

- `.conductor-scratch/model-routing/verify/loop.verify.test.ts` (15 tests), `gate-shadow.verify.test.ts` (4 tests), `vitest.config.mts`
- `.conductor-scratch/model-routing/verify/typecheck.log`, `npm-test.log`

## Re-verification of the fix batch (2026-09-28, same verifier)

Builders A (`agent_mul7sgxo_v693f70`) and C (`agent_mul7shmk_bz6uzus`); briefs `fix-batch-a.txt` and `fix-batch-c.txt`, contract `relay-*.txt`, owner rules `owner-decisions.md`.
The code was last modified at 15:38 and did not change while I tested. I fixed no product code; my tests are in `.conductor-scratch/model-routing/verify/`.

### Ship verdict: **DO NOT SHIP** (one blocker, N1)

Every D1–D11 item and every held gap is fixed as claimed, and nothing regressed.
- **Blocker N1:** the fix for D2 introduced a new defect. With the real ten-model catalog, almost every routine route at the default cost weight is escalated to the "caller" and resolved to **Opus**.
- **After N1:** N2–N5 concern the cloud-evaluation caps and Fable spend. The owner should see them before any cloud evaluation runs.
- **Scope of N1:** it only affects routes the caller asks for (`models.route` and `router.dispatch({route})`). Nothing routes on its own.
- **Once N1 is fixed:** SHIP WITH NOTES (N2–N8).

### Tests run

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm test`, run in the background (log `verify/npm-test-2.log`) | 413 files passed, 1 failed; **4530 tests passed, 1 failed, 9 skipped**. The failure is the known `database-wal.test.ts` 5 s timing flake. Within that run: model-intelligence 31 files / 240 tests, approval gate 7 / 55, agent-control 4 / 140, durable-jobs 14 / 153, all passing |
| `npm run test:scripts` (log `verify/test-scripts-2.log`) | 193 tests: 190 passed, 0 failed, 3 skipped |
| my scratch tests (`--config verify/vitest.config.mts`) | `loop.verify` 15/15; `gate-shadow.verify` 10/10 (4 original, plus 6 against the real service shadow with no server and with a server running); `reverify.verify` 20/20; `d8.verify` 1/1; `probe.verify` 3/3 |

The builders edited three of my tests. APP-REALISTIC now asserts Opus with a strong fallback and local ineligible. The two escalation cases now need an equal benchmark to create a close call, because capability priors separate Opus from Sol. "decisions.get shows" now asserts the fallback and reasons. These edits test the owner's intent, not just the new output. The weak spots were that APP-REALISTIC offered only three models, and the `has.fallback` check matched any JSON key named "fallback". `reverify.verify` covers both with the real catalog: opus[1m], claude-fable-5-1, sonnet and haiku; gpt-6-astra and gpt-5.6-sol, terra and luna; and two local Qwen models.

### Items

| Item | Verdict | Evidence |
| --- | --- | --- |
| D1 capability and price for CLI keys | PASS | See "D1 matrix" below. |
| D2 frontier in the app | PASS as designed; **see N1** | A close call escalates to `caller` with no model call, and `route.closeCandidates` is stored. |
| D3 decisions.get | PASS | `explainDecision` shows the selection, fallback with its reason, escalation, reasons, the system-one verdict and the verdicts. `record.route` holds the same details. |
| D4 local admission | PASS | The builders' `dispatch-routing.test.ts` goes through the real AgentControl ("needs 20 GB of VRAM, the card has 12 GB"). The envelope is `resourceRequirements().vramBytes`, which already counts partial offload, the same check the server start enforces. |
| D5 usage windows | PASS | See "D5" below. |
| D6 and gap 1 | PASS | With no server running, the shared runner's `ask` is never called and no approval decision is journaled; the review still settles. With a server running it is asked exactly once. Routes never reach the local runner. `index.ts` passes `localAssist.runner` (awaited earlier). |
| D7 unverified turns | PASS | Four `completed-unverified` outcomes count as evidence 2.0 (half weight) with a mean of 0.68, against 0.73 for four verified successes. I did not independently check that retries are taken from turn events. |
| D8 smooth local exclusion | PASS | See "D8" below. |
| D9 no doubled prefix | PASS | No `local/local/` appears in the decision JSON or the explanation. The `localKey` registry form and `modelKeyId` agree (gap 4, PASS). |
| D10 promotion | PASS | 12 recent turn outcomes promote `codex/gpt-5.6-luna` to `proven` with no evaluation. |
| D11 local verdict and cloud evaluation | PASS | `decisions.list` returns `systemOne` next to `choice`, plus `boundaries`. Cloud evaluation is lifted, subject to the caps. |
| Gap 3 bindings survive a restart | PASS | A binding survives dispose and reopen in the registry key form, and has expired after 8 days. |
| Gap 5 not-gradable | PASS | Command jobs without docker, and jobs past the token cap, are `not-gradable` and record no outcome row. |
| Gap 6 fallback retry | PASS | The builders' AgentControl test covers it, and I read `openRouted` (`agent-control.ts:1431-1455`): one retry on the fallback, both attempts journaled. |
| Gap 7 dry runs | PASS | `models.route` stores `dryRun: true`, and dry runs are hidden from `decisions.list` and the agreement count. |
| Go-live refusal | PASS | Driven through the real gate, the real service shadow and a fake local runner. See "Go-live" below. |
| Cloud-evaluation caps | PARTIAL | Admission is correct. The per-run and per-day caps are soft, and spend accounting has holes (N2–N4). |
| Store migration v1 → v2 on a realistic v1 database | PASS | See "Migration" below. |
| Approval gate byte-identical | PASS | 10/10: every publication, response, journal record, persisted setting and reviewer call is identical with no shadow, a working shadow, a throwing shadow, and the real service shadow with and without a local server. This covers allow, deny, escalate→allow and escalate→deny. |

**D1 matrix.** 330 cells: 11 categories × complexity 1–5 × risk low, medium and high × cost weight 0.3 and 0.9, with no evidence and the app wiring (linked OpenRouter prices, capability ranks). The ranks come out as opus and astra 3; sonnet, terra and fable 2; haiku, sol and luna 1; local 0.
- Hard or high-risk work was **never** routed to a local model, and no fallback for such work was local.
- At complexity 5 with high risk, difficult-coding, architecture and debugging all get a rank-3 model.
- Fable was never chosen in the all-provider matrix.

**D5.** Rate-limit payloads in the shapes the adapters really emit, fed through `recordAccountLimits` → `describeAccountLimits` → `usageVerdict`:
- **Claude:**
  - An exhausted `five_hour` window blocks, and one past its `resetsAt` does not.
  - A 95% five-hour window does not block.
  - `seven_day` blocks at 85 and not at 84.9.
  - `seven_day_overage_included` blocks Fable only; Opus and Sonnet stay eligible.
- **Codex:**
  - A primary window at 100 blocks.
  - A secondary window blocks at 95 and not at 94.
  - A model-scoped limit id `gpt-6-astra` blocks Astra only.
  - Sparse `rateLimits` with a reset primary do not block.
- **Routing:** with Claude at 90% weekly, a hard route goes to Codex with the reason shown. With both providers blocked, the route is refused with the reasons.

**D8.** The Wilson table for 0–20 outcomes is monotone in successes at every sample size, with no cliff at 5:
- For easy work, 0/0 and 3/5 are eligible and 0/5 is not.
- For hard work, 5/8 is not eligible and 6/8 is. That step is the deliberate "5+ outcomes with a lower bound of at least 50%" gate.

**Go-live.**
- 29 agreeing cases give `cases 29, agreement 1`, and the owner is refused.
- 30 cases with 29 agreeing (96.7%): a non-sovereign caller is refused, and the owner is allowed.
- Switching back to shadow and adding 2 disagreements gives 29/32 (90.6%), which is refused ("90.6% of 32").
- `decisions.list` shows `choice allow` beside `systemOne deny`.

**Migration.** I built a v1 schema database: the exact v1 DDL plus settings and 2,000 `structured_events` rows as ballast, with local keys in the v1 `local/local/…` form in the registry, observations, listings, changes and 6 outcomes, and one v1 route decision. I opened a **copy** of it.
- The schema version becomes 2, and zero `local/local/%` keys remain in any of the six tables.
- Every row reads back, the route and dry-run columns are added, and a reopen changes nothing.
- A recapture of an old execution stays idempotent.
- The migrated failures reach reputation (evidence above 5).
- `models.outcome` on the v1 decision, whose choice is still in the doubled form, still amends its linked outcome.

**Cost safety (question 3).**
- **Model calls without `models.evaluate`:** none that the caller did not ask for.
  - A route asks no model (the caller frontier is code).
  - The local decider is asked only by the approval shadow, and only while a server is already up.
  - Cloud turns run only from `startEvaluation`, which is reached only through `models.evaluate`. For cloud keys that needs the owner or a wizard, a weekly stop configured for the provider (openrouter and grok have none, so they are refused), and known usage below it. Unknown usage means skip (tested).
  - `router.dispatch` opens the tab the caller requested.
- **Exceeding the caps:** yes, by one job at a time, and more when usage is missing (N2–N4).
- **Fable:** yes, in edge cases (N5).

### Known and accepted items: are they documented?

- **Cloud evaluation tabs open in the first project:** documented (`docs/model-routing.md`, Evaluation).
- **Local evaluations use a runner per model:** documented ("a runner preferring that model").
- **The hard fallback is on another provider:** only in code (`router.ts:169-172` reason text). The doc's module C still says only "best eligible candidate on a different provider".
- **Fable is rank 2:** not documented. The doc only says the rank comes "of the model name, or of its family".
- **The tiny D6 race** (the server check, then an ask when the server has just stopped): not documented.

### New defects

**N1 — The close set is degenerate, so the caller frontier sends routine work to Opus** (high; blocker).
- Where: `model-intelligence/index.ts:108-113` (`closeCandidates`: `top - probability <= minMargin` over a softmax across all eligible options) together with `callerFrontier` (`index.ts:118-128`) and the route `minConfidence 0.55` (`decision-service.ts`).
- Cause: with about 10 candidates the softmax is flat. The top candidate has p ≈ 0.2, so the confidence check always escalates, and every option within 0.15 of the top is "close". The close set held 8–10 of 10 candidates, including Opus at p 0.07. The caller then takes the highest capability rank.
- Repro:
  - In `probe.verify.test.ts`, summarization at complexity 1, low risk, default weights. The scorer ranks luna first (utility 0.066), then sol 0.031, then the local models, with Opus below them, yet the choice is **claude/opus[1m], "decided by caller after escalation"**.
  - The D1 matrix: **every default-weight cell (165/165) went to Opus**, including trivial summarization and simple coding. Only cells at cost weight 0.9 reached Luna.
- Expected: a close call is one between genuinely close options (for example the top two, or utility within a margin), and a clear scorer winner stands.
- Effect: `router.dispatch({route})` spends Opus, the Claude weekly quota the owner caps at 85%, on routine work. That defeats cost-aware routing.

**N2 — The cloud caps are soft by one job** (medium).
- Where: `evaluation.ts:279` checks `tokens >= maxTokens` only before starting the next job. `index.ts:333` gives `maxTokens = min(perRun, perDay − spent)`.
- Repro:
  - `reverify` "per run": 25k-token jobs give **75,000** tokens against the 60,000 cap.
  - "per day": three runs of 20k-token jobs give 60k + 60k + 40k = **160,000** against 150,000.
- Also: an evaluation turn is an agentic native turn with tools (read-only) and has no token bound of its own, so one job can overshoot by much more than a typical answer.
- Expected per the owner: "at most 60k tokens per model per run; the run stops at the cap". The cap should reserve room for the next job's estimate, or refuse a job it cannot fit.

**N3 — Spend is under-counted** (medium).
- Where: `evaluation.ts:253` (`runTokens` falls back to chars/4 of the prompt, files and answer) and `agent-control.ts` `evaluationTurn`, which throws on a non-completed phase without reading usage (the `settled.phase !== 'completed'` line).
- Repro:
  - 10 failing cloud turns are journaled as **40 tokens**.
  - 10 turns without usage are also journaled as 40 tokens.
  - A timed-out turn (10 min per job) is counted the same way.
- Also: `processedTokens` leaves out cache reads, while the owner's rule says "input + output".
- Expected: read the turn's usage on every ending, and count cache reads (or state the interpretation to the owner).

**N4 — Spend is journaled only at the end of a run** (medium-low).
- Where: `evaluation.ts:314` (in `finally`).
- Repro: `reverify` "interrupted by a restart". A run with turns in flight, then dispose and reopen, gives `evaluationSpend = {runs: 0, tokens: 0}`, so the day's caps forget it.
- Also: the run id is the clock in milliseconds (`index.ts:339`), and `recordEvaluationSpend` upserts on it, so two runs started in the same millisecond merge. That is unlikely with one run at a time; my first cap test hit it only because it froze the clock.

**N5 — Routing can choose Fable** (medium, per the owner's "no Fable spend").
- Repro: `probe.verify` "Fable".
  - A Claude-only route (`excludeProviders: ['codex','local']`) with Opus and Sonnet each failing 8 times picks **claude/claude-fable-5-1**.
  - `allow: ['claude/claude-fable-5-1','claude/haiku']` picks Fable for medium research.
- Fable is also in N1's close sets, but it is not picked there while Opus or Astra is eligible.
- There is no model-level exclusion (only `excludeProviders` or `allow`) and no setting that keeps Fable out of routing.

**N6 — A caller escalation records confidence 1.00** (low).
- Where: `callerFrontier` writes one-hot probabilities, so the record and the explanation say "Confidence 1.00 (margin 1.00), decided by caller after escalation" when the scorer's top candidate had p 0.21. The close-call reason is in the reasons, but the headline confidence misleads.

**N7 — Documentation gaps** (low): Fable at rank 2 and the D6 race (see above).

**N8 — Note, not a violation:** easy work never went local with the real catalog, even at cost weight 0.9. Luna costs almost nothing on the log cost scale and has the higher rank-1 prior (0.65 against 0.55), and an unloaded local model pays the load penalty. With the 9B model already loaded and cost weight 0.9, easy work does go local. The owner's "easy work may still go local" holds only then.

### Mocked or not run

- **Mocked:** OpenRouter responses (realistic records whose prices are my assumptions), the local runner, the cloud evaluation turn, and usage for the caps.
- **Not rerun:** the live OpenRouter check (the owner allowed it once, and it is unchanged).
- **Not run:** a real cloud evaluation (per the rules), Electron and smokes.

## Re-verification 2: fix batch 2 (N1–N7), 2026-09-28

Builders A and C; briefs `fix-batch-2-a.txt`, `fix-batch-2-c.txt` and `builder-a/handoff-batch2.md`. The code was last modified at 16:23 and did not change while I tested. I fixed no product code; my new tests are `.conductor-scratch/model-routing/verify/reverify2.verify.test.ts`.

### Verdict: **SHIP WITH NOTES**

The blocker N1 is fixed, and N2–N7 hold for a runner that respects its budget. One new defect in cloud evaluation, N9, must stop anyone from running a cloud `models.evaluate` until it is fixed. It is not a cost-safety hole: the run stops after one job. But it writes a false failure into the model's routing reputation every time. Routing itself is ready to ship.

### Tests run

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm test`, run in the background (`verify/npm-test-3.log`) | 413 files passed, 1 failed; **4556 tests passed, 1 failed, 9 skipped**. The failure is the known `database-wal.test.ts` timing flake. |
| `npm run test:scripts` (`verify/test-scripts-3.log`) | 193 tests: 190 passed, 0 failed, 3 skipped |
| **Routing-only tree:** `git archive HEAD` plus exactly the ship paths below, with `node_modules` junctioned | `tsc` exit 0. `vitest run src/main/model-intelligence src/main/approval-review src/main/agent-control src/main/durable-jobs src/main/control`: **57 files, 625 tests passed** (1 skipped, the live test). |
| my scratch tests | 60 tests: 59 passed and 1 failed. d8 1, probe 3, gate-shadow 10, loop 15, reverify 20, reverify2 10/11. The failure is my own strict "rank ≥ 2 for hard work" assertion, and it fails only at cost weight 1 (see N1 below). |

### Items

**N1 — close calls. FIXED.** The close set is now measured in utility and holds at most 3 options, and the caller picks the most capable only for hard or high-risk work.

The matrix is 825 cells: 11 categories × complexity 1–5 × risk low, medium and high × five weight settings. The settings are cost 0.3 (the default); cost 0; cost 1; cost 1 with latency 1 and urgent; and cost 0 with latency 0.

| Check | Result |
| --- | --- |
| Easy cells on a pick other than the scorer's top-utility model | **0** |
| Largest close set | **3** |
| Hard cells routed to a local model | **0** |
| Default weights, what gets picked | Luna 55 cells, Opus 110 |

At default weights, Opus is chosen only where it has the top utility (11 easy cells, such as frontend at complexity 3, medium risk). It is no longer chosen by construction.

The probe cases:
- summarization, complexity 1, low risk → **Luna**
- simple-coding, complexity 2, low risk → Luna
- difficult-coding, complexity 4, medium risk → Opus

"Hard or high-risk work never below rank 2" holds at default weights and at cost 0. It does **not** hold at an explicit cost weight of 1:
- 66 hard cells per such setting go to Luna (rank 1), for example difficult-coding at complexity 5, low risk, and debugging at complexity 3, high risk.
- Only complexity ≥ 4 with high risk still gets Opus.
- Evidence can also push hard work to rank 1: a Claude-only route with Opus and Sonnet both failing picks Haiku.

The caller asked for either of those, so I record them as a note (N10), not a failure.

**N6 — confidence. PASS.** Across every caller-decided cell, the recorded confidence equals the chosen candidate's scorer probability (0 mismatches). Below 1/n it is an approximation (a near-uniform lead), and that is documented.

**N2 — hard caps. PASS for a runner that respects its budget; soft by one API call otherwise.**
- **Per run:** a runner that always spends its whole budget reaches exactly 60,000. Job budgets are 16k, 16k, 16k and then 12k (the remainder), after which the rest are not-gradable.
- **Per day:** the caps come out as 60k, 60k and then 30k (dynamic), totalling **150,000** exactly. The 4th run is refused.
- **Concurrent starts:** one starts and the other is refused ("already running").
- **Same-millisecond runs** (frozen clock): distinct ids (`makeId`), and 2 runs counted.
- **Overruns:**
  - `evaluationTurn` can only interrupt a turn *after* a usage report passes the budget. One API call can therefore overrun.
  - With a runner that overruns by 39k, three runs spend 55k each and the day reaches **165,000**.
  - The doc sentence "so the day stays within 150k" is too strong (N11).

**N3 — accounting. PASS.**
- A failed turn is charged its budget (16k), or the measured amount when higher (50k → 50k).
- A timed-out turn is charged its budget, and so is a turn with no usage.
- An overrunning turn is charged its real spend (46k), and the run stops.
- `evaluationTokens` counts cache once. Claude's adapter already folds cache reads and writes into `inputTokens` (`claude.ts` `usage()`; `usage-accounting.ts` `tokenBreakdown`), so `max(input, cache) + output` equals input plus output. Checked on a real first message from this app: 39,115 input (18,777 cache read plus 20,336 cache write) plus 8 output gives 39,123.

**N4 — journaling. PASS.**
- Spend is journaled at the start (0), after every job and at the end, cumulatively, with one row per run id.
- A restart mid-run keeps the journaled 32k and 1 run.
- **Residual:** the in-flight job (up to its budget, 16k) is not counted, and the dead run's unspent reservation is released, so the next run gets a full 60k cap. The evaluation tab and its native turn are not cleaned up after a restart. I could not verify that without Electron (N12).

**N5 — Fable. PASS.**
- A Claude-only hard route with Opus and Sonnet failing now picks Haiku, not Fable, and Fable is not a candidate.
- The explanation says "claude/claude-fable-5-1 excluded by owner setting".
- `allow: [fable, haiku]` picks Haiku. `allow: [fable]` alone is refused with the exclusion reason.
- `models.evaluate` refuses Fable ("excluded by owner setting").
- The glob is case-insensitive and catches `Claude-Fable-5-2` and a bare `fable`.
- Setting `[]` brings Fable back.
- Dispatch goes through `service.route` (code read), so it is covered. A task that names Fable explicitly as provider and model is not routing and still opens.

**N7 — docs. PARTIAL.**
- Documented: Fable at rank 2 with the exclusion list, one runner per model, first-project tabs, N8, the close-set rule and the confidence rule.
- **Wrong:** the D6 race text says the local decider "never starts a server in its place". With the real `createLocalModelRunner` (fake ports) and a guard that reports a server, while the runner finds none, `runner.start` **is called**. The window is also not tiny: the guard is checked when `ask` is called, and the runner looks for a server only after its lock, up to `MODEL_WAIT_BUDGET_MS` = 20 s later.
- Also overstated: "the day stays within 150k" (N2 above).

**Regressions. PASS.** Gate-shadow 10/10 with the real service shadow (with and without a server), typecheck, all module suites and the full `npm test`.

### New defects

**N9 — Cloud evaluation of a native CLI model always records a false failure** (high for evaluation; the verdict's note).
- Where:
  - `evaluation.ts` `JOB_TOKEN_BUDGET = [6k, 10k, 16k, 24k, 32k]` and `minimumJobTokens` (prompt/4 + 1,000).
  - `agent-control.ts` `evaluationTurn`, which interrupts once usage passes the budget.
- Cause: a native Claude turn in this app starts at about 39k input tokens (measured: this verifier's own first message, 39,115, from the Conductor briefing, AGENTS.md and the CLI system prompt). An evaluation tab opened in the first project carries the same kind of preamble. So the first usage report already exceeds every job budget.
- Repro: `reverify2` "a realistic native Claude turn". Evaluating `claude/sonnet` gives:
  - 39,123 tokens and `stoppedBy: token-cap`;
  - job 1 = **failure** with `verifier: fail`, and the other 9 not-gradable;
  - sonnet's simple-coding reputation drops from 0.60 to 0.53 on a harness artifact.
- Expected:
  - Per-job budgets that start above a native turn's fixed cost, or budgets measured net of the first call.
  - An over-budget or harness stop recorded as `cancelled` or not-gradable, never as the model's failure.
- The same applies to a turn that fails to open or times out: it is recorded as a model failure.

**N10 — Note: explicit cost priority and evidence can route hard work to rank 1** (see N1). This holds at cost weight 1, and for Claude-only routes whose strong models are failing. The owner may want a rank floor for hard work that holds regardless of weights.

**N11 — Docs overstate two guarantees** (low): the D6 race, and "the day stays within 150k" (N2, N7).

**N12 — A restart mid-evaluation leaks one job's spend and possibly a stray tab** (low; the tab part is unverified).

### The routing ship: exact paths (74)

- **New, `src/main/model-intelligence/`** (61):
  - `app-wiring.ts`, `app-wiring.test.ts`, `approval-shadow.ts`
  - `capture/` — `approval-review.ts`, `approval-review.test.ts`, `common.ts`, `durable-job.ts`, `durable-job.test.ts`, `local-agent.ts`, `local-agent.test.ts`, `turn.ts`, `turn.test.ts`
  - `categorize.ts`, `categorize.test.ts`, `control.ts`, `control.test.ts`
  - `deciders/` — `frontier.ts`, `frontier.test.ts`, `local-llm.ts`, `local-llm.test.ts`, `scorer.ts`, `scorer.test.ts`
  - `decision-service.ts`, `decision-service.test.ts`, `dispatch-routing.test.ts`
  - `evaluation-ports.ts`, `evaluation-ports.test.ts`, `evaluation-suite.test.ts`, `evaluation.ts`, `evaluation.test.ts`
  - `explain.ts`, `explain.test.ts`, `index.ts`
  - `ingest/` — `benchmarks.ts`, `benchmarks.test.ts`, `configured.ts`, `configured.test.ts`, `index.ts`, `index.test.ts`, `latest-models.ts`, `latest-models.test.ts`, `linked.ts`, `linked.test.ts`, `openrouter.ts`, `openrouter.test.ts`, `openrouter.live.test.ts`, `runtime.ts`, `runtime.test.ts`
  - `registry.ts`, `registry.test.ts`, `reputation-service.ts`, `reputation-service.test.ts`, `reputation.ts`, `reputation.test.ts`, `router.ts`, `router.test.ts`, `service.test.ts`, `store.ts`, `store.test.ts`, `store-v2.test.ts`, `suites/default.json`, `wiring.test.ts`
- **New elsewhere:** `src/main/approval-review-gate.shadow.test.ts`, `docs/model-routing.md`, `docs/verification/2026-09-28-model-routing-verification.md`
- **Modified, routing hunks only** (I checked every hunk of `agent-control.ts`, all 17, and `src/main/index.ts`, all 10):
  - `src/shared/model-routing.ts` (additions only; the existing `capabilityRank` and `coordinatorEffort` are unchanged)
  - `src/main/agent-control.ts`, `src/main/agent-control-server.test.ts`, `src/main/approval-review-gate.ts`, `src/main/control-activity.ts`, `src/main/control-method-classes.ts`, `src/main/index.ts`, `src/main/local-assist/wiring.ts`
  - `docs/agent-control.md`

**Flag:** `feature-list.md` mixes one routing line ("[~] Adaptive model intelligence and routing …") with other agents' task lines (Codex questions, local-model work, queued messages, `tabs.open`). Ship only that hunk, or leave the file out.

**Excluded from the ship:** none of these carry a routing hunk (checked), and nothing in the ship depends on them (the routing-only tree compiles and passes):
- **Scraper:** `local-models/web*`, `web-extract*`, `tools*`, `agent.ts`, `scripts/local-models/web-extraction-baseline.mjs`, and the docs `local-scraper` and `web-extraction-design`.
- **Codex question:** `providers/codex.ts`, `codex-async-question.test.ts`, `scripts/fixtures/codex-async-questions.mjs`, `scripts/smoke-codex-async-questions.mjs`, and the doc `codex-question-fix`.
- **Queued messages:** `structured-sessions*`, `structured-store*`, `structured-agent-reducer*`, and the renderer panes.
- **Other docs and scripts:** `agent-execution-plan`, `local-safety-review`, `local-work-plan`, and `scripts/smoke-verify-v4-*`.
- **Not shipped:** `.conductor-scratch/**`.

## Re-verification 3: fix batch 3 (N9, N11, N12) and the wizard's live fixes, 2026-09-28

A new verifier (Claude Opus, agent_muldl8ux_wypx7ub) ran this round. Its inputs were the brief `fix-batch-3.txt` and the working tree as of 17:00, on top of 4df3653. I fixed no product code. My tests are in `.conductor-scratch/model-routing/verify/reverify3.verify.test.ts` (18 tests), and its outputs are in `reverify3-summary.json`.

This time the route facts came from the **live** app, not a synthetic catalog. All reads were read-only:
- **`models.list`** (`live-models-list.json`): 24 ids. Codex 7, Claude 5, Grok 4, local 4 and cloud 4.
- **`usage.limits`** (`live-usage-limits.json`):
  - Claude: weekly 7 %, five-hour 10 %; the Fable weekly window is `reset`.
  - **Codex: weekly 55 %.**
  - Grok: unknown.
- **The owner's registry** (`live-db.json`, from bounded `SELECT`s on the small tables only; `structured_events` was not touched):
  - 474 records, 5,473 observations.
  - No execution outcomes, so the route runs on priors.
  - No `weekly-stop` override in settings.

The test replays those rows into a temp database and builds the live facts exactly as `AgentControl.routeLive` does, with `routeUsage` over `service.weeklyStop`.

### Verdict: **SHIP WITH NOTES**

- **Routing: every live fix holds on the live catalog.**
  - Ranks are correct.
  - Codex is blocked at 55 % and the reason is given.
  - At default weights, hard work never goes below rank 2, and every hard cell has a fallback of rank 2 or higher.
- **N9, N11 and N12 are fixed.**
- **Two new evaluation defects, N15 and N14,** should be fixed before the first real cloud `models.evaluate`:
  - N15: a slip in the batch header format still records every job as a false failure.
  - N14: a learned overhead at or above the cap locks the provider out of evaluation.
- Routing does not depend on either of them.

### Tests run

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` (`verify/typecheck-4.log`) | exit 0 |
| `npm test` in the background (`verify/npm-test-4.log`) | 413 files passed, 1 failed. **4576 tests passed, 1 failed, 9 skipped.** The failure is the known `database-wal.test.ts` 5 s flake, which passes alone (`verify/wal-4.log`). The counts are identical to C's `builder-c-npm-test-5.log`. |
| `npm run test:scripts` (`verify/test-scripts-4.log`) | 190 passed, 0 failed, 3 skipped |
| **Routing-only tree:** `git archive HEAD` plus exactly the 17 paths below, with `node_modules` junctioned (`verify/ship-tree-3-*.log`) | `tsc` exit 0. `vitest run` over `src/main/model-intelligence`, `approval-review`, `agent-control`, `durable-jobs`, `control`, `local-assist` and `src/shared/model-routing.test.ts`: **63 files, 704 passed, 1 skipped** |
| Scratch tests (`verify/scratch-all-4.log`) | **78 tests: 76 pass.** reverify3 18/18, gate-shadow 10/10, reverify 20/20, loop 15/15, probe 3/3, d8 1/1. The 2 failures in reverify2 are expected. Its N7 repro ("the runner starts one") now fails because N11 is fixed. Its strict rank ≥ 2 assertion trips on N10 at cost weight 1 (synthetic catalog). |

### Items

**N9: batched cloud runs with a real ~39k overhead. PASS**, but see N15.

The run: `claude/sonnet` on the bundled suite, through the real service and `cloudRunPort`. The fake native turn reads 39,115 tokens plus the prompt, reports usage and is interrupted past its budget, as `evaluationTurn` does.
- **One turn per run.** Its `maxTokens` is 60,000 (the run cap). It carries all 7 one-shot jobs, 4,860 characters. The 7 command jobs are not-gradable with the reason given.
- **Every "### JOB <id>" section is graded separately.**
  - 7 success rows and **no failures**; 40,452 tokens.
  - A wrong answer fails only its own job ("expected "3", got "4"").
- **Cut off** (70k overhead against a 60k cap):
  - 1 turn, every job not-gradable, **0 outcome rows**, `stoppedBy: token-cap`.
  - Charged 71,215 tokens.
- **Local runs keep one job per turn:** 7 runner calls, each for a distinct job.

**Overhead learning. PASS**, but see N14.
- After one run, `model-intelligence:evaluation-overhead` holds `{claude: {tokens: 39115}}`. That is the input less the prompt, exactly.
- A restarted service with the same settings returns 39,115 for Claude and the 40,000 default for Codex.

**N11: the D6 race. PASS: the repro is flipped.**
- **Through the real gate:** the guard says a server runs, but the real `createLocalModelRunner` finds none.
  - `runner.start` is called **0 times**.
  - The decision records "no local model server is running, and this call never starts one".
- **Directly on the runner:** no start in any of three cases:
  - no server;
  - an unreadable inventory;
  - a server that stops while a noStart call waits in the queue (the first call held the lock with the server up).
- **Control:** the same runner without `noStart` does start one.
- The wrapper now exposes only `ask`, and the docs describe both guards.

**N12: pre-charge, then reconcile. PASS.**
- While the turn is in flight, `evaluation_runs` holds **60,000** (the run cap).
- After a simulated restart (service disposed mid-turn, a new one on the same database), it still holds 60,000 and counts 1 run.
- A finished run is reconciled to its real 40,452.

**Live fix 1: `capabilityRank`. PASS** for every live id. Changes from the installed build are marked with →.

| Provider | Ranks |
| --- | --- |
| Codex | `gpt-6-astra` 3; `gpt-6-sol` 3→**1**; `gpt-6-luna` 3→**1**; `gpt-5.6-sol` 1; `gpt-5.6-terra` 2; `gpt-5.6-luna` 1; `gpt-5.5` 2 |
| Claude | `opus[1m]` 3; `sonnet` 2; `haiku` 1; `default` 2; `claude-fable-5-1[1m]` 2 |
| Grok | all 2 |
| Local | all 0 |
| Cloud | `claude-opus-5-5` 3; `claude-sonnet-5` 2; `claude-haiku-4-5-20251001` 1; `claude-fable-5-1` 2 |

- **Note:** the registry *stores* the rank.
  - Replayed live rows still say gpt-6-luna, gpt-6-sol and gpt-6-astra are [3, 3, 3] until a `runtime` refresh re-derives them to [1, 1, 3].
  - So the fix takes effect at the updated app's startup ingestion (`timers.after(0)`), not the moment it is installed.
- **Ids outside the live catalog:**
  - `gpt-6-nano`, `gpt-6-pro` and `gpt-6-console` fall to the bare `gpt-6` rule, rank 3.
  - `gemini-*` matches `mini`, rank 1.

**Live fix 2: hard work on the live catalog. PASS at default weights.**

The matrix: 18 categories × complexity 1–5 × 3 risks × 5 weight settings = 1,350 cells.

| Setting | What gets picked | Hard work |
| --- | --- | --- |
| Live usage, Codex blocked; default weights | Opus 252, `local/dolphin-x1-8b` 18 (easy cells only) | never below rank 2, at any of the 5 settings; no hard cell without a fallback at any setting; every hard fallback has rank ≥ 2 at the three settings without cost weight 1 (not asserted at cost weight 1) |
| Codex opened at 20 % (the old live bug) | difficult-coding/5/high → **Opus** (fallback `codex/gpt-6-astra`), not gpt-6-luna. Default weights: gpt-6-luna 72 (easy only), Opus 198 | 0 cells below rank 2 at cost weights 0.3 and 0 |
| Codex opened at 20 %, cost weight 1 | — | **18 hard cells go to gpt-6-luna** (complexity 1, high risk). This is N10, still open by design |

**Live fix 3: one weekly stop. PASS.**
- `weeklyStop` is 55 for Codex, 85 for Claude and 95 for Grok.
- **Boundary:** Codex at 54.9 % is eligible; at 55 % it is blocked.
- Every live decision gives the reason:
  - it carries "codex blocked by its usage stop: Weekly usage 55% at or above the 55% weekly stop";
  - each Codex candidate is excluded as "usage: Weekly usage 55% …".
- **The setting moves both routing and evaluation.** With `{codex: 60}`, routing makes Codex eligible and `evaluationCaps().weeklyStop.codex` is 60.
- **Invalid values keep the defaults:** `"50"`, 101, −1, an array, non-JSON.
- **`models.evaluate` on Codex at the live 55 %** is refused: "codex is at 55% of its week, at or above the 55% stop". With the setting at 60 it is admitted.

**Live fix 4: C's same-provider fallback. PASS.**
- **Claude only** (Codex blocked, Grok and local excluded):
  - the fallback is never null, and it is the strongest other Claude model;
  - Opus falls back to Sonnet (rank 2), and Haiku falls back to Opus (rank 3);
  - the reason reads "no other provider eligible (codex: usage: … 55% …; grok: provider grok excluded; local: …); same-provider fallback (capability rank …)".
- **Claude at 90 % and Codex at 70 %:**
  - Grok carries difficult-coding/5/high, with a Grok fallback;
  - both "blocked by its usage stop" reasons are given.
- **An allow list of one model** gives a null fallback and does not throw.

**Regressions. PASS:** gate-shadow 10/10, typecheck, the module suites, and the full `npm test`, identical to C's log.

### New defects

**N15 — A slip in the batch header format records every one-shot job as a false failure** (medium, evaluation only).
- **Where:** `evaluation.ts:275` accepts only `^#{2,4}\s*JOB\s+<id>\s*:?$`, and `evaluation.ts:380` records a missing section as a `failure` with `invalidOutput`.
- **Near-miss headers that split into nothing:**
  - `### JOB: <id>`
  - ``### JOB `<id>` ``
  - `**JOB <id>**`
  - `### JOB <id> (task 1)`
  - `### JOB 1`
- **What that records:** correct answers under `### JOB: <id>` headers give **7 failure rows across 7 categories** in one run (repro: reverify3 "header format slips").
- A whole answer wrapped in one fence leaves a trailing fence in the last section, so an exact grader fails.
- **Expected:**
  - If no section (or clearly too few) can be found, the batch is not-gradable, as a harness format problem.
  - Near-miss headers are accepted.
- This is the same class of error N9 was meant to remove.

**N14 — A learned overhead can lock a provider out of evaluation, and runs that cannot fit still use a daily run** (low to medium).
- **Where:** `index.ts:322` `recordOverhead` keeps the last value unbounded. It comes from `evaluation-ports.ts:74` `fixedOverhead`, applied to `agent-control.ts:1477`, which is the whole turn's summed input.
- **How it locks:**
  - A turn that calls the API more than once (a tool call despite "Do not use tools"), or a real preamble at or above the cap, is learned as the overhead.
  - After that, no batch fits. No turn starts, so the overhead is never measured again.
  - Each attempt still uses one of the 3 daily runs. Repro, "cut off by the cap": the second run started 0 turns and the day shows 2 runs.
- **Admission has the same gap:** its `minRunTokens` floor is 20k, below the 40k overhead. A run capped at 30k starts 0 turns and uses 1 daily run (repro: "cap 30k").
- **Expected:**
  - Learn from the first usage report, or bound the value.
  - Refuse at admission when the overhead plus the smallest batched job exceeds the run cap.

**N16 — Stale docs** (low), in `docs/model-routing.md`:
- **Line 192** still says "The router falls back only to another provider, so with Codex blocked and no other eligible provider a hard route has no fallback". C's same-provider fallback now contradicts that.
- **Line 222** still describes a cloud run as one budget per job ("hands each job its budget … after every job").
- **Not documented anywhere:**
  - the batch itself: one turn per run under the run cap, the `### JOB <id>` answer format, command jobs not gradable in the cloud, the largest jobs dropped first;
  - N12's pre-charge.

**N17 — The evaluation-caps weekly-stop override is not validated** (low; the line predates the batch but was edited by it).
- **Where:** `index.ts:306` spreads `evaluation-caps.weeklyStop` unchecked.
- **Effect:** `{codex: "x"}` gives `"x"`, `usage >= "x"` is false, so a malformed override switches off the evaluation stop.
- `weekly-stop` itself is validated.

**N18 — Note: models without pricing score as if cost were no concern** (pre-existing scorer behaviour, not batch 3).
- `grok-4.7-build-fast` has no pricing or context in the registry. It wins over its priced siblings:
  - for hard work when Claude and Codex are blocked;
  - in 36 cells at cost weight 1.

**N10** still stands (see above). The owner may want a rank floor for hard work that holds whatever the weights.

### The batch 3 ship: exact paths (17)

These are the paths of `git diff 4df3653 --stat` that belong to routing. **None of the untracked files are routing.** I checked every hunk of the modified files; each one listed here is routing only:
- `agent-control.ts`: 4 hunks (import, `routeLive` stop, `evaluationTurn` input ×2).
- `model-runner.ts` and `contract.ts`: `noStart` only.

The paths:
- `docs/model-routing.md`
- `docs/verification/2026-09-28-model-routing-verification.md` (this section)
- `src/main/agent-control.ts`
- `src/main/local-assist/contract.ts`, `model-runner.ts`, `model-runner.test.ts`
- `src/main/model-intelligence/`:
  - `dispatch-routing.test.ts`
  - `evaluation-ports.ts`, `evaluation-ports.test.ts`
  - `evaluation.ts`, `evaluation.test.ts`
  - `index.ts`
  - `router.ts`, `router.test.ts`
  - `service.test.ts`
- `src/shared/model-routing.ts`, `src/shared/model-routing.test.ts`

**Proven:** HEAD plus only these 17 paths typechecks and passes the module suites (see Tests run). The list is in `verify/ship-paths-3.txt`.

**Excluded:**
- **Scraper:** `local-models/web*`, `web-extract*`, `tools*`, `agent.ts` and `scripts/local-models/`.
- **Codex question:** `providers/codex.ts`, `codex-async-question.test.ts` and `scripts/*codex-async-questions*`.
- **Queued messages:** `structured-sessions*`, `structured-store*`, `structured-agent-reducer*`, `StructuredAgentPane.tsx` and `StructuredAgentRenderers.tsx`.
- **Other docs and scripts:** the other `docs/verification/2026-09-28-*` docs and `scripts/smoke-verify-v4-*`.
- **`feature-list.md`: flagged.** Its only routing hunk is the added "[~] Adaptive model intelligence and routing" line, among other agents' lines (Codex questions, local-model work, queued messages, `tabs.open`, tab archive). Ship that hunk alone or leave the file out.
