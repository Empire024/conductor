# Cloud-coworker tool timings from pulled transcripts (P4 increment)

Cloud-session delivery, 2026-10-30. Branch `claude/t3code-cloud-transcript-timings-4xstsl`.

- **Base:** the P3 export `2736e20c25ff40b92881332841d05a39cce01418`.
- **Patch:** `docs/perf-evidence/t3code-cloud-transcript-timings-integration.patch` is exactly
  `git diff 2736e20 <implementation>`. Its header names the implementation SHA.
- The P3 patch (`t3code-provider-clock-timings-integration.patch`) is unchanged; apply it first.

## Scope

**What this adds:** tool calls of cloud coworkers (`src/main/cloud/runs.ts`), read after a
transcript pull. They are timed on the cloud's own row clock and reported apart from native tabs.

**Still open:**
- Live cloud timing: a transcript exists only after a pull, which happens on the first push or on
  refresh.
- Raw CLI-view tabs.
- Conversations mirrored from another machine.

This is not all-provider coverage.

## Source evidence

**Observed** in this Claude Code cloud session's own transcript (CLI 2.1.312,
`~/.claude/projects/-home-user-conductor/<session>.jsonl`):
- An `assistant` row carries `uuid`, `timestamp` and `message.content[].{type:'tool_use', id:'toolu_…', name, input}`.
- The matching `user` row carries `timestamp`, `sourceToolAssistantUUID` (the assistant row's
  uuid), `toolUseResult` (Bash: `stdout/stderr/interrupted/isImage/noOutputExpected`, with no
  duration), `permissionDecision`, and `message.content[].{type:'tool_result', tool_use_id, is_error}`.
- Example: `toolu_…JfSbVU`, with the call row at 00:39:52.117Z and the result row at 00:39:55.197Z.

**Read from the CLI 2.1.312 binary** (minified), not observed in a real teleport:
- **Order of the saved file.** The teleport builds `[...history, note, resumed]` (`kfn`), where
  `history = Cjt(jBr(loglines))`.
  - `jBr` deserializes messages with object spread, so `timestamp`, `uuid` and the tool ids are
    kept.
  - `Cjt` adds `remoteSourced: true`.
  - The note is `kZo()`: an isMeta user row, "This session is being continued from another
    machine…".
- **Writer.** It writes `{parentUuid, …, ...KLi(message), ...szr(sessionId), version, gitBranch}`.
  `szr` sets `sessionId/cwd/entrypoint/userType/version`, so the file's `sessionId` is the
  *local* teleport id. **It never sets `timestamp`.** History rows therefore keep the cloud's
  timestamps; the note and every later row are stamped by this machine.
- **Synthetic results.** Results the CLI writes for interrupted, cancelled or denied calls carry
  `toolDenialKind` (`'interrupted'`, `'cancelled'`, …). Resuming may also synthesize results for
  calls that had no result.

What I did not verify: a real teleport file, and whether `remoteSourced` is persisted. So it is
not relied on.

## Semantics

**Parser (`parseTranscript`)**
- It keeps `toolUseId` on `tool` and `result` entries (`CloudTranscriptEntry.toolUseId`), so the
  stored transcript keeps the identity through repeated refreshes.
- It pairs tool calls (`tools: TranscriptToolCall[]`) only from rows **before** the teleport note.
  Rows from the note on use this machine's clock and are never paired.
- **Pairing is by exact `tool_use_id` only.**
  - A result whose `sourceToolAssistantUUID` names a different assistant row is noted
    `result-names-another-row`.
  - A call or result restated with different times or uuid is noted `conflicting-restatement`.
  - The first statement's times stay as labels, but a noted call is never timed.
- A call without a result is **not** returned; `unmatched` counts it. A later pull that has the
  result adds it.
- A result whose call is not in the file is ignored.
- At most 2000 calls are returned, the newest by call time. The order is deterministic (call
  time, then id) whatever the order of the cloud rows.
- Result text is bounded to 4000 characters and is only ever summarized.

