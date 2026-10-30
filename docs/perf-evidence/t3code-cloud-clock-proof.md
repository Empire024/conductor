# Cloud transcript clocks: proof from real rows (P4 follow-up)

Cloud-session delivery, 2026-10-30. Branch `claude/t3code-cloud-clock-proof-m8xfqv`.

| | |
|---|---|
| **Base** | `5a97c51da8523b99be43412f094b0d82a426cef1` (the P4 export; its implementation is `afd71210bee130ab22e303f9531845a6c703a91e`) |
| **Implementation** | `cd883f86a71f91c1bbe13c881be8be88d8793957` |
| **Export commit** | the commit that adds `t3code-cloud-clock-proof-integration.patch` and this note; its SHA is recorded in the line below once it exists |
| **Patch** | `docs/perf-evidence/t3code-cloud-clock-proof-integration.patch` = `git diff 5a97c51 cd883f8` plus a two-line header. Applied to a pristine checkout of `5a97c51` it produces exactly the implementation tree (`dd7ec0ad35140e5315ff52c632c80b280fa4906a`). |
| **Left unchanged** | `t3code-provider-clock-timings*` (P3) and `t3code-cloud-transcript-timings*` (P4) |

Export commit SHA: the last line of this note (it cannot be written into the commit it names, so a note-only commit follows it).

This is the P4 claim only. P5 capture safety belongs to the other Cloud sibling and is not touched.
There is no handoff work, no rank-7 work and no provider-clock redesign.

## The question

P4 said cloud-coworker tool calls are timed on the cloud's own row clock. Its evidence was one hand-written
fixture and a reading of the CLI binary. This follow-up asks whether the row timestamps survive
the actual path into the recorder, using real rows.

## Where each fact comes from

I keep three kinds of evidence apart. Only the first is production clock evidence.

### 1. Observed: real rows

`src/main/cloud/fixtures/cloud-session-rows.cli-2.1.314.jsonl` is a redacted slice of the transcript that
Claude Code **2.1.314** wrote in the Claude Code cloud container this work ran in
(`~/.claude/projects/-home-user-conductor/<session>.jsonl`, `entrypoint: "remote"`). The file was 80 lines when first inspected and has grown since; the slice uses lines 0–47, which do not change.

- **Kept as written:** every structural key, the real `timestamp`s, the `uuid` → `parentUuid` →
  `sourceToolAssistantUUID` links, the `tool_use` → `tool_result` id links, `message.id` and `requestId`
  sharing, `apiBlockIndex`, `permissionDecision`'s keys, and the order of the rows.
- **Replaced:** every text, command, output, path, branch name, cwd, session id, request id and message id.
  Ids are pseudonyms with the same links and the same shape (`toolu_01RedactedFixture0000001`).
  The thinking rows (which carry signatures) are left out.
- **Dropped:** `wireToolInputs`, `wireIngestContext`, `rendered`, `usage`.
- The method is reproducible: the script and the row indexes are in the appendix.
  A test checks that the file contains no identifying string.

What the real rows show:

| Fact | Evidence |
|---|---|
| Every `user`/`assistant` row has a `timestamp`, `YYYY-MM-DDTHH:mm:ss.sssZ` | all 31 when first counted; all 10 in the slice |
| A result names the exact `tool_use` row it answers | 12 of 12 pairs in the source when checked: `sourceToolAssistantUUID` equals the call row's `uuid` |
| Call row → result row, in ms | 280, 572, 61, 313, 19, 59, 72, 80, 56, 70, 192, 81 (source); the first, second, fourth and fifth are the slice's Bash, Bash, Grep, Read |
| **A message's content blocks are separate rows with their own times** | two `tool_use` blocks of one `message.id`/`requestId` are rows 826 ms apart (02.166Z and 02.992Z) |
| File order is not clock order | the prompt row (.487) is followed by an attachment row at .485; another pair is 1 ms reversed |
| Rows that are not `user`/`assistant` also carry times or none | `queue-operation`, `attachment` have them; `custom-title`, `agent-name` do not |
| `permissionDecision` has no time | keys are `decision`, `source`, `reasonType`, `ruleSource` only, so an approval wait cannot be read from a row |
| `toolUseResult` has no duration for Bash, Grep or Read | none in the real rows |

#### What "row timestamp" means

`timestamp` is the time this CLI wrote that row on its own wall clock. It is **not**:

- **the message's creation or receipt time.** One API message is several rows with different times,
  and `message.id` and `requestId` carry no time. So parallel calls in one assistant message do **not**
  share a start. (The P4 note said they did; that was wrong for real rows, and the code never assumed it.)
