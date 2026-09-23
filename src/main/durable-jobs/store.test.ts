import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DURABLE_JOB_BUDGETS, DURABLE_JOB_STATUSES, DURABLE_JOB_TRANSITIONS, type DurableJob, type DurableJobStage } from '../../shared/durable-jobs'
import { DurableJobStore, IllegalTransitionError, LeaseHeldError, StaleEpochError } from './store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function job(id = 'job_1', at = '2026-09-24T00:00:00.000Z'): DurableJob {
  return {
    id, projectId: 'project_1', cwd: 'C:/work', title: 'Overnight', objective: 'Do the thing', status: 'queued',
    model: { provider: 'local', model: 'local/qwen', escalation: 'never' }, budgets: DEFAULT_DURABLE_JOB_BUDGETS,
    handoff: { objective: 'Do the thing', constraints: [], decisions: [], workDone: [], filesChanged: [], testResults: [], unresolvedIssues: [], nextAction: 'start', artifacts: [], updatedAt: at },
    createdAt: at, updatedAt: at, activeMs: 0,
    counters: { stagesCompleted: 0, retries: 0, recoveries: 0, contextRollovers: 0, loopsDetected: 0, cloudEscalations: 0 },
    logDir: 'C:/logs/job_1'
  }
}
const stage = (jobId = 'job_1', index = 0): DurableJobStage => ({ id: `${jobId}_s${index}`, jobId, index, title: `Stage ${index + 1}`, objective: 'x', completionCriteria: [], inputs: [], status: 'pending', attempt: 0 })

