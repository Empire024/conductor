import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../agent-control'
import { AgentCollaborationStore } from '../agent-collaboration-store'
import { ConductorDatabase } from '../database'
import { OrchestrationStore } from '../orchestration-store'
import { ProjectBacklogs } from '../project-backlog'
import { StructuredSessions } from '../structured-sessions'
import type { AgentControlUiRequest } from '../../shared/agent-control'
import type { AgentProviderInfo, AgentSpec, PaneTab } from '../../shared/models'
import type { DecisionRecord, ExecutionOutcome, RouteDecision } from '../../shared/model-routing'
import type { ProviderCapabilities } from '../../shared/structured-agent'
import { localStopPayload, type LocalStopReport } from '../../shared/local-stop'
import type { ProviderAdapter } from '../providers/adapter'
import { turnObserver } from './app-wiring'
import { createModelIntelligence, type ModelIntelligence } from './index'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); vi.unstubAllEnvs() })

const LOCAL = 'local/qwen-test'
const localStop: LocalStopReport = {
  reason: 'completed', detail: 'The model finished.', rounds: 4, hardLimit: 40,
  context: { usedTokens: 9_000, capacityTokens: 28_000, reserveTokens: 4_096, windowTokens: 32_768, percent: 32, estimated: false },
  compactions: 0, recoveredTokens: 0, loopWarnings: 0, filesChanged: ['src/parser.ts'], commandsRun: 2, excludedOutputChars: 0, timeline: [],
  acceptance: { command: 'npm test', passed: true, exitCode: 0 },
  task: { lifecycle: 'completed', requests: 4, recoveries: 0, elapsedMs: 30_000, tokens: 40_000, segmentLimit: 8, maxRounds: 40 }
}
/** The whole stack over a temp conductor.db: real AgentControl, StructuredSessions with a zero-
 *  inference adapter, and model intelligence fed by fake sources, as src/main/index.ts wires it. */