- **an approval or execution time.** A call-row to result-row interval contains whatever happened between
  the two writes: permission, hooks, the tool and queueing. I infer the call row is stamped when its content block
  finished arriving; that inference is not read from the CLI. What is observed is only that the
  blocks of one message have increasing times.
- **the server's ingest time.** See the next section.

This is why the report calls the interval `transcript-wall` and leaves wait and execution unavailable.

### 2. Read from the CLI binary (2.1.314, static)

I searched `/opt/claude-code/bin/claude` as bytes with `strings` and `grep`. I did not run it, except for
`claude --version` once to read the version (no session, no model call).

- **Teleport fetch.** The teleport reads pages of events and keeps only each event's `payload`:
  `S.push(FSn(ze.payload))`. `FSn` rewrites `toolUseResult` and otherwise returns the row as it was.
  A `null` payload is skipped (the CLI counts `rowsWithoutPayload`). So a row's own `timestamp` is kept
  if the stored payload has one, and anything the server stamps on the event itself is never read.
- **Writer.** Each history row is written as `{parentUuid, …, ...KLi(message), ...szr(sessionId), version, gitBranch}`.
  `KLi` only touches `origin`. `szr` sets `sessionKind/userType/entrypoint/cwd/sessionId/version`.
  So the file's `sessionId` is the **local** teleport id, and the writer sets **no `timestamp`**. The part of
  `appendEntry` I read (its start) adds none either; I did not read all of it.
- **Note.** The "This session is being continued from another machine…" text matches the start the code looks for.
- **History marker.** `Cjt` adds `remoteSourced: true` to history `user`/`assistant` rows, and the writer spreads
  the whole row, so it is probably persisted. It is not observed, so the code does not rely on it.
- **Synthetic results.** Results the CLI makes for interrupted, cancelled or denied calls are
  `Ie({…, toolDenialKind: "interrupted"|"cancelled"|…, sourceToolAssistantUUID})`, where `Ie` is the CLI's message
  constructor. I did not read how it stamps, so I assume the clock of whichever machine makes them. Every one
  I found carries `toolDenialKind`, which is what the recorder refuses to time.
- **A host-clock fallback exists, on another path.** The SDK message adapter that turns live
  remote frames into rows does `timestamp: e.timestamp ?? new Date().toISOString()` (and stamps a
  `compact_boundary` frame with `new Date()` outright). That is the receiver's clock standing in for a missing one. It is not on the teleport path above, so
  it does not affect this change, but anyone who later mirrors live remote rows must not treat their times as cloud times.
- **Bridge marker.** `foreignToBridgeSession` is a Remote Control bridge marker, not a teleport one. It is not used.

### 3. Constructed in tests

The teleport file itself: history rows with `sessionId` set to a local id (and `remoteSourced: true`), then the
note, then rows this machine wrote after it, stamped a day later. No teleport file was observed (a real one needs
a real CLI launch against a real session, which this cycle may not do). These tests say what the code does
with such a file. They do not show that the CLI writes it. The transport is faked; no model, CLI or Electron runs.

## What the trace found

The path is `CloudRuns.transcript(refresh)` → `pullTranscript` → `teleport` → `parseTranscript` →
`onToolCalls` → `ToolTimingRecorder.importCloudTranscript` → `report`.
For real-shape rows the path **keeps** the cloud clock: the four real pairs come out at 280, 572, 313 and 19 ms,
with `startedAt`/`endedAt` equal to the rows' own strings, `transcript-wall`, wait and execution unavailable, and
nothing stamped by the pull time. Seven of the ten new tests pass on the unmodified base for exactly that reason; they lock it in.

Two clock fields were being misassigned:

1. **A stamp without a zone was read in the host's time zone.** `isoTime` accepted anything `Date.parse` accepts.
   With a call row ending in `Z` and a result row of `2026-10-30T20:07:02.446`, the base returned
   **`elapsedMs: 25200280`** (7 h 0 min 0.28 s) labelled `transcript-wall` under `TZ=America/Los_Angeles`. A date alone, or `"5"`, read as
   a reversed interval, so the note was wrong too. Real rows never look like this, but the reader is the one place
   where a malformed stamp turns this machine's zone into a cloud duration.
   **Fix:** `rowClockMs` (new, `src/shared/tool-timings.ts`) reads only `YYYY-MM-DDTHH:mm:ss[.fff…](Z|±HH:MM)`.
   The parser and the recorder both use it. Anything else is a missing time: not timed, noted
   `missing-transcript-time`, and the other row's time stays as the label.
2. **A call with no usable time on either row was dated by this host.** `transcriptRecord` fell back to
   `endedAt = new Date(this.wallNow())` with only an `ended-at-import` note. `endedAt` is what the report filters
   `since`/`until` on, what `recordedSince` and a failure group's `lastAt` read, and what retention uses, so
   a call the cloud never dated appeared as "just now". **Fix:** such a call is not recorded; it is counted in the
   returned `skipped`. No `ended-at-import` record can be written any more.

