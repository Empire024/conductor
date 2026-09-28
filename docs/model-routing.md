# Model intelligence and routing

Owner request 2026-09-28: Conductor should know which models and providers exist, what they cost
and how well they actually do inside Conductor, and a small "System-One" decision model should
settle routine bounded decisions (which model, retry or escalate, an approval card), escalating to
a frontier model when it is unsure or the decision is high-impact. Feature-list task
`model-intelligence-routing`.

The shared contract is `src/shared/model-routing.ts`. Everything main-process lives in
`src/main/model-intelligence/`. Nothing here replaces an existing path silently: routing is used
where a caller omits the model, and the approval decider starts in **shadow** mode.

## The loop

```text
sources ─► ingestion ─► registry ◄─ configured catalogs, models.list runtime discovery
                            │
task ─► features (classify) ─► candidates (registry + live state) ─► scorer ─► DecisionService
                                                                      │  system-one → frontier when unsure
                                                                      ▼
                                   execution (tabs.open / router.dispatch / durable jobs / gate)
                                                                      │
                            outcome capture ─► execution_outcomes ─► reputation ─► scorer (next time)
                                                                      │
                                                         decisions.outcome links back to the decision
```

## Modules (src/main/model-intelligence/)

| Module | Files | Owns |
| --- | --- | --- |
| A. Store, registry, ingestion | `store.ts`, `registry.ts`, `ingest/*.ts` | tables, observations with provenance, effective records, change detection, sources |
| B. Telemetry and reputation | `outcomes.ts`, `capture/*.ts`, `reputation.ts`, `categorize.ts` | outcome rows from every execution path, Beta reputation with priors and recency |
| C. Decisions and routing | `decision-service.ts`, `deciders/*.ts`, `router.ts`, `explain.ts` | DecisionService, scorer, local and frontier deciders, route decisions and their explanation |
| D. Evaluation | `evaluation.ts`, `suites/*.json` | unproven → evaluating → proven, reusable suite, results as outcomes |
| E. Wiring | `index.ts` of the module, `src/main/index.ts`, `agent-control.ts`, `approval-review-gate.ts`, schedule wiring | control methods, approval shadow, models.list fields, router.dispatch `route` |

Modules A–D depend only on the contract and on ports they declare. None of them imports
`agent-control.ts`, `structured-sessions.ts` or `index.ts`; module E does the wiring.

### Storage (module A owns the schema; B and C use it through the store)

One class `ModelIntelligenceStore` over `conductor.db` with its own `DatabaseSync` connection (WAL,
busy_timeout), in the ScheduleStore / DurableJobStore style, plus a `model_intel_meta` table
holding `schema_version`. The conductor.db is multi-gigabyte: every query is on an index and
bounded by key and/or time window; nothing here ever reads `structured_events`.

- `model_registry(key PK, provider, model, status, first_seen_at, updated_at, record_json)`
- `model_observations(id PK, key, field, value_json, source_kind, source_name, source_url, observed_at)`, index (key, field, observed_at)
- `model_benchmarks(id PK, key, benchmark, score, raw, categories_json, source_json, observed_at)`, index (key, benchmark)
- `model_changes(id PK, kind, key, field, before_json, after_json, source_json, at)`, index (at)
- `execution_outcomes(id PK, key, source, ref, category, at, result, …, row_json)`, unique (source, ref, key), index (key, category, at), index (at)
- `routing_decisions(id PK, kind, requester, at, choice, confidence, decided_by, escalated, project_id, agent_session_id, record_json, outcome_json)`, index (at), index (kind, at)

Retention: outcomes older than `OUTCOME_RETENTION_DAYS` and decisions older than 90 days are pruned
in bounded batches at startup.

### A. Registry and ingestion

- `applyBatch(batch)` is one transaction: store every observation, recompute the effective record
  of touched keys (highest `SOURCE_AUTHORITY`, then newest), emit `RegistryChange`s, commit. A
  failing source produces no batch; a throwing apply rolls back. Existing data is never deleted by
  ingestion; a key missing from a `complete` source is a `removed` change, and `retired` status
  needs every source that listed it to have dropped it.