**Recorder (`ToolTimingRecorder.importCloudTranscript`)**
- **Key:** `cloud-transcript \0 <cloud sessionId> \0 <tool_use_id>`. No runtime id is used. The
  same id in another session is a different call. A known key is counted `known` (and
  `deduplicated`) and never re-added. The first statement stands.
- **Record:**
  - `provider: 'claude-cloud'`, `origin: 'cloud-transcript'`;
  - `agentSessionId` is the run id, `runtimeId` the cloud session id, `itemId` the tool_use_id;
  - the masked argument summary is capped at 160 characters;
  - a failure keeps only its masked first error line, capped at 160 characters. The output is
    never stored.
- **Elapsed:** `resultAt − usedAt` on the cloud rows' own clock, labelled `transcript-wall`. It
  includes permission, hooks and queueing, so it is **not** execution. Otherwise it is null and
  `unavailable`, with one of these notes:
  - `denied-or-interrupted-result` (a `toolDenialKind`; outcome `interrupted` or `rejected`);
  - the parser's note;
  - `missing-transcript-time`;
  - `invalid-transcript-interval` (reversed, or more than 7 days).
- Wait, execution and prepare are always `unavailable`. This host's clock is never a
  measurement, and `startedAt`/`endedAt` are the rows' own times.
- **Bounds:**
  - at most 1000 cloud records (`cloudCapacity`), inside the shared capacity of 5000;
  - when the allowance is full, the oldest cloud records are dropped and native records are
    never touched;
  - a call older than everything kept, or beyond 14-day retention, is `skipped`, so a re-pull
    does not churn;
  - the same trim is applied after `load()`.
- **Persistence:** records ride the existing batched append, tail load, claimed exit journal and
  compaction. `parseRecord` refuses any `origin` other than `'cloud-transcript'`; older lines
  without one still parse.

**Report and API**
- `ToolTimingsQuery.origin` is `'native'` (the default) or `'cloud-transcript'`. They are never
  mixed, so native totals, coverage and offenders are unchanged.
- The `tools.timings` signature documents `origin`, and `toolTimingsQuery` validates it.
- A cloud report has `inFlight: 0`, and its gap text explains `transcript-wall`.
- The Settings line says cloud transcripts are kept apart. The smoke assertion is updated to that
  wording.

**Wiring**
- In `CloudRuns.pullTranscript`, after the parse, `options.onToolCalls?.(run, tools)` is called.
  It is guarded, so a timing failure never fails a pull.
- `createCloud` gains `toolTimings?()`, which forwards to `importCloudTranscript`.
- `index.ts` passes `toolTimings: () => toolTimings`.
- The remote mirror is untouched: mirrored events go to `store.append` and never reach the
  recorder, so nothing is counted twice.

## Tests

The new test file `src/main/cloud/transcript-timings.test.ts` uses real-shape rows through the
real parser, then `importCloudTranscript`, then `report`. The host clock is pinned far from the
row times. It covers:

1. A Bash pair at 52.117 → 55.197: 3080 `transcript-wall`, with wait, execution and prepare
   unavailable. The default report and a `provider: 'claude-cloud'` native report both stay at 0;
   the cloud gap text is shown.
2. Repeated pulls give `known: 1`. After dispose and load in a new recorder, it is still 1. With
   reordered cloud rows, the paired calls are identical and still `known`. The persisted file
   holds one key.
3. A partial pull (call without result, plus an orphan result) adds nothing and reports
   `unmatched: 1`. The full pull later adds it once.
4. The same `tool_use_id` in two cloud sessions gives two records, and a repeat adds nothing.
5. Missing, unparsable, reversed, conflicting, misattributed and denied (`interrupted`) rows, an
   in-flight call whose "result" came after the note, and a fully local pair:
   - none is timed, each has its note, and the local pair is absent;
   - the first statements' times stay as labels;
   - no `ended-at-import` note appears.
