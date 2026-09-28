import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSpec, PaneTab, WorkspaceLayout } from '../shared/models'
import type { AdapterEvent, ProviderCapabilities, SessionSettings, StructuredProvider } from '../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { FinishTarget } from './coworker-autoclose'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { TabArchiver } from './tab-archive-eligibility'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) }, removeHandler: (channel: string) => { handlers.delete(channel) } } }))
const { registerTabArchiveIpc, uncollectedReport } = await import('./tab-archive-ipc')

/**
 * The archive latch (StructuredSessions.beginArchive) and the uncollected-report refusal: a submit
 * or steer that lands between a tab's last eligibility check and the UI acknowledging its close is
 * refused, never lost and never run; after a successful archive the latch holds until the tab is
 * reopened from the archive; a refusal or a failed close releases it at once.
 */
const settings: SessionSettings = { permission: 'default', plan: false }
const cleanup: Array<() => void> = []
afterEach(() => { for (const step of cleanup.splice(0).reverse()) { try { step() } catch { /* best effort */ } } vi.unstubAllEnvs() })

class FakeProvider implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: true, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: true, plans: true, permissions: ['default', 'accept-edits'], effort: ['low'], models: [], limitations: ['SYNTHETIC zero-inference fixture'] }
  submissions: string[] = []
  steers: string[] = []
  constructor(readonly options: AdapterOptions) {}
  async start(): Promise<void> { this.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: `native-${this.options.runtimeId}` } }) }
  async submit(text: string): Promise<void> { this.submissions.push(text) }
  async steer(text: string, _settings: SessionSettings, _attachments?: unknown, inputId = 'input'): Promise<void> { this.steers.push(text); this.emit({ data: { type: 'input_delivery', inputId, status: 'delivered' } }) }
  async respond(): Promise<void> {}
  async interrupt(): Promise<void> { this.emit({ data: { type: 'session', phase: 'interrupted' } }) }
  async fork(): Promise<string> { return 'fork' }
  async rename(): Promise<void> {}
  dispose(): void {}
  emit(event: AdapterEvent): void { this.options.emit(event) }
  finish(): void { this.emit({ data: { type: 'session', phase: 'completed' } }) }
}

function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-archive-latch-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const database = new ConductorDatabase(join(root, 'conductor.db'))
  cleanup.push(() => database.close())
  const project = database.upsertProject(workspace, 'Latch project')
  const session = database.listSessions(project.id)[0]!
  // The controller works in a project of its own, which is how its fake runtime is told apart.
  const bossCwd = join(root, 'boss'); mkdirSync(bossCwd)
  const bossProject = database.upsertProject(bossCwd, 'Boss project')
  const spec: AgentSpec = { id: 'agent_child_1', projectId: project.id, sessionId: session.id, provider: 'claude', title: 'Coworker', cwd: workspace }
  const boss: AgentSpec = { id: 'agent_boss_1', projectId: bossProject.id, sessionId: database.listSessions(bossProject.id)[0]!.id, provider: 'claude', title: 'Archive boss', cwd: bossCwd }
  const adapters: FakeProvider[] = []
  const manager = new StructuredSessions(database, () => 'synthetic-executable', vi.fn(), (_provider: StructuredProvider, options: AdapterOptions) => { const adapter = new FakeProvider(options); adapters.push(adapter); return adapter })
  cleanup.push(() => manager.dispose())
  manager.ensure(spec)
  manager.ensure(boss)
  const tab: PaneTab = { id: 'tab_child', kind: 'agent', title: 'Coworker', resourceId: spec.id }
  const target: FinishTarget = { agentSessionId: spec.id, projectId: project.id, sessionId: session.id, tabId: tab.id, title: tab.title, controller: boss.id, opened: true, wizard: false, controlsLiveCoworkers: false, remote: false }
  let open = true
  let ack: { resolve(): void; reject(error: Error): void } | undefined
  let closeStarted: () => void = () => {}
  const closing = new Promise<void>(resolve => { closeStarted = resolve })
  const layoutOf = (...tabs: PaneTab[]): WorkspaceLayout => ({ version: 1, root: { type: 'group', id: 'group', tabs, activeTabId: tabs[0]?.id ?? '' } })
  const archiver = new TabArchiver({
    layoutTab: () => open ? tab : undefined,
    targets: () => [target],
    snapshot: id => database.structured.snapshot(id),
    uncollectedReport: (id, found) => uncollectedReport(database, id, found?.controller ?? null),
    // The close lands the tab in the reopen list (and so the archive) once the UI acknowledges it.
    closeAgent: () => new Promise<void>((resolve, reject) => {
      ack = { resolve: () => { open = false; database.saveSession(session.id, layoutOf(), null, [tab]); resolve() }, reject }
      closeStarted()
    }),
    closeOther: async () => {},
    latch: { begin: id => manager.beginArchive(id), end: id => manager.endArchive(id) }
  })
  const adapter = (id: string): FakeProvider => adapters.filter(item => item.options.cwd === (id === boss.id ? bossCwd : workspace)).at(-1)!
  const userTexts = (id = spec.id) => database.structured.snapshot(id)!.items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => (item.data as { text: string }).text)
  const finishFirstTurn = async (): Promise<void> => { await manager.submit(spec.id, 'First task', settings); adapter(spec.id).finish() }
  return { database, spec, boss, manager, archiver, project, session, tab, closing, layoutOf, adapter, finishFirstTurn, ack: () => ack!, userTexts }
}

