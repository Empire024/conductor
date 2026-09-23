import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { AgentSpec } from '../shared/models'
import type { ProviderCapabilities } from '../shared/structured-agent'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.unstubAllEnvs() })

it('wires registered conversation identity through database reopening and expires old runtime closures without submitting', async () => {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-local-checkpoint-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const dbPath = join(root, 'db.sqlite')
  let database = new ConductorDatabase(dbPath)
  const project = database.upsertProject(workspace, 'Local fixture')
  const spec: AgentSpec = { id: 'stable-registered-conversation', projectId: project.id, sessionId: database.listSessions(project.id)[0]!.id, provider: 'local', title: 'Fixture', cwd: workspace }
  const options: AdapterOptions[] = []
  const submit = vi.fn(async () => {})
  const capabilities: ProviderCapabilities = { provider: 'local', runtimeVersion: 'fixture', adapterVersion: 1, authentication: 'api', textStreaming: true, steering: false, toolInputStreaming: false, toolOutputStreaming: false, approvals: false, questions: false, resume: false, fork: false, plans: false, permissions: ['read-only'], effort: [], models: [], limitations: [] }
  const factory = (_provider: unknown, opts: AdapterOptions): ProviderAdapter => {
    options.push(opts)
    return { provider: 'local', capabilities, start: async () => { opts.emit({ data: { type: 'session', phase: 'idle' } }) }, submit, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
  }
  let manager = new StructuredSessions(database, () => '', () => {}, factory)
  cleanup.push(() => { manager.dispose(); database.close() })
  manager.ensure(spec)
  // ensure registers only. A deliberate owner input creates the first live transport.
  await manager.submit(spec.id, 'owner input', { permission: 'read-only', plan: false })
  const first = options.at(-1)!
  expect(first.localTaskId).toBe(spec.id)
  expect(first.localTaskId).not.toBe(first.runtimeId)
  const checkpoint = { input: 'owner input', pending: { id: 'mutation-1' }, messages: [{ role: 'assistant', tool_calls: [{ id: 'read-1' }] }, { role: 'tool', tool_call_id: 'read-1', content: 'kept' }] }
  await first.localCheckpoint!.save(checkpoint)
  manager.dispose(); database.close()
  database = new ConductorDatabase(dbPath)
  manager = new StructuredSessions(database, () => '', () => {}, factory)
  manager.ensure(spec)
  expect(submit).toHaveBeenCalledTimes(1)
  await expect(first.localCheckpoint!.save({ stale: true })).rejects.toThrow('unavailable')
  await manager.submit(spec.id, 'explicit next input', { permission: 'read-only', plan: false })
  const second = options.at(-1)!
  expect(second.runtimeId).not.toBe(first.runtimeId)
  expect(second.localTaskId).toBe(spec.id)
  expect(second.localCheckpoint!.load()).toEqual(checkpoint)
})
