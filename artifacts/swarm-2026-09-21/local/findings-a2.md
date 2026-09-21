# A2: local loop context and cache improvements — 2026-09-21

## Delivered for controller integration

1. Long tool output now enters model history as a bounded head-and-tail representation. The 32000-character cap includes an explicit omission count and retrieval guidance (`read_file` with a positive 1-based offset and smaller limit, or search). The existing tool-end event still receives the full result, so the reviewer can inspect every original character. A deterministic regression only returns the right answer if the actual second HTTP request includes the tail, and succeeds within two requests.
2. `read_file` adds total line count, returned range and a truncated flag to its result. Offsets are documented in the result and refusal message as positive 1-based line numbers; negative, zero, fractional, string and unsafe-integer offsets are rejected. This changes result text, not schemas. Empty files and ranges beyond EOF are represented explicitly. No separate tail tool or expanded capability was added.
3. The client preserves the server's `prompt_tokens_details.cached_tokens` plus the recognized numeric `timings` fields, including timing-only SSE frames. The adapter emits cached usage and stores timings in the existing native event envelope (`llama.cpp/timings`); full input tokens are preserved as context occupancy. No cached-token subtraction or new renderer interpretation was introduced.
4. The client checks the final request immediately before HTTP, after the loop has trimmed, pinned, repaired and inserted any fallback user message. It counts serialized messages and complete schemas, with the explicitly passed 4096-token response reserve. Overflow raises an actionable error and sends no HTTP request or futile retry. The new helper uses UTF-8 bytes / 3 plus template/message padding: this is a conservative heuristic for normal code/text, **not exact server tokenization or a guarantee for arbitrary text**. The server's existing bounded context-error retry remains authoritative for estimator misses.
5. Provider reuse passes through shared `inspectAdmission` model identity/key checks. A healthy foreign server or one impersonating our model id without enforcing the key cannot receive a conversation. Concurrent startup still goes through `startServer` and its cross-process lock; the optimistic probe never authorizes a spawn. Existing same-process starts share the pending promise, and a refusal/loading race is resolved again under the startup lock.

## Exact file list and protected hunks

- `src/main/local-models/client.ts`: telemetry parsing and final request budget check.
- New `src/main/local-models/context-budget.ts` and `context-budget.test.ts`: bounded result representation, final payload estimate and overflow tests.
- `src/main/local-models/agent-loop.test.ts`: tail-answer, complete review output, metadata/offset validation, telemetry and no-HTTP-overflow regressions.
- `src/main/providers/local.ts` and `local.test.ts`: shared identity validation, native timing envelope and foreign/unauthenticated server tests. Tests now use isolated temporary synthetic state rather than writing to a real secondary-drive root; none are skipped.
- `scripts/local-models/measure-thrift.ts`: optional report tag, loop stop reason and client telemetry capture. Existing fixture inputs, four-round bound and sampling remain unchanged.
- Protected `src/main/local-models/agent.ts`: one import, two explicit budget fields on the existing completion request, and replacement of the prefix-only history cap. The existing app.update wording is unchanged.
- Protected `src/main/local-models/tools.ts`: only the `read_file` result/offset block was extended. The other agent's app.update/control/schema lines are unchanged.
- Evidence and this report under `artifacts/swarm-2026-09-21/local/`. No other production files or documentation were touched in A2.

## Paired run

Baseline: `measurements-before-a2.json`, captured at 18:53 UTC by Task A. Rerun: `measurements-after-a2.json`, 19:12 UTC, using the same fixture files, prompts, system/schema text, four-round limit, temperature 0.3 and server build `b10901-28ff09582`. First request bodies compare byte-for-byte equal. `comparison-a2.json` is reproducible with `node artifacts/swarm-2026-09-21/local/compare-a2.mjs`.

