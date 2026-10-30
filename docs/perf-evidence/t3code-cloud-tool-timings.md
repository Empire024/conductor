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
- **Restarts and quitting mid-write.** On quit, `dispose()` records every open call as `abandoned`
  (note `app-exit`). It then synchronously writes every line that is not yet durable to
  `tool-timings.exit.jsonl`: lines still pending, and lines held by an append that is queued or in
  flight. It never writes to the main file, because a compaction may be renaming over it. Queued
  steps that have not started become no-ops. A line that is both in the exit file and appended by a
  step already in flight is read as one record.

  **Load ownership.** The next `load()` runs on the same write queue and does nothing once disposed.
  It never reads or deletes `tool-timings.exit.jsonl` in place:
  - It first renames the exit file to a claimed file of its own,
    `tool-timings.exit.<13-digit ms>-<pid>-<random>.claimed.jsonl`. A quit during that load
    therefore writes a fresh exit file, which this load never touches. The quit is synchronous on
    the main thread, so it cannot interleave with the rename callback and the read that follows it.
  - It reads the main file, then every claimed file, oldest first. That includes claimed files left
    behind by earlier loads that never finished. It merges them by key, with later lines winning,
    and rewrites the main file.
  - It deletes only the claimed files it read, and only when `rewrite()` reports that the new main
    file is in place. A rewrite skipped because the app is quitting deletes nothing, and those
    claimed files are read again by the next load.

  Leftover claimed files are bounded: the newest 8 are read. Older ones exist only after more than 8
  loads in a row each failed to reach a durable rewrite; they are deleted after the next durable
  rewrite, and their rows are dropped. If renaming a busy exit file fails (Windows, while a quit
  writes it), the file stays where it is for the next load.

  Four regressions hold this in place. Each reopens with a fresh recorder and asserts that every
  record appears exactly once:
  - a quit while a compaction `rename` is held;
  - a quit while an `appendFile` is held;
  - a quit while a load's rewrite `rename` is held, with an earlier exit file present (the
    earlier quit's row, the new quit's rows and the main row all survive);
  - a quit while the load is still reading the exit file. The skipped rewrite deletes nothing, and
    the claimed file and the new exit file both remain until the next load.

  Each fails against the code it replaces.
- **Resuming an abandoned call.** If the runtime host kept the provider running, the next process amends that same
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
  registered 64-hex secrets). `maskToolText` adds:
  - URL credentials;
  - secret-named query parameters (`?token=`, `&sig=`, `X-Amz-Signature=`, an OAuth `?code=`; the
    name list is deliberately wide);
  - `Cookie` and `Set-Cookie` header values, `--cookie` flags and session cookies (`sessionid=`,
    `connect.sid=`, `csrftoken=`);
  - quoted and unquoted secret assignments in any case (`password = '…'`,
    `"client_secret": "…"`, `apiKey: "…"`, `auth_token=…`);
  - AWS key ids, Slack tokens, and secret-named environment assignments;
  - `--password/--token/--secret/--api-key` flags.

  Every pattern is compiled once. Arguments and failure lines are clipped to 640 characters *before*
  masking, which bounds the masker's cost: a 100,000-character adversarial line stays under 250 ms in
  the test, including the patterns' backtracking. For structured inputs only keys are summarized,
  and a secret-looking key name has its value replaced. Full inputs and outputs are never stored.
  Synthetic dummy secrets are tested through the persisted JSONL and through the report. The journal's
  own `maskSecrets` (structured-store) was left unchanged because it is outside timing scope; the
  same gaps there are a candidate follow-up for the journal's owner.
- **Bounded storage and retention.** There are 5,000 records in memory (with a trim slack of 1.1×),
  14-day retention, at most 2,000 open calls (beyond that the oldest is abandoned with note
  `open-limit`). `load()` reads at most the newest 16 MiB of each file through a file handle, using
  a positioned tail read with a buffer of exactly that size. It never reads the whole file. Bytes
  read are reported as `loadedBytes`. When the read starts mid-file, the partial first line is cut
  at the first newline *byte*, before decoding; a newline byte never occurs inside a UTF-8 sequence,
  so a split character is dropped with its line. The file is append-only JSONL with a version field.
  It is rewritten atomically (tmp + rename) during the load step itself, before any queued append can
  land, in any of these cases:
  - it was larger than the bound;
  - its last line was torn by a crash mid-append;
  - it held stale or extra lines;
  - an exit file was present.

  It is also rewritten when it grows past 1.5× capacity. A rewrite skips records whose line an append
  still owes, so nothing is written twice. Corrupt and unknown-version lines are counted
  (`parseErrors`) and skipped. Regression tests cover:
  - a 20 MiB file, of which exactly 16 MiB is read, the newest records are kept, and the file is
    rewritten to 5,000 valid lines;
  - a UTF-8 character split at the tail boundary;
  - a torn last line raced against an append;
  - a single unterminated line larger than the bound.

  The directory is created once per process; the flag resets after a failed write. Report lists are
  bounded: `limit` up to 50 and `recent` up to 100.
