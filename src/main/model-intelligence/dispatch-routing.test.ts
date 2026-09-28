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
import type { RouteDecision } from '../../shared/model-routing'
import type { ProviderCapabilities } from '../../shared/structured-agent'
import type { ProviderAdapter } from '../providers/adapter'
import { cloudRunPort, evaluationPrompt } from './evaluation-ports'
import type { EvaluationJob } from './evaluation'
import { createModelIntelligence } from './index'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); vi.unstubAllEnvs() })

const LOCAL = 'local/qwen-test'
const GiB = 1024 ** 3
/** AgentControl + StructuredSessions (zero-inference adapter) + model intelligence on a temp db,
 *  with a local provider whose VRAM envelope and admission verdicts the test chooses. */
type Emit = (event: { turnId?: string; itemId?: string; parentId?: string; data: Record<string, unknown> }) => void
/** The zero-inference turn: an answer, usage and completion, unless the test scripts another. */
const answerTurn = (emit: Emit) => {
  emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
  emit({ turnId: 't1', itemId: 'answer', data: { type: 'text', role: 'assistant', text: '42', mode: 'snapshot' } })
  emit({ turnId: 't1', itemId: 'usage', data: { type: 'usage', inputTokens: 700, outputTokens: 50, costUsd: 0.01, scope: 'turn', source: 'provider' } })
  emit({ turnId: 't1', data: { type: 'session', phase: 'completed' } })
}
function fixture(options: { vramBytes: number; availability: (id: string) => { available: boolean; reason?: string }; turn?: (emit: Emit) => void }) {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0'); vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const interrupted: string[] = []
  const root = mkdtempSync(join(tmpdir(), 'model-intel-dispatch-')), projectPath = join(root, 'project')
  mkdirSync(projectPath)
  dispose.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(root, 'conductor.db'), database = new ConductorDatabase(path)
  dispose.push(() => database.close())
  const project = database.upsertProject(projectPath, 'Routing project'), workspace = database.listSessions(project.id)[0]!
  const orchestration = new OrchestrationStore(path), collaboration = new AgentCollaborationStore(path)
  dispose.push(() => orchestration.close(), () => collaboration.close())
  const sessions = new StructuredSessions(database, () => 'synthetic-provider', () => {}, (provider, adapterOptions): ProviderAdapter => {
    const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: ['default', 'read-only', 'accept-edits', 'auto'], sandboxModes: ['inherit', 'read-only', 'workspace-write'], effort: ['low', 'high'],
      models: [{ id: `${provider}-synthetic`, label: `${provider} Synthetic`, effort: ['low', 'high'], defaultEffort: 'low' }], limitations: ['Zero inference fixture'] }
    return { provider, capabilities, start: async () => { adapterOptions.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-' + adapterOptions.runtimeId } }) },
      submit: async () => { (options.turn ?? answerTurn)(adapterOptions.emit as unknown as Emit) },
      respond: async () => {}, interrupt: async () => { interrupted.push(adapterOptions.runtimeId); adapterOptions.emit({ turnId: 't1', data: { type: 'session', phase: 'interrupted' } }) }, dispose: () => {} }
  })
  dispose.push(() => sessions.dispose())
  const scope = { projectId: project.id, sessionId: workspace.id, agentSessionId: 'controller' }
  const spec: AgentSpec = { id: scope.agentSessionId, projectId: project.id, sessionId: workspace.id, cwd: project.path, provider: 'codex', title: 'Controller', model: 'codex-synthetic' }
  sessions.ensure(spec)
  const rootTab: PaneTab = { id: 'controller-tab', kind: 'agent', resourceId: spec.id, title: spec.title, state: { provider: spec.provider, model: spec.model } }
  database.saveSession(workspace.id, { version: 1, root: { type: 'group', id: 'group', activeTabId: rootTab.id, tabs: [rootTab] } }, null, [])
  const closed: string[] = []
  const ui = vi.fn(async (request: AgentControlUiRequest) => {
    const current = database.getSession(request.sessionId)!
    if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
    if (request.action === 'tabs.open') { const tab = request.params.tab as PaneTab; current.layout.root.tabs.push(tab); database.saveSession(request.sessionId, current.layout, null, []); return { tabId: tab.id } }
    if (request.action === 'tabs.close') { closed.push(String(request.params.tabId)); current.layout.root.tabs = current.layout.root.tabs.filter(tab => tab.id !== request.params.tabId); database.saveSession(request.sessionId, current.layout, null, []) }
    return { applied: true }
  })
  const providers: AgentProviderInfo[] = [
    { id: 'codex', displayName: 'Codex', available: true, installUrl: '', models: [{ id: 'codex-synthetic', label: 'Codex Synthetic' }], efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { id: 'local', displayName: 'Local', available: true, installUrl: '', models: [{ id: LOCAL, label: 'Qwen test (local)' }], efforts: [{ id: 'auto', label: 'Provider default' }] }
  ]
  const availability = vi.fn(async (id: string) => options.availability(id))
  const control = new AgentControl({ database, sessions, orchestration, collaboration, backlogs: new ProjectBacklogs(database), ui, confirm: vi.fn(async () => false), fileChanged: vi.fn(), providers: () => providers,
    localModels: { availability, vramTotalGb: () => 12 } })
  const service = createModelIntelligence({
    dbPath: path, settings: database, timers: { every: () => () => {}, after: () => () => {} }, log: () => {},
    sources: { configured: { catalogs: () => ({ providers, localModels: [{ id: LOCAL, label: 'Qwen test (local)', quant: 'Q4_K_M', sizeBytes: 5 * GiB, contextTokens: 32_768, gpuLayers: 999, vramBytes: options.vramBytes }] }) } }
  })
  dispose.push(() => service.dispose())
  control.setModelIntelligence(service)
  return { control, scope, service, availability, closed, database, interrupted }
}

const CHEAP = { features: { category: 'simple-coding', complexity: 1, risk: 'low' }, constraints: { costWeight: 0.9 } }
const pick = (decision: RouteDecision, model: string) => decision.candidates.find(candidate => candidate.key.model === model)!

describe('routing live facts and dispatch (AgentControl over model intelligence)', () => {
  it('routes cheap work to the local model only while it fits the VRAM and can be admitted (D4)', async () => {
    const admitted = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }) })
    await admitted.service.refresh(['configured'])
    const ok = await admitted.control.call(admitted.scope, 'models.route', CHEAP) as { decision: RouteDecision }
    expect(ok.decision.selected.key.model).toBe(LOCAL)

    const tooBig = fixture({ vramBytes: 20 * GiB, availability: () => ({ available: true }) })
    await tooBig.service.refresh(['configured'])
    const big = await tooBig.control.call(tooBig.scope, 'models.route', CHEAP) as { decision: RouteDecision; explanation: string }
    expect(pick(big.decision, LOCAL)).toMatchObject({ eligible: false, excluded: 'needs 20 GB of VRAM, the card has 12 GB' })
    expect(big.explanation).toContain('needs 20 GB of VRAM, the card has 12 GB')

    const busy = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: false, reason: 'Ornith (local/ornith) is busy' }) })
    await busy.service.refresh(['configured'])
    const refused = await busy.control.call(busy.scope, 'models.route', CHEAP) as { decision: RouteDecision }
    expect(pick(refused.decision, LOCAL)).toMatchObject({ eligible: false, excluded: 'cannot be admitted now: Ornith (local/ornith) is busy' })
    expect(refused.decision.selected.key.provider).toBe('codex')
  })

  it('retries a routed open once on the fallback when the choice cannot open, and journals both attempts', async () => {
    let calls = 0
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ++calls === 1 ? { available: true } : { available: false, reason: 'the GPU was taken meanwhile' } })
    await f.service.refresh(['configured'])
    const [result] = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Typo', prompt: 'Fix a typo in the readme', route: CHEAP }] }) as Array<{ provider: string; model: string; decisionId: string; accepted: boolean }>
    expect(result).toMatchObject({ provider: 'codex', model: 'codex-synthetic', accepted: true })
    const attempts = f.service.store.decision(result!.decisionId)!.route!.attempts!
    expect(attempts.map(attempt => [attempt.key.model, attempt.ok, attempt.error ?? null])).toEqual([[LOCAL, false, 'the GPU was taken meanwhile'], ['codex-synthetic', true, null]])
  })

  it('runs one cloud evaluation turn through a background native tab at the lowest effort and closes it', async () => {
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }) })
    const result = await f.control.evaluationTurn({ provider: 'codex', model: 'codex-synthetic' }, { system: 'Answer.', user: 'Say 42' }, new AbortController().signal)
    expect(result).toMatchObject({ answer: '42', effort: 'low', tokens: expect.any(Number) })
    expect(result.tokens).toBeGreaterThan(0)
    expect(f.closed).toHaveLength(1)
    await expect(f.control.evaluationTurn({ provider: 'codex', model: 'not-offered' }, { system: 's', user: 'u' }, new AbortController().signal)).rejects.toThrow(/not offered/)
  })

  // N3: spend counts cache reads and writes; a failed, stopped or usage-less turn counts at least its budget.
  const SYNTHETIC = { provider: 'codex', model: 'codex-synthetic' }
  const PROMPT = { system: 'Answer.', user: 'Say 42' }
  it('counts cache reads and writes in an evaluation turn', async () => {
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => {
      emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
      emit({ turnId: 't1', itemId: 'answer', data: { type: 'text', role: 'assistant', text: '42', mode: 'snapshot' } })
      emit({ turnId: 't1', itemId: 'usage', data: { type: 'usage', inputTokens: 9_000, cachedTokens: 8_000, cacheCreationTokens: 500, outputTokens: 100, scope: 'turn', source: 'provider' } })
      emit({ turnId: 't1', data: { type: 'session', phase: 'completed' } })
    } })
    // The whole input comes back too: the fixed overhead is learned from it (N9).
    expect(await f.control.evaluationTurn(SYNTHETIC, PROMPT, new AbortController().signal, { maxTokens: 20_000 })).toMatchObject({ tokens: 9_100, inputTokens: 9_000 })
  })
  // N14: the fixed overhead is learned from the turn's first API call, not the summed input of every call.
  const usageItem = (itemId: string, data: Record<string, unknown>, parentId?: string) => ({ turnId: 't1', itemId, ...(parentId ? { parentId } : {}), data: { type: 'usage', source: 'provider', ...data } })
  it('learns from the first API call of a turn that reports its calls (Claude), ignoring subagent calls', async () => {
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => {
      emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
      // Three API calls of one turn (a tool call in between), a subagent's own call, and the turn total.
      for (const [id, input] of [['m1', 45_000], ['m2', 52_000], ['m3', 60_000]] as const) emit(usageItem(`usage:message:${id}`, { scope: 'message', inputTokens: input, outputTokens: 300 }))
      emit(usageItem('usage:message:sub', { scope: 'message', inputTokens: 1_000, outputTokens: 50 }, 'task:sub'))
      emit(usageItem('usage:turn:t1', { scope: 'turn', inputTokens: 157_000, outputTokens: 900 }))
      emit({ turnId: 't1', itemId: 'answer', data: { type: 'text', role: 'assistant', text: '### JOB j\n42', mode: 'snapshot' } })
      emit({ turnId: 't1', data: { type: 'session', phase: 'completed' } })
    } })
    const result = await f.control.evaluationTurn(SYNTHETIC, PROMPT, new AbortController().signal, { maxTokens: 200_000 })
    expect(result.inputTokens).toBe(45_000)
    // Through the port, the learned value is that first call's input less the prompt it was sent.
    const job: EvaluationJob = { id: 'j', category: 'simple-coding', complexity: 1, prompt: 'Say 42', grader: { kind: 'exact', expected: '42' } }
    const prompt = evaluationPrompt(job)
    const run = await cloudRunPort((key, sent, signal, options) => f.control.evaluationTurn(key, sent, signal, options))(SYNTHETIC, job, new AbortController().signal, { maxTokens: 200_000 })
    expect(run.overheadTokens).toBe(45_000 - Math.ceil((prompt.system.length + prompt.user.length) / 4))
  })
  it('falls back to the whole turn input when only turn totals are reported (Codex)', async () => {
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => {
      emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
      emit(usageItem('usage:thread', { scope: 'session', inputTokens: 70_000, cachedTokens: 30_000, outputTokens: 500 }))
      emit({ turnId: 't1', itemId: 'answer', data: { type: 'text', role: 'assistant', text: '42', mode: 'snapshot' } })
      emit({ turnId: 't1', data: { type: 'session', phase: 'completed' } })
    } })
    expect((await f.control.evaluationTurn(SYNTHETIC, PROMPT, new AbortController().signal, { maxTokens: 200_000 })).inputTokens).toBe(70_000)
  })
  it('a failed turn carries the first call\'s input for the overhead too', async () => {
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => {
      emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
      emit(usageItem('usage:message:m1', { scope: 'message', inputTokens: 41_000, outputTokens: 10 }))
      emit(usageItem('usage:message:m2', { scope: 'message', inputTokens: 48_000, outputTokens: 10 }))
      emit({ turnId: 't1', data: { type: 'session', phase: 'failed' } })
    } })
    await expect(f.control.evaluationTurn(SYNTHETIC, PROMPT, new AbortController().signal, { maxTokens: 200_000 })).rejects.toMatchObject({ inputTokens: 41_000 })
  })

  it('counts a usage-less turn at its budget', async () => {
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => {
      emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
      emit({ turnId: 't1', itemId: 'answer', data: { type: 'text', role: 'assistant', text: '42', mode: 'snapshot' } })
      emit({ turnId: 't1', data: { type: 'session', phase: 'completed' } })
    } })
    expect((await f.control.evaluationTurn(SYNTHETIC, PROMPT, new AbortController().signal, { maxTokens: 6_000 })).tokens).toBe(6_000)
  })
  it('throws a failed turn with its budget as the spend, or its usage when that is higher', async () => {
    const failed = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => {
      emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
      emit({ turnId: 't1', data: { type: 'session', phase: 'failed' } })
    } })
    await expect(failed.control.evaluationTurn(SYNTHETIC, PROMPT, new AbortController().signal, { maxTokens: 6_000 })).rejects.toMatchObject({ message: 'the evaluation turn ended failed', tokens: 6_000 })
    expect(failed.closed).toHaveLength(1)
    const heavy = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => {
      emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
      emit({ turnId: 't1', itemId: 'usage', data: { type: 'usage', inputTokens: 7_000, outputTokens: 500, scope: 'turn', source: 'provider' } })
      emit({ turnId: 't1', data: { type: 'session', phase: 'failed' } })
    } })
    await expect(heavy.control.evaluationTurn(SYNTHETIC, PROMPT, new AbortController().signal, { maxTokens: 6_000 })).rejects.toMatchObject({ tokens: 7_500 })
  })
  it('interrupts a turn whose usage passes its budget and counts what it spent', async () => {
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => {
      emit({ turnId: 't1', data: { type: 'session', phase: 'running' } })
      emit({ turnId: 't1', itemId: 'usage', data: { type: 'usage', inputTokens: 9_000, outputTokens: 200, scope: 'turn', source: 'provider' } })
    } })
    await expect(f.control.evaluationTurn(SYNTHETIC, PROMPT, new AbortController().signal, { maxTokens: 6_000 })).rejects.toMatchObject({ message: 'the evaluation turn passed its 6000-token budget and was stopped', tokens: 9_200 })
    expect(f.interrupted).toHaveLength(1)
  })
  it('an aborted turn still reports its budget as spent', async () => {
    const f = fixture({ vramBytes: 7 * GiB, availability: () => ({ available: true }), turn: emit => { emit({ turnId: 't1', data: { type: 'session', phase: 'running' } }) } })
    const controller = new AbortController()
    const pending = f.control.evaluationTurn(SYNTHETIC, PROMPT, controller.signal, { maxTokens: 6_000 })
    setTimeout(() => controller.abort(), 300)
    await expect(pending).rejects.toMatchObject({ message: 'evaluation turn aborted', tokens: 6_000 })
  })
})
