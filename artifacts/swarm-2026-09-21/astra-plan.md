**1. Dispatch four coworkers in the first batch**

Use fresh native tabs through `router.dispatch`. These selections are advertised by the live `models.list` response:

| Task | Provider | Model | Effort | Permission |
|---|---|---|---|---|
| A. Local startup safety and inference measurements | codex | `gpt-6-astra` | `high` | `accept-edits` |
| B. Provider capability verification | claude | `claude-fable-5-1[1m]` | `high` | `accept-edits` |
| C. Context-cost analysis and routing policy | codex | `gpt-5.6-sol` | `medium` | `accept-edits` |
| D. Local models, inexpensive providers, and agent runtimes | claude | `opus[1m]` | `high` | `accept-edits` |

`accept-edits` permits the named deliverables only. B and D must not change production code.

Put the complete ownership map and hard constraints in **every** prompt: no commits, pushes, checkouts, nested workers, installations, model downloads, or changes outside the whitelist. Refresh live coordination and the working-tree inventory before dispatch. Keep at most four workers active, one local inference experiment active, and one build/smoke active.

Protect the brief’s entire dirty-file list. Also protect these additional files found during inspection: `AGENTS.md`, `docs/agent-control.md`, `scripts/fixtures/codex-app-server.mjs`, `docs/machine-profile.md`, `scripts/smoke-background-wait-activity.mjs`, `scripts/smoke-limit-continuation.mjs`, `scripts/smoke-local-update-build.mjs`, `src/main/local-update-build.ts`, and `src/main/local-update-build.test.ts`.

**A. Local startup safety and inference measurements**

**Exclusive ownership:** `src/main/local-models/llama.ts`, `src/main/local-models/config.ts`, `src/main/local-models/local-models.test.ts`, new `src/main/local-models/resource-guard.ts` and `.test.ts`, `scripts/local-models/cli.ts`, `scripts/local-models/start.ps1`, new `scripts/local-models/measure-thrift.ts`, new `scripts/smoke-local-admission.mjs`, and `artifacts/swarm-2026-09-21/local/`.

**Prompt instructions:** Enforce the machine’s one-server rule centrally before spawning, covering both CLI and installed-app startup. Reuse the existing matching server; refuse another model without stopping the owner’s server. Address concurrent starts across processes, stale records, adopted servers, and unavailable resource measurements. Assess RAM/VRAM headroom conservatively; parameter count alone is insufficient.

Measure the already-running 9B model using bounded read, edit/read-back, and long-tool-output fixtures. Record request composition, reported tokens, elapsed time, tool rounds, retries, correctness, and observed memory use. Investigate cache reuse using the installed llama.cpp version. Leave `agent.ts`, `tools.ts`, and live configuration untouched.

**Success/evidence:** Tests prove simultaneous starts cannot admit two models, existing-server reuse works, and refusals preserve running work. Run targeted Vitest tests and `npx tsc --noEmit`. Supply raw benchmark results and a parked admission smoke showing the owner-facing refusal. Separate measured cache behavior from hypotheses.

**B. Provider capability verification**

**Exclusive ownership:** `docs/conductor-provider-parity.md`, new `scripts/probe-capability-sweep.mjs`, new `scripts/smoke-capability-sweep.mjs`, new `scripts/fixtures/swarm-capabilities-codex.mjs`, new `scripts/fixtures/swarm-capabilities-claude.mjs`, and `artifacts/swarm-2026-09-21/capabilities/`.

**Prompt instructions:** Compare installed CLI versions and native metadata against Conductor’s discovery, fallback catalogs, adapters, and rendered controls. Cover model identity, effort/defaults, context capacity, current versus cumulative usage, cache accounting, compaction, thinking display, fast mode, subagents/background work, web search, MCP, hooks, and permission boundaries. Include local-model labels and context reporting.