Everything else the task listed was already right and is now covered with real rows: the note and everything after
it (also a second note, and a note written as a text-part array), a call before the note with its result after,
reversed times, conflicting restatements, a copy given a new `uuid`, exact copies, a CLI-synthesised interrupted
result stamped a day later, a second cloud session with identical rows, a restart, and origin separation.

## Tests

`src/main/cloud/transcript-clock-proof.test.ts` (10 tests). "Base" is the same tests run on `5a97c51`'s source.

| # | Test | Base | Now |
|---|---|---|---|
| 1 | Real rows carry ISO times, exact id links, one clock per content block (826 ms apart, same `message.id`), file order ≠ clock order, no identifying strings, no time in `permissionDecision` | pass | pass |
| 2 | Real rows → `parseTranscript` → recorder → report: 280/572/313/19 ms, labels equal the rows' strings, `transcript-wall`, wait/exec unavailable, this machine's own pair after the note absent, nothing stamped by pull time, native report 0 | pass | pass |
| 3 | The same through **`CloudRuns.transcript(refresh)`** with a faked teleport and `onToolCalls` wired as `register.ts` does: stored entries keep `toolUseId`, second pull `known: 4`; a restart; a file with the cloud rows copied and reversed; the persisted file holds 4 keys | pass | pass |
| 4 | Another cloud session's identical rows are kept apart (8 records, 4 per run); native and cloud never mix (native 1, cloud-provider native 0) | pass | pass |
| 5 | `rowClockMs` accepts `Z` and `±HH:MM`, refuses zone-less, space-separated, date-only, bare year/digit, prose, epoch number, empty, null, object and impossible dates | **fail**: `rowClockMs is not a function` | pass |
| 6 | **A pair whose stamp has no zone, is an epoch number, a date or `"5"` is not timed** (run with `TZ=America/Los_Angeles`); the call row's time stays as the label; explicit offsets in any zone are timed | **fail**: `elapsedMs` 25,200,280 `transcript-wall`, expected null | pass |
| 7 | **A call with neither row dated is not recorded** (`skipped`), no `ended-at-import`, a "last hour of host time" query finds nothing, a re-pull is stable | **fail**: `added: 4`, expected `added: 2, skipped: 2`; the undated calls ended "now" | pass |
| 8 | The note as string or text-part array, a second note, a late row repeating a call: only the rows before the first note pair; a result written after the note is unmatched | pass | pass |
| 9 | A CLI-synthesised interrupted result stamped a day later is not timed (`interrupted`, `denied-or-interrupted-result`) while its neighbours are | pass | pass |
| 10 | Reversed → `invalid-transcript-interval`; a result restated 60 s later and a call copy with a new `uuid` → `conflicting-restatement`, first statement's times stay as labels; an exact copy is timed once | pass | pass |

Test 5 fails on the base because it tests the new function. Tests 6 and 7 fail on the base for the two behaviours above.
Test 6's loop stops at its first failing case (no zone); for the other three I computed the base's reading by hand under the same zone
(a date alone and `"5"` become reversed intervals, an epoch number is already ignored), rather than running them.

Results in this Linux container, with `npm ci --ignore-scripts` (no Electron binary):

| Check | Result |
|---|---|
| `npx tsc --noEmit` | no diagnostics |
| `npx electron-vite build` | built |
| `vitest run src/main/cloud src/main/tool-timings.test.ts src/shared/tool-timings.test.ts src/main/providers/codex-provider-clock.test.ts src/main/providers/codex.test.ts` | 9 files, **160/160** passed (150 in the P4 note plus these 10) |
| `vitest run src/main/cloud/transcript-clock-proof.test.ts` under `TZ=UTC`, `Asia/Tokyo`, `Pacific/Auckland` | 10/10 each |
| Full suite, Windows acceptance, `agent-control.test.ts` `tools.timings` cases, `tool-timings.pipeline.test.ts`, `smoke-tool-timings` | **Not run.** They need the Electron binary or the Windows host. |

## Limitations

- **No real teleport file was observed.** The claim that a teleport keeps the cloud's `timestamp`s rests on
  real cloud-written rows (observed) plus the binary's pass-through of `payload` and its writer (read, 2.1.314).
  Closing it takes one teleport on the owner's machine and a comparison of a history row's `timestamp` with the cloud UI.
  A future CLI that restamps history would make `transcript-wall` the teleport time. Neither the note guard nor the
  7-day guard can detect a uniform restamp.
- **The fixture is the cloud CLI's own transcript, not a teleport result.** That the cloud returns the same row as
  `payload` is read from the CLI, not observed.
