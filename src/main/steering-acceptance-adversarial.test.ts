import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { ProviderCapabilities } from '../shared/structured-agent'

describe('native assignment acknowledgement liveness', () => {
  it('rejects a timed-out acceptance even while the transport call remains pending', async () => {
    vi.useFakeTimers()
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
    const root = mkdtempSync(join(tmpdir(), 'conductor-ack-review-'))
    const database = new ConductorDatabase(join(root, 'state.db'))
    const project = database.upsertProject(root, 'Ack review')
    const workspace = database.listSessions(project.id)[0]!
    let release!: () => void
    const transport = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: true, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: false, plans: true, permissions: ['default'], effort: [], models: [], limitations: [] }
    const factory = (_provider: unknown, options: AdapterOptions): ProviderAdapter => ({
      provider: 'claude', capabilities,
      async start() { options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-ack-review' } }) },
      async submit() {},
      async steer() { entered = true; await transport },
      async respond() {},
      async interrupt() {},
      dispose() {}
    })
    const manager = new StructuredSessions(database, () => 'unused', () => {}, factory)
    const spec = { id: 'agent-ack-review', projectId: project.id, sessionId: workspace.id, provider: 'claude' as const, title: 'Ack review', cwd: root }
    const settings = { permission: 'default' as const, plan: false }
    let pending: Promise<unknown> | undefined
    let outcome = 'pending'
    try {
      manager.ensure(spec)
      await manager.submit(spec.id, 'Original', settings)
      pending = manager.steerAccepted(spec.id, 'New assignment', settings).then(() => { outcome = 'accepted' }, () => { outcome = 'rejected' })
      await vi.waitFor(() => expect(entered).toBe(true))
      await vi.advanceTimersByTimeAsync(30_001)
      expect(outcome).toBe('rejected')
      expect(database.structured.snapshot(spec.id)?.pendingSteering).toMatchObject([{ text: 'New assignment', status: 'uncertain' }])
    } finally {
      release()
      await pending
      manager.dispose()
      database.close()
      vi.useRealTimers()
      vi.unstubAllEnvs()
      const actual = realpathSync(root)
      expect(actual.toLowerCase().startsWith(join(realpathSync(tmpdir()), 'conductor-ack-review-').toLowerCase())).toBe(true)
      rmSync(actual, { recursive: true, force: true })
    }
  })
})
