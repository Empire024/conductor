import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../shared/structured-agent'
import type { ConductorDatabase } from './database'
import { RemoteSessionMirror, type RemoteSessionBinding } from './remote-session-mirror'
import { StructuredAgentStore } from './structured-store'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })
const binding: RemoteSessionBinding = {
  localSessionId: 'controller-copy', machineId: 'render-pc', projectId: 'project', workspaceId: 'workspace',
  provider: 'codex', cwd: 'C:/project', remoteProjectId: 'host-project', remoteSessionId: 'host-workspace',
  remoteAgentSessionId: 'host-agent', remoteSequence: 0
}
function fixture(call: () => Promise<unknown> = async () => []) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-mirror-boundary-'))
  const db = new DatabaseSync(':memory:')
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
  db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY)')
  const structured = new StructuredAgentStore(db, root)
  const settings = new Map<string, string>()
  const database = {
    structured,
    getSetting: (key: string) => settings.get(key) ?? '',
    setSetting: (key: string, value: string) => { settings.set(key, value) },
    upsertAgent: (spec: { id: string }) => db.prepare('INSERT OR IGNORE INTO agent_sessions(id) VALUES(?)').run(spec.id)
  } as unknown as ConductorDatabase
  const deps = { database, call, publish: () => {} }
  const mirror = new RemoteSessionMirror(deps)
  mirror.bind(binding)
  return { mirror, structured, restart: () => new RemoteSessionMirror(deps) }
}

describe('remote machine ownership remains fail-closed after disconnection', () => {
  it('forgetting a machine cannot route its retained conversation into a local provider', () => {
    const f = fixture()
    f.mirror.releaseMachine('render-pc')
    expect(f.mirror.isRemote('controller-copy')).toBe(true)
    expect(f.restart().isRemote('controller-copy')).toBe(true)
  })

  it('releasing a mirror tab cannot convert retained remote history into local execution', () => {
    const f = fixture()
    f.mirror.release('controller-copy')
    expect(f.mirror.isRemote('controller-copy')).toBe(true)
    expect(f.restart().isRemote('controller-copy')).toBe(true)
  })

  it('a pending history reply cannot resurrect a forgotten binding or append after release', async () => {
    let finish!: (value: unknown) => void
    const f = fixture(() => new Promise(resolve => { finish = resolve }))
    const pending = f.mirror.pull('controller-copy')
    f.mirror.releaseMachine('render-pc')
    const event: AgentEvent = {
      schemaVersion: 1, id: 'late-event', sequence: 1, sessionId: 'host-agent', runtimeId: 'host-runtime',
      provider: 'codex', projectId: 'host-project', workspaceId: 'host-workspace', cwd: 'D:/project',
      timestamp: new Date().toISOString(), data: { type: 'text', role: 'assistant', text: 'late result', mode: 'snapshot' }
    }
    finish([event])
    await pending
    expect(f.mirror.list()).toEqual([])
    expect(f.structured.snapshot('controller-copy')?.sequence).toBe(0)
  })
})