function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0'); vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'model-intel-wiring-')), projectPath = join(root, 'project')
  mkdirSync(projectPath)
  dispose.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(root, 'conductor.db'), database = new ConductorDatabase(path)
  dispose.push(() => database.close())
  const project = database.upsertProject(projectPath, 'Routing project'), workspace = database.listSessions(project.id)[0]!
  const orchestration = new OrchestrationStore(path), collaboration = new AgentCollaborationStore(path)
  dispose.push(() => orchestration.close(), () => collaboration.close())
  let service: ModelIntelligence | undefined
  const submissions: Array<{ provider: string; model?: string; effort?: string }> = []
  let observe: (channel: string, payload: unknown) => void = () => {}
  const sessions = new StructuredSessions(database, () => 'synthetic-provider', (channel, payload) => observe(channel, payload), (provider, options): ProviderAdapter => {
    const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: ['default', 'read-only', 'accept-edits', 'auto'], sandboxModes: ['inherit', 'read-only', 'workspace-write'], effort: ['low', 'high'],
      models: [{ id: `${provider}-synthetic`, label: `${provider} Synthetic`, effort: ['low', 'high'], defaultEffort: 'low' }, { id: `${provider}-advanced`, label: `${provider} Advanced`, effort: ['high'], defaultEffort: 'high' }], limitations: ['Zero inference fixture'] }
    let turn = 0
    return { provider, capabilities, start: async () => { options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-' + options.runtimeId } }) },
      submit: async (_prompt, settings) => {
        submissions.push({ provider, ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}) })
        const turnId = `turn-${++turn}`
        options.emit({ turnId, data: { type: 'session', phase: 'running' } })
        options.emit({ turnId, itemId: `result-${turn}`, data: { type: 'text', role: 'assistant', text: 'Implemented the parser', mode: 'snapshot' } })
        options.emit({ turnId, itemId: `usage-${turn}`, data: { type: 'usage', inputTokens: 12_000, outputTokens: 900, costUsd: 0.2, scope: 'turn', source: 'provider' } })
        // The local adapter's telemetry notice and stop notice, as providers/local.ts emits them.
        if (provider === 'local') {
          options.emit({ turnId, data: { type: 'notice', message: 'Local run telemetry: repair', payload: { localTelemetry: { kind: 'repair', round: 1, name: 'edit', outcome: 'failed' } } } })
          options.emit({ turnId, itemId: `${turnId}:stop`, data: { type: 'notice', message: 'Completed', payload: localStopPayload(localStop) } })
        }
        options.emit({ turnId, data: { type: 'session', phase: 'completed' } })
      }, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
  })
  dispose.push(() => sessions.dispose())
  const scope = { projectId: project.id, sessionId: workspace.id, agentSessionId: 'controller' }
  const spec: AgentSpec = { id: scope.agentSessionId, projectId: project.id, sessionId: workspace.id, cwd: project.path, provider: 'codex', title: 'Controller', model: 'codex-synthetic' }
  sessions.ensure(spec)
  const rootTab: PaneTab = { id: 'controller-tab', kind: 'agent', resourceId: spec.id, title: spec.title, state: { provider: spec.provider, model: spec.model } }
  database.saveSession(workspace.id, { version: 1, root: { type: 'group', id: 'group', activeTabId: rootTab.id, tabs: [rootTab] } }, null, [])
  const ui = vi.fn(async (request: AgentControlUiRequest) => {
    if (request.action === 'tabs.open') {
      const current = database.getSession(request.sessionId)!, tab = request.params.tab as PaneTab
      if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
      current.layout.root.tabs.push(tab); current.layout.root.activeTabId = tab.id
      database.saveSession(request.sessionId, current.layout, null, [])
      return { tabId: tab.id }
    }
    return { applied: true }
  })
  const providers: AgentProviderInfo[] = [
    { id: 'codex', displayName: 'Codex', available: true, installUrl: '', models: [{ id: 'codex-synthetic', label: 'Codex Synthetic' }], efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { id: 'claude', displayName: 'Claude', available: true, installUrl: '', models: [{ id: 'claude-advanced', label: 'Claude Advanced' }], efforts: [{ id: 'high', label: 'High' }] },
    { id: 'local', displayName: 'Local', available: true, installUrl: '', models: [{ id: LOCAL, label: 'Qwen test (local)' }], efforts: [{ id: 'auto', label: 'Provider default' }] }
  ]
  const control = new AgentControl({ database, sessions, orchestration, collaboration, backlogs: new ProjectBacklogs(database), ui, confirm: vi.fn(async () => false), fileChanged: vi.fn(), providers: () => providers })
  const benchmarks = JSON.stringify({ source: { name: 'SWE-bench Verified' }, observedAt: '2026-09-01T00:00:00Z', results: [
    { provider: 'claude', model: 'claude-advanced', score: 90 }, { provider: 'codex', model: 'codex-synthetic', score: 55 }, { provider: 'local', model: LOCAL, score: 45 }
  ] })
  service = createModelIntelligence({
    dbPath: path, settings: database,
    sources: {
      configured: { catalogs: () => ({ providers, localModels: [{ id: LOCAL, label: 'Qwen test (local)', quant: 'Q4_K_M', sizeBytes: 5 * 1024 ** 3, contextTokens: 32_768, gpuLayers: 999, vramBytes: 7 * 1024 ** 3 }] }) },
      runtime: { modelsList: () => control.runtimeModelCatalog() },
      benchmarks: { read: () => benchmarks }
    },
    timers: { every: () => () => {}, after: () => () => {} }
  })
  dispose.push(() => service!.dispose())
  observe = turnObserver(() => service, id => database.structured.snapshot(id))
  control.setModelIntelligence(service)
  return { database, sessions, control, scope, service: service!, submissions }
}

const candidate = (decision: RouteDecision, model: string) => decision.candidates.find(entry => entry.key.model === model)!
const HARD = { features: { category: 'difficult-coding', complexity: 5, risk: 'high' } }

