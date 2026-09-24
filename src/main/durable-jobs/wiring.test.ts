import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DurableJob, DurableJobStage } from '../../shared/durable-jobs'
import type { LocalStopReport } from '../../shared/local-stop'
import type { Json, SessionProjection, TimelineItem } from '../../shared/structured-agent'
import { DurableJobsServiceImpl } from './index'
import type { StageObservation } from './ports'
import { LocalGenerationGate, type ServerLifecyclePorts, type ServerObservation } from './server-lifecycle'
import { DurableJobStore } from './store'
import { FakeRuntime, FakeWorktrees, tick, until, type ScriptedOutcome } from './test-fakes'
import type { HealthProbe } from './watchdog'
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

  it('treats three differently-worded permission refusals in a row as the same block', () => {
    const ports = supervisionPorts({ store: store(), snapshot: () => projection([]), modelConfig: window.modelConfig, probeHealth: async () => ({ healthy: true }), serverPorts: async () => { throw new Error('unused') }, endpointOverride: () => null, gate: new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null }), watchdog: { tickMs: 5 } })
    const previousErrors = ['I cannot run npm install: no network access in this sandbox.', 'The install is not permitted here; the host must run it with network access.']
    expect(ports.loopGuard.assess({ job: job(), stage: stage(), stages: [stage()], observation: observed(''), error: 'This step requires the owner\'s approval to install left-pad.', previousErrors })).toMatchObject({ loop: true, kind: 'approval' })
    // Two unrelated failures do not trip it.
    expect(ports.loopGuard.assess({ job: job(), stage: stage(), stages: [stage()], observation: observed(''), error: 'This step requires the owner\'s approval to install left-pad.', previousErrors: ['a.ts has a syntax error', 'still a syntax error'] })).toMatchObject({ loop: false })
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

  it('restores a late replan for this stage and ignores a late replan for another stage', async () => {
    const fill = (jobs: DurableJobStore, extra: () => void) => {
      jobs.create(job(), [stage()], false)
      jobs.batch('job_1', () => {
        for (let i = 0; i < 1_000; i++) jobs.event('job_1', { owner: true }, 'note', `filler ${i}`)
        extra()
      })
    }
    const drive = async (jobs: DurableJobStore): Promise<string> => {
      const items: TimelineItem[] = []
      const ports = supervisionPorts({ store: jobs, snapshot: () => projection(items), modelConfig: window.modelConfig, probeHealth: async () => ({ healthy: true }), serverPorts: async () => { throw new Error('unused') }, endpointOverride: () => null, gate: new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null }), watchdog: { tickMs: 5 } })
      const stuck: string[] = []
      const watch = ports.watchdog.watch({ job: jobs.get('job_1'), stage: stage(), agentSessionId: 's' }, reason => stuck.push(reason))
      for (let i = 0; i < 8 && !stuck.length; i++) { items.push(toolItem(`c${items.length}`, 'read_file', { path: 'a.ts' }, 'same content', false, items.length + 1)); await new Promise(resolve => setTimeout(resolve, 15)) }
      await until(() => stuck.length > 0)
      watch.dispose()
      return stuck[0]!
    }
    const blocked = store()
    fill(blocked, () => {
      blocked.event('job_1', { owner: true }, 'loop-detected', 'other stage replan', { stageId: 'other', replan: 1 })
      blocked.event('job_1', { owner: true }, 'loop-detected', 'plural does not count', { stageId: 'stage_1', replans: 9, blocked: true })
      blocked.event('job_1', { owner: true }, 'loop-detected', 'late replan for this stage', { stageId: 'stage_1', replan: 1 })
    })
    expect(blocked.events('job_1', undefined, 1_000).some(event => event.message === 'late replan for this stage')).toBe(false)
    expect(await drive(blocked)).toMatch(/^loop: /)
    blocked.close()

    const otherOnly = store()
    fill(otherOnly, () => { otherOnly.event('job_1', { owner: true }, 'loop-detected', 'late replan for another stage', { stageId: 'other', replan: 1 }) })
    expect(otherOnly.events('job_1', undefined, 1_000).some(event => event.message === 'late replan for another stage')).toBe(false)
    expect(await drive(otherOnly)).toMatch(/loop guard replan/)
    otherOnly.close()
  })

  /** A watch on a fake clock: each step moves the clock at most a minute and lets the watch tick. */
  const clocked = (probe: HealthProbe) => {
    let now = 0
    const items: TimelineItem[] = []
    const ports = supervisionPorts({ store: store(), snapshot: () => projection(items), modelConfig: window.modelConfig, probeHealth: async () => probe, serverPorts: async () => { throw new Error('unused') }, endpointOverride: () => null, gate: new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null }), now: () => now, watchdog: { tickMs: 5, clockJumpMs: 24 * 3_600_000 } })
    const stuck: string[] = []
    const watch = ports.watchdog.watch({ job: job(), stage: stage(), agentSessionId: 's' }, reason => stuck.push(reason))
    const advance = async (ms: number): Promise<void> => {
      for (let spent = 0; spent < ms;) { const step = Math.min(60_000, ms - spent); now += step; spent += step; await new Promise(resolve => setTimeout(resolve, 25)) }
    }
    const running = (id: string, name: string, input: { [key: string]: Json }, sequence: number): TimelineItem => ({ id, runtimeId: 'r', sequence, timestamp: '', data: { type: 'tool', name, input, status: 'running' } })
    return { items, stuck, watch, advance, running }
  }
  // job(): modelCallTimeoutMs 10 min, toolCallTimeoutMs 15 min; the stall window is 3 min.
  const minutes = (count: number): number => count * 60_000

  it('gives a quiet running tool the tool budget, past the model timeout, then watches the model again', async () => {
    const { items, stuck, watch, advance, running } = clocked({ healthy: true, processing: false })
    items.push(running('t1', 'run_command', { command: 'npm test' }, 1))
    await advance(1_000)
    await advance(minutes(12))
    expect(stuck).toEqual([])
    items[0] = toolItem('t1', 'run_command', { command: 'npm test' }, 'Tests passed', false, 2)
    await advance(1_000)
    expect(stuck).toEqual([])
    // The model's turn after the tool is a model call again: silence there is a stall.
    await advance(minutes(4))
    watch.dispose()
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatch(/^no progress for \d+s and the server is not processing/)
  })

  it('stops a tool that runs past the tool budget, and not before', async () => {
    const { items, stuck, watch, advance, running } = clocked({ healthy: true, processing: false })
    items.push(running('t1', 'run_command', { command: 'npm run build' }, 1))
    await advance(1_000)
    await advance(minutes(14))
    expect(stuck).toEqual([])
    await advance(minutes(2))
    watch.dispose()
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatch(/run_command ran past its 900s tool-call budget/)
  })

  it('still stops a silent model call as a stall when no tool is running', async () => {
    const { stuck, watch, advance } = clocked({ healthy: true, processing: false })
    await advance(minutes(2))
    expect(stuck).toEqual([])
    await advance(minutes(2))
    watch.dispose()
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatch(/^no progress for \d+s and the server is not processing/)
  })
})

