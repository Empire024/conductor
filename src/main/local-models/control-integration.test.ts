import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from '../database'
import { StructuredSessions } from '../structured-sessions'
import { AgentControl } from '../agent-control'
import { OrchestrationStore } from '../orchestration-store'
import { AgentCollaborationStore } from '../agent-collaboration-store'
import { ProjectBacklogs } from '../project-backlog'
import type { AdapterOptions, ProviderAdapter } from '../providers/adapter'
import type { AgentSpec } from '../../shared/models'
import type { ProviderCapabilities } from '../../shared/structured-agent'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.unstubAllEnvs() })

// Real session authorization, AgentControl and SQLite. Only model inference is a fixture.
it('binds LocalAdapter control to durable project memory, live permissions and runtime lifetime', async () => {
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0'); vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'local-control-integration-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(root, 'conductor.db'), workspace = join(root, 'project')
  mkdirSync(workspace)
  const database = new ConductorDatabase(path)
  cleanup.push(() => database.close())
  const project = database.upsertProject(workspace, 'Local project'), session = database.listSessions(project.id)[0]!
  const spec: AgentSpec = { id: 'local-fixture', projectId: project.id, sessionId: session.id, cwd: project.path, provider: 'local', title: 'Bounded local' }
  let current: AdapterOptions | undefined
  const capabilities: ProviderCapabilities = { provider: 'local', runtimeVersion: 'fixture', adapterVersion: 1, authentication: 'api', textStreaming: true, steering: false, toolInputStreaming: false, toolOutputStreaming: false, approvals: false, questions: false, resume: false, fork: false, plans: false, permissions: ['accept-edits', 'read-only'], effort: [], models: [], limitations: ['Synthetic inference only'] }
  const manager = new StructuredSessions(database, () => 'fixture', vi.fn(), (_provider, options): ProviderAdapter => {
    current = options
    return { provider: 'local', capabilities, start: async () => { options.emit({ data: { type: 'session', phase: 'idle' } }) }, submit: async () => {}, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
  }, undefined, undefined, { configure: () => 'SYNTHETIC_MCP_CREDENTIAL', release: () => {} })
  cleanup.push(() => manager.dispose())
  const orchestration = new OrchestrationStore(path), collaboration = new AgentCollaborationStore(path)
  cleanup.push(() => orchestration.close(), () => collaboration.close())
  const control = new AgentControl({ database, sessions: manager, orchestration, collaboration, backlogs: new ProjectBacklogs(database), providers: () => [], ui: async () => ({}), confirm: async () => false, fileChanged: () => {} })
  manager.setLocalControl((bound, method, args) => control.call({ projectId: bound.projectId, sessionId: bound.sessionId, agentSessionId: bound.id }, method, args))
  manager.ensure(spec)
  database.saveSession(session.id, { version: 1, root: { type: 'group', id: 'group', activeTabId: 'local-tab', tabs: [{ id: 'local-tab', kind: 'agent', resourceId: spec.id, title: 'Local', state: { provider: 'local' } }] } }, null, [])
  await manager.connectSession(spec.id)
  const broker = current!.localControl!
  expect(current!.mcpConfig).toBe('')
  expect(JSON.stringify(current)).not.toContain('SYNTHETIC_MCP_CREDENTIAL')
  const memory = await broker('memory.remember', { gist: 'LOCAL_INTEGRATION_DURABLE', kind: 'semantic', cues: ['local'] }) as { id: string }
  expect(memory.id).toBeTruthy()
  expect(JSON.stringify(await broker('memory.recall', { query: 'LOCAL_INTEGRATION_DURABLE' }))).toContain('LOCAL_INTEGRATION_DURABLE')
  expect(await broker('agents.list', {})).toEqual([expect.objectContaining({ agentSessionId: spec.id })])
  expect(await broker('agents.snapshot', { agentSessionId: spec.id })).toMatchObject({ sessionId: spec.id })
  const reopened = new ConductorDatabase(path)
  try { expect(reopened.recall(project.id, 'LOCAL_INTEGRATION_DURABLE', undefined, 12).some(entry => entry.id === memory.id)).toBe(true) } finally { reopened.close() }
  for (const [method, args] of [['router.dispatch', {}], ['memory.recall', { projectId: 'foreign' }], ['memory.remember', { gist: 'x', origin: { agentSessionId: 'forged' } }]] as const) await expect(broker(method, args)).rejects.toThrow()
  const state = database.structured.snapshot(spec.id)!
  database.structured.update(spec.id, { settings: { ...state.settings, permission: 'read-only' } })
  await expect(broker('memory.remember', { gist: 'REFUSED' })).rejects.toThrow(/unavailable/)
  expect(JSON.stringify(await broker('memory.recall', {}))).toContain('LOCAL_INTEGRATION_DURABLE')
  manager.dispose()
  await expect(broker('memory.recall', {})).rejects.toThrow(/runtime/)
})