| Fixture | Correct before → after | Requests | Tool rounds | Elapsed ms | Summed full prompt tokens | Completion tokens |
|---|---|---|---|---|---|---|
| file read | yes → yes | 2 → 2 | 1 → 1 | 1572 → 1358 | 3422 → 3452 | 43 → 40 |
| edit/read-back | yes → yes | 3 → 3 | 2 → 2 | 1530 → 1482 | 5315 → 5345 | 93 → 86 |
| long output | no → yes | 4 → 2 | 4 → 1 | 7626 → 3740 | 41011 → 13279 | 290 → 50 |

All fixtures had zero request retries before and after. The long fixture now returns exactly `FINAL_MARKER=LONG_7319`, stop reason `complete`. It sends 27732 fewer full input tokens across its requests (67.6%); actually evaluated prompt tokens fall from 12040 to 9883 (17.9%). The full-input reduction is chiefly avoided follow-up rounds, not an equivalent reduction in inference compute. Read metadata adds 30 prompt tokens to each short fixture's final request. The new head/tail result retains the same 32000-character bound, and the server reports 11582 prompt tokens on the second long-output request versus 11598 before.

This is one bounded sample in each condition, not a latency distribution or an agent benchmark. The deterministic regression demonstrates tail preservation independently of model randomness. Shell execution and app-control mutations remain disabled in the harness; the old long fixture's failed shell fallback is part of that bounded result. No additional inference workers ran during the experiment, but other native coworkers were active. No model was started, stopped or reconfigured.

The rerun's machine-wide free RAM was 34093789184 → 33478037504 bytes; free VRAM was 3752853504 → 3755999232 bytes. These are before/after snapshots, not per-process or peak usage. CIM process inventory remains unavailable to the sandbox; authenticated loopback HTTP and log reads worked.

## Prefix/cache evidence

All 16 combinations of read-only/control/git/research yielded byte-identical system prompts and ordered serialized schemas before and after A2 (`prefix-before-a2.json`, `prefix-after-a2.json`). No prefix text or schema ordering changed. The fixture system prompt is still 1999 characters and tool schemas 4273 serialized characters.

The A1 → A2 → B1 → A3 → B2 sequence was rerun anyway. No cache/slot override was sent:

| Call | Full prompt | Cached | Newly evaluated | Request elapsed ms |
|---|---:|---:|---:|---:|
| A1 | 1921 | 1917 | 4 | 240 |
| A2 | 1939 | 1917 | 22 | 192 |
| B1 | 1921 | 1917 | 4 | 164 |
| A3 | 1958 | 1935 | 23 | 217 |
| B2 | 1939 | 1917 | 22 | 238 |

Returning A reused 98.83% and returning B 98.87% of full prompt tokens. Earlier A/B histories were still warm, so A1/B1 are **not cold-cache measurements** in this rerun. The returned A/B reuse counts match Task A. No improvement in cache implementation is claimed; the change preserves and exposes existing reuse. Live fixture telemetry contains the same full prompt/cached/timing values as raw SSE.

## Validation, sampling and remaining limits

- 76 tests passed across context-budget, agent-loop, provider local, existing local-models and control-integration suites. Raw output: `vitest-a2.txt`.
- `npx.cmd tsc --noEmit`: exit 0 (`typecheck-a2.txt`).
- Live paired fixtures and A/B sequence completed with no server lifecycle changes. Task A's parked admission smoke was already run successfully by the controller; A2 adds no Electron launch or screenshot.
- Sampling is unchanged at temperature 0.3, without explicit top_p/top_k. The research coworker reported model-card guidance of 0.6/0.95/20 for coding; that configuration was **not tested here**. Its correctness/tool-round behavior cannot be inferred from this context-only paired run, so no sampling change is justified by these results.
- Exact server-tokenizer validation, alternative sampling, larger-cache eviction behavior, new tail/search tools and timing UI changes were not implemented. The scoped recommendations are complete; these are explicit limits or separate experiments, not claimed results.
- No commits, pushes, builds, model downloads, live configuration edits or edits to docs/local-models.md. Controller owns integration/build/release.