- **Hot-path overhead.** Measured in `tool-timings.test.ts` on this container, over several runs:
  **23–31 ns per non-tool event** (a single type check) and **12–26 µs per tool call**, start plus
  end, including summarizing and masking a 2 KB command. The 21 µs figure is the wider masker on an
  idle container; 26 µs was measured while the full suite ran alongside. Writes are batched every 2 s and done off the event path; loading is asynchronous
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

- A headline that claims only what is recorded: "Structured tool calls recorded from Claude, Codex,
  Grok and local-model tabs". Directly under the filters, always visible, it says what is **not**
  recorded: raw CLI-view tabs, cloud coworkers and conversations mirrored from another machine.
  It also says that execution and approval wait are shown only where a provider or Conductor
  observed them.
- Window and provider filters, and a refresh button.
- A summary with a coverage line.
- A per-tool table showing elapsed, execution and approval wait as p50 / p95. It shows "n/a" when
  nothing was measured, and "(k/n)" when only some calls were.
- Top offenders, with suggestion and evidence.
- The five slowest calls, each labelled visibly with whether its time is elapsed or execution and
  from which source (for example "4 ms exec · provider" when elapsed was not measured). There is no
  derived wait/execution split.
- A list, open by default, of what each provider cannot report, and how much storage is held.

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
  runs 36 tests, all passing. These include:
  - the bounded-load regressions;
  - the four quit-mid-write and load-ownership regressions;
  - the redaction cases with synthetic dummy secrets, through the persisted JSONL and the report;
  - the masker's bounded-cost check.

  The bounded-load and quit-mid-write regressions were each confirmed to fail against the code they
  replace:
  - 4 of 4 bounded-load tests fail against the original whole-file `readFile`.
  - 2 of 2 quit tests fail against the earlier synchronous append to the main file.
  - Both load-ownership tests fail against `5f08f38`. The held-rewrite case fails by assertion. The
    held-read case fails by assertion against `5f08f38` with only an `io.open` hook added, since
    that version had no way to hold a read.
- `npx vitest run src/main/agent-control.test.ts -t tools.timings` passes. It covers project scoping,
  the owner/wizard `"*"`, argument validation, the read-lane class, `tools.list` advertising, and the
  not-wired message.
- Full `npx vitest run` in this Linux container, on the final implementation: 6,349 passed,
  **15 failed**, 78 skipped. The 15 are, by name, exactly the 15 that fail on the untouched base
  `3f95349` in this container (checked in a clean worktree). They depend on the host:
  where.exe/PATHEXT lookup, icacls ACL repair, IPv6 relay, Python and pip path policy,
  process-kill timing, and the approval and wizard listings that rely on them.

  **This is not a full-green run.** The owner's Windows machine is the authoritative run for those
  tests. An earlier run of the first increment had 2 more failures: one load-sensitive production
  browser test that passes 3 of 3 runs on its own, and one tool-timings test picked up mid-edit.
  Neither recurred.
- `npx electron-vite build`, then `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a node scripts/smoke-tool-timings.mjs`
  passes. It drives the parked window (`CONDUCTOR_TEST_USER_DATA`, offline) through the synthetic
  Codex scenario `synthetic:activity-groups` and checks that:
  - 9 calls are recorded, with exec = 4 ms from the provider, elapsed and wait null, and coverage 0 / 0 / 1;
  - there is 1 failure, with exit code 2;
  - Settings → Usage shows "9 calls", with elapsed "n/a" and "exec · provider";
  - the headline claims only recorded structured calls, the not-recorded line is visible, and the
    gaps list is open;
  - after a quit and relaunch, the same 9 records load exactly once; the exit file is claimed and
    merged into the main file; no exit or claimed file remains; and the main file holds 9 unique keys.

  `ELECTRON_DISABLE_SANDBOX` is set only because this Linux container runs as root.
- On the owner's machine, run `npm run build && node scripts/smoke-tool-timings.mjs`. The window is
  parked, so it never takes the desktop.

## Integration plan and patch notes

**Exact patch.** `docs/perf-evidence/t3code-cloud-tool-timings-integration.patch` is the exact
`git diff` from base `3f95349` to the final implementation commit. That commit's SHA is in the
patch's header lines; the header is ignored by `git apply` and `patch`. The patch excludes itself,
and it contains no binaries (`artifacts/` is git-ignored). To apply it in a checkout that contains
`3f95349`, run `git apply --3way docs/perf-evidence/t3code-cloud-tool-timings-integration.patch`.
Where git cannot be run, it is a plain unified diff with `a/` and `b/` prefixes. Every hunk in a
shared file is small, so apply those hunks by hand from the table below. That keeps the newer local
async/IPC code and the root output-download hooks around them. Take the new files whole.

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
  - `docs/perf-evidence/t3code-cloud-tool-timings-integration.patch` (for reference; it is not
    application code)
- Every file in the hunk table above.

At runtime the recorder writes `<userData>/tool-timings/tool-timings.jsonl`. Between a quit and
the next load's durable rewrite there is also `tool-timings.exit.jsonl`, and possibly
`tool-timings.exit.*.claimed.jsonl` files.

If `app.update` smokes are requested for acceptance, add `smoke-tool-timings`.
