import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { ProviderCapabilities } from '../shared/structured-agent'

describe('independent durable remote prompt review', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('rejects revoked provenance before reconnecting an existing native conversation', async () => {
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
    const root = mkdtempSync(join(tmpdir(), 'conductor-dispatch-review-'))
    const database = new ConductorDatabase(join(root, 'state.db'))
    const project = database.upsertProject(root, 'Dispatch boundary')
    const workspace = database.listSessions(project.id)[0]!
    let starts = 0, submissions = 0
    const capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'fixture', adapterVersion: 1,
      authentication: 'cli', steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false,
      approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: ['default'], effort: [], models: [], limitations: [] }
    const factory = (_provider: unknown, options: AdapterOptions): ProviderAdapter => ({
      provider: 'claude', capabilities,
      async start() { starts++; options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'retained-native' } }) },
      async submit() { submissions++ }, async respond() {}, async interrupt() {}, dispose() {}
    })
    const manager = new StructuredSessions(database, () => 'unused', () => {}, factory)
    const spec = { id: 'retained-remote-agent', projectId: project.id, sessionId: workspace.id, provider: 'claude' as const, title: 'Remote', cwd: root }
    try {
      manager.ensure(spec)
      const state = database.structured.snapshot(spec.id)!
      database.structured.append({ schemaVersion: 1, id: 'disconnected-event', sequence: state.sequence + 1,
        sessionId: spec.id, runtimeId: state.runtimeId, provider: 'claude', projectId: project.id,
        workspaceId: workspace.id, cwd: root, timestamp: new Date().toISOString(),
        data: { type: 'session', phase: 'disconnected', nativeSessionId: 'retained-native' } })
      manager.setPromptDispatchAuthorityGuard(() => { throw new Error('Peer grant was revoked') })
      await expect(manager.submit(spec.id, 'Old remote instruction', { permission: 'default', plan: false }, [], {
        agentSessionId: 'remote-peer', label: 'Remote peer', authority: { kind: 'remote-peer', peerId: 'revoked-peer', projectId: project.id }
      })).rejects.toThrow('Peer grant was revoked')
      expect(submissions).toBe(0)
      expect(starts).toBe(0)
    } finally {
      manager.dispose(); database.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