- A new key enters as `unproven`. Status moves only through module D / reputation evidence.
- Sources (each `ingest/<name>.ts` exports `fetchBatch(ports): Promise<IngestionBatch>`):
  - `configured`: agent-manager catalogs and `local-models/config.ts` PINNED_MODELS (config authority; local size, quant, VRAM, GPU layers).
  - `runtime`: what `models.list` discovered from open tabs (cli authority: efforts, availability).
  - `latest-models`: the latest-models-methods schedule's `cli-catalogs` and `primary-sources` script outputs (creator/provider-docs).
  - `openrouter`: `https://openrouter.ai/api/v1/models`, public JSON with context and per-token prices (aggregator). This is the required real external source; it keys its records under provider `openrouter` and maps family names so priors can flow to the first-party keys without claiming identity.
  - Benchmarks (optional, prior only): a parser for a checked-in or fetched JSON of SWE-bench / Artificial Analysis style scores, stored in `model_benchmarks` and never in the record's factual fields.
- Refresh: a daily pass after the latest-models schedule run, plus `configured` + `runtime` at startup. The fetch uses `fetch` with an 8 s timeout, conditional GET where offered, and a cache under userData.
- `stale` is computed on read.

### B. Telemetry and reputation

- `recordOutcome(outcome)` is idempotent on (source, ref, key).
- Capture adapters are pure functions from an existing event to an `ExecutionOutcome`. Module E calls them from the existing hooks:
  - `capture/turn.ts`: a structured turn settled (completed / failed / interrupted), with the turn's usage summary (tokens, cost, duration) as the session already computes it, retries, and tool failures from the turn's items. Only turns with a category signal are counted: a routed or dispatched task, or one `categorize.ts` can label.
  - `capture/durable-job.ts`: a stage settled (counters: retries, recoveries, loopsDetected, contextRollovers; verifier result from the stage outcome).
  - `capture/local-agent.ts`: a LocalTelemetryEntry `stop`: stop reason → looped / contextFailure / timedOut / invalidOutput.
  - `capture/approval-review.ts`: a settled review record. The reviewer model's decision quality is category `decision`; an owner who overrides it counts as ownerCorrected.
  - `owner`: `models.outcome` lets the owner or a wizard mark a decision or turn rejected or corrected, and false-completion.
- `categorize.ts`: a deterministic keyword/tool heuristic from a task prompt and tool list to `TaskFeatures`, used when no one labelled the task. The local classifier (C, kind `classify`) may refine it; the heuristic is the fallback and the test oracle.
- `reputation.ts` (pure): `score(prior, outcomes, now)` → ReputationScore.
  - Beta posterior with `priorWeight` pseudo-counts at `priorMean`, and each outcome weighted `0.5^(ageDays/halfLifeDays)`.
  - success = 1, partial = 0.5, failure = 0, cancelled is skipped.
  - Behaviour dimensions: reliability (not timedOut/toolFailures/context failure), instruction-following (verifier pass), loop-tendency (looped), false-completion. Each is scored as the probability of *good* behaviour.
  - The prior comes from benchmarks mapped to the category (priorSource benchmark), else the family's other keys (family), else `defaultPrior`.
  - `lower` = the 10th percentile of the posterior (normal approximation is fine, clamped to 0..1).
- `status`: a key with at least `provenSamples` recency-weighted outcomes across categories becomes `proven` (store helper `promote`).

### C. Decisions and routing

- `DecisionService.decide(request)`:
  1. Validate that the options are non-empty and unique, and that the state is at most `DECISION_STATE_MAX_CHARS`.
  2. Ask the first system-one decider that supports the kind. Its verdict's probabilities are normalised over the option ids, and unknown ids are dropped.
  3. Escalate to the frontier decider when:
     - the thresholds' mode is `shadow`;
     - the system-one decider failed;
     - confidence < minConfidence, or margin < minMargin;
     - the choice is in `frontierOnly`;
     - the request is `impact: 'high'` and highImpact is `always-escalate`.
  4. The frontier verdict decides.
  5. If the frontier also fails, the result is `choice: null` with the reason. The caller then falls back to its old behaviour; for approvals that means the existing Opus review or owner card path.
  6. Journal a `DecisionRecord` with every verdict, including the shadow one. The record is returned to the caller.
