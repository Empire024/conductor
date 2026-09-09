import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { usageCapKey } from './usage-limit'
import type { AgentSpec } from '../shared/models'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { AdapterEvent, ContextAttachment, InteractionResponse, Json, ProviderCapabilities, SessionSettings } from '../shared/structured-agent'

const settings: SessionSettings = { permission: 'default', plan: false }
const roots: string[] = [], databases: ConductorDatabase[] = [], managers: StructuredSessions[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) { try { manager.dispose() } catch { /* fixture teardown */ } }
  for (const db of databases.splice(0)) { try { db.close() } catch { /* fixture teardown */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  vi.unstubAllEnvs()
})

class FakeProvider implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: true, plans: true, permissions: ['default'], effort: ['low'], models: [], limitations: ['SYNTHETIC zero-inference fixture'] }
  submissions: string[] = []
  interrupts = 0
  constructor(readonly options: AdapterOptions) {}
  async start(): Promise<void> { this.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: `native-${this.options.runtimeId}` } }) }
  async submit(text: string): Promise<void> { this.submissions.push(text); this.emit({ data: { type: 'session', phase: 'running' } }) }
  async steer(): Promise<void> { /* not exercised */ }
  async respond(_response: InteractionResponse): Promise<void> { /* not exercised */ }
  async interrupt(): Promise<void> { this.interrupts++; this.emit({ data: { type: 'session', phase: 'interrupted' } }) }
  async fork(): Promise<string> { return 'fork' }
  async rename(): Promise<void> { /* not exercised */ }
  dispose(): void { /* not exercised */ }
  emit(event: AdapterEvent): void { this.options.emit(event) }
  private reportedAccount = false
  /** One provider account report, mirroring how both adapters record a run's first level
   *  separately from the rolling current level the timeline reconciles in place. */
  account(usedPercent: number): void {
    const limits: Json = { rateLimits: { seven_day: { usedPercent, windowDurationMins: 10080 } } }
    if (!this.reportedAccount) {
      this.reportedAccount = true
      this.emit({ itemId: 'usage:account-rate-limits:first', data: { type: 'usage', source: 'provider', limits } })
    }
    this.emit({ itemId: 'usage:account-rate-limits', data: { type: 'usage', source: 'provider', limits } })
  }
  tokens(inputTokens: number, outputTokens: number): void {
    this.emit({ itemId: 'usage:tokens', data: { type: 'usage', source: 'provider', scope: 'session', inputTokens, outputTokens } })
  }
  attachments(_attachments?: ContextAttachment[]): void { /* not exercised */ }
}

function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-usage-cap-')); roots.push(root)
  const workspace = join(root, 'Workspace'); mkdirSync(workspace)
  const database = new ConductorDatabase(join(root, 'conductor.db')); databases.push(database)
  const project = database.upsertProject(workspace, 'Synthetic project')
  const session = database.listSessions(project.id)[0]!
  const spec: AgentSpec = { id: 'agent-session', projectId: project.id, sessionId: session.id, provider: 'claude', title: 'Synthetic', cwd: workspace }
  const adapters: FakeProvider[] = []
  const manager = new StructuredSessions(database, () => 'synthetic-executable', vi.fn(),
    (_provider, options) => { const adapter = new FakeProvider(options); adapters.push(adapter); return adapter })
  managers.push(manager)
  manager.ensure(spec)
  const notices = (): string[] => (database.structured.snapshot(spec.id)?.items ?? [])
    .flatMap(item => item.data.type === 'notice' ? [item.data.message] : [])
  return { database, spec, workspaceId: session.id, manager, adapters, notices, get current() { return adapters.at(-1)! } }
}
/** The backend coalesces cap checks onto a short timer, so wait for the decision to land
 *  rather than for a fixed delay that a loaded machine can outrun. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
}
/** No decision is expected; give the timer room to fire so "did not stop" means something. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 400))

describe('usage caps stop a conversation cleanly (synthetic, zero inference)', () => {
  it('stops on the consumed share, says why, and refuses further turns until the cap changes', async () => {
    const f = fixture()
    f.database.setSetting(usageCapKey('workspace', f.workspaceId), JSON.stringify({ metric: 'weekly-percent', limit: 20, basis: 'conversation' }))
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    const runtime = f.current
    runtime.account(40)
    await settle()
    expect(runtime.interrupts).toBe(0)

    runtime.account(65)
    await waitFor(() => runtime.interrupts > 0)
    expect(runtime.interrupts).toBe(1)
    const notice = f.notices().find(message => message.includes('Usage cap reached'))
    // The stop names the two reported levels it rests on and separates itself from continuation.
    expect(notice).toContain('40% to 65%')
    expect(notice).toContain('25 points')
    expect(notice).toContain('workspace cap')
    expect(notice).toMatch(/continuation does not apply/i)

    await expect(f.manager.submit(f.spec.id, 'Another turn', settings)).rejects.toThrow(/Usage cap reached/)
    // Raising the cap releases the stop without any other action.
    f.database.setSetting(usageCapKey('workspace', f.workspaceId), JSON.stringify({ metric: 'weekly-percent', limit: 90, basis: 'conversation' }))
    await settle()
    await f.manager.submit(f.spec.id, 'Another turn', settings)
    expect(f.current.submissions.at(-1)).toContain('Another turn')
  })

  it('caps an absolute account level and a token total, and honors a tab opt-out', async () => {
    const f = fixture()
    f.database.setSetting(usageCapKey('default'), JSON.stringify({ metric: 'weekly-percent', limit: 80, basis: 'account' }))
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    f.current.account(85)
    await waitFor(() => f.current.interrupts > 0)
    expect(f.current.interrupts).toBe(1)
    expect(f.notices().some(message => message.includes('85% account-wide'))).toBe(true)

    const g = fixture()
    g.database.setSetting(usageCapKey('tab', g.spec.id), JSON.stringify({ metric: 'tokens', limit: 1_000 }))
    await g.manager.submit(g.spec.id, 'Synthetic turn', settings)
    g.current.tokens(400, 100)
    await settle()
    expect(g.current.interrupts).toBe(0)
    g.current.tokens(900, 200)
    await waitFor(() => g.current.interrupts > 0)
    expect(g.current.interrupts).toBe(1)
    expect(g.notices().some(message => message.includes('1,100 of 1,000 capped tokens'))).toBe(true)

    const h = fixture()
    h.database.setSetting(usageCapKey('default'), JSON.stringify({ metric: 'weekly-percent', limit: 1, basis: 'account' }))
    h.database.setSetting(usageCapKey('tab', h.spec.id), JSON.stringify({ metric: 'none' }))
    await h.manager.submit(h.spec.id, 'Synthetic turn', settings)
    h.current.account(99)
    await settle()
    expect(h.current.interrupts).toBe(0)
    expect(h.notices().some(message => message.includes('Usage cap reached'))).toBe(false)
  })

  it('never stops on a figure the provider has not reported', async () => {
    const f = fixture()
    f.database.setSetting(usageCapKey('workspace', f.workspaceId), JSON.stringify({ metric: 'weekly-percent', limit: 1, basis: 'conversation' }))
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    // Tokens alone say nothing about the account allowance, so a window cap must stay silent.
    f.current.tokens(500_000, 200_000)
    await settle()
    expect(f.current.interrupts).toBe(0)
    expect(f.notices().some(message => message.includes('Usage cap reached'))).toBe(false)
    f.current.emit({ data: { type: 'session', phase: 'completed' } })
    await expect(f.manager.submit(f.spec.id, 'Next', settings)).resolves.toBeUndefined()
  })
})
