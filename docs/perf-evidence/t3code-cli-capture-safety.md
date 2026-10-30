# CLI-view capture safety (follow-up to the P5 raw Claude CLI-transcript timings)

Cloud-session delivery, 2026-10-30. Branch `claude/t3code-cli-capture-safety-ylyp4p`.

- **Base:** `aecc505ec16eb4dfd16103cb10df959fc0510445` (P5 export, head of
  `claude/t3code-cli-transcript-timings-4xstsl`). Head verified equal before any edit; the P3/P4/P5
  artifacts (`docs/perf-evidence/t3code-{provider-clock,cloud-tool,cloud-transcript,cli-transcript}-*`)
  were present and are unchanged.
- **Implementation:** `21fc3f083adeb1aabbb0338a0fc4b33bb19b21f8`.
- **Export commit:** the branch head, the commit that adds only this note and the patch (a commit cannot
  name its own SHA; read it from the branch).
- **Patch:** `docs/perf-evidence/t3code-cli-capture-safety-integration.patch` is exactly
  `git diff aecc505 21fc3f0` (7 paths, listed below). Apply it after P3, P4 and P5.

Not installed, not in `app.update`, not on `main`. This does not redo P3/P4/P5.

## The three gaps and what changed

1. **`prepareCli`/`finishCli` wiring was untested.** `src/main/cli-capture-safety.test.ts` drives the
   real `StructuredSessions.prepareCli`/`finishCli` (synthetic runtime, no CLI or model launched,
   Electron and node-pty mocked), the real `ToolTimingRecorder`, and `AgentManager`'s hook.
2. **A same-size or otherwise rewritten file was undetected** (the handoff kept only a byte size).
   `prepareCli` now persists `claudeBoundary`: `{ bytes, id?, head, tail }`: size, file identity
   (`dev:ino`, only where the platform reports a non-zero index), and SHA-256 of the first and last
   4 KiB up to that size. Hashes only, no row text is retained. `finishCli` checks it on the same open
   handle it then reads from, so nothing can change between check and read.
3. **A transcript over 16 MiB silently lost old calls.** The read still takes only the newest 16 MiB
   after the boundary (bounded, asynchronous), but the result now says what was left out.

## Coverage, explicitly

Every Claude return to Chat reports `CliCaptureCoverage` to the hook (also when nothing is imported):

| status | reason | meaning |
|---|---|---|
| complete | `complete` / `no-transcript` | verified boundary, every appended row read (or no transcript existed at the handoff or after) |
| partial | `window-truncated` | appended rows beyond the newest 16 MiB were not read (`bytesSkipped`) |
| partial | `call-limit` | pairing bounds let calls go (`droppedCalls`) |
| unavailable | `boundary-missing` / `-unverified` / `-malformed` | lost, legacy size-only, or malformed boundary: nothing is imported |
| unavailable | `file-missing` / `-shrank` / `-replaced` / `-changed` / `-unreadable` | the file is no longer the one handed over: nothing is imported |

Counts: `boundaryBytes`, `fileBytes`, `bytesRead`, `bytesSkipped`, `unmatchedCalls` (calls with no result),
`unpairedResults` (results whose call is in unread rows), `droppedCalls`. A call in unread rows is simply
absent; **no duration is estimated for it**. Elapsed is still only the CLI's own row times
(`transcript-wall`); unknown stays `null`; it is not execution or approval wait.

The recorder (`importCliTranscript({ …, coverage })`) keeps one note per handoff id in memory (at most 50;
counts are lifetime-of-process), so a retried `finishCli` or a restart before the handoff was cleared
replaces its note rather than adding a return. `report()` adds `captureCoverage.cliTranscript`
(`returns/complete/partial/unavailable`, newest 10 incomplete notes) and, when any return was incomplete,
one `gaps` line. The field is absent until a return has happened. Not persisted: a process restart
forgets the counts (the imported records themselves persist as before).

