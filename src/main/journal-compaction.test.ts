import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StructuredAgentStore } from './structured-store'
import { compactJournal, runJournalCompaction, type JournalCompactionOptions } from './journal-compaction'
import type { AgentEvent, AgentEventData, Json } from '../shared/structured-agent'

const roots: string[] = [], dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) try { db.close() } catch { /* fixture teardown */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

const HOUR = 60 * 60_000
const now = Date.parse('2026-10-22T12:00:00.000Z')
const options: JournalCompactionOptions = { now, settleMs: HOUR, chunk: 7, batch: 3, pauseMs: 0 }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conductor-compaction-')); roots.push(root)
  const path = join(root, 'conductor.db')
  const db = new DatabaseSync(path); dbs.push(db)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE agent_sessions (id TEXT PRIMARY KEY)`)
  db.exec(`INSERT INTO agent_sessions(id) VALUES ('a'), ('b')`)
  const store = new StructuredAgentStore(db, root)
  store.register('a', 'p', 'claude', {})
  store.register('b', 'p', 'claude', {})
  const sequences = new Map<string, number>()
  const write = (id: string, data: AgentEventData, at: number, extra: Partial<AgentEvent> = {}): number => {
    const sequence = (sequences.get(id) ?? 0) + 1
    sequences.set(id, sequence)
    const event = { schemaVersion: 1, id: `${id}-${sequence}`, sequence, sessionId: id, runtimeId: 'r', provider: 'claude', projectId: 'p', workspaceId: 'w', cwd: 'C:/x', timestamp: new Date(at).toISOString(), data, ...extra } as AgentEvent
    db.prepare('INSERT INTO structured_events(session_id,sequence,event_json) VALUES(?,?,?)').run(id, sequence, JSON.stringify(event))
    return sequence
  }
  const tool = (id: string, item: string, at: number, fragments: string[], full: boolean, extra: Partial<AgentEvent> = {}) => {
    const input = (full ? JSON.parse(fragments.join('')) : {}) as Json
    const opened = write(id, { type: 'tool', name: 'Write', input: {}, status: 'preparing' }, at, { itemId: item, ...extra })
    const streamed = fragments.map(fragment => write(id, { type: 'tool', name: 'Write', status: 'preparing', inputDelta: fragment }, at, { itemId: item, ...extra }))
    if (full) { write(id, { type: 'tool', name: 'Write', status: 'preparing', input }, at, { itemId: item, ...extra }); write(id, { type: 'tool', name: 'Write', status: 'completed', input, output: 'ok' }, at, { itemId: item, ...extra }) }
    return { opened, streamed }
  }
  const sequencesOf = (id: string): number[] => (db.prepare('SELECT sequence FROM structured_events WHERE session_id=? ORDER BY sequence').all(id) as Array<{ sequence: number }>).map(row => row.sequence)
  return { db, path, store, write, tool, sequencesOf }
}

describe('journal compaction removes only superseded tool-input fragments', () => {
  it('removes the fragments of a tool whose full input was journaled, and keeps everything else', () => {
    const { db, write, tool, sequencesOf } = fixture()
    const old = now - 3 * HOUR
    write('a', { type: 'text', role: 'user', text: 'go', mode: 'snapshot' }, old)
    const done = tool('a', 'toolu_done', old, ['{"file', '_path": "x"', ', "content": "y"}'], true)
    const interrupted = tool('a', 'toolu_cut', old, ['{"file', '_pa'], false)
    const framed = tool('a', 'toolu_framed', old, ['{"a"', ': 1}'], true, { native: { method: 'raw' } })
    const fresh = tool('a', 'toolu_fresh', now - 60_000, ['{"b"', ': 2}'], true)
    const before = sequencesOf('a')
    const result = compactJournal(db, options, () => undefined)
    const after = sequencesOf('a')
    expect(before.filter(sequence => !after.includes(sequence))).toEqual(done.streamed)
    for (const sequence of [done.opened, ...interrupted.streamed, ...framed.streamed, ...fresh.streamed]) expect(after).toContain(sequence)
    expect(result.deleted).toBe(3)
    // A second run reads only what is new since and removes nothing more.
    const again = compactJournal(db, options, () => undefined)
    expect(again.deleted).toBe(0)
    expect(again.scanned).toBeLessThan(result.scanned)
    // Once the fresh tool has settled, its fragments go too.
    const later = compactJournal(db, { ...options, now: now + 2 * HOUR }, () => undefined)
    expect(later.deleted).toBe(2)
    expect(sequencesOf('a')).not.toContain(fresh.streamed[0])
  })
  it('never removes the journal floor, and a projection rebuilt from the compacted journal is unchanged', () => {
    const { db, store, write, tool, sequencesOf } = fixture()
    const old = now - 3 * HOUR
    // The window already cut into this tool: its first remaining row is a fragment.
    tool('b', 'toolu_w', old, ['{"x"', ': 1', '}'], true)
    db.prepare('DELETE FROM structured_events WHERE session_id=? AND sequence<?').run('b', 2)
    write('b', { type: 'text', role: 'assistant', text: 'done', mode: 'snapshot' }, old, { itemId: 'm1' })
    tool('b', 'toolu_v', old, ['{"y"', ': [1, 2]}'], true)
    const replay = () => store.events('b').reduce((state, event) => ({ ...state, items: [...state.items.filter(item => item.id !== event.itemId), { id: event.itemId, data: event.data }] }), { items: [] as Array<{ id?: string; data: AgentEventData }> })
    const finalTools = () => (store.events('b')).filter(event => event.data.type === 'tool' && event.data.status === 'completed').map(event => event.data)
    const before = finalTools()
    compactJournal(db, options, () => undefined)
    expect(sequencesOf('b')[0]).toBe(2)
    expect(finalTools()).toEqual(before)
    expect(replay().items.map(item => item.data.type === 'tool' ? item.data.status : 'text')).toEqual(['completed', 'text', 'completed'])
  })
  it('runs in a worker thread against its own connection', async () => {
    const { db, path, tool, sequencesOf } = fixture()
    const done = tool('a', 'toolu_done', now - 3 * HOUR, ['{"a"', ': 1}'], true)
    const result = await runJournalCompaction(path, options)
    expect(result.deleted).toBe(2)
    for (const sequence of done.streamed) expect(sequencesOf('a')).not.toContain(sequence)
    expect((db.prepare('SELECT through FROM structured_journal_compaction WHERE session_id=?').get('a') as { through: number }).through).toBe(done.opened + 4)
  })
})