describe('tab archive latch', () => {
  it('latch: a submit arriving after the eligibility check but before the UI ack is refused, never lost and never run', async () => {
    const f = fixture()
    await f.finishFirstTurn()
    const archiving = f.archiver.archive(f.project.id, f.session.id, [f.tab.id])
    await f.closing
    await expect(f.manager.submit(f.spec.id, 'Late submit', settings)).rejects.toThrow('The tab is being archived; no message was sent')
    await expect(f.manager.steerOrStart(f.spec.id, 'Late report', settings)).rejects.toThrow(/being archived/)
    f.ack().resolve()
    expect(await archiving).toEqual({ archived: [{ tabId: f.tab.id, title: 'Coworker' }], refused: [] })
    expect(f.adapter(f.spec.id).submissions).toEqual([expect.stringContaining('First task')])
    expect(f.userTexts()).toEqual(['First task'])
    const state = f.database.structured.snapshot(f.spec.id)!
    expect(state.queued ?? null).toBeNull()
    expect(state.queuedPrompts ?? []).toEqual([])
  })

  it('latch: a steer arriving after the eligibility check but before the UI ack is refused, never queued and never run', async () => {
    const f = fixture()
    await f.finishFirstTurn()
    const archiving = f.archiver.archive(f.project.id, f.session.id, [f.tab.id])
    await f.closing
    await expect(f.manager.steer(f.spec.id, 'Late steer', settings)).rejects.toThrow(/being archived/)
    await expect(f.manager.queue(f.spec.id, 'Late queue', settings)).rejects.toThrow(/being archived/)
    f.ack().resolve()
    await archiving
    expect(f.adapter(f.spec.id).steers).toEqual([])
    expect(f.database.structured.snapshot(f.spec.id)!.pendingSteering ?? []).toEqual([])
    expect(f.userTexts()).toEqual(['First task'])
  })

  it('latch: holds across the final UI ack; a submit or steer after a successful archive stays refused until the tab is reopened from the archive, which clears it', async () => {
    const f = fixture()
    await f.finishFirstTurn()
    const archiving = f.archiver.archive(f.project.id, f.session.id, [f.tab.id])
    await f.closing
    expect(f.manager.isArchiving(f.spec.id)).toBe(true)
    f.ack().resolve()
    await archiving
    expect(f.manager.isArchiving(f.spec.id)).toBe(true)
    await expect(f.manager.submit(f.spec.id, 'After archive', settings)).rejects.toThrow(/being archived/)
    await expect(f.manager.steer(f.spec.id, 'After archive steer', settings)).rejects.toThrow(/being archived/)
    expect(f.database.tabArchive.list(f.session.id).tabs.map(entry => entry.tab.id)).toEqual([f.tab.id])
    // Reopened from the archive: the same IPC the Archive dialog, Ctrl+K and the lineage link use.
    const ui = vi.fn(async () => undefined)
    const stop = registerTabArchiveIpc({ database: f.database, trusted: () => {}, ui: () => ui, publish: () => {}, archiver: () => f.archiver, reopened: ids => { for (const id of ids) f.manager.endArchive(id) } })
    cleanup.push(stop)
    expect(await handlers.get('tab-archive:reopen')!({}, f.session.id, [f.tab.id])).toEqual({ reopened: 1 })
    expect(ui).toHaveBeenCalledWith(expect.objectContaining({ action: 'tabs.open', sessionId: f.session.id, params: expect.objectContaining({ tab: expect.objectContaining({ id: f.tab.id }) }) }))
    expect(f.manager.isArchiving(f.spec.id)).toBe(false)
    await f.manager.submit(f.spec.id, 'After reopening', settings)
    expect(f.adapter(f.spec.id).submissions.at(-1)).toContain('After reopening')
    expect(f.userTexts()).toEqual(['First task', 'After reopening'])
  })

  it('latch: a tab reopened by Ctrl+Shift+T or a close undo (back in the saved layout) clears it too', async () => {
    const f = fixture()
    await f.finishFirstTurn()
    const stop = registerTabArchiveIpc({ database: f.database, trusted: () => {}, ui: () => undefined, publish: () => {}, archiver: () => f.archiver, reopened: ids => { for (const id of ids) f.manager.endArchive(id) } })
    cleanup.push(stop)
    const archiving = f.archiver.archive(f.project.id, f.session.id, [f.tab.id])
    await f.closing
    f.ack().resolve()
    await archiving
    f.database.saveSession(f.session.id, f.layoutOf(f.tab), null, [])
    expect(f.manager.isArchiving(f.spec.id)).toBe(false)
    await f.manager.steerOrStart(f.spec.id, 'Back again', settings)
    expect(f.userTexts()).toEqual(['First task', 'Back again'])
  })

  it('latch: a failed close releases it, and the same submit then goes through', async () => {
    const f = fixture()
    await f.finishFirstTurn()
    const archiving = f.archiver.archive(f.project.id, f.session.id, [f.tab.id])
    await f.closing
    await expect(f.manager.submit(f.spec.id, 'Racing submit', settings)).rejects.toThrow(/being archived/)
    f.ack().reject(new Error('the window did not answer'))
    expect(await archiving).toMatchObject({ archived: [], refused: [{ tabId: f.tab.id, reason: 'the window did not answer' }] })
    expect(f.manager.isArchiving(f.spec.id)).toBe(false)
    await f.manager.submit(f.spec.id, 'Racing submit', settings)
    expect(f.userTexts()).toEqual(['First task', 'Racing submit'])
  })

  it('busy: a tab whose turn runs is refused with its reason and its latch released at once', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Long task', settings)
    expect(await f.archiver.archive(f.project.id, f.session.id, [f.tab.id])).toMatchObject({ archived: [], refused: [{ reason: 'its turn is still running', message: '“Coworker” was not archived: its turn is still running.' }] })
    expect(f.manager.isArchiving(f.spec.id)).toBe(false)
    await f.manager.steer(f.spec.id, 'Still reachable', settings)
    expect(f.adapter(f.spec.id).steers).toEqual([expect.stringContaining('Still reachable')])
  })
})