6. Redaction: a Bearer token and `?token=` in the arguments, and a failure with a password line
   and a 9 KB body. The secret is masked everywhere, the error is that line only (at most 161
   characters), and neither the first nor the last body line is in the report.
7. Bounds with `cloudCapacity: 3`:
   - 5 calls keep the newest 3, and a re-pull reports `known 3, skipped 2`;
   - the one native record is untouched;
   - a 2026-10-01 call is skipped by retention;
   - a 2050-call transcript yields 2000.
8. `origin` is validated in queries, and a malformed `origin` is refused on load.

In `src/main/cloud/runs.test.ts`, the existing end-to-end pull, through the fixture teleport
(`scripts/fixtures/cloud-cli.cjs`, now with real-shape ids, uuids and two row times), checks:
- the stored entries carry `toolUseId`;
- `onToolCalls` receives the run with its cloud `sessionId` and one call 1500 ms apart.

**Failure-first.** With only the test changes applied to a clean `2736e20`, all 9 new or
extended tests fail and the 12 unchanged ones pass.

Results in this Linux container, using only the existing dependencies:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx electron-vite build` | built |
| `vitest run src/main/cloud src/main/tool-timings.test.ts src/shared/tool-timings.test.ts src/main/providers/codex-provider-clock.test.ts src/main/providers/codex.test.ts` | 150/150 passed |
| `agent-control.test.ts` (`tools.timings` cases), `tool-timings.pipeline.test.ts`, `smoke-tool-timings` | Not run: they need the Electron binary, which is not installed here. |
| Full Linux suite | Not repeated. The P3 run on this container had 15 host-dependent failures and 32 files that could not load without Electron; nothing in this change touches those areas. |

This is not a Windows acceptance run.

## Integration cautions

- **Order:** apply the P3 patch, then this one. Both touch `src/main/tool-timings.ts` and
  `src/shared/tool-timings.ts`. This patch's anchors assume P3 is applied (`ElapsedSource`
  includes `'provider'`; `reviewMs` is in the record and in `parseRecord`).
- **Local fixes on `7d99da3`; keep them:**
  - the `native.method === 'cli/history'` exclusion in `observe` and the `Observed` Pick;
  - sticky `inputComplete` (`OpenCall`, `start()`, `closePhase`);
  - the Claude hook's top-level `input.duration_ms` in `claude.ts`.

  This patch touches none of those functions. In `tool-timings.ts` it adds: an option and a
  field; `importCloudTranscript`, `transcriptRecord` and `trimCloud` before `commit()`; one
  `trimCloud` call in `loadTail`; the `inFlight` origin guard in `report()`; and the `origin`
  checks in `parseRecord` and `toolTimingsQuery`.
- **Other hunks to merge by hand:**
  - `index.ts`: one `createCloud({…, toolTimings: () => toolTimings })`.
  - `register.ts`: the option and the `onToolCalls` forward.
  - `agent-control.ts`: the `tools.timings` signature text.
  - `ToolTimings.tsx`: the scope line.
  - `scripts/smoke-tool-timings.mjs`: the scope assertion text.
  - `scripts/fixtures/cloud-cli.cjs`: the teleport rows.

## Limitations

- The teleport's timestamp handling is read from the CLI binary. It was not observed on a real
  teleported file, and a future CLI that restamps rows would make `transcript-wall` the teleport
  time. Guards: only rows before the note are used, and a stamp more than 7 days apart is not
  trusted. Neither guard can detect a uniform restamp. A real-file check on the owner's machine
  (compare one teleported row's `timestamp` with the cloud UI) would close this.
- A transcript that has no teleport note is treated as wholly cloud-clock.
- `transcript-wall` is call-row to result-row write time. Parallel calls in one assistant message
  share a start. Never read it as execution or approval wait.
- `toolUseResult` durations that some tools report (WebFetch `durationMs`) are not used.
- When the cloud allowance is full, older cloud calls are dropped.

## Effort

One bounded session, about 1.5 hours: roughly 200 lines of source, 230 lines of tests and this
note.