Distinguish *latest publicly documented*, *installed*, *advertised to this account*, and *verified through Conductor*. Prefer zero-turn discovery. Native `model/list` is the documented source for available models and their effort options. [Official OpenAI documentation](https://learn.chatgpt.com/docs/app-server#models)

**Success/evidence:** A dated matrix links every finding to runtime evidence, official documentation, or a reproducible fixture. Parked screenshots demonstrate controls for advertised model families, unknown metadata, and compaction/reset states. Report exact proposed repair locations without editing protected adapters or UI files. Run existing relevant unit tests, typecheck, and the new smoke.

**C. Context-cost analysis and routing policy**

**Exclusive ownership:** `scripts/measure-context-churn.mjs`, new `scripts/measure-context-churn.test.mjs`, `docs/context-accounting.md`, new `docs/token-thrift-policy.md`, and `artifacts/swarm-2026-09-21/context/`.

**Prompt instructions:** Extend the existing log analysis rather than creating another telemetry system. Separate calls from user turns, parent from child usage, cached from uncached input, and historical from post-v0.1.36 behavior. Report distributions as well as means.

Compare continuing, compacting, and starting a fresh task with a bounded handoff. Include summary generation, orientation, verification, and escalation costs. Specify an advisory routing policy using advertised capabilities and current allowance buckets, with bounded retries and explicit escalation. Define a handoff containing objective, constraints, owned files, verified findings, remaining work, and artifact references.

**Success/evidence:** Reproducible, sanitized log aggregates; parser tests for duplicate/cumulative events and compaction; sensitivity analysis showing when a handoff pays back. Run the script tests and typecheck. Label replay estimates as estimates; do not claim measured product savings before a paired task experiment.

**D. Local models, inexpensive providers, and agent runtimes**

**Exclusive ownership:** new `docs/local-model-shortlist.md`, `docs/budget-provider-options.md`, `docs/agent-runtime-options.md`, and `artifacts/swarm-2026-09-21/research/`, including proposed configuration snippets.

**Prompt instructions:** Screen the draft’s named candidates, then investigate at most three local models, three remote offerings, and two alternative runtimes deeply. Explain rejections briefly.

For local models, report total weights, quantization, runtime support, context/KV requirements, offload assumptions, license, tool-use evidence, and fit within available RAM/VRAM. Distinguish measured throughput, comparable published measurements, and unknowns.

For remote offerings, verify monthly versus annual pricing, recurring versus introductory rates, API entitlement, supported harnesses, fair-use limits, concurrency, caching, data handling, and availability to this owner. Compare benchmark results only with their harness and evaluation conditions attached.

**Success/evidence:** Dated primary-source citations; ranked recommendations including “keep the current stack” when appropriate; exact proposed setup commands and configuration snippets, never executed. Include integration cost and cost per accepted task, not just headline subscription price.

**Second batch**

Start after reviewing first-batch evidence and explicitly transferring ownership:

| Task | Selection | Exclusive worker files |
|---|---|---|
| Local context/cache improvements | A’s Astra/high worker | `src/main/local-models/client.ts`, `src/main/local-models/agent-loop.test.ts`, new `src/main/local-models/context-budget.ts` and `.test.ts`, `src/main/providers/local.ts` and `.test.ts`; transfer `scripts/local-models/measure-thrift.ts` from A |
| Confirmed native capability repairs | B’s Fable/high worker | `src/main/agent-manager.ts` and `.test.ts`, `src/main/providers/codex.ts` and `.test.ts`, `src/shared/model-effort.ts` and new `.test.ts`, `src/renderer/src/agent-models.ts` and `.test.ts` |
| Fresh-task handoff and routing | codex, `gpt-6-astra`, high | New `src/main/context-handoff.ts` and `.test.ts`, new `src/renderer/src/components/ContextHandoff.tsx`, `src/shared/orchestration.ts`, new `scripts/smoke-context-handoff.mjs` |
| Bounded local acceptance | local, `local/qwen3.5-9b`, **omit effort** | Only controller-prepared fixture files explicitly named under `artifacts/swarm-2026-09-21/local-acceptance/` |

Use `accept-edits` for these tasks. Run local acceptance after the local implementation and benchmark slot are released; the controller evaluates its output and updates its orchestration task.

The controller alone applies coordinated integration hunks in protected files, including `agent.ts`, `tools.ts`, Claude/session/shared types, and `StructuredAgentPane.tsx`. Preserve the existing `agent.ts` addition concerning `app.update`. The controller also owns `turn-briefing.ts`/tests for a compact machine-policy briefing available in every project, sent once per runtime/reset.

Do not merge unused helpers as completed features. Integrate and verify the complete behavior, then run the full relevant suite, typecheck, serialized parked smokes, and `npm.cmd run build`. The controller commits, pushes `main`, and verifies the release’s installer, blockmap, and `latest.yml`; no manual version bump.

**2. Risks and prompt requirements**

| Task | Concrete risk | Required mitigation |
|---|---|---|
| A | Two models overload MAIN; startup races bypass an in-process map; benchmarks disturb the owner’s server | Central cross-process admission; no automatic eviction/restart; synthetic race tests; benchmark only the existing server |
| B | Discovery is mistaken for demonstrated support; shared UI edits collide; fixtures obscure actual runtime gaps | Separate implementation/evidence labels; independent new fixtures; retain unknown capacities; defer production repairs |
| C | A universal threshold breaks cache economics or loses task state; log replay double-counts usage | Model-specific sensitivity analysis; include handoff overhead; test event deduplication; no automatic mid-turn migration |
| D | Subscription excludes API access; benchmark claims exaggerate agent quality; “A3B” conceals large resident weights | Verify terms and evaluation setup; budget total weights plus runtime/KV memory; mark unknown throughput; no purchases/downloads |

For every smoke, immediately validate the fresh `electron-slot.json` grant against generation, agent ID, and script. Use a parked test profile. **Do not run the existing local smoke unchanged:** it opens both configured models, and `--cold` stops servers.

**3. Highest-leverage savings, ranked**

1. **Fresh task boundaries with compact handoffs — high potential, medium effort.** The recorded 160k mean context and 192 calls/session make retained unrelated history expensive. Under the accounting document’s illustrative cache ratios, startup is about **126k cached-input-token equivalents** before handoff overhead. That supports testing task boundaries, not a universal 130k trigger. The current controller snapshot already reports approximately 466k context tokens.

2. **Reduce tool-output accumulation and repeated reads — high potential, medium effort.** The local loop retains up to 32,000 characters per tool result. Prefer bounded excerpts, paths, and retrievable artifacts while preserving full review evidence. Measure avoided subsequent input, not just shorter output.

3. **Route bounded work cheaply, with acceptance checks — potentially high cost savings, medium effort.** Use local models for narrow tasks with deterministic verification; escalate ambiguity and failures. Count the controller’s review and failed attempts. Existing Fixer instructions already recommend cheaper models; the missing part is evidence-backed task selection.

4. **Keep controller context small — moderate potential, low effort.** Use incremental `agents.history`, concise worker results, and artifact references. Avoid repeated full snapshots, repeated research, and several agents independently rereading the same repository.

5. **Stable local prefixes and verified KV reuse — primarily latency/compute savings, medium effort.** Preserve stable tool ordering and prompt prefixes. Measure same-tab and alternating-tab behavior: one server slot does not imply efficient cache reuse across conversations.

**4. What is wrong or missing in the draft**

- **A is too broad.** Separate admission safety and measurement from local-loop changes. The machine profile says one server; startup code and local documentation still assume both may reside.
- **Several proposed optimizations already exist.** Local first attempts request `reasoning_effort: 'none'`; trimming includes schema overhead and a 4,096-token response reserve. Test remaining weaknesses in the final request after trimming, pinning, and protocol repair.
- **Sending schemas again is not inherently wasted processing.** Chat-completions requests still need their tool definitions; reuse must be established through the server’s actual cache behavior.
- **The local adapter is not a configurable remote-provider integration.** It constructs loopback endpoints, reads local credentials, and starts llama.cpp. Remote inference needs an explicit endpoint/authentication/data-boundary design.
- **The fresh-tab cost claim is stronger than its evidence.** At 160k, the illustrative first-request comparison alone is roughly a 21% input-cost reduction, not “several times cheaper.” Larger savings depend on subsequent calls.
- **Machine limits must reach every project through shared runtime policy**, not solely this repository’s documentation. Keep changing free-memory telemetry out of repeatedly injected prompts.
- **Refresh budgets before dispatch.** The observed Claude values had already moved to 16% five-hour, 12% weekly, and 19% Fable weekly. Preserve the Fable-specific scope.
- **A new agent runtime is not a stronger model.** Evaluate orchestration, cancellation, permissions, structured events, maintenance, and accepted-task cost separately.

Planning task `task_mubl5brs_e8eol4r` is marked done through the app protocol. No repository files were edited, workers launched, tests/builds run, or downloads made.