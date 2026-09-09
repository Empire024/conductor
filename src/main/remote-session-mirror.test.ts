import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../shared/structured-agent'
import type { ConductorDatabase } from './database'
import { RemoteSessionMirror, readBindings, rekeyRemoteEvents, type RemoteSessionBinding } from './remote-session-mirror'
import { StructuredAgentStore } from './structured-store'

const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

const binding = (overrides: Partial<RemoteSessionBinding> = {}): RemoteSessionBinding => ({
  localSessionId: 'local-session', machineId: 'desktop', projectId: 'project', workspaceId: 'workspace',
  provider: 'claude', cwd: '/local/project', remoteProjectId: 'their-project', remoteSessionId: 'their-workspace',
  remoteAgentSessionId: 'their-session', remoteSequence: 0, ...overrides
})

/** A remote event as the other machine journals it: its ids, its sequence. */
const remoteEvent = (sequence: number, text: string): AgentEvent => ({
  schemaVersion: 1, id: `remote-event-${sequence}`, sequence, sessionId: 'their-session', runtimeId: 'their-runtime',
  provider: 'claude', projectId: 'their-project', workspaceId: 'their-workspace', cwd: 'D:/render/project',
  timestamp: new Date(1700000000000 + sequence).toISOString(), data: { type: 'text', role: 'assistant', text, mode: 'snapshot' }
})

function fixture(calls: (method: string, args?: Record<string, unknown>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-mirror-')); roots.push(root)
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY)')
  const store = new StructuredAgentStore(db, root)
  const settings = new Map<string, string>()
  const published: Array<{ channel: string; payload: unknown }> = []
  const database = {
    structured: store,
    getSetting: (key: string) => settings.get(key) ?? '',
    setSetting: (key: string, value: string) => { settings.set(key, value) },
    upsertAgent: (spec: { id: string }) => { db.prepare('INSERT OR IGNORE INTO agent_sessions(id) VALUES(?)').run(spec.id); return spec.id }
  } as unknown as ConductorDatabase
  const asked: Array<{ machineId: string; method: string; args?: Record<string, unknown> }> = []
  const mirror = new RemoteSessionMirror({
    database,
    call: async (machineId, method, args) => { asked.push({ machineId, method, args }); return calls(method, args) },
    publish: (channel, payload) => { published.push({ channel, payload }) }
  })
  return { mirror, store, settings, published, asked, database }
}

