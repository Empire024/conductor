import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StructuredAgentStore, messageSnippet, searchableMessage } from './structured-store'
import type { AgentEvent, AgentEventData, StructuredProvider } from '../shared/structured-agent'

const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) { try { db.close() } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

function fixture(sessions: string[], provider: StructuredProvider = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'conductor-find-fixture-')); roots.push(root)
  const db = new DatabaseSync(join(root, 'events.sqlite')); databases.push(db)
  db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY)')
  for (const id of sessions) db.prepare('INSERT INTO agent_sessions(id) VALUES(?)').run(id)
  const store = new StructuredAgentStore(db, root)
  for (const id of sessions) store.register(id, 'project', provider, {})
  const sequences = new Map<string, number>()
  const emit = (sessionId: string, data: AgentEventData): AgentEvent => {
    const sequence = (sequences.get(sessionId) ?? 0) + 1
    sequences.set(sessionId, sequence)
    const event: AgentEvent = { schemaVersion: 1, id: `${sessionId}-${sequence}`, sequence, sessionId, runtimeId: 'runtime', provider, projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: '2026-09-10T00:00:00.000Z', data }
    return store.append(event)
  }
  return { store, emit }
}
const text = (role: 'user' | 'assistant' | 'status', body: string): AgentEventData => ({ type: 'text', role, text: body, mode: 'snapshot' })

describe('workspace-wide message search', () => {
  it('finds message text case-insensitively across conversations and ignores tool internals', () => {
    const { store, emit } = fixture(['alpha', 'beta'])
    emit('alpha', text('user', 'Please review the RETRY BUDGET before shipping.'))
    emit('alpha', text('assistant', 'The retry budget is already capped.'))
    emit('alpha', { type: 'tool', name: 'Bash', description: 'retry budget diagnostics', input: { command: 'retry budget --dump' }, status: 'completed', output: 'retry budget = 4' })
    emit('beta', text('user', 'Unrelated work in the second conversation.'))
    const result = store.searchMessages('project', 'retry budget')
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ sessionId: 'alpha', messages: 2, archived: false, provider: 'claude' })
    expect(result.groups[0]!.hits.map(hit => hit.role)).toEqual(['user', 'assistant'])
    // A blunt stringify of the projection would also match the tool call, its input and its output.
    expect(result.groups[0]!.messages).toBe(2)
    expect(store.searchMessages('project', 'RETRY BUDGET').groups[0]!.messages).toBe(2)
    expect(store.searchMessages('project', '--dump').groups).toEqual([])
    expect(searchableMessage({ id: 'x', runtimeId: 'r', sequence: 1, timestamp: '', data: { type: 'tool', name: 'Bash', status: 'completed' } })).toBeNull()
  })
  it('reports every match but returns bounded hits, and excludes the conversation already open', () => {
    const { store, emit } = fixture(['alpha', 'beta'])
    for (let index = 1; index <= 9; index++) emit('alpha', text('assistant', `Checkpoint ${index}: the marker is here.`))
    emit('beta', text('user', 'The marker is in beta too.'))
    const all = store.searchMessages('project', 'marker')
    expect(all.groups.map(group => group.sessionId)).toEqual(['beta', 'alpha'])
    expect(all.groups.find(group => group.sessionId === 'alpha')).toMatchObject({ messages: 9 })
    expect(all.groups.find(group => group.sessionId === 'alpha')!.hits).toHaveLength(5)
    expect(all.truncated).toBe(false)
    const excluded = store.searchMessages('project', 'marker', 'alpha')
    expect(excluded.groups.map(group => group.sessionId)).toEqual(['beta'])
  })
  it('counts repeated occurrences inside one message and caps the conversation list', () => {
    const ids = Array.from({ length: 22 }, (_, index) => 'session-' + index)
    const { store, emit } = fixture(ids)
    for (const id of ids) emit(id, text('user', 'echo echo echo'))
    const result = store.searchMessages('project', 'echo')
    expect(result.groups).toHaveLength(20)
    expect(result.truncated).toBe(true)
    expect(result.groups[0]!.hits[0]!.matches).toBe(3)
    expect(store.searchMessages('project', 'e').groups).toEqual([])
    expect(store.searchMessages('project', '  ').groups).toEqual([])
  })
  it('returns a flattened snippet whose reported offset still addresses the match', () => {
    const { store, emit } = fixture(['alpha'])
    const body = 'A'.repeat(200) + '\n\tneedle here\n' + 'B'.repeat(200)
    emit('alpha', text('assistant', body))
    const hit = store.searchMessages('project', 'NEEDLE').groups[0]!.hits[0]!
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe('needle')
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
    expect(hit.snippet).not.toMatch(/[\n\t]/)
    const short = messageSnippet('one needle two', 4, 6)
    expect(short).toEqual({ snippet: 'one needle two', matchStart: 4 })
    expect(messageSnippet('x'.repeat(50) + 'hit', 50, 3, 10).snippet).toBe('…' + 'x'.repeat(10) + 'hit')
  })
})
