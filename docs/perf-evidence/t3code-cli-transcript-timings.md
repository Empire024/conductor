# Raw Claude CLI-view tool timings from the conversation transcript (P5 increment)

Cloud-session delivery, 2026-10-30. Branch `claude/t3code-cli-transcript-timings-4xstsl`.

- **Base:** the P4 export `5a97c51da8523b99be43412f094b0d82a426cef1`.
- **Implementation:** `2a91f5c4819916d0ba5c3ac65106017cfd1705b3`.
- **Patch:** `docs/perf-evidence/t3code-cli-transcript-timings-integration.patch` is exactly
  `git diff 5a97c51 2a91f5c`.
- Apply order: P3, then P4, then this one. The P3 and P4 exports are unchanged.

## Scope

**Covered:** calls made in a raw **Claude** CLI-view tab (`NativeCliManager`, a PTY running
`claude --resume|--session-id <native id>`). They are read once, when the tab returns to Chat
(`StructuredSessions.finishCli`).

**Still open:**
- Codex and Grok CLI-view tabs.
- Conversations mirrored from another machine.
- Any live (in-view) timing.

This is not all-provider coverage.

## Source evidence (repository code)

**Identity**
- The raw CLI tab and the structured Claude adapter use the same native conversation id:
  - `nativeCliArgs` passes `--resume <nativeId>`, or `--session-id <nativeId>` when the
    conversation is fresh;
  - `prepareCli` takes `nativeSessionId` from the conversation's projection.
- That id does not depend on the handoff runtime: `finishCli`'s `connect()` makes a new
  `runtimeId`, but the native id stays.
- The transcript is `claudeHistoryPath(cwd, nativeId)`, that is
  `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd with non-alphanumerics as '-'>/<nativeId>.jsonl`.
  `readClaudeHistory` already reads it after the CLI view and filters rows by
  `row.sessionId === nativeId`.

