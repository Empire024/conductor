import { Worker } from 'node:worker_threads'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Removes journal rows that later rows of the same conversation make redundant
 * (conductor-task:db-growth-1022), off the main process.
 *
 * Until journal-coalescing.ts, every streamed fragment of a tool's input was its own
 * `structured_events` row: about half of the owner's 13 M rows on 2026-10-22, each a ~580-byte
 * envelope around a few bytes of JSON. Once the tool's complete input is journaled (the
 * `preparing` event with `input`, then `running`/`completed`, all carrying it), those fragments
 * add nothing: the reducer replaces the streamed preview with the full input the moment it
 * arrives, so a projection, a history rebuild and a replay end in the same item without them.
 *
 * Only such fragments are removed, and only when (a) the same conversation's journal holds a later
 * event of the same tool carrying its full input, (b) the fragment is older than `settleMs`, (c) it
 * carries no raw provider frame, and (d) it is not the conversation's oldest journal row (which
 * history paging and accounting read as the journal floor). Interrupted tools that never received
 * a full input keep every fragment: there the fragments are the only record.
 *
 * Progress is stored per conversation (`structured_journal_compaction.through`), so each run reads
 * only what was journaled since the last one, and the first run reads the backlog once, a chunk at
 * a time, pausing between chunks. Freed pages go to SQLite's free list and are reused by new rows;
 * the file itself only shrinks with a VACUUM while Conductor is closed.
 *
 * `compactJournal` must stay self-contained (no imports, no outer helpers): the worker runs its
 * source text (`compactionWorkerSource`), so the packaged app needs no extra bundle on disk.
 */
export interface JournalCompactionOptions {
  now: number
  /** Rows newer than this are left for the next run: their tool may still be streaming. */
  settleMs: number
  /** Rows read per statement. */
  chunk: number
  /** Rows deleted per write transaction, so the app's own writes never wait long. */
  batch: number
  /** Pause between chunks and batches. */
  pauseMs: number
}
export interface JournalCompactionResult { conversations: number; scanned: number; deleted: number; freedBytes: number; ms: number }

