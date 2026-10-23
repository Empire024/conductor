# Event journal growth and retention (conductor-task:db-growth-1022)

Owner, 2026-10-22: "conductor.db grew from ~3.2 GB to ~14.5 GB, fix retention so it stays bounded".

## What the database holds

Measured read-only on the owner's live `conductor.db` (15.74 GB, 3,843,628 pages of 4 KB, 249 free
pages, `auto_vacuum` off), 2026-10-22 ~17:50:

| what | size |
| --- | --- |
| `structured_events` (the journal: 13.24 M rowids issued, ~11 M live rows, avg 1,041 B of JSON) plus its primary-key index | ~13.5 GB |
| `structured_sessions` (one projection snapshot per conversation, 1,666 of them) | ~1.3 GB |
| everything else | < 1 GB |

The 3.2 GB figure was from 2026-09-22, not 2026-10-21. The file grew steadily: 6.4 GB on 09-28,
12 GB on 10-20 and 15.7 GB on 10-22. The growth followed agent activity: about 1 M journal rows
a day this week (a swarm day writes more), roughly 1.2–1.8 GB a day with index and page slack.
No single looping writer was behind it.

## Why it grew

1. **Every streamed fragment of a tool's input was one journal row.** Claude streams a tool call's
   arguments as `input_json_delta` fragments of a few bytes. Each became an event with the full
   envelope (ids, cwd, runtime, timestamp: ~580 bytes). A 7 KB `control` call was 520 rows and
   320 KB. Sampled across the whole table, these fragments are **54% of rows and 30% of event
   JSON**, and 67% of the rows written on 2026-10-22. Once the tool's full input arrives, they are
   redundant: the `preparing` event with `input`, then `running` and `completed`, all carry it.
2. **Claude restated its full capability set on every turn start** (a ~3.5 KB `capabilities`
   block of models and limitations). That is about **7% of event JSON**.
3. **No retention for idle conversations.** The journal keeps the newest 20,000 events of each
   conversation (`JOURNAL_WINDOW`), forever, closed or not. A new conversation adds up to that much
   and never gives it back.

## What changed

- `journal-coalescing.ts` + `StructuredSessions.emit`: a streamed delta (tool `inputDelta`, text
  `mode: 'delta'`, no raw provider frame) is held and merged with the deltas of the same item that
  follow it. It is journaled as one event when anything else arrives from the conversation, or at
  the end of the burst (the store flush, a microtask). The reducer folds the merged delta exactly
  as it folded its parts, so the timeline, the renderer and the phone show the same text.
- An unchanged `capabilities` block is dropped from a session event if this runtime journaled the
  same block within the last 5,000 events. The projection keeps the previous set. Weekly
  accounting, which reads the model from `capabilities.effectiveSettings.model`, still finds a
  restatement inside the 20,000-event window.
- `journal-compaction.ts`: a worker thread (its own SQLite connection, off the main thread) runs
  five minutes after launch and then daily. It deletes **only tool-input fragments that a later
  event of the same tool in the same conversation supersedes with the full input**. It never
  deletes fragments of tools that never got a full input (interrupted: there they are the only
  record), rows carrying a raw provider frame, rows newer than an hour, or a conversation's oldest
  journal row. Progress is kept per conversation (`structured_journal_compaction.through`), so after
  the first pass over the backlog each run reads only the new rows. Reads are short statements, so
  no long read transaction holds the WAL. Deletes run in transactions of 200 rows with pauses.

## Expected size afterwards

- New writes: roughly half as many rows and 35–40% less event JSON per day of the same activity.
- First compaction pass: about 5–6 M rows and ~3–4 GB of event JSON plus their index entries go
  to SQLite's free list. New rows reuse those pages, so **the file stops growing for a few weeks**
  but does not shrink by itself.
- Long term the journal still grows with the number of conversations (up to 20,000 events each).
  See the owner decision below.

## One-off: shrinking the file (run 2026-10-23)

`VACUUM` rewrites the database without the free pages. Run it only with Conductor closed (it
takes an exclusive lock, and the app holds the database open), after the first compaction pass
has run (five minutes after a launch of a build with this change, plus its run time):

```
sqlite3 "%APPDATA%\Conductor\conductor.db" "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"
```

Estimate: it reads ~16 GB and writes ~9–11 GB, plus a temporary copy of the same size (C: has
173 GB free), so 5–15 minutes on this NVMe drive. To shrink later without closing the app,
`PRAGMA auto_vacuum = INCREMENTAL` could be set in the same session before the `VACUUM`. After
that, a background `PRAGMA incremental_vacuum(N)` could return free pages a little at a time.

Run on 2026-10-23 with the owner's approval (.conductor-scratch/vacuum/vacuum-run.mjs, through node:sqlite since sqlite3 is not installed): 15.85 GB -> 11.54 GB in 239 s, quick_check ok. The script disabled the meta-wizard task for the duration, quit Conductor cleanly (answering the stop-hosting and running-work questions through app.quit.confirm, possible since 38b723d) and started it again.

## Owner decision: no retention trimming for old conversations (2026-10-23)

The owner declined trimming on 2026-10-23. The analysis stays here for reference.

Bounding the file for good means trimming the journals of conversations nobody has touched for a
while (say 30 days) down to their snapshot. The rendered timeline already lives in
`structured_sessions` and `structured_transcript_archive`. What would be lost is the raw provider
events: the full tool inputs above the 64,000-character preview, the raw `agents.history` of those
conversations, and weekly accounting older than the window. That is owner data, not redundant data,
so it was not done here.
