import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DurableJob, DurableJobStage } from '../../shared/durable-jobs'
import type { LocalStopReport } from '../../shared/local-stop'
import type { Json, SessionProjection, TimelineItem } from '../../shared/structured-agent'
import { DurableJobsServiceImpl } from './index'
import type { StageObservation } from './ports'
import { LocalGenerationGate } from './server-lifecycle'
import { DurableJobStore } from './store'
import { FakeRuntime, FakeWorktrees, tick, until } from './test-fakes'
import { durableJobPorts, gatedRuntime, handoffPort, serverPort, supervisionPorts } from './wiring'

const dirs: string[] = []
const services: DurableJobsServiceImpl[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await new Promise(resolve => setTimeout(resolve, 30))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const window = { modelConfig: () => ({ id: 'qwen3.6-35b-a3b', contextTokens: 32_768 }) }
const job = (extra: Partial<DurableJob> = {}): DurableJob => ({
  id: 'job_1', projectId: 'p', cwd: 'C:/work', title: 'Overnight', objective: 'Summarise the modules', status: 'running',
  model: { provider: 'local', model: 'local/qwen3.6-35b-a3b', escalation: 'never' },
  budgets: { maxElapsedMs: 0, modelCallTimeoutMs: 600_000, toolCallTimeoutMs: 900_000, stageTimeoutMs: 5_400_000, maxStageAttempts: 3, contextRolloverFraction: 0.7, contextSafetyMarginTokens: 2_048 },
  handoff: { objective: 'Summarise the modules', constraints: [], decisions: [], workDone: [], filesChanged: [], testResults: [], unresolvedIssues: [], nextAction: '', artifacts: [], updatedAt: '' },
  createdAt: '', updatedAt: '', activeMs: 0, counters: { stagesCompleted: 0, retries: 0, recoveries: 0, contextRollovers: 0, loopsDetected: 0, cloudEscalations: 0 }, logDir: 'C:/logs/job_1', ...extra
})
const stage = (extra: Partial<DurableJobStage> = {}): DurableJobStage => ({ id: 'stage_1', jobId: 'job_1', index: 0, title: 'Summarise', objective: 'Summarise a.ts', completionCriteria: [], inputs: [], status: 'running', attempt: 1, ...extra })
const report = (usedTokens: number, extra: Partial<LocalStopReport> = {}): LocalStopReport => ({ reason: 'completed', detail: 'done', rounds: 4, hardLimit: 40, context: { usedTokens, capacityTokens: 28_672, reserveTokens: 4_096, windowTokens: 32_768, percent: usedTokens / 327.68, estimated: false }, compactions: 0, recoveredTokens: 0, loopWarnings: 0, filesChanged: ['notes.md'], commandsRun: 1, excludedOutputChars: 0, timeline: [], ...extra })
const observed = (answer: string, stop?: LocalStopReport): StageObservation => ({ phase: 'completed', stopSequence: 1, lastAnswer: answer, filesChanged: [], ...(stop ? { stop: { reason: stop.reason, detail: stop.detail, filesChanged: stop.filesChanged, ...(stop.acceptance ? { acceptance: stop.acceptance } : {}) }, report: stop } : {}) })

describe('handoff port', () => {
  it('builds a bounded fresh-context prompt that asks for the status line and carries the retry reason', () => {
    const prompt = handoffPort(window).stagePrompt({ job: job(), stage: stage({ attempt: 2 }), stages: [stage()], handoff: job().handoff, retryOf: 'context_limit: the window filled' })
    expect(prompt).toContain('This is a fresh context')
    expect(prompt).toContain('PREVIOUS ATTEMPT')
    expect(prompt).toContain('context_limit: the window filled')
    expect(prompt.trimEnd().endsWith('when more work remains.')).toBe(true)
  })

  it('refuses a stage whose fixed part cannot fit a fresh context', () => {
    expect(() => handoffPort(window).stagePrompt({ job: job({ budgets: { ...job().budgets, stagePromptBudgetTokens: 600 } }), stage: stage({ objective: 'x '.repeat(4_000) }), stages: [stage()], handoff: job().handoff })).toThrow(/cannot start in a fresh context/)
  })

  it('turns a CONTINUE line into the next stage, records tests and counts a rollover past the threshold', () => {
    const stop = report(24_000, { acceptance: { command: 'npm test', passed: true, exitCode: 0 } })
    const decision = handoffPort(window).afterStage({ job: job(), stage: stage(), stages: [stage()], observation: observed('Summarised a.ts into notes.md.\nJOB STATUS: CONTINUE: summarise b.ts', stop), succeeded: true })
    expect(decision.jobDone).toBe(false)
    expect(decision.nextStage).toMatchObject({ title: 'Stage 2', objective: 'summarise b.ts' })
    expect(decision.handoff.nextAction).toBe('summarise b.ts')
    expect(decision.handoff.filesChanged).toContain('notes.md')
    expect(decision.result).toBe('Summarised a.ts into notes.md.')
    expect(decision.tests).toEqual([{ command: 'npm test', outcome: 'pass' }])
    expect(decision.contextRollover).toBe(true)
    const small = handoffPort(window).afterStage({ job: job(), stage: stage(), stages: [stage()], observation: observed('All done.\nJOB STATUS: DONE', report(9_000)), succeeded: true })
    expect(small).toMatchObject({ jobDone: true, contextRollover: false, nextStage: undefined })
  })
})

describe('supervision ports', () => {
  const store = (): DurableJobStore => new DurableJobStore(':memory:')
  const toolItem = (id: string, name: string, input: { [key: string]: Json }, output: string, failed: boolean, sequence: number): TimelineItem => ({ id, runtimeId: 'r', sequence, timestamp: '', data: { type: 'tool', name, input, status: failed ? 'failed' : 'completed', output } })
  const projection = (items: TimelineItem[]): SessionProjection => ({ sessionId: 's', runtimeId: 'r', phase: 'running', sequence: items.length, items, settings: { permission: 'accept-edits', plan: false }, title: 't', archived: false, truncated: false })

  it('blocks for the owner when the same step keeps being refused, instead of retrying it', async () => {
    const items: TimelineItem[] = []
    const ports = supervisionPorts({ store: store(), snapshot: () => projection(items), modelConfig: window.modelConfig, probeHealth: async () => ({ healthy: true }), serverPorts: async () => { throw new Error('unused') }, endpointOverride: () => null, gate: new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null }), watchdog: { tickMs: 5 } })
    const stuck: string[] = []
    const watch = ports.watchdog.watch({ job: job(), stage: stage(), agentSessionId: 's' }, reason => stuck.push(reason))
    items.push(toolItem('t1', 'run_command', { command: 'npm install left-pad' }, 'npm installs are refused: there is no network', true, 1))
    items.push(toolItem('t2', 'run_command', { command: 'npm install left-pad' }, 'npm installs are refused: there is no network', true, 2))
    await until(() => stuck.length > 0)
    watch.dispose()
    expect(stuck[0]).toMatch(/needs the owner/)
    expect(ports.loopGuard.assess({ job: job(), stage: stage(), stages: [stage()], observation: observed(''), error: 'x', previousErrors: [] })).toMatchObject({ loop: true, kind: 'approval' })
  })

  it('replans once on a repeated identical call, then blocks the stage with evidence', async () => {
    const jobs = store()
    const service = new DurableJobsServiceImpl({ store: jobs, runtime: new FakeRuntime([{ kind: 'hang' }]), worktrees: new FakeWorktrees(), logRoot: mkdtempSync(join(tmpdir(), 'wiring-')), projectPath: () => 'C:/p', sleep: tick, pollMs: 0 })
    services.push(service)
    const created = await service.create({ projectId: 'p', title: 'Loop', objective: 'Read a file', model: 'local/qwen3.6-35b-a3b' })
    await until(() => service.get(created.id).stages[0]!.status === 'running')
    const running = jobs.get(created.id)
    const items: TimelineItem[] = []
    const ports = supervisionPorts({ store: jobs, snapshot: () => projection(items), modelConfig: window.modelConfig, probeHealth: async () => ({ healthy: true }), serverPorts: async () => { throw new Error('unused') }, endpointOverride: () => null, gate: new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null }), watchdog: { tickMs: 5 } })
    const runStage = async (): Promise<string> => {
      const stuck: string[] = []
      const current = service.get(created.id).stages[0]!
      const watch = ports.watchdog.watch({ job: running, stage: current, agentSessionId: 's' }, reason => stuck.push(reason))
      for (let i = 0; i < 6 && !stuck.length; i++) { items.push(toolItem(`c${items.length}`, 'read_file', { path: 'a.ts' }, 'same content', false, items.length + 1)); await new Promise(resolve => setTimeout(resolve, 15)) }
      await until(() => stuck.length > 0)
      watch.dispose()
      return stuck[0]!
    }
    expect(await runStage()).toMatch(/loop guard replan/)
    expect(jobs.events(created.id).filter(event => event.kind === 'loop-detected')).toHaveLength(1)
    expect(await runStage()).toMatch(/^loop: /)
    expect(ports.loopGuard.assess({ job: running, stage: service.get(created.id).stages[0]!, stages: [], observation: observed(''), error: 'x', previousErrors: [] })).toMatchObject({ loop: true, kind: 'loop' })
  })
})

