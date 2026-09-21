# Task A findings — 2026-09-21

## Implemented

- `llama.ts`: shared app/CLI startup admission, authenticated same-model reuse, configured/recorded/moved/adopted port checks, stale-record handling and process inventory. The startup lock covers admission, spawn, record publication and readiness. No automatic stop path was introduced.
- `resource-guard.ts`: OS-owned machine-wide loopback mutex (51434), Windows llama-server inventory, RAM and NVIDIA VRAM measurements, conservative envelopes and owner-facing refusals. No stale lock file or lease stealing. Failure to obtain inventory/telemetry prevents a new allocation, while a matching server can still be reused.
- `config.ts`: removed the incorrect claim that both servers should be resident together. `cli.ts` defaults start to 9B only and reports the actual chosen port. `start.ps1` describes this behavior.
- Tests cover a second process excluded by the lock, lock release on errors, stale PID records, adopted reuse, preserving the owner's running server on refusal, unrecorded servers, unreadable inventory, missing telemetry, context growth and MoE total weight residency. Lifecycle tests use isolated synthetic storage instead of requiring writable D: drive roots.
- New bounded measurement harness and parked admission smoke. Documentation proposal is separate because the controller owns integration into the existing dirty documentation.

## Measured (one bounded run, not a benchmark distribution)

Source: `measurements.json`, complete synthetic requests/responses, composition, usage, tool results, memory snapshots and per-request log deltas. `/props` in `server-props.json` reports build `b10901-28ff09582`, one slot, and the actual model path. Config records the matching build/version; direct executable `--version` returned no output in the sandbox. No inference server was started, stopped or reconfigured.

| Fixture | Requests / tool rounds | Prompt tokens per request | Completion tokens per request | Elapsed | Correct | Retries |
|---|---|---|---|---|---|---|
| file read | 2 / 1 | 1685, 1737 | 26, 17 | 1572 ms | yes, READ_4827 | 0 |
| edit + read-back | 3 / 2 | 1703, 1783, 1829 | 56, 26, 11 | 1530 ms | yes, actual file status=after | 0 |
| long tool output | 4 / 4 | 1697, 11598, 13801, 13915 | 40, 95, 83, 72 | 7626 ms | no final answer within bound | 0 HTTP/loop retries |

Each fixture used the real LocalAgentSession, current system prompt and current tool schemas. System text was 1999 characters; schemas 4273 serialized characters on every request. Serialized non-system history grew from 124 to 40934 characters for the long fixture. These are characters, not tokenizer estimates. The server's usage fields provide actual full prompt/completion tokens. Tool and app-control schemas were offered for composition realism, but shell execution and app-control mutations were disabled. Read/edit used the real workspace tools. The long fixture's shell fallback was denied, so this is not an unrestricted installed-app acceptance result.

The long fixture read a 35415-byte ASCII file; the loop's 32000-character prefix cap removed FINAL_MARKER at the tail. The model recognized truncation, tried a negative offset (read_file clamps it to the first line), tried a denied shell command, then correctly read offset 453. That fourth tool result contained LONG_7319, but maxIterations=4 ended the fixture before another completion. This failure is a measured bound/truncation interaction, not proof the model cannot solve it with another round.

Machine free RAM was 35,959,934,976 bytes before and 33,131,520,000 after; free VRAM was 3,859,808,256 before and 3,732,930,560 after. A separate nvidia-smi read reported 12227 MiB total, 8304 MiB used, 3640 MiB free before the run. These are machine-wide snapshots, not isolated per-process usage or peak allocation. CIM process inventory was denied in the sandbox; authenticated loopback HTTP and server-log reads worked. The known run record names PID 44580. Do not attribute all memory changes to inference with other coworkers active.

## Prompt/KV cache experiment

Two synthetic conversations had an identical system prefix and different user ledgers. Requests followed A1 → A2 → B1 → A3 → B2; no cache/slot overrides were sent. Each follow-up retained its own previous assistant response and appended a new user request. These measurements establish reuse on the installed build for these histories, not an eviction capacity guarantee.

| Call | Full prompt | Cached prompt | Newly evaluated prompt | Completion | Request elapsed | Server prompt evaluation |
|---|---:|---:|---:|---:|---:|---:|
| A1 | 1921 | 0 | 1921 | 3 | 813 ms | 609.351 ms |
| A2 | 1939 | 1917 | 22 | 4 | 171 ms | 86.738 ms |
| B1 | 1921 | 501 | 1420 | 3 | 595 ms | 470.248 ms |
| A3 | 1958 | 1935 | 23 | 4 | 1309 ms | 1170.852 ms |
| B2 | 1939 | 1917 | 22 | 4 | 267 ms | 89.180 ms |

The return to A reused 98.83% of its prompt but was slower than cold A1; cache restoration/other activity is a possible explanation, not established by the timing alone. The log independently records only 23 prompt-evaluation tokens for A3. A single slot does not mean only one conversation prefix can be cached. Report full prompt tokens separately from evaluated tokens; graphs reused is a different metric.

## Concrete second-batch recommendations (not implemented here)

1. `agent.ts` tool-result cap: replace silent prefix-only `slice(0, 32000)` with a bounded head/tail representation plus explicit omitted-character count and retrieval guidance. Preserve enough tail for markers; keep original full tool output for review. Add a regression where the answer is at the tail and the bounded retry budget must still produce a final response. The long fixture is ready for a paired rerun.
2. `tools.ts` read_file: expose total line count/range returned/truncation, validate or document negative offsets; optionally support an explicit tail operation. Avoid making the model infer file size by rereading or shelling out. This needs controller authorization because tools.ts is protected.
3. `client.ts`: preserve `usage.prompt_tokens_details.cached_tokens` and timings (`cache_n`, `prompt_n`, prompt_ms) in local telemetry. Keep full prompt usage as context occupancy; do not subtract cached tokens from the context window.
4. Keep tool schemas/order and system prefixes stable. Cache reuse already works by default on this build; do not remove schemas, increase `--parallel`, or add cache flags as an unmeasured optimization. Rerun the A/B sequence after any prefix/trimming change. Longer conversations/eviction remain unmeasured.
5. Final-request budget validation after trimming/pinning/protocol repair: test actual sent messages plus schemas and response reserve. This run did not measure a context overflow, so proposed savings remain unmeasured.
6. `providers/local.ts` ensureServer currently returns on any successful health response without validating model identity/key enforcement. Route its reuse check through shared identity validation (or the guarded start path) in batch two; no new spawn bypass exists, but a foreign server can currently pass its fast path. No edit made outside ownership.
7. CLI launcher imports TS parameter properties through client.ts; Node 24 strip-only fails. The measurement and owned start.ps1 now use `--experimental-transform-types`. Controller should apply the same runtime choice to other local PowerShell entrypoints or remove parameter properties in a coordinated client change. Only start.ps1 is owned here.

## Validation and delivery state

Targeted Vitest: 52/52 passed; `npx.cmd tsc --noEmit`: passed (2026-09-21). An initial lifecycle run failed because old tests attempted scratch writes at D: drive root; tests now isolate mocked storage in permitted temporary directories. No tests were skipped.

Parked smoke prepared; waiting for controller's serialized build and fresh exact electron-slot grant. See admission-preflight.json for the real shared startup refusal and unchanged healthy owner server. Build, parked screenshot, integration, commits and publishing belong to the controller. Task A is not marked done until the agreed smoke/report handoff is finished.
