import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CreateDurableJobInput } from '../../shared/durable-jobs'
import { DurableJobsServiceImpl } from './index'
import { stageSucceeded } from './controller'
import { DurableJobStore } from './store'
import { FakeRuntime, FakeWorktrees, tick, until, type ScriptedOutcome } from './test-fakes'

const dirs: string[] = []
const services: DurableJobsServiceImpl[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  // Reports are written asynchronously after a terminal status.
  await new Promise(resolve => setTimeout(resolve, 30))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(script: ScriptedOutcome[] = [], options: { worktrees?: FakeWorktrees; store?: DurableJobStore; runtime?: FakeRuntime; ownerId?: string; clock?: () => Date } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-controller-')); dirs.push(dir)
  const store = options.store ?? new DurableJobStore(':memory:', options.clock)
  const runtime = options.runtime ?? new FakeRuntime(script)
  const worktrees = options.worktrees ?? new FakeWorktrees()
  const service = new DurableJobsServiceImpl({ store, runtime, worktrees, logRoot: dir, projectPath: () => dir, ownerId: options.ownerId ?? 'pid:test', sleep: tick, pollMs: 0, interruptGraceMs: 200, ...(options.clock ? { clock: options.clock } : {}) })
  services.push(service)
  return { service, store, runtime, worktrees, dir }
}

/** Oldest-forward pages until a short page, so a test can see past the 1,000-row read cap. */
function allEvents(store: DurableJobStore, jobId: string) {
  const events: ReturnType<DurableJobStore['events']> = []
  for (let after: string | undefined; ;) {
    const page = store.events(jobId, after, 500)
    events.push(...page)
    if (page.length < 500) return events
    after = page[page.length - 1]!.id
  }
}

const input = (extra: Partial<CreateDurableJobInput> = {}): CreateDurableJobInput => ({ projectId: 'project_1', title: 'Overnight', objective: 'Refactor the parser', model: 'local/qwen3.6-35b-a3b', ...extra })
const planned = (count: number) => Array.from({ length: count }, (_, i) => ({ title: `Step ${i + 1}`, objective: `Do step ${i + 1}`, completionCriteria: ['tests pass'] }))

describe('durable job controller', () => {
  it('runs planned stages sequentially, each in a fresh local conversation on the same model, and completes', async () => {
    const { service, runtime, store } = setup([{ kind: 'answer', text: 'Step one done', filesChanged: ['a.ts'] }, { kind: 'answer', text: 'Step two done', filesChanged: ['b.ts'] }])
    const created = await service.create(input({ stages: planned(2) }))
    await until(() => service.status(created.id).status === 'completed')
    const job = service.get(created.id)
    expect(runtime.opened).toHaveLength(2)
    expect(new Set(job.stages.map(stage => stage.agentSessionId)).size).toBe(2)
    expect([...runtime.sessions.values()].map(session => session.request.job.model)).toEqual([{ provider: 'local', model: 'local/qwen3.6-35b-a3b', escalation: 'never' }, { provider: 'local', model: 'local/qwen3.6-35b-a3b', escalation: 'never' }])
    expect(job.stages.map(stage => [stage.status, stage.attempt, stage.model])).toEqual([['completed', 1, 'local/qwen3.6-35b-a3b'], ['completed', 1, 'local/qwen3.6-35b-a3b']])
    expect(job.stages[0]!.result).toBe('Step one done')
    expect(job.handoff.filesChanged).toEqual(['a.ts', 'b.ts'])
    expect(job.counters).toMatchObject({ stagesCompleted: 2, retries: 0, cloudEscalations: 0 })
    // The second stage's prompt was built from the persisted handoff, not a transcript.
    expect(runtime.prompts[1]).toContain('Step 1: Step one done')
    expect(store.operations(created.id).filter(op => op.kind === 'model-call').map(op => op.status)).toEqual(['done', 'done'])
    await until(() => Boolean(service.get(created.id).reportPath))
  })

  it('never treats an empty or truncated answer as success, retries in fresh conversations and blocks when attempts run out', async () => {
    const { service, runtime } = setup([{ kind: 'answer', text: '' }, { kind: 'answer', text: 'half an ans', reason: 'context_limit' }, { kind: 'answer', text: 'cut', reason: 'round_limit' }])
    const created = await service.create(input({ budgets: { maxStageAttempts: 3 } }))
    await until(() => service.status(created.id).status === 'blocked')
    const job = service.get(created.id)
    expect(runtime.opened).toHaveLength(3)
    expect(job.stages[0]).toMatchObject({ status: 'pending', attempt: 3 })
    expect(job.counters).toMatchObject({ retries: 3, contextRollovers: 1, stagesCompleted: 0 })
    expect(job.statusReason).toContain('used all 3 attempts')
    expect(runtime.prompts[1]).toContain('The previous attempt at this stage did not finish')

    // The owner's resume grants a fresh set of attempts.
    runtime.script.push({ kind: 'answer', text: 'Finally.\nJOB STATUS: DONE' })
    await service.resume(created.id)
    await until(() => service.status(created.id).status === 'completed')
    expect(service.get(created.id).stages[0]!.attempt).toBe(4)
  })

  it('credits back a context rollover attempt that made file progress, so a stage may roll over more times than maxStageAttempts and still complete', async () => {
    const { service, runtime, store } = setup([
      { kind: 'answer', text: 'progress 1', reason: 'context_limit', detail: 'rollover at line 40', filesChanged: ['INDEX.md'] },
      { kind: 'answer', text: 'progress 2', reason: 'context_limit', detail: 'rollover at line 80', filesChanged: ['INDEX.md'] },
      { kind: 'answer', text: 'progress 3', reason: 'context_limit', detail: 'rollover at line 120', filesChanged: ['INDEX.md'] },
      { kind: 'answer', text: 'progress 4', reason: 'context_limit', detail: 'rollover at line 150', filesChanged: ['INDEX.md'] },
      { kind: 'answer', text: 'Finally.\nJOB STATUS: DONE', filesChanged: ['INDEX.md'] }
    ])
    const created = await service.create(input({ budgets: { maxStageAttempts: 3 } }))
    await until(() => service.status(created.id).status === 'completed')
    const job = service.get(created.id)
    expect(runtime.opened).toHaveLength(5)
    // Four rollovers past a 3-attempt budget never blocked the job: each one wrote to INDEX.md,
    // so each was credited back instead of spending one of the stage's 3 attempts.
    expect(job.stages[0]).toMatchObject({ status: 'completed', attempt: 5 })
    expect(job.counters).toMatchObject({ stagesCompleted: 1, contextRollovers: 4 })
    expect(store.attemptBase(job.stages[0]!.id)).toBe(4)
  })

  it('spends the attempt on a context rollover that made no file progress, same as any other failure', async () => {
    const { service, store } = setup([
      { kind: 'answer', text: 'no progress', reason: 'context_limit' },
      { kind: 'answer', text: 'Finally.\nJOB STATUS: DONE' }
    ])
    const created = await service.create(input({ budgets: { maxStageAttempts: 3 } }))
    await until(() => service.status(created.id).status === 'completed')
    const job = service.get(created.id)
    expect(job.stages[0]).toMatchObject({ status: 'completed', attempt: 2 })
    expect(store.attemptBase(job.stages[0]!.id)).toBe(0)
  })

  it('never settles a stage completed when its completion criterion is unmet, even though the model claims done (RV1 D5)', async () => {
    const { service } = setup([{ kind: 'answer', text: 'Wrote the log.\nJOB STATUS: DONE' }])
    const created = await service.create(input({ budgets: { maxStageAttempts: 1 }, stages: [{ title: 'Write the log', objective: 'Write LOG.md with at least 3 lines', completionCriteria: ['LOG.md has 3 lines'] }] }))
    await until(() => service.status(created.id).status === 'blocked')
    const job = service.get(created.id)
    expect(job.stages[0]).toMatchObject({ status: 'pending' })
    expect(job.stages[0]!.error).toContain('Completion criteria not met: LOG.md does not exist')
    expect(job.counters.stagesCompleted).toBe(0)
  })

  it('completes a stage once its completion criterion is actually met on disk', async () => {
    const { service, dir } = setup([{ kind: 'answer', text: 'Wrote the log.\nJOB STATUS: DONE', filesChanged: ['LOG.md'] }])
    writeFileSync(join(dir, 'LOG.md'), 'a\nb\nc\n')
    const created = await service.create(input({ stages: [{ title: 'Write the log', objective: 'Write LOG.md with at least 3 lines', completionCriteria: ['LOG.md has 3 lines'] }] }))
    await until(() => service.status(created.id).status === 'completed')
    expect(service.get(created.id).stages[0]).toMatchObject({ status: 'completed' })
  })

  it('treats an output-limit stop as unfinished even when text exists', () => {
    expect(stageSucceeded({ phase: 'completed', stopSequence: 1, stop: { reason: 'output_limit', detail: '', filesChanged: [] }, lastAnswer: 'partial', filesChanged: [] })).toBe(false)
    expect(stageSucceeded({ phase: 'completed', stopSequence: 1, stop: { reason: 'completed', detail: '', filesChanged: [] }, lastAnswer: 'ok', filesChanged: [], execution: { lifecycle: 'blocked', nextAction: 'x' } })).toBe(false)
    expect(stageSucceeded({ phase: 'completed', stopSequence: 1, stop: { reason: 'completed', detail: '', filesChanged: [], acceptance: { command: 'npm test', passed: false, exitCode: 1 } }, lastAnswer: 'ok', filesChanged: [] })).toBe(false)
    expect(stageSucceeded({ phase: 'completed', stopSequence: 1, stop: { reason: 'completed', detail: '', filesChanged: [] }, lastAnswer: 'ok', filesChanged: [] })).toBe(true)
  })

  it('never counts an answer that is only reasoning as a completed stage', () => {
    const answer = (lastAnswer: string) => ({ phase: 'completed' as const, stopSequence: 1, stop: { reason: 'completed' as const, detail: '', filesChanged: [] }, lastAnswer, filesChanged: [] })
    expect(stageSucceeded(answer('<think>I should edit the parser.</think>'))).toBe(false)
    expect(stageSucceeded(answer('<think>still thinking about the parser'))).toBe(false)
    expect(stageSucceeded(answer('<think>checked</think>\nParser refactored.\nJOB STATUS: DONE'))).toBe(true)
  })

  it('plans further stages for an open-ended job until the model reports done', async () => {
    const { service, runtime } = setup([{ kind: 'answer', text: 'Parsed module A.\nJOB STATUS: CONTINUE: refactor module B' }, { kind: 'answer', text: 'B done.\nJOB STATUS: DONE' }])
    const created = await service.create(input())
    await until(() => service.status(created.id).status === 'completed')
    const job = service.get(created.id)
    expect(job.stages.map(stage => stage.objective)).toEqual(['Refactor the parser', 'refactor module B'])
    expect(runtime.opened).toHaveLength(2)
  })

  it('blocks instead of spawning implicit stages forever when the model keeps declining the same step without touching a file', async () => {
    const decline = { kind: 'answer' as const, text: 'The sandbox refuses npm install: there is no network access.\nJOB STATUS: CONTINUE: ask the owner to install it' }
    const { service, runtime } = setup([decline, decline, decline, decline])
    const created = await service.create(input())
    await until(() => service.status(created.id).status === 'blocked')
    const job = service.get(created.id)
    expect(job.stages).toHaveLength(3)
    expect(job.statusReason).toContain('not making progress')
    expect(runtime.opened).toHaveLength(3)
  })

  it('blocks an open-ended job whose stage reports no status instead of guessing', async () => {
    const { service } = setup([{ kind: 'answer', text: 'I did some things.' }])
    const created = await service.create(input())
    await until(() => service.status(created.id).status === 'blocked')
    expect(service.status(created.id).statusReason).toContain('without saying whether the objective is met')
  })

  it('blocks with an approval event when the conversation needs an approval, never answering it', async () => {
    const { service, runtime } = setup([{ kind: 'approval' }])
    const created = await service.create(input())
    await until(() => service.status(created.id).status === 'blocked')
    expect(service.events(created.id).some(event => event.kind === 'approval')).toBe(true)
    const [id] = runtime.opened
    expect(runtime.sessions.get(id!)!.interrupts).toBe(0)
    expect(runtime.observe(id!).phase).toBe('waiting_approval')
    // The owner answers it in the tab; resume re-attaches to the same conversation.
    runtime.set(id!, { phase: 'completed', stopSequence: 1, stop: { reason: 'completed', detail: '', filesChanged: [] }, lastAnswer: 'ok\nJOB STATUS: DONE', filesChanged: [] })
    await service.resume(created.id)
    await until(() => service.status(created.id).status === 'completed')
    expect(runtime.opened).toHaveLength(1)
  })

  it('pauses cooperatively: interrupts the conversation, does not charge the attempt, and resumes in a fresh conversation', async () => {
    const { service, runtime, store } = setup([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    const created = await service.create(input())
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    const paused = service.pause(created.id)
    expect(paused.status).toBe('paused')
    await until(() => runtime.sessions.get(runtime.opened[0]!)!.interrupts > 0)
    await service.controller.idle(created.id)
    for (let i = 0; i < 20; i++) await tick()
    expect(service.status(created.id).status).toBe('paused')
    expect(service.get(created.id).stages[0]).toMatchObject({ status: 'pending', attempt: 0 })
    expect(store.operations(created.id, 'intended')).toHaveLength(0)
    await service.resume(created.id)
    await until(() => service.status(created.id).status === 'completed')
    expect(runtime.opened).toHaveLength(2)
    expect(service.get(created.id).stages[0]!.attempt).toBe(1)
  })

  it('cancels authoritatively and never continues', async () => {
    const { service, runtime } = setup([{ kind: 'hang' }], {})
    const created = await service.create(input({ stages: planned(2) }))
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    const cancelled = await service.cancel(created.id, 'Owner changed their mind')
    expect(cancelled.status).toBe('cancelled')
    expect(runtime.observe(runtime.opened[0]!).phase).toBe('interrupted')
    for (let i = 0; i < 30; i++) await tick()
    const job = service.get(created.id)
    expect(job.status).toBe('cancelled')
    expect(job.stages.map(stage => stage.status)).toEqual(['failed', 'skipped'])
    expect(runtime.opened).toHaveLength(1)
    await expect(service.resume(created.id)).rejects.toThrow()
    expect(() => service.pause(created.id)).toThrow()
  })

  it('interrupts a stage that exceeds its timeout and retries it', async () => {
    const { service, runtime } = setup([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    const created = await service.create(input({ budgets: { stageTimeoutMs: 1 } }))
    // A timeout, an interrupt and a retry each take a few event-loop turns; a busy full-suite run
    // can stretch that past until()'s 4 s default, so this test alone waits longer (still bounded).
    await until(() => service.status(created.id).status === 'completed', 20_000)
    expect(runtime.sessions.get(runtime.opened[0]!)!.interrupts).toBe(1)
    expect(service.events(created.id).some(event => event.kind === 'retry' && event.message.includes('timed out'))).toBe(true)
  })

  it('detects a repeating failure as a loop and blocks', async () => {
    const same: ScriptedOutcome = { kind: 'answer', text: '', reason: 'stagnation' }
    const { service } = setup([same, same, same, same, same])
    const created = await service.create(input({ budgets: { maxStageAttempts: 5 } }))
    await until(() => service.status(created.id).status === 'blocked')
    expect(service.status(created.id).counters.loopsDetected).toBe(1)
    expect(service.events(created.id).some(event => event.kind === 'loop-detected')).toBe(true)
  })

  it('keeps the model policy: refuses a non-local model and records the policy', async () => {
    const { service } = setup()
    await expect(service.create(input({ model: 'claude/opus' }))).rejects.toThrow(/local model/)
    const created = await service.create(input())
    expect(service.events(created.id).some(event => event.message.startsWith('Model policy'))).toBe(true)
    expect(service.get(created.id).model).toEqual({ provider: 'local', model: 'local/qwen3.6-35b-a3b', escalation: 'never' })
  })

  it('isolates a git project in its own worktree and commits checkpoints there', async () => {
    const worktrees = new FakeWorktrees('C:/repo')
    const { service } = setup([{ kind: 'answer', text: 'ok\nJOB STATUS: DONE', filesChanged: ['x.ts'] }], { worktrees })
    const created = await service.create(input())
    await until(() => service.status(created.id).status === 'completed')
    const job = service.get(created.id)
    expect(job.worktree?.branch).toBe(`conductor-job/${created.id}`)
    expect(worktrees.commits.map(commit => commit.message)).toEqual(['Durable job checkpoint: Before stage 1 attempt 1', 'Durable job checkpoint: After stage 1 "Stage 1"'])
    expect(job.stages[0]!.checkpointId).toBeDefined()
    expect(service.status(created.id).lastCheckpoint?.commit).toBeDefined()
  })

  it('snapshots changed files under logDir for a folder without git', async () => {
    const worktrees = new FakeWorktrees(null)
    const { service } = setup([{ kind: 'answer', text: 'ok', filesChanged: ['notes.md'] }], { worktrees })
    const created = await service.create(input({ stages: planned(1) }))
    await until(() => service.status(created.id).status === 'completed')
    expect(worktrees.commits).toHaveLength(0)
    expect(worktrees.snapshots.map(snapshot => snapshot.files)).toEqual([['notes.md']])
    expect(worktrees.snapshots[0]!.directory.startsWith(service.get(created.id).logDir)).toBe(true)
  })

  it('fires onChange with a summary on every persisted change', async () => {
    const { service } = setup([{ kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    const statuses: string[] = []
    service.onChange(summary => statuses.push(summary.status))
    const created = await service.create(input())
    await until(() => service.status(created.id).status === 'completed')
    expect(statuses[0]).toBe('queued')
    expect(statuses).toContain('running')
    expect(statuses.at(-1)).toBe('completed')
  })

  it('queues a second job behind the first', async () => {
    const { service, runtime } = setup([{ kind: 'hang' }])
    const first = await service.create(input({ title: 'First' }))
    const second = await service.create(input({ title: 'Second' }))
    await until(() => runtime.opened.length === 1)
    expect(service.status(second.id).status).toBe('queued')
    await service.cancel(first.id)
    await until(() => service.status(second.id).status === 'completed')
  })

  it('restarts the elapsed budget from a resume note recorded after the first 1000 events', async () => {
    let now = Date.parse('2026-09-24T00:00:00.000Z')
    const { service, store, runtime } = setup([{ kind: 'hang' }, { kind: 'answer', text: 'step two done' }], { clock: () => new Date(now) })
    const created = await service.create(input({ budgets: { maxElapsedMs: 60_000 }, stages: planned(2) }))
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    now += 120_000
    runtime.set(runtime.opened[0]!, { phase: 'completed', stopSequence: 1, stop: { reason: 'completed', detail: '', filesChanged: [] }, lastAnswer: 'step one done', filesChanged: [] })
    await until(() => service.status(created.id).status === 'blocked')
    expect(service.status(created.id).statusReason).toMatch(/elapsed-time budget/)
    store.batch(created.id, () => { for (let i = 0; i < 1_000; i++) store.event(created.id, { owner: true }, 'note', `filler ${i}`) })
    expect(allEvents(store, created.id).length).toBeGreaterThan(1_000)
    await service.resume(created.id)
    const restartAt = allEvents(store, created.id).findIndex(event => event.kind === 'note' && event.data?.elapsedBudget === 'restarted')
    expect(restartAt).toBeGreaterThanOrEqual(1_000)
    await until(() => runtime.opened.length >= 2 || service.status(created.id).status === 'blocked')
    expect(runtime.opened.length).toBeGreaterThanOrEqual(2)
    expect(service.status(created.id).statusReason ?? '').not.toMatch(/elapsed-time budget/)
  })

  it('counts a repeated failure past the first 1000 events and ignores another stage', async () => {
    const fail: ScriptedOutcome = { kind: 'answer', text: '', reason: 'stagnation' }
    const { service, store, runtime } = setup([{ kind: 'hang' }, fail, fail, fail, fail, fail])
    const created = await service.create(input({ budgets: { maxStageAttempts: 6 } }))
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    const stageId = service.get(created.id).stages[0]!.id
    const error = 'stagnation: stagnation detail'
    store.batch(created.id, () => {
      for (let i = 0; i < 1_000; i++) store.event(created.id, { owner: true }, 'note', `filler ${i}`)
      store.event(created.id, { owner: true }, 'retry', 'other stage', { stageId: `${stageId}-other`, error })
      store.event(created.id, { owner: true }, 'retry', 'other stage again', { stageId: `${stageId}-other`, error })
    })
    runtime.set(runtime.opened[0]!, { phase: 'failed', stopSequence: 1, stop: { reason: 'stagnation', detail: 'stagnation detail', filesChanged: [] }, lastAnswer: '', filesChanged: [] })
    await until(() => service.status(created.id).status === 'blocked')
    expect(service.status(created.id).statusReason).toMatch(/Loop detected/)
    expect(service.get(created.id).stages[0]!.attempt).toBe(3)
    expect(service.status(created.id).counters.loopsDetected).toBe(1)
    expect(runtime.opened).toHaveLength(3)
  })
})

describe('owner commands while a tool runs', () => {
  const tool = { id: 'call_9', name: 'run_command', arguments: '{"command":"npm run migrate"}' }

  it('records a tool the pause cut off as an unknown side effect, not a clean failure, and resumes fresh', async () => {
    const { service, runtime, store } = setup([{ kind: 'hang' }, { kind: 'answer', text: 'ok\nJOB STATUS: DONE' }])
    const created = await service.create(input())
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    const id = runtime.opened[0]!
    runtime.set(id, { ...runtime.observe(id), execution: { lifecycle: 'running', nextAction: '', pending: tool } })
    const paused = service.pause(created.id)
    expect(paused.status).toBe('paused')
    expect(paused.statusReason).toContain('run_command was cut off mid-run')
    const ops = store.operations(created.id)
    expect(ops.filter(op => op.kind === 'model-call').map(op => op.status)).toEqual(['unknown'])
    expect(ops.filter(op => op.kind === 'shell')).toMatchObject([{ status: 'unknown', description: expect.stringContaining('npm run migrate') }])
    expect(store.operations(created.id, 'failed')).toHaveLength(0)
    expect(service.get(created.id).handoff.nextAction).toContain('npm run migrate')
    expect(service.get(created.id).stages[0]).toMatchObject({ status: 'pending', attempt: 0 })
    await until(() => runtime.sessions.get(id)!.interrupts > 0)
    await service.resume(created.id)
    await until(() => service.status(created.id).status === 'completed')
    expect(runtime.opened).toHaveLength(2)
    expect(service.events(created.id).some(event => event.message.includes('unverified side effect'))).toBe(true)
    // Recorded once: the check after the interrupt sees the same call.
    expect(store.operations(created.id).filter(op => op.kind === 'shell')).toHaveLength(1)
  })

  it('records a tool the cancel cut off, including one that started while the interrupt went out', async () => {
    const { service, runtime, store } = setup([{ kind: 'hang' }])
    const created = await service.create(input())
    await until(() => runtime.opened.length === 1 && runtime.observe(runtime.opened[0]!).phase === 'running')
    const id = runtime.opened[0]!
    const interrupt = runtime.interrupt.bind(runtime)
    runtime.interrupt = async agentSessionId => { await interrupt(agentSessionId); runtime.set(agentSessionId, { ...runtime.observe(agentSessionId), execution: { lifecycle: 'blocked', nextAction: '', pending: { ...tool, id: 'call_10', name: 'write_file', arguments: '{"path":"db.sqlite"}' } } }) }
    const cancelled = await service.cancel(created.id)
    expect(cancelled.status).toBe('cancelled')
    expect(runtime.sessions.get(id)!.interrupts).toBeGreaterThan(0)
    expect(store.operations(created.id).filter(op => op.kind === 'file-write')).toMatchObject([{ status: 'unknown', description: expect.stringContaining('db.sqlite') }])
  })
})
