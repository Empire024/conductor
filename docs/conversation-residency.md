# Conversation residency: what the main process holds in memory

Owner, 2026-10-22 14:00 (+02:00): "fix conductor now it is broken immediately make sure can't
break again".

## What happened

At 11:22 the installed app stopped for the `0db4b53` local update. Every launch after that, of the
new build and of the previous one the recovery agent rolled back to, died about four seconds in
with `OOM error in V8: ... JavaScript heap out of memory` after the heap reached ~3.9 GB
(`recovery\launch-2026-10-22T09-25-59-868Z.log`, `meta-wizard\launch-*.log`, Application event
log 11:26:05, exception 0xe0000008). The recovery watchdog's two relaunches and the meta-wizard's
three starts all failed the same way, and the crash-loop guard stood down at 13:59.

The cause was not the new build or a corrupt row. `StructuredAgentStore`'s constructor ran
`SELECT id, provider, projection_json FROM structured_sessions`, parsed every row and kept every
projection in a map for the life of the process. A projection is a whole conversation (up to
2,000 timeline items); the owner had 1,666 of them, 1.27 GB of JSON (the largest 10.8 MB), and
parsed objects take two to three times the text. The total had been growing with every
conversation since 2026-09-16 and on 2026-10-22 it crossed the main process's default 4 GB V8 heap
limit. The 09:21 process had started six hours earlier with slightly less data and survived;
nothing started after it could.

`conductor.db` is 15.5 GB: 13.5 GB of `structured_events` (11.1 M events, the 20,000-event journal
window per conversation), 1.27 GB of `structured_sessions`. The journal was never read whole; it
was not the problem.

## The fix (`src/main/structured-store.ts`)

- **Nothing is read at construction.** A conversation is loaded by `snapshot(id)` the first time
  something asks for it: its stored snapshot plus the journal after it, with the previous process's
  runtime state normalised exactly as the constructor used to do it (`restore`). A launch costs the
  same with ten conversations as with ten thousand.
- **Idle resident conversations are bounded** (`RESIDENT_BUDGET_BYTES`, 256 MB of JSON text).
  Past it, the least recently used conversations that are not mid-turn are checkpointed and
  dropped (`evictIdle`); a later read loads them back from the row they were just written to. A
  reload of a snapshot this process wrote is not normalised again (`ownSnapshots`): nothing ran it
  in between. Conversations in `starting`, `running`, `waiting_approval`, `waiting_input` or
  `interrupting` are never evicted; anonymous (volatile) ones neither.
- **Scans never make a project resident.** `peek(id)` reads a conversation without keeping it;
  `searchMessages` and the artifact prune's cross-conversation edit scan use it.
- **Listing reads a stored summary.** `structured_sessions.summary_json` (phase, item count,
  model, last message snippet and role) is written with every checkpoint. `history()` reads it,
  with the resident projection for what is resident, so a project of a thousand conversations
  lists without a parse. A row from before the column, or from an archive import, is summarised
  from its projection the first time a list reaches it, once. A stored live phase of a
  non-resident conversation is listed as `disconnected`: nothing in this process is running it.
  A history query is matched inside SQLite (`LIKE` over the stored text) for non-resident rows.
- **A memory guard** (`startMemoryGuard`, started from `index.ts`) checks the V8 heap every 15 s;
  past 70% of its limit it drops every idle resident conversation and logs how many, what was
  resident and how much JSON it was, so a process that is filling up sheds what it can before the
  allocator kills it.
- `residentStats()` reports how many conversations are resident, roughly how many bytes of JSON
  they were and how many are live.

## Rules

- No query in the store may read `projection_json` for more than one conversation
  (`structured-store.test.ts` checks the source: every such `SELECT` carries `WHERE id=?`).
- A read over many conversations goes through `peek` or the summary column, never `snapshot`.
- Anything new that must be known for every conversation goes into `summary_json` at checkpoint,
  not into a startup scan.

## Verification

`src/main/structured-store.test.ts`, "conversations are resident only while used": a reopened
store has nothing resident and lists the project from summaries; `peek` keeps nothing; `snapshot`
loads one; the budget evicts least recently used idle conversations and never the live one, and an
evicted conversation reloads identical and continues its sequence; a row with no summary is
summarised once; the memory guard drops every idle conversation past the heap fraction and keeps
the live one; the source rule above.