describe('DurableJobStore', () => {
  it('allows exactly the contract transitions and records each with its reason', () => {
    for (const from of DURABLE_JOB_STATUSES) for (const to of DURABLE_JOB_STATUSES) {
      const store = new DurableJobStore(':memory:')
      store.create({ ...job(), status: from }, [], false)
      const allowed = DURABLE_JOB_TRANSITIONS[from].includes(to)
      if (allowed) {
        expect(store.transition('job_1', to, 'because', { owner: true }).status).toBe(to)
        expect(store.events('job_1').at(-1)).toMatchObject({ kind: 'transition', message: `${from} → ${to}: because`, data: { from, to } })
      } else {
        expect(() => store.transition('job_1', to, 'nope', { owner: true })).toThrow(IllegalTransitionError)
        expect(store.get('job_1').status).toBe(from)
        expect(store.events('job_1')).toHaveLength(1)
      }
      store.close()
    }
  })

  it('accumulates active time only while running and stamps start and finish', () => {
    let now = Date.parse('2026-09-24T00:00:00.000Z')
    const store = new DurableJobStore(':memory:', () => new Date(now))
    store.create(job(), [], false)
    store.transition('job_1', 'running', 'go', { owner: true })
    now += 60_000
    store.transition('job_1', 'paused', 'pause', { owner: true })
    now += 3_600_000
    store.transition('job_1', 'running', 'again', { owner: true })
    now += 30_000
    const done = store.transition('job_1', 'completed', 'done', { owner: true })
    expect(done.activeMs).toBe(90_000)
    expect(done.startedAt).toBe('2026-09-24T00:00:00.000Z')
    expect(done.finishedAt).toBe(new Date(now).toISOString())
  })

  it('round-trips jobs, stages, checkpoints, operations and events through the database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-store-')); dirs.push(dir)
    const path = join(dir, 'conductor.db')
    const first = new DurableJobStore(path)
    first.create(job(), [stage(), stage('job_1', 1)], true)
    const lease = first.acquire('job_1', 'pid:a', 60_000)
    first.transition('job_1', 'running', 'go', lease)
    const op = first.intend('job_1', lease, { stageId: 'job_1_s0', kind: 'model-call', description: 'stage 1' })
    first.addCheckpoint('job_1', lease, { stageId: 'job_1_s0', reason: 'before', commit: 'abc', artifacts: [] })
    first.saveStage('job_1', lease, { ...stage(), status: 'running', attempt: 1, agentSessionId: 'agent_x' })
    first.count('job_1', lease, { retries: 2 })
    first.close()

    const second = new DurableJobStore(path)
    const loaded = second.get('job_1')
    expect(loaded).toMatchObject({ status: 'running', planned: true, counters: { retries: 2 }, lease: { epoch: 1, ownerId: 'pid:a' } })
    expect(second.stages('job_1').map(s => [s.status, s.attempt, s.agentSessionId])).toEqual([['running', 1, 'agent_x'], ['pending', 0, undefined]])
    expect(second.operations('job_1', 'intended').map(o => o.id)).toEqual([op.id])
    expect(second.checkpoints('job_1')).toMatchObject([{ reason: 'before', commit: 'abc' }])
    const events = second.events('job_1')
    expect(events.map(e => e.kind)).toEqual(['transition', 'note', 'transition', 'checkpoint'])
    expect(second.events('job_1', events[1]!.id).map(e => e.id)).toEqual(events.slice(2).map(e => e.id))
    second.close()
  })

  it('gives one owner per job: another owner is refused, a takeover bumps the epoch and stale writers are rejected', () => {
    let now = Date.parse('2026-09-24T00:00:00.000Z')
    const store = new DurableJobStore(':memory:', () => new Date(now))
    store.create(job(), [stage()], false)
    const a = store.acquire('job_1', 'pid:a', 60_000)
    expect(a.epoch).toBe(1)
    expect(store.acquire('job_1', 'pid:a', 60_000).epoch).toBe(1)
    expect(() => store.acquire('job_1', 'pid:b', 60_000)).toThrow(LeaseHeldError)
    const b = store.acquire('job_1', 'pid:b', 60_000, { takeover: true })
    expect(b.epoch).toBe(2)
    expect(() => store.transition('job_1', 'running', 'stale', { epoch: a.epoch })).toThrow(StaleEpochError)
    expect(() => store.intend('job_1', { epoch: a.epoch }, { stageId: 's', kind: 'shell', description: 'x' })).toThrow(StaleEpochError)
    expect(() => store.renew('job_1', a.epoch, 60_000)).toThrow(StaleEpochError)
    expect(store.operations('job_1')).toHaveLength(0)
    store.transition('job_1', 'running', 'fresh', { epoch: b.epoch })
    // An expired lease can be taken without forcing.
    now += 120_000
    expect(store.acquire('job_1', 'pid:c', 60_000).epoch).toBe(3)
    // The owner's command supersedes everyone.
    const epoch = store.supersede('job_1', 'owner paused')
    expect(epoch).toBe(4)
    expect(store.get('job_1').lease).toBeUndefined()
    expect(() => store.event('job_1', { epoch: 3 }, 'note', 'late')).toThrow(StaleEpochError)
  })

  it('records an operation before execution and its outcome after', () => {
    const store = new DurableJobStore(':memory:')
    store.create(job(), [stage()], false)
    const op = store.intend('job_1', { owner: true }, { stageId: 'job_1_s0', kind: 'git', description: 'commit' })
    expect(store.operations('job_1')).toMatchObject([{ id: op.id, status: 'intended' }])
    store.settle('job_1', { owner: true }, op.id, 'done', 'Committed abc')
    expect(store.operations('job_1')).toMatchObject([{ id: op.id, status: 'done', reconciliation: 'Committed abc' }])
    expect(store.operations('job_1', 'intended')).toHaveLength(0)
  })

  it('notifies once per committed batch and not for a rolled-back one', () => {
    const store = new DurableJobStore(':memory:')
    const seen: string[] = []
    store.onChange(id => seen.push(id))
    store.create(job(), [stage()], false)
    store.batch('job_1', () => { store.event('job_1', { owner: true }, 'note', 'a'); store.event('job_1', { owner: true }, 'note', 'b') })
    expect(seen).toEqual(['job_1', 'job_1'])
    expect(() => store.batch('job_1', () => { store.event('job_1', { owner: true }, 'note', 'c'); throw new Error('boom') })).toThrow('boom')
    expect(seen).toHaveLength(2)
    expect(store.events('job_1').map(e => e.message)).not.toContain('c')
  })
})
