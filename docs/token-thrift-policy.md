# Token-thrift routing policy

This is an advisory policy, not an automatic model switch. Route against the capabilities currently advertised by `models.list`, the live allowance buckets, the task's risk, and the acceptance check. Never spend a cheap attempt when its result cannot be checked cheaply.

The 2026-09-21 planning snapshot showed Codex weekly usage at 7%; the later Claude snapshot showed 16% of the five-hour bucket, 12% of the general seven-day bucket and 19% of the Fable-specific weekly bucket. These numbers expire. Refresh the zero-turn account/rate-limit read before a batch; do not treat the Fable bucket as universal Claude capacity.

## Routing ladder

| Route | Suitable work | Acceptance check | Retry and escalation |
| --- | --- | --- | --- |
| Local (`local/qwen3.5-9b`; use the larger configured local model only when admission and memory checks allow it) | Search, classification, formatting, bounded extraction, fixture generation, mechanical edits with exact file ownership | Deterministic test, schema validation, exact diff inspection, or controller comparison against source | One corrective retry. Escalate on ambiguity, tool failure, a non-local dependency, or a second rejected result. |
| Cheap native (`gpt-5.6-luna`, `gpt-5.6-sol` low/medium, Claude Haiku where advertised) | Small implementation, routine debugging, summaries and handoffs whose facts are already verified | Targeted test plus typecheck for code; source-linked checklist for analysis; controller reviews changed lines | At most two attempts total. Escalate when the first failure reveals architectural uncertainty; do not use the second attempt to repeat the same prompt. |
| Strong general (`gpt-5.6-terra`, Sonnet, default Claude) | Multi-file implementation, uncertain diagnosis, integration review, synthesis across artifacts | Relevant tests, typecheck/build in the owning workflow, and explicit verification of assumptions | One bounded repair after concrete feedback; then escalate to frontier or the owner. |
| Frontier (`gpt-6-astra`, Opus/Fable 1M variants as advertised) | Architecture, high-risk or security-sensitive work, conflicting evidence, hard review, recovery after bounded cheaper attempts | Independent evidence appropriate to the risk; for delivery, the controller's full test/build/release contract | Do not loop. If the frontier pass still lacks authority, credentials or a material product decision, ask the owner. |

Use the lowest route whose acceptance check can reject a plausible wrong answer. Prefer unused or less-constrained allowance buckets only after capability and risk fit; quota availability does not make a model suitable. Keep controller review cost in the estimate. Local inference saves remote tokens only when retries and review do not exceed the avoided work.

## Conversation routing

- Continue when the work is the same objective, retained decisions are valuable, or only a few calls remain.
- Compact when the objective is unchanged, the transcript contains large obsolete tool output, and important constraints can be verified after compaction.
- Start a fresh task with a bounded handoff when the objective or file ownership changes, unrelated history dominates, or the model/cache sensitivity shows enough remaining calls to repay the transition.
- Do not trigger on one universal context threshold. The 2026-09-21 estimate ranges from a two-call payoff for some large-context models to 28 calls for Haiku and 14 for Luna at a 90% cache ratio.
- Label replay calculations as estimates. Claim no measured Conductor saving until equivalent tasks are paired by model, acceptance result and workload, including failed attempts, handoff writing, re-orientation, verification and escalation.

## Bounded handoff format

```text
Objective
- One sentence describing the accepted end state.

Constraints
- Safety, delivery and coordination rules that change execution.

Owned files
- Exact writable paths; everything else is read-only.

Verified findings
- Facts already demonstrated, each with command/result or source reference.

Remaining work
- Ordered, bounded actions and their acceptance checks.

Artifact references
- Stable repository paths to sanitized evidence; never prompt text, credentials or copied secrets.
```

Keep the handoff at or below 1,200 tokens unless the receiving task demonstrably requires more. Reference full outputs by path instead of pasting them. The receiving model must verify current file state before editing because other workers may have changed the shared checkout.

## Measuring whether the policy works

For a paired task experiment, record model, route, user turns, API calls, cached and uncached input, output, wall time, retries, escalations and whether the acceptance check passed. Compare accepted tasks of similar scope. A shorter prompt, lower replay estimate or lower mean context is not by itself a product saving.