**Row shape** (observed in this cloud session's own Claude Code 2.1.312 transcript)
- `assistant` rows: `uuid`, `timestamp`, `sessionId`, and `tool_use` with `id: 'toolu_…'`.
- `user` rows: `timestamp`, `sessionId`, `sourceToolAssistantUUID`, and `tool_result` with
  `tool_use_id` and `is_error`.
- The rows are written by the CLI process on this machine with its own clock, so their stamps are
  that CLI's source clock.

**Why a byte boundary is needed**
- The structured (chat) view and the raw CLI view write the **same** file.
- The handoff's `known` list comes from `readClaudeHistory`, which keeps at most 2000 items
  (`while (items.size > 2000)`). In a long conversation, older chat-view tool ids are missing from
  it, so `known` alone cannot separate the CLI view's calls from chat-view calls already timed
  live.
- Claude Code appends rows (the writer's `appendEntry`), so the file's size at the handoff is
  where the CLI view's own rows begin.

**Cloud rows.** The P4 evidence shows a teleport writes the cloud session's rows and then its
note "This session is being continued from another machine…". The CLI also sets `remoteSourced`
on copied rows in memory, and the writer does not strip it.

## Semantics

**At the handoff (`prepareCli`)**
- For Claude, `claudeHistorySize(cwd, nativeId)` (an async `stat`) is stored as `claudeBytes` in
  the persisted `cliHandoff:<id>` setting.
- A missing file reads as 0, for a fresh conversation. An unreadable file is left out.

**On return (`finishCli`)**
- After the existing history import, `readClaudeCliToolCalls(cwd, nativeId, claudeBytes, { known })`
  runs, wrapped in a guard so a timing failure never strands the tab.
- **It reads only bytes after the boundary, at most the newest 16 MiB.** The read is
  asynchronous, positioned on a file handle, and never covers the whole file.
  - A window that starts mid-row drops that partial row, cut at the newline byte.
  - A file that shrank below the boundary is not read (`shrank`).
- **Rows left out:**
  - another `sessionId`;
  - `remoteSourced: true`;
  - everything up to and including the last teleport note in the window (cloud rows on the
    cloud's clock: never counted twice with P4);
  - any call whose id is in the handoff's `known` list.
- A handoff persisted by an older build has no `claudeBytes`, so nothing is read for it.

**Pairing** (`TranscriptToolPairs`, `src/main/transcript-tool-pairs.ts`)
- These are the P4 rules, now one module that both P4's `parseTranscript` and this reader use.
  P4's behaviour is unchanged, and its 35 tests pass.
- Pairing is by exact `tool_use_id`, with the `sourceToolAssistantUUID` check and the
  `conflicting-restatement` and `result-names-another-row` notes.
- A call without a result is not returned and is counted in `unmatched`.
- At most 8192 calls and results are held, and at most 2000 calls are returned. The output is
  ordered deterministically.

**Recorder** (`importCliTranscript`, sharing `importTranscript` with `importCloudTranscript`)
- **Key:** `cli-transcript \0 <native id> \0 <tool_use_id>`. No runtime id is used, so a repeated
  read, a read after a restart, or a retried handoff adds nothing twice. The first statement
  stands.
- **Record:** `origin: 'cli-transcript'`, `provider: 'claude-cli'`, `agentSessionId` the
  conversation, `runtimeId` the native id.
- **Elapsed:** `transcript-wall`, from the CLI's own row times, or `unavailable` with one of these
  notes: `missing-transcript-time`, `invalid-transcript-interval`, `denied-or-interrupted-result`,
  or the pairing note.
- **Never measured:** wait, execution and prepare. This host's import time is never a
  measurement or a label.
- **Bounds:** its own allowance of 1000 (`cliCapacity`) inside the shared 5000, 14-day
  retention, no re-churn of calls already trimmed, and the same trim after `load()`.
- **Privacy:** masked argument summaries, and a failure's masked first line only; output is never
  stored.

**Report and API**
- `origin: 'cli-transcript'` is now valid in `ToolTimingsQuery`, `toolTimingsQuery` and
  `parseRecord`.
- Native (the default), CLI and cloud reports never mix, and a non-native report has
  `inFlight: 0`.
- The gap texts, the `tools.timings` signature, the Settings scope line and the smoke assertion
  are updated.

**Anonymous conversations** are skipped in `AgentManager`, as for live timings.

## Tests

The new test file `src/main/cli-transcript-timings.test.ts` writes real-shape rows under a temp
`CLAUDE_CONFIG_DIR`, then runs the real `claudeHistorySize` / `readClaudeCliToolCalls`, then
`importCliTranscript`, then `report`. The host clock is pinned far from the row times. It covers:

1. Only rows after the handoff: 1250 `transcript-wall`, wait, execution and prepare unavailable.
   The chat-view call is absent, the native and cloud reports stay at 0, and the gap is shown. The
   size of a missing file reads as 0.
2. A known call restated after the handoff is left out.
3. A partial read (`unmatched: 1`), then the full read adds it once. A repeat gives `known`.
   Restart (dispose, then load in a new recorder) gives `known`. Reordered rows pair the same.
4. The same `tool_use_id` in two native conversations gives two records. Two calls with the same
   arguments but different ids give two records.
5. Another session's rows, `remoteSourced` rows and a teleported cloud block before its note are
   all left out; only the local call after the note is recorded.
6. Missing, reversed, conflicting, misattributed and denied rows: none is timed, each has its
   note.
7. Bounds:
   - with a 20,000-byte window over about 200 calls, exactly 20,000 bytes are read, the result is
     `truncated`, only the newest calls come back (the last one is the newest), and no partial
     row is mis-paired;
   - a shrunk file is not read;
   - a negative offset and a missing file read nothing.
8. Allowance: with `cliCapacity: 2`, 4 calls keep the newest 2 and a re-read gives
   `known 2, skipped 2`. The native and cloud records are untouched.
9. Redaction: an `sk-ant-` key in the arguments, a query `api_key`, and a failure with a 20 KB
   body. The secret is masked everywhere, the error is that line only (at most 161 characters),
   and the body is absent.
10. `origin: 'cli-transcript'` is accepted in queries and on load, and an unknown origin is
    refused.

**Failure-first.** The new file fails all 10 tests on a clean `5a97c51`: the reader and importer
do not exist there.

Results in this Linux container, using only the existing dependencies:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx electron-vite build` | built |
| `vitest run` of the new file, `src/main/cloud` (P4, now on the shared pairer), `tool-timings.test.ts`, `shared/tool-timings.test.ts`, `codex-provider-clock.test.ts`, `native-cli-manager.test.ts` | 104/104 passed |
| `structured-sessions.test.ts`, `agent-manager.test.ts`, `agent-control.test.ts`, `tool-timings.pipeline.test.ts`, `smoke-tool-timings` | Not run: they need the Electron binary, which is not installed here. |
| Full Linux suite | Not repeated. The known baseline is 15 host-dependent failures and 32 files that cannot load without Electron (see the P3 note). |

The `prepareCli`/`finishCli` hunks are therefore type-checked and built but **not exercised by a
test here**. The Windows run is authoritative. This is not a Windows acceptance run.

## Integration cautions

**Local `7d99da3` fixes; keep them**
- `native.method === 'cli/history'` exclusion. This increment does not touch `observe`, and it
  depends on that fix. Without it, the existing `finishCli` history replay records the CLI view's
  calls a second time in the *native* report, as untimed rows. The local tree has the fix; this
  base does not.
- Sticky `inputComplete`, and the Claude hook's top-level `duration_ms`: neither is touched here.

**Hunks to merge by hand into newer local files**
- `src/main/structured-sessions.ts`:
  - the import line;
  - the `cliToolCalls` field before `turnSettledListeners`;
  - `claudeBytes` in `prepareCli`'s handoff object;
  - the handoff type and the guarded read in `finishCli`, placed before
    `removeSetting('cliHandoff:' + id)`.
- `src/main/agent-manager.ts`: the `toolTimings` parameter type, and the `cliToolCalls`
  assignment after the `StructuredSessions` construction.
- `src/main/native-history.ts`: the imports and the two new exports. `readClaudeHistory` is
  unchanged.
- `src/main/cloud/runs.ts`: P4's inline pairing replaced by `TranscriptToolPairs`.
  `TELEPORT_NOTE` moved to `transcript-tool-pairs.ts`.
- `src/main/tool-timings.ts`: `importTranscript`, `trimOrigin` and the per-origin capacities
  replace P4's cloud-only versions; `importCloudTranscript` keeps its signature.
- The texts in `agent-control.ts`, `ToolTimings.tsx` and `scripts/smoke-tool-timings.mjs`.

## Limitations

- **Not live.** Calls appear only when the tab returns to Chat. A view still open, or one whose
  handoff never finishes, is not read.
- **Ownership is inferred from append-only writes.** If something rewrites the transcript rather
  than appending (another process resuming the same id at the same time, or a future CLI
  rewriting it), the boundary is wrong. A shrunk file is detected; a same-size rewrite is not.
- **More than 16 MiB written in one CLI view:** older calls in it are not read.
- **`transcript-wall` is row write time**, from call to result. Parallel calls share one start.
  It is not execution and not approval wait.
- **Subagent (sidechain) calls** are paired if the CLI writes them into this file. Newer CLIs
  write subagent transcripts to separate files, and those are not read.
- **Codex CLI view:** its `history()` uses `thread/read`, whose items carry no per-item times.
  `thread/items/list` exposes `startedAtMs`/`completedAtMs` (see P3), but it is not wired here.
  Grok has no timestamps in this reader.

## Effort

One bounded session, about 1.5 hours: roughly 230 lines of source (including the P4 refactor),
200 lines of tests and this note.
