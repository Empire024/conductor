# Tool-call timing analysis: t3code survey and the Conductor equivalent

Cloud-session delivery, 2026-10-29. Branch `claude/t3code-tool-timing-analysis-3aqudf`.

> **Stale-base warning.** This work is based on `origin/main` at `3f95349`. The owner's local
> checkout is about 92 commits ahead of that. Every change is either a new file or a small hunk
> anchored on a stable line; the hunks are listed under [Integration](#integration-plan-and-patch-notes)
> so the controller can re-apply them by hand if a cherry-pick does not apply cleanly. Nothing in
> `feature-list.md`, the thread view or the projectless-thread flow was touched.

## 1. What t3code actually has (pinned source)

Source: `pingdotgg/t3code` at **`dd148481531a0a090780a2ade20588566db099a2`** (2026-10-29,
"perf(server): idle servers run 100x fewer background queries…"). It was cloned read-only; no t3
script, install or build was run.

t3code has **no tool-call timing analysis.** What it has instead:

| Area | What exists | Where |
|---|---|---|
| Per-item timestamps | Every turn item (tools included) has `startedAt`, `completedAt` and `updatedAt`, all nullable. There is no per-tool `durationMs`. | `packages/contracts/src/orchestrationV2.ts:1460-1487` |
| Codex | The adapter stamps `startedAt = DateTime.now` when it first sees an item, and `completedAt = now` when the item reaches a terminal state. It never reads the app-server's own `durationMs` (0 references in the adapter), even though the schema carries it for commandExecution, mcpToolCall and dynamicToolCall. | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:2375-2394, 3459-3523`; `packages/effect-codex-app-server/src/_generated/schema.gen.ts:33386,33405,33421` |
| Claude | `startedAt` is stamped by `DateTime.now`, sometimes inside the `canUseTool` permission callback, so approval wait is counted as tool time. | `ClaudeAdapterV2.ts:6750-6760, 8974-8982` |
| ACP, OpenCode | Times are taken at ingestion. Only OpenCode v1 uses provider-reported `time.start/end`. | `packages/provider-acp/src/server/adapter.ts:2637-2656`; `packages/provider-opencode/src/server/adapter.ts:504-507` |
| Wait vs execution | Not split for tools. `runQueueWait` exists for runs only. | `apps/server/src/observability/Metrics.ts`; `orchestration-v2/RunMetrics.ts` (it dedups outcomes with a bounded set of 4096) |
| Aggregation | `TraceDiagnostics` covers **server Effect spans**, not agent tools. It groups by name (count, failures, total, max), keeps the 10 slowest (`TOP_LIMIT`), the 20 latest failures and logs, uses a 1 s slow threshold, and its `insertBounded` keeps a bounded top-N. `t3 trace summary` gives nearest-rank p50 and p90 per span. | `apps/server/src/diagnostics/TraceDiagnostics.ts:72-74,166-181`; `apps/server/src/cli/trace.ts:70-95` |
| Retention | Trace files are capped at 10 MiB × 10 rotated files. Provider NDJSON is capped at 10 MiB × 10, 512 MiB in total, and 14 days. | `config.ts:225-226`; `provider/EventNdjsonLogger.ts:26-36` |
| Redaction | Span strings are cut at 500 characters. Codex native logs mask sensitive keys and Bearer tokens. Tool inputs stored on items are **not** redacted. | `packages/shared/src/observability.ts:301-346`; `CodexAdapterV2.ts:1431-1466` |
| UI | Settings → Diagnostics shows "Slowest Spans" and "Most Common Failures" for spans. The chat shows "Worked for X" per turn. No duration is shown per tool. | `apps/web/src/components/settings/DiagnosticsSettings.tsx:1062-1321`; `MessagesTimeline.logic.ts:1160-1206` |

What Conductor took from t3: span-style diagnostics applied to tool calls (top-N slowest, failures
grouped by cause, nearest-rank percentiles), bounded top lists, first-seen start times keyed by native
id, 14-day retention, and deduplicated outcomes. What it deliberately does differently:

- It uses the provider's own `durationMs`, which t3 discards.
- It keeps approval wait separate from execution, where t3 mixes them.
- It reports p95 as well as p50.
- It masks argument summaries, where t3 stores tool inputs unredacted.
- It marks a missing time as unavailable rather than substituting the ingestion time.

## 2. Conductor architecture

```
provider adapter ──emit──▶ StructuredSessions.emit (stages AgentEvent: id, sequence, runtimeId, timestamp)
                                   │ this.observe(spec, event)            (existing hook)
                                   ▼
                     AgentManager observer ──▶ ToolTimingRecorder.observe(event, spec.model)
                                                   │ open calls (Map)  ──finish/abandon──▶ ring of records
                                                   │                                        │ batched append (2 s)
                                                   ▼                                        ▼
                         tools.timings (app control)            <userData>/tool-timings/tool-timings.jsonl
                         tool-timings:report (IPC) ──▶ Settings → Usage → "Tool timings"
```

Files:

- `src/shared/tool-timings.ts` contains the record and report types, the argument summarizer and
  masker, the failure-line extractor, nearest-rank percentiles, aggregation, and the offender rules.
  It is pure and shared by the main process and the renderer.
- `src/main/tool-timings.ts` is `ToolTimingRecorder`. It handles the call lifecycle, deduplication,
  abandonment and amendment, bounded storage, compaction, and query validation, and it registers the
  `tool-timings:report` IPC handler.
- `src/preload/tool-timings.ts` is the bridge (`window.conductor.toolTimings.report`).
- `src/renderer/src/components/ToolTimings.tsx` and `.css` are the Settings → Usage section.
- The tests are `src/shared/tool-timings.test.ts`, `src/main/tool-timings.test.ts` and
  `src/main/tool-timings.pipeline.test.ts`, plus one case in `agent-control.test.ts`.
- `scripts/smoke-tool-timings.mjs` is the parked Electron smoke.

### Record (one per tool call)

Each record holds the tool name, its category (shell, file-read, file-write, search, web, mcp, agent,
other), a **masked argument summary** of at most 160 characters, and the provider, model, project,
conversation, runtime, item and turn. The duration fields are:

| Field | Meaning | Source label |
|---|---|---|
| `elapsedMs` | From the first non-terminal event to the terminal event. | `host-monotonic`; `wall-clock` only for a call that outlived a process; otherwise `unavailable` (null) |
| `waitMs` | Time spent in `awaiting_approval`, only when that phase was observed. | `observed-approval` / `unavailable` |
| `execMs` | The provider's own `durationMs`, otherwise the observed `running` phase. | `provider` / `host-phase` / `unavailable` |
| `prepareMs` | Time spent in `preparing` (the model still streaming the arguments). | null when that phase was not seen |

**Never invented.** `execMs` is never computed as `elapsed − wait`. A call first seen already finished
(Codex `item/completed` without `item/started`, as in the synthetic fixture) has `elapsedMs: null`.
In every aggregate a null counts as *unavailable*, with `measured` and `unavailable` counts beside
each statistic, and the UI shows it as "n/a", never as 0. A provider duration that is negative,
non-finite, or more than 7 days is dropped and the record is noted `invalid-provider-duration`.

### Hard parts

- **Deduplication.** The key is `sessionId + runtimeId + provider item id`. A restated terminal
  event (Claude restates its tools on re-attach; Codex can repeat `item/completed`) or late progress
  on a finished call increments `restated` and is otherwise ignored. Counts appear in
  `storage.deduplicated`.
- **Overlapping tool ids.** Ids repeat across tabs and runtime incarnations (a local runtime's
  `call-1`, for example), and the key keeps those calls apart. `concurrent` records how many other
  calls of the same conversation were already in flight when a call started.
- **Restarts.** On quit, `dispose()` writes every open call as `abandoned` (note `app-exit`)
  synchronously. If the runtime host kept the provider running, the next process amends that same
  record when the terminal event arrives, even under a new runtime id. Elapsed is then wall-clock
  (bounded to 24 h, never negative) and labelled `wall-clock`. The record keeps its key, so the
  file's later line replaces the abandoned one on load, and a call is never counted twice. The new
  runtime's key is kept as an alias so that its own restatements are deduplicated too.
- **Runtime ended without the tool ending.** A `session` phase of completed, failed, interrupted or
  disconnected abandons that runtime's open calls, except provider-confirmed `detached` background
  work. The note is `turn-ended-without-tool-end` or `runtime-lost`. A late end still amends the
  record, using the monotonic start that was kept.
- **Clock handling.** Durations use `performance.now()`, so a wall-clock jump cannot produce a
  negative or inflated duration (tested by jumping the wall clock back an hour mid-call). Wall time is
  used only for `startedAt`/`endedAt` labels and for the cross-restart fallback, which is labelled
  as such.
- **Secret redaction.** Summaries pass through `maskToolText` and then the journal's `maskSecrets`
  (Bearer tokens; `sk-`/`ghp_` keys; api_key, token and password assignments; the control token;
  registered 64-hex secrets). `maskToolText` adds URL credentials, AWS key ids, Slack tokens,
  secret-named environment assignments and `--password/--token/--secret/--api-key` flags. For
  structured inputs only keys are summarized, and a secret-looking key name has its value replaced.
  Inputs are clipped *before* masking, so a huge input costs nothing extra. Failure lines are masked
  the same way. Full inputs and outputs are never stored.
- **Bounded storage and retention.** There are 5,000 records in memory (with a trim slack of 1.1×),
  14-day retention, at most 2,000 open calls (beyond that the oldest is abandoned with note
  `open-limit`), and reads cut at 16 MiB. The file is append-only JSONL with a version field. It is
  rewritten atomically (tmp + rename) on load whenever it holds stale or extra lines, and when it
  grows past 1.5× capacity. Corrupt and unknown-version lines are counted (`parseErrors`) and
  skipped. Report lists are bounded: `limit` up to 50 and `recent` up to 100.
- **Hot-path overhead.** Measured in `tool-timings.test.ts` on this container: **22 ns per non-tool
  event** (a single type check) and **14.3 µs per tool call**, start plus end, including summarizing a
  2 KB command. Writes are batched every 2 s and done off the event path; loading is asynchronous
  after the database is up. The recorder catches its own errors (`errors` counter) and never throws
  into the event pipeline.
- **Privacy scoping.** Anonymous conversations are skipped, the same rule as memory and
  coordination. App-control callers see their own project only; the owner or a wizard tab may pass
  another `projectId`, or `"*"`.

### `tools.timings` (app control, read lane)

```
tools.timings({projectId?, agentSessionId?, provider?, tool?, since?, until?, limit?, recent?, includeDetached?})
```

It is a zero-turn call and returns the following:

- `totals`: calls, failures, failure rate, abandoned, detached and in-flight counts.
- `coverage`: the share of calls with a measured elapsed time, approval wait and execution time,
  per provider, including how many exec times came from the provider.
- `tools`: per tool, calls, failures, and p50/p95/max/total for elapsed, wait, exec and prepare.
  Each statistic carries its measured and unavailable counts.
- `slowest`: the slowest calls.
- `failures`: failures grouped by provider, tool and error line, with exit codes.
- `offenders`: each with its evidence and a suggested fix (below).
- `recent`: the most recent raw records.
- `storage`: what the recorder holds and has dropped.
- `gaps`: what each provider cannot report.

Detached background work is excluded from latency unless `includeDetached` is set.

**Offender rules.** Each rule cites its numbers and up to three example argument summaries:

| Kind | Trigger | Suggested fix |
|---|---|---|
| failure-rate | At least 4 calls and at least 30% failed. | Based on the common error: sandbox → repair the sandbox; denied → grant the class or use Auto; not found → install or brief; timeout → narrow or background the command. |
| approval-wait | At least 3 calls waited, with p50 of 10 s or more. | Add an Always-allow rule, an approval policy, or a wizard. |
| slow | At least 3 timed calls with p95 of 60 s or more. | Shell: narrow the command, use `run_and_summarize`, or background it. Web, MCP: specific advice for each. |
| argument-streaming | Prepare p95 of 30 s or more. | Use smaller Edit calls instead of whole-file rewrites. |
| repeated | The same arguments 5 or more times in one conversation. | Keep the first result. |
| abandoned | 3 or more calls that never ended. | Their time is unknown, not zero. |
| coverage | 80% or more of a provider's calls (out of at least 10) have no time. | Names that provider's gap. |

### UI

The "Tool timings" section in Settings → Usage, below Token burn, has:

- Window and provider filters, and a refresh button.
- A summary with a coverage line.
- A per-tool table showing elapsed, execution and approval wait as p50 / p95. It shows "n/a" when
  nothing was measured, and "(k/n)" when only some calls were.
- Top offenders, with suggestion and evidence.
- The five slowest calls, each labelled with whether its time is elapsed or execution and from
  which source.
- A disclosure listing what is not measured, and how much storage is held.

The screenshot from the smoke is `artifacts/tool-timings/settings-usage.png`, which git ignores.

## 3. Coverage gaps by runtime

| Runtime | Elapsed | Approval wait | Execution | Notes |
|---|---|---|---|---|
| Codex (app-server) | Yes, when `item/started` is seen; unavailable when only `item/completed` arrives | Yes, `awaiting_approval` on the app-server request | **Provider** `durationMs` for commandExecution, mcpToolCall and dynamicToolCall; none for fileChange and webSearch (then host phase, if one was seen) | |
| Claude (stream-json CLI) | Yes (preparing → running → result) | Only when a card is raised; the CLI's Auto-mode classifier time is invisible | Host-observed `running` phase, which includes stream transport latency | No provider duration in the stream |
| Grok (ACP) | Yes | Yes, on the ACP permission request | Host phase | |
| Local model | Running → completed | None (no approval phase); unavailable | **Provider**: Conductor's own runtime measures `durationMs` | |
| CLI-view tabs (raw PTY, `NativeCliManager`) | — | — | — | Not covered: no structured tool events. |
| Remote-mirrored conversations (`remote-session-mirror.ts`) | — | — | — | Snapshot events are written straight to the store and bypass the observer. The machine that runs the tab records its own timings. |
| Cloud coworkers (`src/main/cloud/runs.ts`) | — | — | — | Not covered: transcripts live in the cloud session. A follow-up could parse `cloud.transcript` tool blocks. |
| Anonymous conversations | — | — | — | Excluded on purpose (privacy rule). |

## 4. Effort

- **This increment:** one cloud session, about 2 hours of wall time. It is about 1,000 lines of new
  code and tests and 14 one- to three-line integration hunks.
- **Follow-ups**, each about half a day:
  - Read Claude's `tool_use_result` timing fields, if a CLI version reports them, to get provider
    exec times for Claude.
  - Tap remote-machine timings through the existing relay.
  - Parse cloud-coworker transcripts.
  - Add a per-tab "slowest tool" badge (this would intersect the thread view, which belongs to the
    thread coworker).

## 5. Verification (this container)

- `npx tsc --noEmit` passes with no errors.
- `npx vitest run src/shared/tool-timings.test.ts src/main/tool-timings.test.ts src/main/tool-timings.pipeline.test.ts`
  runs 25 tests, all passing.
- `npx vitest run src/main/agent-control.test.ts -t tools.timings` passes. It covers project scoping,
  the owner/wizard `"*"`, argument validation, the read-lane class, `tools.list` advertising, and the
  not-wired message.
- Full `npx vitest run` in this Linux container: 6,336 passed, 17 failed. Breakdown of the 17:
  - **15 also fail on the untouched base `3f95349`.** They depend on the host: where.exe/PATHEXT
    lookup, icacls ACL repair, IPv6 relay, Python and pip path policy, process-kill timing, and the
    approval and wizard listings that rely on them.
  - **1 was a race.** `production/browser.test.ts > maxRequests` failed once under full-suite load
    but passes 3 of 3 runs on its own; it touches nothing changed here.
  - **1 was a race.** The new tool-timings case was picked up mid-edit; it passes now.

  The owner's Windows machine is the authoritative run for the host-specific tests.
- `npx electron-vite build`, then `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a node scripts/smoke-tool-timings.mjs`
  passes. It drives the parked window (`CONDUCTOR_TEST_USER_DATA`, offline) through the synthetic
  Codex scenario `synthetic:activity-groups` and checks that:
  - 9 calls are recorded, with exec = 4 ms from the provider, elapsed and wait null, and coverage 0 / 0 / 1;
  - there is 1 failure, with exit code 2;
  - Settings → Usage shows "9 calls", with elapsed "n/a";
  - after a quit and relaunch, the same 9 records load exactly once.

  `ELECTRON_DISABLE_SANDBOX` is set only because this Linux container runs as root.
- On the owner's machine, run `npm run build && node scripts/smoke-tool-timings.mjs`. The window is
  parked, so it never takes the desktop.

## Integration plan and patch notes

The new files have no conflicts. Each shared-file hunk below is minimal and anchored, so if the
92-commit-ahead checkout has moved a line, it can be re-applied by searching for the anchor.

| File | Hunk | Anchor |
|---|---|---|
| `src/main/agent-manager.ts` | Optional 5th constructor parameter `toolTimings?: { observe(event, model?) }`, plus one call `toolTimings?.observe(event, spec.model)` | After `if (anonymousConversations.has(spec.id)) return` in the StructuredSessions observer |
| `src/main/index.ts` | Imports `registerToolTimingsIpc, ToolTimingRecorder` and `maskSecrets` | After the `./token-burn` import |
| `src/main/index.ts` | `let toolTimings` | After `let tokenBurnMeter` |
| `src/main/index.ts` | Construct the recorder, `void load()`, and pass it to `new AgentManager(…, browserMcp, toolTimings)` | The `agents = new AgentManager(` line |
| `src/main/index.ts` | `registerToolTimingsIpc(…)` | After `registerTokenBurnIpc(` |
| `src/main/index.ts` | `toolTimings` in the `new AgentControl({ … usageWeeks, toolTimings, …` deps | The `new AgentControl({` line |
| `src/main/index.ts` | `['tool timings', () => toolTimings?.dispose()]` | After `['agents', …]` in `disposeRuntimeServices` |
| `src/main/agent-control.ts` | Imports; `toolTimings?` deps field; `'tools.timings'` signature; the handler | Placed before the `local.servers` dispatch line |
| `src/main/agent-control.ts` | Adds `method === 'tools.timings'` to the sovereign cross-project exception | The "This method only runs in the authorized project" guard |
| `src/main/control-method-classes.ts` | `'tools.timings'` in the read lane | After `'usage.weekly'` |
| `src/main/agent-control-server.test.ts` | `'tools.timings'` in the advertised list | After `'usage.weekly'` |
| `src/main/agent-control.test.ts` | One import and one test | After the `usage.weekly` test |
| `src/shared/ipc.ts` | `toolTimings: import('./tool-timings').ToolTimingsBridge` | After `tokenBurn:` |
| `src/preload/index.ts` | Import, and `toolTimings: toolTimingsBridge` | After the `tokenBurn` entries |
| `src/renderer/src/components/SettingsPanel.tsx` | Import, and `<ToolTimingsSetting />` | After `<TokenBurnSetting />` |

**Paths to ship:**

- New files:
  - `src/shared/tool-timings.ts`
  - `src/shared/tool-timings.test.ts`
  - `src/main/tool-timings.ts`
  - `src/main/tool-timings.test.ts`
  - `src/main/tool-timings.pipeline.test.ts`
  - `src/preload/tool-timings.ts`
  - `src/renderer/src/components/ToolTimings.tsx`
  - `src/renderer/src/components/ToolTimings.css`
  - `scripts/smoke-tool-timings.mjs`
  - `docs/perf-evidence/t3code-cloud-tool-timings.md`
- Every file in the hunk table above.

If `app.update` smokes are requested for acceptance, add `smoke-tool-timings`.
