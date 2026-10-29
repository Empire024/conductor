# Bounded journal and archive reads (t3code adoption, cloud branch)

Cloud branch `claude/bounded-journal-archive-reads-nkh3qf`, base `3f95349` (the cloud origin, 92+ commits behind the owner's local checkout), implementation commit `19e771c`.

Integration patch: [`t3code-bounded-reads-integration.patch`](t3code-bounded-reads-integration.patch), which is `git diff 3f95349 19e771c` over the six paths below. Neither this document nor the patch itself is included in it.

## Source read

Read-only: `pingdotgg/t3code` at `dd148481531a` ("perf(server): idle servers run 100x fewer background queries…"). No t3code script was run.

- **`apps/server/src/persistence/OrchestrationEventStore.ts`**
  - `readApplicationRows`: one keyset statement, `WHERE sequence > ${afterSequence} AND sequence <= ${throughSequence} … ORDER BY sequence ASC LIMIT ${limit}`, with an `INDEXED BY` hint.
  - `readAgentEvents`: pages that statement with `READ_PAGE_SIZE = 500`.
    - The caller's total `limit` is kept separate from the page size.
    - The cursor is the last row's `sequence`.
    - Paging stops on a short page, when the total is reached, or at `throughSequence`.
  - `catchUpApplicationEvents`: advances over raw rows, so a filtered page cannot end replay early.
  - `getAgentReplayStats`: uses `LIMIT maxEvents + 1` to detect overflow.
- **`apps/server/src/orchestration-v2/EventStore.ts`**: the `afterSequence` / `throughSequence` / `limit` read contract.

Adopted:
- Keyset paging on the primary key, with the last-read sequence as a durable cursor.
- `LIMIT n+1` to tell `hasMore` without a second query.
- A `through` upper bound, so a multi-page read sees one consistent set.
- A 500-row default page.

Not adopted:
- Effect streams.
- `INDEXED BY`. Conductor's `(session_id, sequence)` primary key already drives these scans.
- t3code's schema.

## What changed (six paths)

**`src/main/structured-store.ts`**
- New exports:
  - `JOURNAL_PAGE_DEFAULT = 500` and `JOURNAL_PAGE_MAX = 5000`.
  - `journalPageSize(limit)`: a missing limit takes the default and an oversized one is capped. A non-integer or a value below 1 throws `RangeError`.
- New `eventsPage(id, after, limit)`, returning `{events, nextAfter, hasMore}`.
- New `archivePage(id, after, limit, through)`, returning `{items, from, through, nextAfter, hasMore}` or `null`.
- `archive(id)` keeps its signature and result, but now reads through `archivePage`.
- `journalRange` now refuses `limit < 1`, because SQLite reads a negative LIMIT as no limit at all. It stays uncapped otherwise, since its callers detect the end of the journal by a short page.
- `events()` is **unchanged**. Restore and archive-tail replay keep `LIMIT 20001`, so no tail is lost.

**`src/main/conversation-history.ts`**
- Copy transcript (`transcript`) reads the archive in 1,000-item pages, with `await this.pause()` between pages.
- Later pages are capped at the first page's `through`.
- `HistoryStore` picks `archivePage` instead of `archive`.

**`src/main/remote-control-host.ts`**
- The remote `agents.history` (the mirror pull) used `events(after).slice(0, 100)`, which read up to 20,001 rows to keep 100.
- It is now `eventsPage(after, min(limit ?? 100, 100)).events`, bounded in SQL.
- It takes an optional `limit` from 1 to 100. An invalid limit is refused with 400.
- The response is still an array, so old mirrors are unaffected.

**`src/main/*.test.ts`** (three files): the tests listed below.

The controller's `agents.history`, including `raw:true`, was already bounded in SQL on this base (`agent-history.ts` via `journalRange`) and is untouched.

## Semantics preserved

**Order and cursors**
- Every page is `ORDER BY sequence` on the primary key.
- `nextAfter` is the last row's sequence column, or `after` when the page is empty.
- Sequences never move, so a cursor stays valid across appends and trims.
- The archive's `through` cap is safe because `settleArchiveTail` keeps nothing below the cut. A later flush only adds items above the coverage it extends, in the same transaction that advances `archived_through`.

**Redaction**
- `eventsPage` goes through `readBack`.
- `archivePage` masks with `maskStrings` while `redactionPending`.
- This is new for the archive. Before, `archive()` returned unredacted archive rows until the background walk reached them. The change only masks more, never less.

**Volatile (anonymous) conversations**
- `eventsPage` returns an empty page.
- `archivePage` and `archive` return `null`.
- Nothing is read.

**Export completeness**
- The paged export is `toEqual` to the same export with the whole archive handed over in one piece.
- A checkpoint that lands between archive pages neither duplicates nor drops a message.
- The existing 24,000-message and restart tests still pass.

**Restore and replay**
- `events()`, `restore` and `archiveTail` are byte-identical to the base.

## Tests run (cloud, Node v22.22.0)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `vitest run src/main/structured-store.test.ts` (5 new) | pass (38) |
| `vitest run src/main/conversation-history.test.ts` (2 new) | pass (12) |
| `vitest run src/main/remote-control-host.test.ts` (1 new) | pass (89, 7 skipped) |
| `vitest run` on agent-history, remote-session-mirror, awaiting-results, database, structured-sessions and local-models/anonymous-persistence | pass |
| `vitest run src/main/agent-control.test.ts` | 1 failure, **pre-existing**: "the owner's auto-approve policy answers a card it covers itself…". It fails the same way on base `3f95349` with no change applied. |
| Full `npm test`, `npm run build`, smokes | **Not run** in the cloud. The controller's local `git.ship` / `app.update` acceptance must run them. |

New tests:

1. **Journal larger than a page (1,234 events)**
   - Pages of 100 concatenate to exactly 1..1234, with no gap and no repeat.
   - Every statement handed at most 101 rows to JavaScript. The test wraps `db.prepare` to count rows.
   - The cursor survives an append and a trim.
   - A read past the end returns an empty page.
   - Another conversation's rows never leak in.
2. **Missing, oversized and invalid limits**
   - A missing limit gives 500. `1e6` is capped at 5,000.
   - These limits throw: `0`, `-1`, `1.5`, `NaN`, `Infinity`, `'10'`, `null`. Invalid cursors throw too.
   - `journalRange` still returns 5,002 rows for a limit of 5,002, and throws on `0` and `-1`.
   - `events()` still returns all 5,002 rows.
3. **Archive of 2,500 items**
   - Reads in 1,000-item pages, in order, bounded in SQL.
   - A simulated checkpoint between pages is excluded by `through`.
   - `archive()` equals a direct full `ORDER BY sequence` read.
4. **Redaction pending**: journal pages, archive pages and `archive()` never return the token.
5. **Anonymous conversation**: nothing is read.
6. **Copy transcript paging**
   - Reads 4 pages of at most 1,000 items.
   - Later pages are capped at coverage 3,999, with a yield between pages.
   - Output is deep-equal to the one-piece reference: 24,000 messages.
7. **Copy transcript with a checkpoint mid-export**: a checkpoint archives 2,000 more events inside the yield, and every message 1..24000 still appears exactly once.
8. **Remote `agents.history` with a real store**
   - Without `limit` it returns 100.
   - `afterSequence:200` returns 50, `limit:5` returns 5, and `limit:1000` is capped at 100.
   - Reading past the end returns `[]`.
   - `events()` is never called, and `eventsPage` receives the clamped size.
   - Invalid limits are refused.

Mutation checks, all confirmed:
- Removing the archive read-time mask fails test 4.
- Removing the `through` cap from `archivePage` fails test 3.
- Dropping `through` from Copy transcript's later pages fails test 7.

## Measurements

Measured in the cloud container:
- **Machine**: Intel Xeon @ 2.10 GHz, 4 vCPU, Node v22.22.0, `node:sqlite`.
- **Data**: one conversation with 20,000 journal events and 50,000 archive items, each carrying 1,500 characters of text.
- **Setup**: the redaction walk was finished first, so neither side pays read-time masking.
- **Method**: median of 15 runs. Two separate process runs agreed within about 10%. The bench source is in the appendix; it was run with `npx vite-node`.

| Read | Before | After |
|---|---|---|
| Remote `agents.history` pull from sequence 0 (catch-up or new mirror) | 118.6–129.5 ms | 0.33–0.35 ms |
| Remote pull from sequence 10,000 (catch-up) | 54.9–58.9 ms | 0.37–0.50 ms |
| Remote pull from sequence 19,950 (steady-state tail, ≤50 rows) | 0.15 ms | 0.16 ms (no change: the old read was already small here) |
| Copy transcript archive read: longest single main-thread block | 264.9–277.8 ms (one `all()`) | 7.7–13.4 ms (one 1,000-item page); median page 3.4 ms |
| Copy transcript archive read: total | 264.9–277.8 ms | 178.0–195.6 ms |

**Inference, not measured on the owner's machine**
- The owner's journal is multi-GB and real event sizes vary, so absolute times will differ.
- The ratios follow from the number of rows read: 20,001 versus 101 per pull, and one 50k-row block versus blocks of about 1k rows.
- The archive gain is mostly responsiveness, because the main process yields between pages, rather than throughput.
- The steady-state mirror tail pull was never the problem. The win is for catch-up pulls: a reconnect, a new mirror, or a mirror far behind.

## Risks for local integration (local is 92+ commits ahead)

**History reader worker**
- The owner reports that async history, phone, process and projection reader workers are already delivered locally.
- If the local `ConversationHistory`, or a worker copy of it, still calls `store.archive(id)`, there are two ways to port this change:
  - Switch it to the `archived()` paging loop in this patch, keeping the `through` cap and a yield between pages.
  - Inside a worker, page without the yield.
- `archive()` remains available and correct for any other caller.

**Structured-store hunks**
- The changes are additive:
  - new exports after `CHECKPOINT_INTERVAL_MS`;
  - new methods next to `archive` and `journalFloor`;
  - one guard line in `journalRange`.
- If local moved `events` or `journalRange` (for example behind the narrow meta table or WAL worker), apply these by hand. The new methods use only `this.db`, `this.volatileSpecs`, `this.redactionPending`, `readBack` and `maskStrings`.

**`journalRange` limit guard**
- Any local caller that passes `0` or a negative limit now throws.
- On this base, every caller passes 1, 400, 1000 or a validated 1..100.
- Grep `journalRange(` before shipping.

**Remote `agents.history` `limit`**
- The parameter is optional, and older peers never send it.
- Hosts on older builds ignore it and still return at most 100 events, so mirrors stay compatible in both directions.

**Archive masking while redaction is pending**
- This changes Copy transcript output only for rows the one-off redaction has not reached yet, and only toward `[REDACTED]`.

**Not touched; owned elsewhere (possible follow-ups, not part of this patch)**
- The renderer's diagnostic Event log (`StructuredAgentPane.tsx`: `structured.events(id).slice(-200)`) still reads up to 20,001 rows. Fixing it needs a tail reader plus a renderer change, and the thread UI is owned by another worker.
- The `CliDrawer.tsx` backlog.
- `agent-control.ts` `events(id, sequence - 1)[0]`. The data already bounds this to at most one row.

## Effort

**Owner's estimate** for this increment: 3–5 h for journal reads and 2–3 h for archive paging.

**This cloud session** covered all of it in one pass:
- reading the t3code source;
- the implementation and 8 tests;
- the mutation checks and the benchmark;
- this document and the patch.

**Local integration**: an estimate, not a measurement, of 0.5–1.5 h. That covers:
- applying the six-file patch with `git apply -3`;
- porting the archive loop into the local history worker, if one exists;
- running `git.ship` with the related tests plus the full suite.

## Appendix: bench source

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { StructuredAgentStore } from '<checkout>/src/main/structured-store'

const EVENTS = 20_000, ARCHIVE = 50_000, BODY = 'x'.repeat(1_500), RUNS = 15
const root = mkdtempSync(join(tmpdir(), 'bounded-reads-bench-'))
const db = new DatabaseSync(join(root, 'events.sqlite'))
db.exec("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY); INSERT INTO agent_sessions(id) VALUES('chat')")
const store = new StructuredAgentStore(db, root)
store.register('chat', 'project', 'claude', {})
db.exec('BEGIN')
for (let sequence = 1; sequence <= EVENTS; sequence++) store.append({ schemaVersion: 1, id: `e${sequence}`, sequence, sessionId: 'chat', runtimeId: 'r', provider: 'claude', projectId: 'project', workspaceId: 'w', cwd: 'c', timestamp: '2026-10-29T00:00:00.000Z', itemId: `i${sequence}`, data: { type: 'text', role: 'assistant', text: `${sequence} ${BODY}`, mode: 'snapshot' } })
const insert = db.prepare('INSERT INTO structured_transcript_archive(session_id,sequence,item_json) VALUES(?,?,?)')
for (let sequence = 1; sequence <= ARCHIVE; sequence++) insert.run('chat', sequence, JSON.stringify({ id: `a${sequence}`, sequence, data: { type: 'text', role: 'assistant', text: `${sequence} ${BODY}`, mode: 'snapshot' } }))
db.prepare('INSERT INTO structured_transcript_archive_state(session_id,archived_through,archived_from) VALUES(?,?,1)').run('chat', ARCHIVE)
db.exec('COMMIT')
// Finish the one-off redaction walk so neither path pays read-time masking.
while (store.redactSecretsStep()) { /* walk */ }

const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const time = (run: () => unknown): number => { const samples: number[] = []; for (let i = 0; i < RUNS; i++) { const t = performance.now(); run(); samples.push(performance.now() - t) } return median(samples) }

const oldHistory = time(() => store.events('chat', 0).slice(0, 100))
const newHistory = time(() => store.eventsPage('chat', 0, 100).events)
const oldTail = time(() => store.events('chat', EVENTS - 50).slice(0, 100))
const newTail = time(() => store.eventsPage('chat', EVENTS - 50, 100).events)
const oldMid = time(() => store.events('chat', EVENTS / 2).slice(0, 100))
const newMid = time(() => store.eventsPage('chat', EVENTS / 2, 100).events)
const oldArchive = time(() => (db.prepare('SELECT item_json FROM structured_transcript_archive WHERE session_id=? ORDER BY sequence').all('chat') as Array<{ item_json: string }>).map(row => JSON.parse(row.item_json)))
const pageBlocks: number[] = []
const pagedArchive = time(() => {
  let page = store.archivePage('chat', 0, 1_000)!
  for (;;) {
    const t = performance.now()
    if (!page.hasMore) break
    page = store.archivePage('chat', page.nextAfter, 1_000, page.through)!
    pageBlocks.push(performance.now() - t)
  }
})
console.log(JSON.stringify({
  node: process.version, journalEvents: EVENTS, archiveItems: ARCHIVE, payloadBytes: BODY.length, runs: RUNS,
  agentsHistoryPull_old_events_slice100_ms: +oldHistory.toFixed(2),
  agentsHistoryPull_new_eventsPage100_ms: +newHistory.toFixed(2),
  tailPull_after19950_old_ms: +oldTail.toFixed(2), tailPull_after19950_new_ms: +newTail.toFixed(2),
  catchUpPull_after10000_old_ms: +oldMid.toFixed(2), catchUpPull_after10000_new_ms: +newMid.toFixed(2),
  archive_old_single_all_block_ms: +oldArchive.toFixed(2),
  archive_paged_total_ms: +pagedArchive.toFixed(2),
  archive_paged_longest_single_page_ms: +Math.max(...pageBlocks).toFixed(2),
  archive_paged_median_page_ms: +median(pageBlocks).toFixed(2)
}, null, 2))
db.close(); rmSync(root, { recursive: true, force: true })
```
