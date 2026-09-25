import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StructuredAgentStore } from './structured-store'
import { ConversationHistory } from './conversation-history'
import { MAX_TIMELINE_ITEMS } from '../shared/structured-agent-reducer'
import type { AgentEvent, AgentEventData } from '../shared/structured-agent'

const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) { try { db.close() } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

/** One conversation whose journal holds `count` single-event messages, appended in one commit. */
function conversation(count: number, data: (index: number) => AgentEventData = index => ({ type: 'text', role: index % 2 ? 'assistant' : 'user', text: `Message ${index}`, mode: 'snapshot' })) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-history-fixture-')); roots.push(root)
  const db = new DatabaseSync(join(root, 'events.sqlite')); databases.push(db)
  db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY)')
  db.prepare('INSERT INTO agent_sessions(id) VALUES(?)').run('chat')
  const store = new StructuredAgentStore(db, root)
  store.register('chat', 'project', 'claude', { provider: 'claude' })
  db.exec('BEGIN')
  for (let index = 1; index <= count; index++) {
    const event: AgentEvent = { schemaVersion: 1, id: 'event-' + index, sequence: index, sessionId: 'chat', runtimeId: 'runtime', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: '2026-09-24T00:00:00.000Z', itemId: 'item-' + index, data: data(index) }
    store.append(event)
  }
  db.exec('COMMIT')
  const reads: Array<[number, number]> = []
  const journalRange = store.journalRange.bind(store)
  store.journalRange = (id, from, to, limit) => { reads.push([from, to]); return journalRange(id, from, to, limit) }
  return { db, store, reads, history: new ConversationHistory(store, async () => {}) }
}
const texts = (items: Array<{ data: AgentEventData }>): string[] => items.map(item => item.data.type === 'text' ? item.data.text : item.data.type)

