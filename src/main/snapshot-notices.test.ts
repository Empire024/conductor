import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import type { AgentSpec } from '../shared/models'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { AdapterEvent, ContextAttachment, ProviderCapabilities, SessionSettings, TimelineItem } from '../shared/structured-agent'

const settings: SessionSettings = { permission: 'default', plan: false }
const roots: string[] = [], databases: ConductorDatabase[] = [], managers: StructuredSessions[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) { try { manager.dispose() } catch {} }
  for (const db of databases.splice(0)) { try { db.close() } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  vi.unstubAllEnvs()
})

/** The smallest adapter the manager will drive: it only has to hand back the lifecycle hooks. */
class HookOnlyProvider implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: true, plans: true, permissions: ['default'], effort: ['low'], models: [], limitations: ['SYNTHETIC zero-inference fixture'] }
  constructor(readonly options: AdapterOptions) {}
  async start(): Promise<void> { this.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: `native-${this.options.runtimeId}` } }) }
  async submit(): Promise<void> {}
  async steer(_text: string, _settings: SessionSettings, _attachments?: ContextAttachment[]): Promise<void> {}
  async respond(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async fork(): Promise<string> { return 'forked' }
  async rename(): Promise<void> {}
  dispose(): void {}
  emit(event: AdapterEvent): void { this.options.emit(event) }
}

function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-snapshot-notice-')); roots.push(root)
  const workspace = join(root, 'Workspace 日本語 with spaces'); mkdirSync(workspace)
  const database = new ConductorDatabase(join(root, 'conductor.db')); databases.push(database)
  const project = database.upsertProject(workspace, 'Synthetic project')
  const session = database.listSessions(project.id)[0]!
  const spec: AgentSpec = { id: 'agent-session', projectId: project.id, sessionId: session.id, provider: 'claude', title: 'Synthetic Claude', cwd: workspace }
  const adapters: HookOnlyProvider[] = []
  const manager = new StructuredSessions(database, () => 'synthetic-executable', vi.fn(), (_provider, options: AdapterOptions) => {
    const adapter = new HookOnlyProvider(options); adapters.push(adapter); return adapter
  }); managers.push(manager)
  manager.ensure(spec)
  const notices = (): string[] => (database.structured.snapshot(spec.id)?.items ?? [])
    .filter((item: TimelineItem) => item.data.type === 'notice' && item.data.message.startsWith('Snapshot unavailable:'))
    .map((item: TimelineItem) => item.data.type === 'notice' ? item.data.message : '')
  return { root, workspace, database, spec, manager, notices, get current() { return adapters.at(-1)! } }
}

describe('snapshot notices in the conversation timeline', () => {
  it('says nothing at all when a turn writes files outside the session workspace', async () => {
    const f = fixture()
    mkdirSync(join(f.root, 'memory'))
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    const runtime = f.current
    for (let index = 0; index < 12; index++) {
      const outside = ['../memory/note.md', join(f.root, 'memory', `fact-${index}.md`)]
      await runtime.options.beforeTool?.(`write-${index}`, outside)
      writeFileSync(join(f.root, 'memory', `fact-${index}.md`), `fact ${index}\n`)
      await runtime.options.afterTool?.(`write-${index}`, outside, true)
    }
    f.manager.flush()
    expect(f.notices()).toEqual([])
  })

  it('states an unactionable snapshot failure once, not on every tool call that hits it', async () => {
    const f = fixture()
    writeFileSync(join(f.workspace, 'binary.bin'), Buffer.from([0, 255, 0, 255]))
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    const runtime = f.current
    for (let index = 0; index < 12; index++) await runtime.options.beforeTool?.(`write-${index}`, ['binary.bin'])
    f.manager.flush()
    expect(f.notices()).toHaveLength(1)
    expect(f.notices()[0]).toContain('Binary')
  })
})
