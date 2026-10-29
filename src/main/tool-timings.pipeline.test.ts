import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { maskSecrets } from './structured-store'
import { ToolTimingRecorder } from './tool-timings'
import type { AgentSpec } from '../shared/models'
import type { ProviderCapabilities } from '../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'

const dispose: Array<() => void> = []
afterEach(() => { for (const step of dispose.splice(0).reverse()) step(); vi.unstubAllEnvs() })

/** The recorder behind the real staging path: envelopes, sequence and the observer AgentManager wires. */
describe('tool timings through StructuredSessions', () => {
  it('times each call a provider reports, with wait, provider exec and masked failures', async () => {
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0'); vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
    const root = mkdtempSync(join(tmpdir(), 'tool-timings-pipeline-'))
    dispose.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    const database = new ConductorDatabase(join(root, 'conductor.db'))
    dispose.push(() => database.close())
    const project = database.upsertProject(join(root), 'Timing project'), workspace = database.listSessions(project.id)[0]!
    let clock = 0
    const recorder = new ToolTimingRecorder({ now: () => clock, mask: maskSecrets })
    let emit: AdapterOptions['emit'] = () => {}
    const sessions = new StructuredSessions(database, () => 'synthetic-provider', vi.fn(), (provider, options): ProviderAdapter => {
      emit = options.emit
      const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: ['default'], sandboxModes: ['inherit'], effort: ['low'], models: [{ id: 'codex-synthetic', label: 'Synthetic', effort: ['low'], defaultEffort: 'low' }], limitations: ['Zero inference fixture'] }
      return { provider, capabilities, start: async () => { options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-1' } }) },
        submit: async () => { options.emit({ data: { type: 'session', phase: 'running' } }) }, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
    }, undefined, (spec, event) => recorder.observe(event, spec.model))
    dispose.push(() => sessions.dispose())
    const spec: AgentSpec = { id: 'worker', projectId: project.id, sessionId: workspace.id, cwd: root, provider: 'codex', title: 'Worker', model: 'codex-synthetic' }
    sessions.ensure(spec)
    await sessions.submit(spec.id, 'go', database.structured.snapshot(spec.id)!.settings)
    const token = 'a'.repeat(40)
    emit({ itemId: 'cmd-1', data: { type: 'tool', name: 'PowerShell', status: 'running', input: { command: `pwsh -c "npm test" --token ${token}`, cwd: root } } })
    clock += 50
    emit({ itemId: 'cmd-1', data: { type: 'tool', name: 'PowerShell', status: 'awaiting_approval' } })
    clock += 8000
    emit({ itemId: 'cmd-1', data: { type: 'tool', name: 'PowerShell', status: 'running' } })
    clock += 1500
    emit({ itemId: 'cmd-1', data: { type: 'tool', name: 'PowerShell', status: 'completed', exitCode: 0, durationMs: 1430, output: 'ok' } })
    emit({ itemId: 'cmd-2', data: { type: 'tool', name: 'PowerShell', status: 'failed', exitCode: 1, durationMs: 12, input: { command: 'git push' }, output: 'remote: Bearer ghp_abcdefghijklmnopqrstuvwxyz denied\nfatal: Authentication failed' } })
    emit({ itemId: 'cmd-2', data: { type: 'tool', name: 'PowerShell', status: 'failed', exitCode: 1, durationMs: 12 } })
    emit({ data: { type: 'session', phase: 'completed' } })

    const report = recorder.report({ recent: 10, projectId: project.id })
    expect(report.totals).toMatchObject({ calls: 2, failures: 1, inFlight: 0 })
    const [failed, ran] = report.recent
    expect(ran).toMatchObject({ provider: 'codex', model: 'codex-synthetic', projectId: project.id, agentSessionId: 'worker', elapsedMs: 9550, waitMs: 8000, waitSource: 'observed-approval', execMs: 1430, execSource: 'provider', outcome: 'completed' })
    expect(ran!.args).toBe('pwsh -c "npm test" --token [REDACTED]')
    expect(failed).toMatchObject({ elapsedMs: null, elapsedSource: 'unavailable', execMs: 12, exitCode: 1, restated: 1 })
    expect(failed!.error).not.toContain('ghp_')
    expect(report.coverage).toEqual(expect.objectContaining({ elapsed: 0.5, wait: 0.5, exec: 1 }))
    expect(recorder.report({ projectId: 'another-project' }).totals.calls).toBe(0)
  })
})
