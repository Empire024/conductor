import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ContextAttachment, SessionProjection } from '../shared/structured-agent'
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

const remoteSnapshot = (): SessionProjection => ({
  sessionId: 'their-session', runtimeId: 'their-runtime', phase: 'idle', sequence: 0, items: [],
  nativeSessionId: 'native-on-desktop', title: 'Remote conversation', archived: false, truncated: false,
  settings: { model: 'model-a', effort: 'high', permission: 'default', plan: false },
  capabilities: {
    provider: 'claude', runtimeVersion: 'remote-fixture', adapterVersion: 1, authentication: 'cli',
    textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true,
    approvals: true, questions: true, resume: true, fork: true, plans: true,
    effort: ['high'], models: [{ id: 'model-a', label: 'Model A' }], limitations: []
  }
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

  it('mounts a stale-layout tab from durable remote identity without contacting or starting anything locally', () => {
    const f = fixture(() => { throw new Error('mount must not contact the host') })
    f.mirror.bind(binding({ cwd: 'D:/host/project' }))

    // A restored legacy layout has no machineId and PaneWorkspace supplies the controller cwd.
    // Neither is allowed to rebind or locally validate the remotely-owned structured session.
    expect(f.mirror.mount({
      id: 'local-session', projectId: 'project', sessionId: 'workspace', provider: 'claude',
      title: 'Restored tab', cwd: 'C:/controller/project'
    })).toEqual({
      id: 'local-session', available: true, status: 'exited', transcript: '', model: 'default'
    })
    expect(f.asked).toEqual([])
    expect(f.store.spec<{ cwd: string; machineId?: string }>('local-session')).toMatchObject({
      cwd: 'D:/host/project', machineId: 'desktop'
    })
  })

  it('rejects mount metadata that tries to change a retained remote identity', () => {
    const f = fixture(() => [])
    f.mirror.bind(binding())
    const requested = {
      id: 'local-session', projectId: 'project', sessionId: 'workspace', provider: 'claude' as const,
      title: 'Restored tab', cwd: 'C:/controller/project'
    }
    expect(() => f.mirror.mount({ ...requested, projectId: 'other-project' })).toThrow(/does not match.*identity/)
    expect(() => f.mirror.mount({ ...requested, sessionId: 'other-workspace' })).toThrow(/does not match.*identity/)
    expect(() => f.mirror.mount({ ...requested, provider: 'codex' })).toThrow(/does not match.*identity/)
    expect(() => f.mirror.mount({ ...requested, machineId: 'other-machine' })).toThrow(/does not own/)
    expect(f.asked).toEqual([])
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

  it('keeps immutable remote ownership after release and restart so retained history stays read-only', async () => {
    const f = fixture(() => [])
    f.mirror.bind(binding())
    f.mirror.release('local-session')
    expect(f.mirror.list()).toEqual([])
    expect(f.mirror.isRemote('local-session')).toBe(true)
    expect(f.mirror.fileContext('local-session')).toEqual({ machineId: 'desktop', cwd: '/local/project' })
    await expect(f.mirror.submit('local-session', 'must not run locally')).rejects.toThrow(/pairing is no longer active/)

    const restarted = new RemoteSessionMirror({ database: f.database, call: async () => [], publish: () => {} })
    expect(restarted.isRemote('local-session')).toBe(true)
    expect(restarted.fileContext('local-session')).toEqual({ machineId: 'desktop', cwd: '/local/project' })
    expect(restarted.mount({
      id: 'local-session', projectId: 'project', sessionId: 'workspace', provider: 'claude',
      title: 'Retained history', cwd: 'C:/controller/project'
    })).toMatchObject({ available: true, status: 'exited', message: expect.stringMatching(/read-only/) })
    expect(() => restarted.bindWorkspace('local-session', 'workspace')).not.toThrow()
    expect(() => restarted.bindWorkspace('local-session', 'different-workspace')).toThrow(/pairing is no longer active|not supported/)
    await expect(restarted.submit('local-session', 'still must not run locally')).rejects.toThrow(/pairing is no longer active/)
  })

  it('accepts only an idempotent workspace bind for an active remote conversation', () => {
    const f = fixture(() => [])
    f.mirror.bind(binding())
    expect(() => f.mirror.bindWorkspace('local-session', 'workspace')).not.toThrow()
    expect(() => f.mirror.bindWorkspace('local-session', 'different-workspace')).toThrow(/not supported.*another machine/)
    expect(f.mirror.get('local-session')).toMatchObject({ workspaceId: 'workspace', machineId: 'desktop' })
  })

  it('drops a late history reply when the session was rebound while the pull was in flight', async () => {
    const oldHistory = deferred<AgentEvent[]>()
    let historyCalls = 0
    const f = fixture(method => method === 'agents.history' && historyCalls++ === 0 ? oldHistory.promise : [])
    f.mirror.bind(binding())
    const oldPull = f.mirror.pull('local-session')
    f.mirror.bind(binding({ remoteSessionId: 'replacement-workspace', remoteAgentSessionId: 'replacement-session' }))
    oldHistory.resolve([remoteEvent(1, 'stale')])

    await expect(oldPull).resolves.toEqual([])
    expect(f.mirror.get('local-session')).toMatchObject({
      remoteSessionId: 'replacement-workspace', remoteAgentSessionId: 'replacement-session', remoteSequence: 0
    })
    expect(f.store.snapshot('local-session')?.sequence).toBe(0)
    expect(f.published).toEqual([])
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

  it('mounts provider metadata from the remote snapshot without constructing a local runtime', async () => {
    const f = fixture(method => method === 'agents.snapshot' ? remoteSnapshot() : [])
    f.mirror.bind(binding())
    await f.mirror.connect('local-session')
    expect(f.asked.map(call => call.method)).toEqual(['agents.history', 'agents.snapshot'])
    expect(f.store.snapshot('local-session')).toMatchObject({
      phase: 'idle', nativeSessionId: 'native-on-desktop',
      capabilities: { provider: 'claude', runtimeVersion: 'remote-fixture' },
      settings: { model: 'model-a', effort: 'high' }
    })
    expect(f.published.at(-1)).toMatchObject({ channel: 'structured:events' })
  })

  it('lets only the latest concurrent metadata reply update a mounted pane', async () => {
    const firstSnapshot = deferred<SessionProjection>()
    const firstSnapshotStarted = deferred<void>()
    let snapshotCalls = 0
    const f = fixture(method => {
      if (method === 'agents.history') return []
      if (method !== 'agents.snapshot') return []
      snapshotCalls += 1
      if (snapshotCalls === 1) {
        firstSnapshotStarted.resolve()
        return firstSnapshot.promise
      }
      return { ...remoteSnapshot(), title: 'Newest metadata' }
    })
    f.mirror.bind(binding())
    const oldConnect = f.mirror.connect('local-session')
    await firstSnapshotStarted.promise
    await f.mirror.connect('local-session')
    firstSnapshot.resolve({ ...remoteSnapshot(), title: 'Stale metadata' })
    await oldConnect

    expect(f.store.snapshot('local-session')).toMatchObject({ title: 'Newest metadata', sequence: 1 })
    expect(f.published).toHaveLength(1)
  })

  it('does not let metadata requested for an old binding alter its replacement', async () => {
    const oldSnapshot = deferred<SessionProjection>()
    const oldSnapshotStarted = deferred<void>()
    const f = fixture(method => {
      if (method === 'agents.history') return []
      if (method === 'agents.snapshot') {
        oldSnapshotStarted.resolve()
        return oldSnapshot.promise
      }
      return []
    })
    f.mirror.bind(binding())
    const oldConnect = f.mirror.connect('local-session')
    await oldSnapshotStarted.promise
    f.mirror.bind(binding({ remoteSessionId: 'replacement-workspace', remoteAgentSessionId: 'replacement-session' }))
    oldSnapshot.resolve({ ...remoteSnapshot(), title: 'Old binding metadata' })
    await oldConnect

    expect(f.mirror.get('local-session')).toMatchObject({ remoteAgentSessionId: 'replacement-session' })
    expect(f.store.snapshot('local-session')).toMatchObject({ sequence: 0 })
    expect(f.store.snapshot('local-session')?.title).not.toBe('Old binding metadata')
    expect(f.published).toEqual([])
  })

  it('routes the structured lifecycle to the selected host and mirrors the resulting events', async () => {
    const queued = { id: 'queued-1', text: 'later', settings: remoteSnapshot().settings, attachments: [] }
    const f = fixture(method => method === 'agents.cancelQueued' ? queued : method === 'agents.discover' ? { commands: ['remote'] } : [])
    f.mirror.bind(binding())
    const settings = remoteSnapshot().settings
    await f.mirror.queue('local-session', 'later', settings)
    await expect(f.mirror.cancelQueued('local-session', 'queued-1')).resolves.toMatchObject({ id: 'queued-1' })
    await f.mirror.submit('local-session', 'now', 'agents.steer', settings)
    await f.mirror.interrupt('local-session', true)
    await f.mirror.resume('local-session', settings)
    await expect(f.mirror.discover('local-session')).resolves.toEqual({ commands: ['remote'] })
    await f.mirror.saveSettings('local-session', settings)
    await f.mirror.respond({ sessionId: 'local-session', runtimeId: 'their-runtime', requestId: 'approval', decision: 'allow' })
    await f.mirror.rename('local-session', 'Remote title')
    await f.mirror.archive('local-session', true)
    expect(f.asked.map(call => call.method)).toEqual(expect.arrayContaining([
      'agents.queue', 'agents.cancelQueued', 'agents.steer', 'agents.interrupt', 'agents.resume',
      'agents.discover', 'agents.settings', 'agents.respond', 'agents.rename', 'agents.archive'
    ]))
    expect(f.asked.find(call => call.method === 'agents.interrupt')?.args).toMatchObject({ expediteSubmittedInput: true })
    expect(f.asked.find(call => call.method === 'agents.respond')?.args).toMatchObject({ response: { sessionId: 'their-session' } })
    expect(f.store.snapshot('local-session')?.settings).toMatchObject({ model: 'model-a', effort: 'high' })
  })

  it('serializes settings replies so an older mutation cannot overwrite a newer owner choice', async () => {
    const firstSettings = deferred<unknown>()
    const firstSettingsStarted = deferred<void>()
    let settingsCalls = 0
    const f = fixture(method => {
      if (method === 'agents.settings') {
        settingsCalls += 1
        if (settingsCalls === 1) {
          firstSettingsStarted.resolve()
          return firstSettings.promise
        }
      }
      return []
    })
    f.mirror.bind(binding())
    const older = { ...remoteSnapshot().settings, model: 'older-model' }
    const newer = { ...remoteSnapshot().settings, model: 'newer-model' }
    const oldSave = f.mirror.saveSettings('local-session', older)
    await firstSettingsStarted.promise
    const newSave = f.mirror.saveSettings('local-session', newer)
    expect(settingsCalls).toBe(1)
    firstSettings.resolve(undefined)
    await Promise.all([oldSave, newSave])

    expect(settingsCalls).toBe(2)
    expect(f.store.snapshot('local-session')?.settings.model).toBe('newer-model')
  })

  it('rejects a queued settings mutation captured before the session is rebound', async () => {
    const firstSettings = deferred<unknown>()
    const firstSettingsStarted = deferred<void>()
    let settingsCalls = 0
    const f = fixture(method => {
      if (method === 'agents.settings') {
        settingsCalls += 1
        if (settingsCalls === 1) {
          firstSettingsStarted.resolve()
          return firstSettings.promise
        }
      }
      return []
    })
    f.mirror.bind(binding())
    const first = f.mirror.saveSettings('local-session', { ...remoteSnapshot().settings, model: 'old-first' })
    await firstSettingsStarted.promise
    const queued = f.mirror.saveSettings('local-session', { ...remoteSnapshot().settings, model: 'old-queued' })
    f.mirror.bind(binding({ remoteSessionId: 'replacement-workspace', remoteAgentSessionId: 'replacement-session' }))
    firstSettings.resolve(undefined)

    const results = await Promise.allSettled([first, queued])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(results.every(result => result.status === 'rejected' && /binding changed/.test(String(result.reason)))).toBe(true)
    expect(settingsCalls).toBe(1)
    expect(f.mirror.get('local-session')).toMatchObject({ remoteAgentSessionId: 'replacement-session' })
    expect(f.store.snapshot('local-session')?.settings.model).not.toBe('old-first')
    expect(f.store.snapshot('local-session')?.settings.model).not.toBe('old-queued')
  })

  it('maps machine-scoped file attachments to the exact host project and refuses controller bytes or paths', async () => {
    const f = fixture(() => [])
    f.mirror.bind(binding())
    await f.mirror.submit('local-session', 'inspect it', 'agents.submit', remoteSnapshot().settings, [{
      id: 'file-1', kind: 'file', name: 'notes.md',
      remoteFile: { machineId: 'desktop', projectId: 'project', path: 'notes.md' }
    } as ContextAttachment])
    expect(f.asked.find(call => call.method === 'agents.submit')?.args).toMatchObject({ attachments: [{
      id: 'file-1', kind: 'file', name: 'notes.md',
      remoteFile: { machineId: 'desktop', projectId: 'their-project', path: 'notes.md' }
    }] })
    await expect(f.mirror.submit('local-session', 'wrong machine', 'agents.submit', remoteSnapshot().settings, [{
      id: 'file-2', kind: 'file', name: 'notes.md',
      remoteFile: { machineId: 'controller', projectId: 'project', path: 'notes.md' }
    } as ContextAttachment])).rejects.toThrow(/confirmed host project/)
    await expect(f.mirror.submit('local-session', 'controller path', 'agents.submit', remoteSnapshot().settings, [
      { id: 'file-3', kind: 'file', name: 'notes.md', path: 'C:/controller/notes.md' }
    ])).rejects.toThrow(/controller paths and content are refused/)
    await expect(f.mirror.submit('local-session', 'controller bytes', 'agents.submit', remoteSnapshot().settings, [{
      id: 'file-4', kind: 'file', name: 'notes.md', content: undefined,
      remoteFile: { machineId: 'desktop', projectId: 'project', path: 'notes.md' }
    } as ContextAttachment])).rejects.toThrow(/controller paths and content are refused/)
    expect(() => f.mirror.unsupported('local-session', 'Native CLI handoff')).toThrow(/not supported.*another machine/)
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
    expect(f.mirror.isRemote('local-session')).toBe(true)
    expect(f.mirror.isRemote('other-local')).toBe(true)
  })

  it('ignores stored bindings that lost a field rather than mirroring against a partial address', () => {
    expect(readBindings(undefined)).toEqual([])
    expect(readBindings('not json')).toEqual([])
    expect(readBindings(JSON.stringify([{ localSessionId: 'a', machineId: 'desktop' }]))).toEqual([])
    expect(readBindings(JSON.stringify([{ ...binding(), remoteSequence: -4 }]))).toMatchObject([{ remoteSequence: 0 }])
  })
})