- **`transcript-wall` is not execution, and not approval wait.** The real rows have no time to read either from.
- **A file's rows cannot be checked against its session.** The writer overwrites `sessionId` with the local id,
  so a wrongly chosen conversation file would be attributed to the run's cloud session. The only guard is the way
  `teleport()` finds the file (the `claude --resume <id>` the prompt prints, else the newest file for the run's own worktree).
- **A file with no note is treated as wholly cloud-clock**, as in P4.
- **`ended-at-import` records already persisted** by a build of `afd7121` stay until retention drops them; `parseRecord` is unchanged.
- **Skipped undated calls are not visible in the report.** Only the import's `skipped` count shows them, and `register.ts` discards it.
- **The unverified `remoteSourced` marker** could later make the cloud/local split explicit; it must keep working
  where nothing carries it.
- I cannot see this session's spend from inside it, so no cost figure is recorded here.

## Integration cautions

- **Order:** P3 patch, P4 patch, then this one. Its anchors assume P4's `importCloudTranscript` and `transcriptRecord`.
- **Hunks:**
  - `src/main/tool-timings.ts`: the import of `rowClockMs`; in `importCloudTranscript`, the null check after
    `transcriptRecord`; in `transcriptRecord`, the signature, the first lines and the `startedAt`/`endedAt` line.
  - `src/shared/tool-timings.ts`: one function and its regex, added before `TranscriptToolCall`.
  - `src/main/cloud/runs.ts`: the import line and `isoTime`.
- **Kept untouched:** the local `native.method === 'cli/history'` exclusion, sticky `inputComplete`, the Claude
  hook's top-level `input.duration_ms`, and the reviewed P3 native provenance (`c4a78ba37a9d12119261532a73d5aecc3055eb9e`).
  The diff contains no line of them (checked by searching the diff for `cli/history`, `inputComplete`, `reviewMs`).
- New files: `src/main/cloud/transcript-clock-proof.test.ts` and `src/main/cloud/fixtures/cloud-session-rows.cli-2.1.314.jsonl`
  (vitest includes `src/**/*.test.ts`; the fixture is read by relative path from the repository root).

## Appendix: how the fixture was made

Source lines (0-based) of the transcript: `1, 2, 4, 5, 24, 25, 26, 27, 28, 42, 43, 46, 47`.
An attachment row is reduced to its `type`.

```python
import json, sys
src, out, idx = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3:]]
rows = [json.loads(l) for l in open(src)]
KEEP = {'type','role','name','version','entrypoint','userType','subtype','kind','decision','source','reasonType','permissionMode',
        'promptSource','turnOrigin','clientPlatform','mode','stop_reason','model','requestedModel','advisorModel','effort','perTurnEffort','timestamp','operation'}
DROP = {'wireToolInputs','wireIngestContext','rendered','renderedRole','usage','input_transformations','diagnostics','context_management','container','stop_details','stop_sequence','content_blocks','signature'}
maps = {}
def pseudo(kind, value, fmt):
    m = maps.setdefault(kind, {})
    if value not in m: m[value] = fmt % (len(m) + 1)
    return m[value]
UUID = lambda v: pseudo('uuid', v, '00000000-0000-4000-8000-%012d')
def walk(key, value):
    if key in ('uuid','parentUuid','sourceToolAssistantUUID','leafUuid','turnAttributionKey','promptId'):
        return UUID(value) if isinstance(value, str) else value
    if key == 'sessionId': return '00000000-0000-4000-8000-00000000cafe'
    if key == 'cwd': return '/redacted/cwd'
    if key == 'gitBranch': return 'redacted-branch'
    if key == 'requestId': return pseudo('req', value, 'req_REDACTED%04d')
    if key == 'id' and isinstance(value, str) and value.startswith('msg_'): return pseudo('msg', value, 'msg_REDACTED%04d')
    if key in ('id','tool_use_id') and isinstance(value, str) and value.startswith('toolu_'): return pseudo('tool', value, 'toolu_01RedactedFixture%07d')
    if isinstance(value, dict): return {k: walk(k, v) for k, v in value.items() if k not in DROP}
    if isinstance(value, list): return [walk(key, v) for v in value]
    if isinstance(value, str): return value if key in KEEP else '[redacted]'
    return value
result = []
for i in idx:
    r = rows[i]
    if r.get('type') == 'attachment': r = {k: v for k, v in r.items() if k != 'attachment'} | {'attachment': {'type': r['attachment']['type']}}
    result.append(walk('', r))
with open(out, 'w') as f:
    for r in result: f.write(json.dumps(r, separators=(',', ':')) + '\n')
```

Export commit SHA: `8acb91053ea206e3be407bb29f1909650df505c6`