describe('server port and generation gate', () => {
  it('skips the server when a test endpoint stands in for llama-server', async () => {
    const port = serverPort({ store: new DurableJobStore(':memory:'), serverPorts: async () => { throw new Error('must not supervise') }, endpointOverride: () => 'http://127.0.0.1:1' })
    expect(await port.ensureReady('local/qwen3.6-35b-a3b')).toEqual({ ready: true })
    expect(await port.recover('local/qwen3.6-35b-a3b', 'x')).toBe(false)
  })

  it('holds the gate for a stage and releases it when the conversation settles', async () => {
    const gate = new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null })
    const inner = new FakeRuntime([{ kind: 'answer', text: 'ok' }])
    let turnStarted: (() => void) | undefined
    const runtime = gatedRuntime(inner, gate, listener => { turnStarted = listener; return () => { turnStarted = undefined } })
    const { agentSessionId } = await runtime.open({ job: job(), stage: stage(), title: 't' })
    await runtime.submit(agentSessionId, 'go')
    expect(gate.holder()).toBe('job_1')
    turnStarted?.()
    expect(gate.yieldRequested()).toBe(true)
    await until(() => runtime.observe(agentSessionId).phase === 'completed')
    expect(gate.holder()).toBeNull()
    runtime.dispose()
    expect(turnStarted).toBeUndefined()
  })
})