describe('conversation history beyond the resident projection', () => {
  it('has nothing to add while the resident projection is the whole conversation', async () => {
    const { history, reads, store } = conversation(50)
    expect(await history.page('chat', store.snapshot('chat')!.items[0]!.sequence)).toEqual({ items: [], hasMore: false, unavailable: false })
    expect(await history.search('chat', 'Message 1')).toEqual([])
    expect(reads).toEqual([])
  })

  it('pages older messages out of the journal, newest first, until the start', async () => {
    const { history, store } = conversation(MAX_TIMELINE_ITEMS + 300)
    const resident = store.snapshot('chat')!
    expect(resident.truncated).toBe(true)
    expect(resident.items[0]!.sequence).toBe(301)
    const first = await history.page('chat', 301, 200)
    expect(texts(first.items)).toEqual(Array.from({ length: 200 }, (_, index) => `Message ${index + 101}`))
    expect(first).toMatchObject({ hasMore: true, unavailable: false })
    const second = await history.page('chat', first.items[0]!.sequence, 200)
    expect(texts(second.items)).toEqual(Array.from({ length: 100 }, (_, index) => `Message ${index + 1}`))
    expect(second).toMatchObject({ hasMore: false, unavailable: false })
  })

  it('rebuilds more than the reducer keeps at once without losing the oldest items', async () => {
    const { history, store } = conversation(MAX_TIMELINE_ITEMS + 2500)
    const page = await history.page('chat', store.snapshot('chat')!.items[0]!.sequence, 500)
    expect(page.hasMore).toBe(true)
    const all = []
    for (let before = store.snapshot('chat')!.items[0]!.sequence; ;) {
      const next = await history.page('chat', before, 500)
      all.unshift(...next.items)
      if (!next.hasMore) break
      before = next.items[0]!.sequence
    }
    expect(all).toHaveLength(2500)
    expect(texts(all.slice(0, 2))).toEqual(['Message 1', 'Message 2'])
  })

  it('reads the journal in bounded primary-key ranges and reuses the rebuild', async () => {
    const { history, reads, store } = conversation(MAX_TIMELINE_ITEMS + 2500)
    const boundary = store.snapshot('chat')!.items[0]!.sequence
    await history.page('chat', boundary)
    await history.search('chat', 'Message 7')
    await history.transcript('chat')
    expect(reads.length).toBeGreaterThan(1)
    for (const [from, to] of reads) expect(to - from).toBeLessThanOrEqual(boundary + 400)
    expect(reads.every(([, to]) => to === boundary + 400)).toBe(true)
    expect(new Set(reads.map(([from]) => from)).size).toBe(reads.length)
  })

  it('finds messages that only the journal still holds', async () => {
    const { history } = conversation(MAX_TIMELINE_ITEMS + 300)
    expect(await history.search('chat', 'message 42')).toEqual([{ itemId: expect.any(String), sequence: 42, matches: 1 }])
    // The resident part is the renderer's to search.
    expect(await history.search('chat', 'Message 2250')).toEqual([])
  })

  it('says when older activity is no longer stored', async () => {
    const { db, history, store } = conversation(MAX_TIMELINE_ITEMS + 300)
    db.prepare('DELETE FROM structured_events WHERE session_id=? AND sequence<?').run('chat', 201)
    const page = await history.page('chat', store.snapshot('chat')!.items[0]!.sequence)
    expect(texts(page.items)[0]).toBe('Message 201')
    expect(page).toMatchObject({ hasMore: false, unavailable: true })
    const transcript = await history.transcript('chat')
    expect(transcript.olderUnavailable).toBe(true)
    expect(transcript.markdown).toContain('200 earlier events are no longer stored')
  })

  /** One conversation's events appended and checkpointed the way production actually drives
   *  `StructuredAgentStore`: `checkpoint` after each batch, so the durable transcript archive
   *  (`structured_transcript_archive*`) grows the way `trimJournal` grows it, not by deleting
   *  the journal directly the way the fixture above does. */
  function seedWithCheckpoints(total: number, chunk: number) {
    const root = mkdtempSync(join(tmpdir(), 'conductor-history-archive-')); roots.push(root)
    const db = new DatabaseSync(join(root, 'events.sqlite')); databases.push(db)
    db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO agent_sessions(id) VALUES(?)').run('chat')
    const store = new StructuredAgentStore(db, root)
    store.register('chat', 'project', 'claude', { provider: 'claude' })
    const event = (index: number): AgentEvent => ({ schemaVersion: 1, id: 'event-' + index, sequence: index, sessionId: 'chat', runtimeId: 'runtime', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: '2026-09-24T00:00:00.000Z', itemId: 'item-' + index, data: { type: 'text', role: index % 2 ? 'assistant' : 'user', text: `Message ${index}`, mode: 'snapshot' } })
    for (let start = 1; start <= total; start += chunk) {
      db.exec('BEGIN')
      for (let index = start; index < start + chunk && index <= total; index++) store.append(event(index))
      db.exec('COMMIT')
      store.checkpoint('chat')
    }
    return { db, store, event }
  }

  it('archives what falls out of the journal, so Copy transcript still starts at the first prompt beyond sequence 20,000', async () => {
    const total = 24_000
    const { store } = seedWithCheckpoints(total, 2_000)
    const history = new ConversationHistory(store, async () => {})
    const transcript = await history.transcript('chat')
    expect(transcript.olderUnavailable).toBe(false)
    expect(transcript.messages).toBe(total)
    // No gap and no duplicate: every message from 1 to `total`, in order, exactly once. The title
    // line (`# Message 2`) echoes an early message and is excluded, or it would double-count it.
    const found = [...transcript.markdown.slice(transcript.markdown.indexOf('\n')).matchAll(/Message (\d+)/g)].map(match => Number(match[1]))
    expect(found).toEqual(Array.from({ length: total }, (_, index) => index + 1))
    expect(transcript.markdown).toMatch(/^# Message \d+\n\n## Claude Code\n\nMessage 1\n\n## You\n\nMessage 2/)
    expect(transcript.markdown.trimEnd().endsWith(`Message ${total}`)).toBe(true)
  })

  it('keeps archiving correctly across a restart, and only reports a real gap for history that predates the archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-history-archive-restart-')); roots.push(root)
    const dbPath = join(root, 'events.sqlite')
    let db = new DatabaseSync(dbPath); databases.push(db)
    db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO agent_sessions(id) VALUES(?)').run('chat')
    let store = new StructuredAgentStore(db, root)
    store.register('chat', 'project', 'claude', { provider: 'claude' })
    const event = (index: number): AgentEvent => ({ schemaVersion: 1, id: 'event-' + index, sequence: index, sessionId: 'chat', runtimeId: 'runtime', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: '2026-09-24T00:00:00.000Z', itemId: 'item-' + index, data: { type: 'text', role: index % 2 ? 'assistant' : 'user', text: `Message ${index}`, mode: 'snapshot' } })
    const append = (from: number, to: number): void => { db.exec('BEGIN'); for (let index = from; index <= to; index++) store.append(event(index)); db.exec('COMMIT') }
    append(1, 21_000)
    store.checkpoint('chat') // first trim: archives 1..1000, journal keeps 1001..21000
    db.close()
    db = new DatabaseSync(dbPath); databases.push(db)
    store = new StructuredAgentStore(db, root) // cold rebuild of the archive tail from archived_through=1000
    append(21_001, 24_000)
    store.checkpoint('chat') // second trim: archives up to 4000
    const history = new ConversationHistory(store, async () => {})
    const transcript = await history.transcript('chat')
    expect(transcript.olderUnavailable).toBe(false)
    const found = [...transcript.markdown.slice(transcript.markdown.indexOf('\n')).matchAll(/Message (\d+)/g)].map(match => Number(match[1]))
    expect(found).toEqual(Array.from({ length: 24_000 }, (_, index) => index + 1))
  })

  it('copies the whole stored conversation, journal and resident parts, as Markdown', async () => {
    const { history } = conversation(MAX_TIMELINE_ITEMS + 300, index => index === 5
      ? { type: 'tool', name: 'Bash', input: { command: 'npm test' }, status: 'completed' }
      : { type: 'text', role: index % 2 ? 'assistant' : 'user', text: `Message ${index}`, mode: 'snapshot' })
    const transcript = await history.transcript('chat')
    expect(transcript.olderUnavailable).toBe(false)
    expect(transcript.messages).toBe(MAX_TIMELINE_ITEMS + 299)
    expect(transcript.markdown.startsWith('# Message 2\n\n## Claude Code\n\nMessage 1\n\n## You\n\nMessage 2')).toBe(true)
    expect(transcript.markdown).toContain('## Claude Code\n\n- `Bash` `npm test`\n\n## You\n\nMessage 6')
    expect(transcript.markdown.trimEnd().endsWith('Message 2300')).toBe(true)
  })

  it('marks journal-only interactions and tools as settled history', async () => {
    const { history } = conversation(MAX_TIMELINE_ITEMS + 10, index => index === 1
      ? { type: 'interaction', interaction: { id: 'r', kind: 'approval', title: 'Run it', input: {}, choices: [], status: 'pending' } }
      : index === 2 ? { type: 'tool', name: 'Bash', input: { command: 'sleep 1' }, status: 'running' }
        : { type: 'text', role: 'assistant', text: `Message ${index}`, mode: 'snapshot' })
    const page = await history.page('chat', 11)
    expect(page.items[0]!.data).toMatchObject({ type: 'interaction', interaction: { status: 'expired' } })
    expect(page.items[1]!.data).toMatchObject({ type: 'tool', status: 'interrupted' })
  })
})