Unchanged on purpose: `observe` (and its `cli/history` exclusion from the owner's `7d99da3`), sticky
`inputComplete`, provider clocks, rank7, threads, UI, control permissions. `ToolTimings.tsx` is untouched.

## Known limits (stated, tested)

- **A rewrite that keeps size, identity and both 4 KiB ends of a prefix longer than 8 KiB** (a change only
  in the middle) is not seen. Test `keeps the one limit it has` pins this as the documented behaviour.
  Hashing the whole prefix would make the handoff read an unbounded file.
- **No continuation once the boundary is untrustworthy.** After a rewrite or truncation the boundary
  cannot be found again by bounded work, so the return imports nothing and says why, rather than guessing.
- **A legacy size-only boundary** (P5's `claudeBytes`, never installed locally) is reported
  `boundary-unverified` and imports nothing.
- Identity mismatch alone rejects the file (`file-replaced`): a CLI that rewrote the transcript by
  rename would lose that return's calls (reported, not hidden). Claude Code appends in place.
- Beyond 16 MiB the oldest appended calls are not recovered; only the report says so.
- Codex/Grok CLI tabs and live capture remain out of scope, as in P5.

## Tests: failing before, passing after

`src/main/cli-capture-safety.test.ts` (11 tests). Run against the **base sources** (new test file kept, the
six source files stashed): 9 failed, 2 passed. The failures that matter are about behaviour, not imports:

| test | before (base) |
|---|---|
| same-size rewrite | `expected [ 'toolu_cli' ] to deeply equal []`: the appended calls of a file that is no longer the handed-over one were imported |
| shrunk / regrown / gone | `expected [] to have a length of 1`: nothing reported at all for a shrunk file; regrown file read from a stale offset |
| lost / legacy / malformed boundary | no hook call: a lost boundary vanished silently (legacy `claudeBytes` was read from, unverified) |
| >16 MiB | the 17 MiB window dropped the early call and the straddling result with no coverage to say so |
| fresh conversation, retry/restart, boundary persisted, limit pin | no coverage/boundary at base (new capability) |
| `AgentManager` hook | spy not called with `coverage` |

The two that pass at base are the recorder-throws-doesn't-keep-CLI-view test and the non-Claude (Codex)
test, which assert existing behaviour that must be preserved.

Covered: actual `prepareCli`/`finishCli`; boundary stored as hashes with no row text; exact conversation,
origin, provider, `runtimeId` = native id, dedup by `tool_use_id`; unmatched call; failed return then retry,
repeated finish, restart with the same handoff id (one record, one return); same-size, head/tail-changed,
shrunk, replaced-and-regrown, deleted file; lost, legacy, malformed (4 shapes) boundary; 17 MiB bounded read
with a straddling call; 9 000-call pairing bound; fresh and no-transcript conversations; recorder error
never keeps the tab in the CLI view; Codex untouched.

## Verified in this cloud container (Linux, Node 22.22)

- `npx vitest run` over `cli-capture-safety`, `cli-transcript-timings`, `structured-sessions`,
  `tool-timings`, `tool-timings.pipeline`, `native-cli-manager`, `src/main/cloud`, `src/shared`:
  **47 files, 518 tests passed** (this needed an Electron path stub in the untracked `node_modules`).
- `tsc --noEmit`: clean. `electron-vite build`: succeeded.

## Not run (truthfully)

- **Full suite and `test:scripts`.** `agent-manager.test.ts` cannot load here (`node-pty` native module not
  built; it fails identically on the base); it is covered on the owner machine only.
- **Windows acceptance**, packaging, `app.update` smoke, installed-app behaviour, a real `claude` CLI
  transcript produced by a live view. File identity on NTFS (`ino` from `stat({bigint:true})`) is
  untested here.
- Cloud budget: no fallback to the regular plan was used.

## Integration notes (controller)

- Touches: `agent-manager.ts` (hook signature only), `native-history.ts`, `structured-sessions.ts`,
  `tool-timings.ts` (`importCliTranscript`, `noteCliCapture`, `report`), `transcript-tool-pairs.ts`
  (`calls()` gains `orphans`/`dropped`; spread into `cloud/runs.ts` output, harmless), `shared/tool-timings.ts`
  (types, one gap sentence), plus the new test file. Rebase-hostile spots on a `main` that is 151 commits
  ahead: `prepareCli`/`finishCli` and the `report()` return. Keep the owner's local `7d99da3` fixes.
- Apply order: P3, P4, P5, then this patch.