export function compactJournal(db: DatabaseSync, options: JournalCompactionOptions, sleep: (ms: number) => void): JournalCompactionResult {
  const started = Date.now()
  db.exec(`CREATE TABLE IF NOT EXISTS structured_journal_compaction (
    session_id TEXT PRIMARY KEY REFERENCES structured_sessions(id) ON DELETE CASCADE,
    through INTEGER NOT NULL
  )`)
  const cutoff = new Date(options.now - options.settleMs).toISOString()
  const sessions = db.prepare(`SELECT s.id AS id, COALESCE(c.through, 0) AS through FROM structured_sessions AS s
    LEFT JOIN structured_journal_compaction AS c ON c.session_id = s.id ORDER BY s.rowid`).all() as Array<{ id: string; through: number }>
  // role 1: a streamed input fragment (no full input, no raw frame); role 2: an event carrying the full input.
  const read = db.prepare(`SELECT sequence, event_at AS at, length(event_json) AS bytes,
      json_extract(event_json, '$.itemId') AS item, json_extract(event_json, '$.parentId') AS parent,
      CASE WHEN event_kind = 'tool' AND json_type(event_json, '$.data.input') IS NOT NULL THEN 2
        WHEN event_kind = 'tool' AND json_extract(event_json, '$.data.status') = 'preparing'
          AND json_type(event_json, '$.data.inputDelta') IS NOT NULL AND json_type(event_json, '$.native') IS NULL THEN 1
        ELSE 0 END AS role
    FROM structured_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
  const floorOf = db.prepare('SELECT sequence FROM structured_events WHERE session_id = ? ORDER BY sequence LIMIT 1')
  const remove = db.prepare('DELETE FROM structured_events WHERE session_id = ? AND sequence = ?')
  const save = db.prepare(`INSERT INTO structured_journal_compaction(session_id, through) VALUES(?, ?)
    ON CONFLICT(session_id) DO UPDATE SET through = excluded.through`)
  const result = { conversations: 0, scanned: 0, deleted: 0, freedBytes: 0, ms: 0 }
  for (const session of sessions) {
    const floor = (floorOf.get(session.id) as { sequence: number } | undefined)?.sequence
    if (floor === undefined) continue
    let cursor = Math.max(session.through, floor - 1), through = session.through
    const fragments: Array<{ sequence: number; key: string; bytes: number }> = []
    const complete = new Map<string, number>()
    for (;;) {
      const rows = read.all(session.id, cursor, options.chunk) as Array<{ sequence: number; at: string | null; bytes: number; item: string | null; parent: string | null; role: number }>
      let settled = true
      for (const row of rows) {
        if (row.at && row.at >= cutoff) { settled = false; break }
        through = row.sequence
        if (!row.item || !row.role) continue
        const key = row.item + '\u0000' + (row.parent ?? '')
        if (row.role === 2) complete.set(key, row.sequence)
        else fragments.push({ sequence: row.sequence, key, bytes: row.bytes })
      }
      result.scanned += rows.length
      if (!rows.length || !settled || rows.length < options.chunk) break
      cursor = rows[rows.length - 1]!.sequence
      sleep(options.pauseMs)
    }
    const redundant = fragments.filter(fragment => fragment.sequence > floor && (complete.get(fragment.key) ?? -1) > fragment.sequence)
    for (let at = 0; at < redundant.length; at += options.batch) {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const fragment of redundant.slice(at, at + options.batch)) {
          const changed = Number(remove.run(session.id, fragment.sequence).changes)
          result.deleted += changed
          if (changed) result.freedBytes += fragment.bytes
        }
        db.exec('COMMIT')
      } catch (reason) { db.exec('ROLLBACK'); throw reason }
      sleep(options.pauseMs)
    }
    if (through > session.through) save.run(session.id, through)
    if (redundant.length || through > session.through) result.conversations++
  }
  result.ms = Date.now() - started
  return result
}

/** The worker's whole program: opens its own connection and runs {@link compactJournal} once. */
export function compactionWorkerSource(): string {
  return `
const { DatabaseSync } = require('node:sqlite')
const { parentPort, workerData } = require('node:worker_threads')
const compactJournal = ${compactJournal.toString()}
const pause = new Int32Array(new SharedArrayBuffer(4))
const db = new DatabaseSync(workerData.path)
try {
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;')
  parentPort.postMessage({ result: compactJournal(db, workerData.options, ms => { if (ms > 0) Atomics.wait(pause, 0, 0, ms) }) })
} catch (error) {
  parentPort.postMessage({ error: String(error && error.stack || error) })
} finally { db.close() }
`
}

/** Runs one compaction in a worker thread; resolves with what it removed. */
export function runJournalCompaction(path: string, options: JournalCompactionOptions): Promise<JournalCompactionResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(compactionWorkerSource(), { eval: true, workerData: { path, options } })
    let settled = false
    worker.once('message', (message: { result?: JournalCompactionResult; error?: string }) => {
      settled = true
      if (message.result) resolve(message.result)
      else reject(new Error(message.error ?? 'Journal compaction failed'))
    })
    worker.once('error', error => { settled = true; reject(error) })
    worker.once('exit', code => { if (!settled) reject(new Error(`Journal compaction worker exited with ${code}`)) })
  })
}

export const COMPACTION_DEFAULTS: Omit<JournalCompactionOptions, 'now'> = { settleMs: 60 * 60_000, chunk: 1000, batch: 200, pauseMs: 15 }

/** Compacts the journal a few minutes after launch and then daily, one run at a time. The returned
 *  function stops further runs (a run in flight finishes its current conversation's batch). */
export function startJournalCompaction(path: string, log: (message: string) => void = console.log, firstDelayMs = 5 * 60_000, everyMs = 24 * 60 * 60_000): () => void {
  let timer: NodeJS.Timeout | undefined, stopped = false
  const run = (): void => {
    if (stopped) return
    void runJournalCompaction(path, { ...COMPACTION_DEFAULTS, now: Date.now() })
      .then(result => { if (result.deleted) log(`Journal compaction removed ${result.deleted} superseded tool-input fragments (${Math.round(result.freedBytes / 1048576)} MB of event JSON) from ${result.conversations} conversations after reading ${result.scanned} rows in ${Math.round(result.ms / 1000)} s`) })
      .catch(error => console.warn('Journal compaction failed; the next run retries it', error))
      .finally(() => { if (!stopped) { timer = setTimeout(run, everyMs); timer.unref?.() } })
  }
  timer = setTimeout(run, firstDelayMs)
  timer.unref?.()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