describe('tab archive: uncollected reports', () => {
  it('uncollected: a finished coworker whose report waits undelivered in its busy controller is refused until the controller collects it', async () => {
    const f = fixture()
    await f.finishFirstTurn()
    // The controller is mid-turn, so the child's agents.report (steerOrStart) waits in its queue.
    await f.manager.submit(f.boss.id, 'Lead the batch', settings)
    f.adapter(f.boss.id).capabilities.steering = false
    expect(await f.manager.steerOrStart(f.boss.id, 'Report: done with the strip', settings, [], { agentSessionId: f.spec.id, label: 'Coworker' })).toBe('queued')
    expect(await f.archiver.archive(f.project.id, f.session.id, [f.tab.id])).toEqual({ archived: [], refused: [{ tabId: f.tab.id, title: 'Coworker', reason: 'its report to Archive boss has not been collected yet', message: '“Coworker” was not archived: its report to Archive boss has not been collected yet.' }] })
    expect(f.manager.isArchiving(f.spec.id)).toBe(false)
    // The controller's turn ends and the queued report is delivered as its next turn: collected.
    f.adapter(f.boss.id).finish()
    await vi.waitFor(() => expect(f.userTexts(f.boss.id)).toContain('Report: done with the strip'))
    f.adapter(f.boss.id).finish()
    expect(uncollectedReport(f.database, f.spec.id, f.boss.id)).toBeNull()
    const archiving = f.archiver.archive(f.project.id, f.session.id, [f.tab.id])
    await f.closing
    f.ack().resolve()
    expect(await archiving).toMatchObject({ archived: [{ tabId: f.tab.id }], refused: [] })
  })

  it('uncollected: a report delivered at once as the controller\'s turn is collected', async () => {
    const f = fixture()
    await f.finishFirstTurn()
    expect(await f.manager.steerOrStart(f.boss.id, 'Report: all done', settings, [], { agentSessionId: f.spec.id, label: 'Coworker' })).toBe('started')
    expect(uncollectedReport(f.database, f.spec.id, f.boss.id)).toBeNull()
  })
})