describe('service with the real ports', () => {
  it('persists the creator and stage kinds, lists checkpoints and writes report.md, and blocks (not fails) at the elapsed budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-service-')); dirs.push(dir)
    let now = Date.parse('2026-09-24T00:00:00Z')
    const store = new DurableJobStore(':memory:', () => new Date(now))
    const ports = durableJobPorts({ store, snapshot: () => null, modelConfig: window.modelConfig, probeHealth: async () => ({ healthy: true }), serverPorts: async () => { throw new Error('unused') }, endpointOverride: () => 'stub', gate: new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null }) })
    const runtime = new FakeRuntime([], { kind: 'answer', text: 'A part done.\nJOB STATUS: CONTINUE: do the next part' })
    const service = new DurableJobsServiceImpl({ store, runtime, worktrees: new FakeWorktrees(), logRoot: dir, projectPath: () => dir, sleep: tick, pollMs: 0, clock: () => new Date(now), ...ports })
    services.push(service)
    const created = await service.create({ projectId: 'p', title: 'Budgeted', objective: 'Two parts', model: 'local/qwen3.6-35b-a3b', budgets: { maxElapsedMs: 60_000 }, stages: [{ title: 'Investigate the parser', kind: 'investigate', objective: 'Read it', completionCriteria: [] }], createdBy: { kind: 'agent', agentSessionId: 'agent_x', title: 'Controller' } })
    const stored = service.get(created.id)
    expect(stored.createdBy).toEqual({ kind: 'agent', agentSessionId: 'agent_x', title: 'Controller' })
    expect(stored.stages[0]!.kind).toBe('investigate')
    await until(() => service.get(created.id).stages[0]!.status === 'completed')
    now += 120_000
    await until(() => service.status(created.id).status === 'blocked')
    expect(service.status(created.id).statusReason).toMatch(/elapsed-time budget/)
    expect(service.checkpoints(created.id)).toEqual(store.checkpoints(created.id))
    const written = await service.report(created.id)
    expect(written.reportPath.endsWith('report.md')).toBe(true)
    expect(readFileSync(written.reportPath, 'utf8')).toContain('Budgeted')
  })
})