- Thresholds are per kind, from settings (`model-routing:thresholds:v1`), with defaults:
  - route: live, 0.55, 0.15, escalate-when-unsure.
  - approval: shadow, 0.9, 0.3, always-escalate, frontierOnly ['deny'].
  - retry / escalate / completion / fallback: live, 0.7, 0.2.
  - classify: live, 0.5, 0.
- Deciders:
  - `deciders/scorer.ts` (system-one, kind `route` and `fallback`): deterministic.
    - Hard filters: availability, localOnly, excludeProviders, allow, toolUse when tools are required, context fits, maxCostUsd, a usage limit at or above the owner's stop threshold, a local model that does not fit VRAM or cannot be admitted now.
    - Utility per candidate: `lower-or-mean success − costWeight·normCost − latencyWeight·normLatency − loadPenalty (local not loaded) − behaviourPenalty (loop / false-completion reputation)`.
    - Probabilities = softmax(utility / T), with T = 0.08.
    - A local candidate whose category reputation `lower` is below 0.5 with at least 5 evidence is excluded, whatever its cost ("stops blindly preferring local").
  - `deciders/local-llm.ts` (system-one, kinds approval, retry, escalate, completion, classify): uses the existing `LocalModelRunner` (local-assist/model-runner.ts) with a strict JSON prompt: `{"probabilities":{"<id>":p,...},"rationale":"..."}`. It never starts a server during an interactive local turn (the runner already enforces this) and returns `ok:false` on any fallback, bad JSON or timeout (bounded by the runner's budgets).
  - `deciders/frontier.ts` (frontier): a port `ask(request) → verdict`. For approvals, module E adapts the existing `ApprovalReviewRouting.run` (Opus reviewer tab). For other kinds, the port can be a one-shot structured call through the same reviewer machinery. Tests use a fake.
- `router.ts`:
  - `route(features, constraints, ports) → RouteDecision`.
  - Candidates come from registry records whose provider is enabled in `models.list`, merged with live facts from ports: loaded local servers, usage-limit percent per provider, provider availability.
  - The scorer produces probabilities, and DecisionService decides (escalating a close call when the thresholds say so).
  - Fallback = the best eligible candidate on a different provider. Escalation = the best candidate by expectedSuccess alone.
  - Model and provider are chosen separately: the scorer ranks keys, and when one model family is offered by several providers the provider choice is explained as its own reason (price, quota, latency).
- `explain.ts`: renders a RouteDecision or DecisionRecord as the text block below. Nothing in the normal UI needs it; `decisions.get` and the Settings inspector show it.

```text
Selected: opus[1m] via claude (effort high)
Reasons:
- 93% success on difficult-coding (41 weighted outcomes, 30-day half-life)
- expected cost $0.42 within the $1.00 cap
- local/qwen3.6-35b-a3b excluded: 38% on difficult-coding (9 outcomes)
- tool use required: supported; 32k context needed, 1M available
Fallback: gpt-5.6-sol via codex
Escalation: claude-fable-5-1 via claude
Confidence 0.91 (margin 0.64), decided by scorer
```

### D. Evaluation

- A suite is a JSON list of jobs `{id, category, complexity, prompt, fixture files, grader}`. Graders are deterministic: exact / regex / JSON-schema / test command exit / file content.
- The suite spans the categories in the owner's list, with at least one job per category.
- `evaluate(key, suite, ports)` sets status `evaluating`, runs each job through a port, grades it and records outcomes with source `evaluation`. The status is then `proven` when the evidence is sufficient, and back to `unproven` otherwise.
  - Local models run through a parked local agent session port.
  - Cloud models run through a tab port, which the owner must allow for its cost.
- Results never change a default by themselves; they only feed reputation. A comparison report (the key against current alternatives on the same jobs) is written as Markdown under userData `model-evaluations/`.

### E. Wiring (control methods)

- `models.list` gains, per model: `registry` (status, pricing, context, stale), `reputation` (top categories) when known.
- `models.registry({provider?, model?, changesSince?})`, `models.refresh()`, `models.route({features, constraints})` (a dry run that returns a RouteDecision plus its explanation), `decisions.list({kind?, since?, limit})`, `decisions.get({decisionId})`, `models.outcome({decisionId|outcomeId, result, ownerCorrected?, falseCompletion?, detail?})`, `models.evaluate({provider, model, suite?})` (owner-only for cloud models).
- `router.dispatch` tasks may pass `route: {features, constraints}` instead of provider/model. The chosen route and decision id are returned and recorded, and the dispatched turn's outcome links to the decision.
- Approval gate: in `ApprovalReviewGate.prepare`, after routine/session rules and before `routing.run`, ask DecisionService kind `approval` with options allow/deny/escalate. In `shadow` (the default), the Opus reviewer decides exactly as today, and the local verdict is journaled next to it so agreement can be measured. `live` can be switched on per boundary only after `decisions.list` shows agreement.
- Every new method is classified in `control-method-classes.ts` and documented in `toolSignatures` and `docs/agent-control.md`.

#### As wired

- `model-intelligence/index.ts` `createModelIntelligence` builds everything on its own connection to `conductor.db` (schema v2):
  - the store, registry, ReputationService and DecisionService;
  - the router, the approval shadow and the evaluation.
- DecisionService deciders:
  - the scorer;
  - the local decider over the shared local-assist runner;
  - a frontier: a model port when one is wired, otherwise the **caller** (`CALLER_DECIDER_ID`, kinds route and fallback).
    - A close route call is escalated to the caller without a model call.
    - The close set is measured in utility: at most three options whose utility is within the route's `minMargin` of the top (`closeCandidates`), best first.
    - Its verdict takes the most capable of them (`capabilityRank`, ties by utility) only for hard (complexity 4+) or high-risk work, read from the request's `state.features`; otherwise the top-utility option stands, so a cheaper model wins a close easy call. Its rationale names them all.
    - Its confidence is the chosen option's own scorer probability (`chosenOnTop`: the others share the rest, none above it), not 1. Where that probability is at or below an even split (1/n), no distribution can keep it on top and the confidence is just above 1/n.
    - The close set is stored as `route.closeCandidates`.
    - `router.dispatch({route})` opens that choice.
- Owner exclusions (N5): setting `model-intelligence:excluded-models`, a JSON array of globs (`*`, `?`, case-insensitive) on the key id `provider/model`; default `["claude/claude-fable-5-1*", "claude/*fable*"]`. An unreadable value keeps the defaults; `[]` excludes nothing.
  - `service.route` drops matching keys before the router sees them, also against an `allow` list, and adds "`<key>` excluded by owner setting" to the route's reasons (four named, then a count). A route left with nothing names them in its error.
  - `models.evaluate` refuses an excluded key.
  - Why: the owner wants no Fable spend. Fable is not in `capabilityRank`'s name patterns, so it gets the default rank 2, below Opus and Astra. That function is shared with the auto-fixer and coordinator choices outside routing and is left as it is; the exclusion list is what keeps Fable out.
- Easy work and local models (N8): a summarization or other complexity 1-2 task goes to a local model only when that model is already loaded and the route's `costWeight` is high (about 0.9 and up). At default weights a cheap cloud model's success prior outweighs the free local one; a model that needs a server start is also charged its load cost.
- `model-intelligence/app-wiring.ts` holds the app side:
  - `src/main/index.ts` starts it in the background after the permission grants and hands it to `AgentControl.setModelIntelligence`. Until then everything behaves as before.
  - Startup prunes, then refreshes `configured` + `runtime`. An hourly check runs the daily pass (all sources) once 24 h have passed; the time is recorded in setting `model-intelligence:last-daily-refresh`.
  - The latest-models schedule's change notice triggers a `latest-models` refresh when the scripts' source state is newer. The latest-models source reads the scheduler's own full normalized script output (`schedule_source_state`, `script:cli-catalogs` / `script:primary-sources`), never the 4000-character run tail.
  - OpenRouter is fetched only outside test profiles and offline runs, with the conditional-GET cache in userData `model-intelligence/openrouter-models.json`.
  - Benchmarks are read from userData `model-intelligence/benchmarks.json` (ingest/benchmarks.ts format) when the owner keeps one there. None are shipped.
- CLI keys and OpenRouter (D1):
  - After every refresh a linked pass (`ingest/linked.ts`, source `linked:openrouter`, aggregator authority) copies prices, context, tool use, modalities and capabilities from the OpenRouter record of the same family onto `claude/*`, `codex/*` and `grok/*` keys.
  - Unversioned Claude aliases (`opus`, `opus[1m]`, `sonnet`, `haiku`, fable) link to the newest family of their tier.
  - Config and CLI facts still win.
  - `store.benchmarks(key)` lends a key its family's benchmark results when it has none.
  - Every record carries `capabilityRank`: the contract's rank of the model name, or of its family when the name alone is unclassified.
- Routing live facts (`AgentControl.routeLive`):
  - Local admission (D4): a local model whose VRAM envelope (`resourceRequirements().vramBytes`, from the configured source) exceeds the card is ineligible. The card is measured once with `nvidia-smi memory.total`, falling back to the machine profile's 12 GB. So is one that `localModelAvailability` says cannot be admitted now; the reason is in the explanation.
  - Usage (D5, `usageVerdict`): only current windows count (not `state: reset`), and a model-scoped window applies only to the models it selects. A weekly window is compared with the weekly stop, and a shorter one with 100 % (exhausted).
  - The weekly stop has one source for routing and evaluation: setting `model-intelligence:weekly-stop` (default Claude 85 %, Codex 55 %; a provider it does not name is routed up to 95 %). `routeLive` builds its usage facts with `routeUsage` over `service.weeklyStop`, and `service.route` applies the same stop when a caller's live facts name none. When every model of a provider is excluded by a usage limit, the route adds "`<provider>` blocked by its usage stop: …" to its reasons.
  - Fallback: another provider is preferred, since it survives an outage of this one (for hard or high-risk work its strongest model, else the best by utility). Only when no other provider is eligible does the fallback stay on the selected model's provider, as its strongest other model, and its reason names why each other provider is out. So with Codex blocked and the local model not eligible, a hard route on Opus falls back to Sonnet.
- Routed dispatch: an open that fails (including a local model that cannot be admitted) is retried once on the route's fallback. Both attempts are journaled in `route.attempts`.
- Decisions:
  - Route decisions store `route` (selected, fallback, escalation, reasons, close candidates, attempts).
  - A `models.route` dry run is journaled with `dryRun: true`, and `store.decisions` leaves it out unless `includeDryRun`.
  - `store.approvalAgreement({kind, since})` counts system-one agreement with the owner's answer (`outcome.answer`), else with the frontier's choice.
- Local decider (D6):
  - It shares the local-assist runner (`LocalAssist.runner`), so there is one runner and one queue.
  - It only uses a model server that is already running and never starts one. When none runs, the approval shadow notes the skip (`approvalShadow.stats()`, one log line an hour) and does nothing else; other local decisions fail with "local decider unavailable".
  - Two guards. `localServerRunning` is a quick check when the ask is made, so no ask queues when no server runs. It is not atomic with the ask: the runner looks for a server only after its queue, up to `MODEL_WAIT_BUDGET_MS` (20 s) later. So every decider ask also carries `noStart: true` (`LocalModelRequest.noStart`, `local-assist/model-runner.ts`): the runner then uses only a server it finds running at that point and otherwise falls back ("no local model server is running, and this call never starts one"), which the decision records as the local decider failing. A server that stops in between (the owner's `local.stop`, an admission handing the GPU to another model) is therefore never replaced by one the decider started.
  - The decider sees only the runner's `ask`: its `contextTokens` and `promptTokens` measurements locate a server the way an assist call does and could start one.
- Capture:
  - Turns: an `onBroadcast` observer takes `session` events with a settled phase for agents bound by `router.dispatch` (every dispatched agent, routed or not) and runs `captureTurn` on `database.structured.snapshot`.
    - Bindings persist in `dispatch_bindings`, so capture survives a restart: the newest 1000, for 7 days.
  - Durable stages: `withStageCapture` wraps the handoff port's `afterStage` (counter deltas are exact from a job's second observed stage).
  - Approval reviews: through the gate's shadow.
  - Local agent stops: the same observer takes the local adapter's stop notice (`localStopOf`, the `LocalStopReport` that `providers/local.ts` emits for every finished local turn) and runs `service.localTurnStopped` → `captureLocalAgentStop` on the next tick. No model is asked; the turn's prompt and its failed tool-grammar repairs (`localTelemetry` notices) are read from the in-memory projection.
    - A dispatched local agent takes its binding's decision, category and project, and `turnSettled` skips a turn that carries a stop report, so it is recorded once. Any other local tab counts only with a category signal, as `captureTurn` does.
    - Durable-job stages (prompt origin `durable-job`) are left to the stage capture.
  - Every recorded outcome promotes its key to `proven` once `ReputationService.proven` holds (D10): the same rule as evaluation, the proven count within one half-life.
- Approval shadow:
  - `ApprovalReviewRouting.shadow` is an optional observer. The gate calls `reviewing` (only when a reviewer turn runs, not for routine or session-rule answers), `reviewed` and `answered`, synchronously and inside try/catch.
  - DecisionService decides kind `approval` with the local decider as system-one and a per-request frontier decider that resolves from the reviewer's own record. The record therefore holds both verdicts, and the owner's later answer becomes its outcome, with `answer` set.
  - Mode `off` skips it. A boundary goes live only through `decisions.live` (owner or wizard, at least 30 cases at 95 % agreement).
- Evaluation:
  - Local keys: a one-shot answer through a runner preferring that model; an answer from another model fails the job. `app-wiring.ts` keeps one runner per evaluated model (created on first use and reused), each with its own admission; one evaluation runs at a time.
  - Cloud keys: `AgentControl.evaluationTurn` opens a background read-only native tab at the model's lowest effort, reads the answer and usage back, and closes it.
    - The tab opens in the first open project (`ownerScope`), whichever project asked; it is read-only and closed after the turn.
    - The owner's caps (setting `model-intelligence:evaluation-caps`, default 60k tokens per run, 3 evaluations and 150k tokens per 24 h, `minRunTokens` 45k, and the weekly stop from `model-intelligence:weekly-stop`, which the caps' own `weeklyStop` overrides for evaluation only) are checked before the run, and unknown usage means skip. Invalid values keep their defaults: a `weeklyStop` entry that is not a percent from 0 to 100 is dropped, so a malformed override can never switch the stop off.
    - Daily admission (N2, N14): a run is admitted while fewer than 3 ran in 24 h and its cap is at least `minRunTokens` (45k: the default 40k overhead plus a small job). Its cap is `min(perRunTokens, perDayTokens - spent in 24 h - what runs in progress still hold of their caps)`, held until it ends. The cap must also hold the provider's fixed overhead plus the suite's smallest one-shot job; otherwise the run is refused with that reason before it is journaled, so it does not use one of the day's runs. Admission charges the raw `measured` overhead while it is under a day old (`OVERHEAD_TRUST_MS`, N19), not the banded value: a per-run cap below the real preamble is refused with the measurement, the cap it needs and when it is measured again, instead of starting a turn sure to be cut off. After a day the preamble may have changed (a CLI or Conductor update), so one run is admitted on the banded value and measures it again. A suite with only command-graded jobs is refused for cloud keys. With the defaults a day therefore holds two full runs; the 30k left after them is refused.
    - The caps hold for a runner that stays within its budget. `evaluationTurn` can interrupt a native turn only after a usage report has passed the budget, so one API call can overrun it. That overrun is charged in full and the run stops, but it already happened: a run can pass its cap, and a day can pass 150k, by at most one job's overrun per run (the verifier measured 165k over three runs with a runner overrunning by 39k).
    - Fixed overhead (N9, N14): a native CLI turn reads about 39k tokens (system prompt, tools, project context) before the job. `service.fixedOverheadTokens(provider)` returns the last measured value, kept in setting `model-intelligence:evaluation-overhead` (`{provider: {tokens, measured, at}}`), default 40k until one is measured. A measurement is the input of the turn's first API call less its batched prompt at about four characters a token (Claude reports per-call input; Codex reports turn totals only, so a Codex turn that makes several calls over-measures). The value used for batching is therefore kept within a band, at least 5k and at most the per-run cap less the suite's smallest one-shot job, both when it is learned (the raw value is kept as `measured`) and when it is read. The band keeps batching usable; admission decides on the raw measurement (above). `evaluate()` gets it as `ports.fixedOverheadTokens`.
    - A cloud run is one batched native turn (`evaluation.ts`, N9): every one-shot-gradable job of the suite goes into one prompt as a numbered section, and the answer must give each job as a `### JOB <id>` block, which is split and graded per job. A numbered header (`### JOB 2`) is the task in that position unless another header names that task by id, and one that maps to no task still ends the section before it (N20). The fixed overhead is paid once per run. Command-graded jobs are not gradable in the cloud. When the overhead plus the jobs' batch sizes pass the run cap, the largest jobs are dropped first and marked not-gradable with the reason. The turn's budget is the run cap (`runCloud(key, batch, signal, {maxTokens})`). Budget exhaustion is never a model failure: jobs cut off by the cap, dropped, or in a batch whose answer holds no section at all are not-gradable and write no outcome. Local runs keep one job per turn, each with its own budget.
    - Journaling: the run's cumulative spend goes to `evaluation_runs` at its start, before and after every turn and at its end, upserted per run id. Before a turn starts, its whole budget is pre-charged (N12), and after it the entry is reconciled to the real spend, so a restart mid-turn leaves the turn's budget counted rather than nothing.
    - Spend (N3) counts the whole prompt, cache reads and writes included, plus the output (`evaluationTokens`). A turn whose usage passes its budget is interrupted. A turn that fails, is stopped, is aborted or reports no usage counts at least its budget: a usage-less answer returns it as `tokens`, and a failure throws `EvaluationTurnError` carrying it (the service normalises any cloud failure the same way).
  - Files come from fenced blocks whose info string is a relative path. Command graders run in `docker run --rm --network none --cap-drop ALL --read-only` on the local-models sandbox image over a temp folder that is removed afterwards; without it command jobs are not gradable.
  - Reports go to userData `model-evaluations/`.