describe('model intelligence wiring (fake sources, zero inference)', () => {
  it('runs the loop: refresh, route, dispatch, outcome, feedback and explanation', async () => {
    const f = fixture()
    // 1. Refresh fills the registry from the fake sources; prices come from a checked-in sheet.
    const refreshed = await f.control.call(f.scope, 'models.refresh', { sources: ['configured', 'runtime', 'benchmarks'] }) as { results: Array<{ source: string; status: string }> }
    expect(refreshed.results.map(entry => [entry.source, entry.status])).toEqual([['configured', 'ok'], ['runtime', 'ok'], ['benchmarks', 'ok']])
    const sheet = { kind: 'conductor' as const, name: 'conductor:price-sheet' }
    f.service.registry.applyBatch({ source: sheet, fetchedAt: '2026-09-28T00:00:00Z', complete: false, benchmarks: [], observations: [
      { key: { provider: 'codex', model: 'codex-synthetic' }, field: 'priceInputPerMTok', value: 0.25, source: sheet, observedAt: '2026-09-28T00:00:00Z' },
      { key: { provider: 'codex', model: 'codex-synthetic' }, field: 'priceOutputPerMTok', value: 2, source: sheet, observedAt: '2026-09-28T00:00:00Z' },
      { key: { provider: 'claude', model: 'claude-advanced' }, field: 'priceInputPerMTok', value: 5, source: sheet, observedAt: '2026-09-28T00:00:00Z' },
      { key: { provider: 'claude', model: 'claude-advanced' }, field: 'priceOutputPerMTok', value: 25, source: sheet, observedAt: '2026-09-28T00:00:00Z' }
    ] })
    const registry = await f.control.call(f.scope, 'models.registry', {}) as { records: Array<{ key: { provider: string; model: string }; status: string }> }
    expect(registry.records.map(record => `${record.key.provider}/${record.key.model}`)).toEqual(expect.arrayContaining(['claude/claude-advanced', 'codex/codex-synthetic', 'codex/codex-advanced', `local/${LOCAL}`]))
    expect(registry.records.every(record => record.status === 'unproven')).toBe(true)
    const listed = await f.control.call(f.scope, 'models.list', {}) as Array<{ provider: string; models: Array<{ id: string; registry?: { status: string; pricing: { inputPerMTok: number } | null } }> }>
    expect(listed.find(entry => entry.provider === 'claude')!.models[0]).toMatchObject({ id: 'claude-advanced', registry: { status: 'unproven', pricing: { inputPerMTok: 5 } } })

    // 2. models.route: trivial cheap work goes local, hard high-risk work to the strong cloud model.
    const cheap = await f.control.call(f.scope, 'models.route', { features: { category: 'simple-coding', complexity: 1, risk: 'low' }, constraints: { costWeight: 0.9 } }) as { decision: RouteDecision; explanation: string }
    expect(cheap.decision.selected.key).toEqual({ provider: 'local', model: LOCAL })
    const midway = await f.control.call(f.scope, 'models.route', { features: { category: 'simple-coding', complexity: 2, risk: 'low' }, constraints: { costWeight: 0.2, excludeProviders: ['local'] } }) as { decision: RouteDecision }
    expect(midway.decision.selected.key.provider).toBe('codex')
    const hard = await f.control.call(f.scope, 'models.route', HARD) as { decision: RouteDecision; explanation: string }
    expect(hard.decision.selected.key).toEqual({ provider: 'claude', model: 'claude-advanced' })
    expect(hard.explanation).toMatch(/^Selected: claude-advanced via claude \(effort high\)/)
    const before = candidate(hard.decision, 'claude-advanced').expectedSuccess

    // 3. A routed dispatch opens the chosen model exactly as if it had been named, and records its decision.
    const dispatched = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Parser', prompt: 'Implement the protocol parser', route: HARD }] }) as Array<{ agentSessionId: string; provider: string; model: string; effort: string; decisionId: string; route: string; accepted: boolean }>
    expect(dispatched[0]).toMatchObject({ provider: 'claude', model: 'claude-advanced', effort: 'high', accepted: true, decisionId: expect.stringMatching(/^decision_/), route: expect.stringContaining('Selected: claude-advanced via claude') })
    expect(f.submissions.at(-1)).toMatchObject({ provider: 'claude', model: 'claude-advanced', effort: 'high' })
    const decisionId = dispatched[0]!.decisionId
    await vi.waitFor(() => expect(f.service.store.outcomesForDecision(decisionId)).toHaveLength(1))
    const captured = f.service.store.outcomesForDecision(decisionId)[0]!
    expect(captured).toMatchObject({ key: { provider: 'claude', model: 'claude-advanced' }, source: 'turn', category: 'difficult-coding', result: 'completed-unverified', agentSessionId: dispatched[0]!.agentSessionId, tokens: expect.any(Number) })
    expect(f.service.store.decision(decisionId)!.outcome).toMatchObject({ result: 'completed-unverified' })

    // 4. The owner says it actually failed: the linked outcome is amended and the next route sees it.
    const corrected = await f.control.call(f.scope, 'models.outcome', { decisionId, result: 'failure', ownerCorrected: true, detail: 'tests did not pass' }) as { amended: string[] }
    expect(corrected.amended).toEqual([captured.id])
    for (let index = 0; index < 3; index++) f.service.recordOutcome({ ...captured, id: `failure-${index}`, ref: `extra-${index}`, result: 'failure', decisionId: null } as ExecutionOutcome)
    const after = await f.control.call(f.scope, 'models.route', HARD) as { decision: RouteDecision }
    expect(candidate(after.decision, 'claude-advanced').expectedSuccess).toBeLessThan(before)
    expect(candidate(after.decision, 'claude-advanced').reputation!.evidence).toBeGreaterThan(3.9)

    // 5. decisions.get explains the decision with its outcome and linked executions.
    const explained = await f.control.call(f.scope, 'decisions.get', { decisionId }) as { decision: DecisionRecord; explanation: string; outcomes: ExecutionOutcome[] }
    expect(explained.decision).toMatchObject({ kind: 'route', choice: 'claude/claude-advanced', requester: 'router.dispatch', outcome: { result: 'failure', detail: 'tests did not pass' } })
    expect(explained.explanation).toContain('Choice: claude-advanced via claude (claude/claude-advanced)')
    expect(explained.explanation).toContain('Outcome: failure')
    expect(explained.outcomes.map(row => [row.result, row.ownerCorrected])).toEqual([['failure', true]])
    const journal = await f.control.call(f.scope, 'decisions.list', { kind: 'route' }) as { decisions: Array<{ id: string; systemOne: { decider: string } | null }>; boundaries: Array<{ kind: string; cases: number; live: boolean }> }
    expect(journal.decisions.map(entry => entry.id)).toContain(decisionId)
    expect(journal.decisions.find(entry => entry.id === decisionId)!.systemOne).toMatchObject({ decider: 'scorer' })
    expect(journal.boundaries).toEqual([expect.objectContaining({ kind: 'route', live: true })])
  })

  it('captures a local agent turn from its stop report, once, and leaves durable-job stages and chat to their own capture', async () => {
    const f = fixture()
    const cwd = f.database.getProject(f.scope.projectId)!.path, key = { provider: 'local', model: LOCAL }
    const open = (id: string) => f.sessions.ensure({ id, projectId: f.scope.projectId, sessionId: f.scope.sessionId, cwd, provider: 'local', title: id, model: LOCAL })
    const local = () => f.service.store.outcomes({ key, since: '2000-01-01T00:00:00Z', limit: 100 })
    // An owner's local tab, not dispatched: its stop report is the outcome (acceptance, failed repair, files).
    open('local-owner')
    await f.sessions.submit('local-owner', 'Fix the failing parser test', { permission: 'auto', plan: false, model: LOCAL })
    await vi.waitFor(() => expect(local()).toHaveLength(1))
    expect(local()[0]).toMatchObject({ source: 'local-agent', ref: 'local-owner:turn-1', agentSessionId: 'local-owner', projectId: f.scope.projectId, category: 'debugging', result: 'success', verifier: 'pass', toolFailures: 1, iterations: 4, tokens: 40_000, decisionId: null })
    // A dispatched local coworker (bound as router.dispatch binds it): the outcome takes the binding's category and
    // project, and the settled turn is not captured a second time by turnSettled.
    open('local-coworker')
    f.service.bindDispatch('local-coworker', { decisionId: null, features: { category: 'difficult-coding', complexity: 4, risk: 'medium', toolsRequired: [], contextTokens: null }, key, effort: null, projectId: 'bound-project' })
    await f.sessions.submit('local-coworker', 'Implement the protocol parser', { permission: 'auto', plan: false, model: LOCAL })
    await vi.waitFor(() => expect(local()).toHaveLength(2))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(local().filter(outcome => outcome.agentSessionId === 'local-coworker')).toEqual([expect.objectContaining({ source: 'local-agent', category: 'difficult-coding', complexity: 4, projectId: 'bound-project', result: 'success' })])
    // A durable-job stage (stageSettled captures it) and a chat turn with no category signal record nothing here.
    open('local-stage')
    await f.sessions.submit('local-stage', 'Fix the failing parser test', { permission: 'auto', plan: false, model: LOCAL }, [], { agentSessionId: 'durable-job', label: 'Durable job' })
    open('local-chat')
    await f.sessions.submit('local-chat', 'hello there', { permission: 'auto', plan: false, model: LOCAL })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(local()).toHaveLength(2)
  })

  it('keeps router.dispatch and models.list unchanged without model intelligence, and refuses a route then', async () => {
    const f = fixture()
    f.control.setModelIntelligence(undefined)
    const listed = await f.control.call(f.scope, 'models.list', {}) as Array<{ models: Array<Record<string, unknown>> }>
    expect(listed.flatMap(entry => entry.models).some(model => 'registry' in model)).toBe(false)
    expect(Object.keys(await f.control.call(f.scope, 'tools.list', {}) as object)).not.toContain('models.route')
    await expect(f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Parser', prompt: 'Implement the parser', route: {} }] })).rejects.toThrow(/model intelligence/)
    await expect(f.control.call(f.scope, 'models.route', HARD)).rejects.toThrow(/unavailable/)
  })

  it('refuses a route that also names a model, and outcomes from a conversation that did not ask', async () => {
    const f = fixture()
    await f.service.refresh(['configured', 'runtime'])
    await expect(f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Parser', prompt: 'Implement the parser', provider: 'claude', route: {} }] })).rejects.toThrow(/names no provider/)
    const routed = await f.control.call(f.scope, 'models.route', HARD) as { decision: RouteDecision }
    const stranger = { ...f.scope, agentSessionId: 'stranger' }
    f.sessions.ensure({ id: 'stranger', projectId: f.scope.projectId, sessionId: f.scope.sessionId, cwd: f.database.getProject(f.scope.projectId)!.path, provider: 'codex', title: 'Stranger', model: 'codex-synthetic' })
    const layout = f.database.getSession(f.scope.sessionId)!.layout
    if (layout.root.type === 'group') layout.root.tabs.push({ id: 'stranger-tab', kind: 'agent', resourceId: 'stranger', title: 'Stranger', state: { provider: 'codex', model: 'codex-synthetic' } })
    f.database.saveSession(f.scope.sessionId, layout, null, [])
    await expect(f.control.call(stranger, 'models.outcome', { decisionId: routed.decision.decisionId, result: 'failure' })).rejects.toThrow(/conversation that asked/)
    await expect(f.control.call(f.scope, 'models.outcome', { decisionId: routed.decision.decisionId, result: 'bad' })).rejects.toThrow(/result must be/)
    const recorded = await f.control.call(f.scope, 'models.outcome', { decisionId: routed.decision.decisionId, result: 'partial' }) as { recorded: string | null }
    expect(f.service.store.outcome(recorded.recorded!)).toMatchObject({ source: 'owner', result: 'partial', category: 'difficult-coding', key: routed.decision.selected.key })
  })
})