describe('mirroring a conversation that runs on another machine', () => {
  it('renumbers a remote transcript onto the local journal without carrying the remote sequence across', () => {
    // The local session is already three events in; the remote one starts at 1. Carrying the
    // remote numbers across would collide, so they are renumbered from the local sequence.
    const { events, remoteSequence } = rekeyRemoteEvents([remoteEvent(1, 'one'), remoteEvent(2, 'two')], binding(), 3)
    expect(events.map(event => event.sequence)).toEqual([4, 5])
    expect(events.map(event => event.sessionId)).toEqual(['local-session', 'local-session'])
    expect(events.map(event => event.projectId)).toEqual(['project', 'project'])
    // The remote high-water mark stays in the remote's own numbering, so the next poll resumes there.
    expect(remoteSequence).toBe(2)
  })

  it('drops events already copied, so an overlapping re-poll cannot duplicate the transcript', () => {
    const { events, remoteSequence } = rekeyRemoteEvents(
      [remoteEvent(1, 'one'), remoteEvent(2, 'two'), remoteEvent(3, 'three')], binding({ remoteSequence: 2 }), 9)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sequence: 10, sessionId: 'local-session' })
    expect(remoteSequence).toBe(3)
  })

  it('orders an out-of-order batch before renumbering it', () => {
    const { events } = rekeyRemoteEvents([remoteEvent(3, 'three'), remoteEvent(1, 'one'), remoteEvent(2, 'two')], binding(), 0)
    expect(events.map(event => (event.data as { text: string }).text)).toEqual(['one', 'two', 'three'])
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3])
  })

  it('registers the local session on bind so the tab opens before the first poll returns', () => {
    const f = fixture(() => [])
    f.mirror.bind(binding())
    expect(f.store.snapshot('local-session')).toBeTruthy()
    expect(f.mirror.isRemote('local-session')).toBe(true)
    expect(f.mirror.isRemote('some-local-tab')).toBe(false)
  })

  it('copies remote events into the local store and tells the renderer over its existing channel', async () => {
    const f = fixture(method => method === 'agents.history' ? [remoteEvent(1, 'rendering'), remoteEvent(2, 'done')] : [])
    f.mirror.bind(binding())
    const appended = await f.mirror.pull('local-session')
    expect(appended).toHaveLength(2)
    expect(f.store.snapshot('local-session')!.sequence).toBe(2)
    expect(f.published.map(entry => entry.channel)).toEqual(['structured:events'])
    // The local store now serves the remote transcript through the ordinary read path.
    expect(f.store.events('local-session', 0)).toHaveLength(2)
  })

  it('asks only for what it has not already copied', async () => {
    const f = fixture(method => method === 'agents.history' ? [remoteEvent(1, 'one')] : [])
    f.mirror.bind(binding())
    await f.mirror.pull('local-session')
    await f.mirror.pull('local-session')
    expect(f.asked.at(-1)!.args).toMatchObject({ afterSequence: 1, agentSessionId: 'their-session' })
    // The second poll returned an event it had already copied, so nothing was appended twice.
    expect(f.store.snapshot('local-session')!.sequence).toBe(1)
  })

  it('survives a restart, resuming the copy where it stopped', async () => {
    const f = fixture(method => method === 'agents.history' ? [remoteEvent(1, 'one')] : [])
    f.mirror.bind(binding())
    await f.mirror.pull('local-session')
    const restarted = new RemoteSessionMirror({
      database: f.database, call: async () => [], publish: () => {}
    })
    expect(restarted.get('local-session')).toMatchObject({ machineId: 'desktop', remoteSequence: 1 })
  })

  it('forwards what the owner types to the machine actually running the conversation', async () => {
    const f = fixture(() => [])
    f.mirror.bind(binding())
    await f.mirror.submit('local-session', 'render frame 200')
    expect(f.asked[0]).toMatchObject({
      machineId: 'desktop',
      method: 'agents.submit',
      args: { prompt: 'render frame 200', agentSessionId: 'their-session', projectId: 'their-project' }
    })
    await f.mirror.interrupt('local-session')
    expect(f.asked.some(call => call.method === 'agents.interrupt')).toBe(true)
  })

  it('refuses to forward a prompt for a session that is not mirrored', async () => {
    const f = fixture(() => [])
    await expect(f.mirror.submit('not-mirrored', 'hello')).rejects.toThrow(/not running on another machine/)
  })

  it('keeps the tab bound when the other machine is unreachable', async () => {
    const f = fixture(() => { throw new Error('offline') })
    f.mirror.bind(binding())
    // A laptop losing the connection must not destroy the owner's view of work still running there.
    await expect(f.mirror.poll()).resolves.toBeUndefined()
    expect(f.mirror.isRemote('local-session')).toBe(true)
  })

  it('releases every tab bound to a machine the owner revoked', () => {
    const f = fixture(() => [])
    f.mirror.bind(binding())
    f.mirror.bind(binding({ localSessionId: 'other-local', remoteAgentSessionId: 'other-remote' }))
    f.mirror.bind(binding({ localSessionId: 'laptop-local', machineId: 'laptop' }))
    f.mirror.releaseMachine('desktop')
    expect(f.mirror.list().map(entry => entry.localSessionId)).toEqual(['laptop-local'])
  })

  it('ignores stored bindings that lost a field rather than mirroring against a partial address', () => {
    expect(readBindings(undefined)).toEqual([])
    expect(readBindings('not json')).toEqual([])
    expect(readBindings(JSON.stringify([{ localSessionId: 'a', machineId: 'desktop' }]))).toEqual([])
    expect(readBindings(JSON.stringify([{ ...binding(), remoteSequence: -4 }]))).toMatchObject([{ remoteSequence: 0 }])
  })
})