## Verification (independent verifier, after the builders)

The requirements in the owner's §15 map to tests. Unit tests use an in-memory or temp-file store; the real-source check is one live fetch of the OpenRouter source into a temp registry.

- **Registry:** round trip; two providers for one family; provenance kept; re-apply produces no duplicates; a throwing batch rolls back.
- **Ingestion:** OpenRouter live; a failing source leaves the registry untouched; changes are detected (new model, price); staleness.
- **Telemetry:** each capture adapter maps real-shaped events; outcomes are queryable by category.
- **Reputation:** outcomes move the score; categories stay distinct; 2 failures do not sink a strong prior; recency.
- **Router:**
  - Local vs cheap cloud vs strong cloud.
  - High cost weight → local/cheap.
  - High-risk difficult coding → strong.
  - Local repeatedly failing → excluded.
- **Escalation:** a close case makes the system-one low-confidence, and the frontier fake decides.
- **Feedback:** a routed failure recorded via `models.outcome` lowers that candidate on the next route.
- **New model:** register a key: it is unproven; evaluate it with a fake runner; the results show in reputation and routing.
- **Explainability:** `decisions.get` shows the selection, provider, reasons, confidence, fallback and evidence.
- **Regression:** the full `npm test`, typecheck, and the approval gate tests unchanged in shadow mode.