describe('generation gate across an approval block', () => {
  const model = 'local/qwen3.6-35b-a3b'
  const gated = (script: ScriptedOutcome[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-gate-')); dirs.push(dir)
    const gate = new LocalGenerationGate({ now: Date.now, sleep: tick, interactiveActive: async () => null })
    const inner = new FakeRuntime(script)
    const store = new DurableJobStore(':memory:')
    const service = new DurableJobsServiceImpl({ store, runtime: gatedRuntime(inner, gate), worktrees: new FakeWorktrees(), logRoot: dir, projectPath: () => dir, sleep: tick, pollMs: 0, interruptGraceMs: 200 })
    services.push(service)
    return { gate, inner, store, service }
  }
  const finished = (answer: string): StageObservation => ({ phase: 'completed', stopSequence: 1, stop: { reason: 'completed', detail: 'done', filesChanged: [] }, lastAnswer: answer, filesChanged: [] })

  it('releases local generation capacity while a job waits on an approval, so a second job runs', async () => {
    const { gate, service } = gated([{ kind: 'approval' }, { kind: 'answer', text: 'Second done.\nJOB STATUS: DONE' }])
    const first = await service.create({ projectId: 'p', title: 'Needs approval', objective: 'Install a package', model })
    await until(() => service.status(first.id).status === 'blocked')
    const second = await service.create({ projectId: 'p', title: 'Second', objective: 'Summarise the modules', model })
    // Before the fix the second job showed running forever, queued on the gate the blocked job held.
    await until(() => service.status(second.id).status === 'completed').catch(() => { throw new Error(`second job starved: ${service.status(second.id).status}, gate held by ${gate.holder() === first.id ? 'the blocked job' : gate.holder()}`) })
    expect(service.status(first.id).status).toBe('blocked')
    expect(gate.holder()).toBeNull()
  })

  it('resumes the answered approval in the same conversation only after reacquiring the gate behind a running job', async () => {
    const { gate, inner, store, service } = gated([{ kind: 'approval' }, { kind: 'hang' }])
    const first = await service.create({ projectId: 'p', title: 'Needs approval', objective: 'Install a package', model })
    await until(() => service.status(first.id).status === 'blocked')
    const firstSession = service.get(first.id).stages[0]!.agentSessionId!
    const second = await service.create({ projectId: 'p', title: 'Second', objective: 'Summarise the modules', model })
    await until(() => gate.holder() === second.id && Boolean(service.get(second.id).stages[0]!.agentSessionId))
    const secondSession = service.get(second.id).stages[0]!.agentSessionId!
    // The owner answers the approval in the stage tab: the same conversation carries on.
    inner.set(firstSession, { phase: 'running', stopSequence: 0, lastAnswer: '', filesChanged: [] })
    await service.resume(first.id)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(service.status(first.id).status).toBe('running')
    expect(gate.holder()).toBe(second.id)
    inner.set(secondSession, finished('Second done.\nJOB STATUS: DONE'))
    await until(() => gate.holder() === first.id)
    expect(service.status(second.id).status).toBe('completed')
    inner.set(firstSession, finished('Installed.\nJOB STATUS: DONE'))
    await until(() => service.status(first.id).status === 'completed')
    expect(gate.holder()).toBeNull()
    // Exactly once: no new conversation, no second prompt, one attempt, one model call settled.
    expect(inner.opened).toEqual([firstSession, secondSession])
    expect(inner.prompts).toHaveLength(2)
    expect(service.get(first.id).stages[0]!.attempt).toBe(1)
    const calls = store.operations(first.id).filter(operation => operation.kind === 'model-call')
    expect(calls.map(operation => operation.status)).toEqual(['done'])
    expect(service.events(first.id).filter(event => event.kind === 'approval')).toHaveLength(1)
  })

  it('blocks again without holding the gate when resumed before the approval is answered', async () => {
    const { gate, inner, service } = gated([{ kind: 'approval' }])
    const first = await service.create({ projectId: 'p', title: 'Needs approval', objective: 'Install a package', model })
    await until(() => service.status(first.id).status === 'blocked')
    await service.resume(first.id)
    await until(() => service.status(first.id).status === 'blocked' && !service.controller.isRunning(first.id))
    expect(gate.holder()).toBeNull()
    expect(inner.opened).toHaveLength(1)
    expect(inner.prompts).toHaveLength(1)
    expect(service.events(first.id).filter(event => event.kind === 'approval')).toHaveLength(2)
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

describe('server wait under an owner command', () => {
  /** Another model holds the one server and is busy: the supervisor waits (30 s polls, up to 2 h). */
  function occupied() {
    const state = { ensureCalls: [] as Array<{ allowSwitch: boolean }>, free: false, modelId: '' }
    const other: ServerObservation = { recordPresent: true, pid: 7, pidAlive: true, port: 8081, listening: true, health: { ok: true, status: 200, models: ['local/other'] } }
    const ports: ServerLifecyclePorts = {
      now: Date.now,
      sleep: ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.() }),
      probe: async () => state.free ? { ...other, health: { ok: true, status: 200, models: [state.modelId] } } : other,
      ensure: async opts => { state.ensureCalls.push(opts); return { ok: false, reason: 'other-model', running: { model: 'local/other', ours: true, busy: 'an interactive chat' }, message: 'busy' } },
      emit: () => undefined
    }
    return { state, serverPorts: async (id: string) => { state.modelId = id; return ports } }
  }
  const settlesWithin = (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('still waiting'), ms))])

  function service(serverPorts: ReturnType<typeof occupied>['serverPorts']) {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-server-wait-')); dirs.push(dir)
    const store = new DurableJobStore(':memory:')
    const runtime = new FakeRuntime([], { kind: 'answer', text: 'ok\nJOB STATUS: DONE' })
    const jobs = new DurableJobsServiceImpl({ store, runtime, worktrees: new FakeWorktrees(), logRoot: dir, projectPath: () => dir, sleep: tick, pollMs: 0, server: serverPort({ store, serverPorts, endpointOverride: () => null }) })
    services.push(jobs)
    return { jobs, runtime }
  }

  it('stops waiting for the server as soon as the owner pauses, and resumes cleanly', async () => {
    const { state, serverPorts } = occupied()
    const { jobs, runtime } = service(serverPorts)
    const created = await jobs.create({ projectId: 'p', title: 'Waits', objective: 'Work', model: 'local/qwen3.6-35b-a3b' })
    await until(() => state.ensureCalls.length === 1)
    jobs.pause(created.id)
    expect(await settlesWithin(jobs.controller.idle(created.id), 1_000)).toBe('settled')
    expect(runtime.opened).toHaveLength(0)
    state.free = true
    await jobs.resume(created.id)
    await until(() => jobs.status(created.id).status === 'completed')
    expect(runtime.opened).toHaveLength(1)
  })

  it('stops waiting as soon as the owner cancels and never starts or switches a model afterwards', async () => {
    const { state, serverPorts } = occupied()
    const { jobs, runtime } = service(serverPorts)
    const created = await jobs.create({ projectId: 'p', title: 'Waits', objective: 'Work', model: 'local/qwen3.6-35b-a3b' })
    await until(() => state.ensureCalls.length === 1)
    await jobs.cancel(created.id)
    expect(await settlesWithin(jobs.controller.idle(created.id), 1_000)).toBe('settled')
    for (let i = 0; i < 20; i++) await tick()
    expect(state.ensureCalls).toEqual([{ allowSwitch: false }])
    expect(runtime.opened).toHaveLength(0)
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
