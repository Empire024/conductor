import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('pages events oldest-forward from afterId when the history is longer than one page', () => {
    const store = new DurableJobStore(':memory:')
    store.create(job(), [], false)
    store.batch('job_1', () => { for (let i = 0; i < 1_200; i++) store.event('job_1', { owner: true }, 'note', `n${i}`) })
    const first = store.events('job_1', undefined, 1_000)
    expect(first).toHaveLength(1_000)
    expect(first[0]?.kind).toBe('transition')
    expect(first.at(-1)?.message).toBe('n998')
    const second = store.events('job_1', first.at(-1)!.id, 1_000)
    expect(second).toHaveLength(201)
    expect(second[0]?.message).toBe('n999')
    expect(second.at(-1)?.message).toBe('n1199')
    expect(store.events('job_1')).toHaveLength(200)
    expect(store.events('job_1')[0]?.id).toBe(first[0]?.id)
    store.close()
  })

  it('finds a matching event that lands after the oldest 1000, filtered by stage and data', () => {
    const store = new DurableJobStore(':memory:')
    store.create(job(), [stage()], false)
    store.batch('job_1', () => {
      for (let i = 0; i < 999; i++) {
        if (i === 10) store.event('job_1', { owner: true }, 'note', 'early restart', { elapsedBudget: 'restarted' })
        else store.event('job_1', { owner: true }, 'note', `filler ${i}`)
      }
      store.event('job_1', { owner: true }, 'retry', 'other stage', { stageId: 'other', error: 'same' })
      store.event('job_1', { owner: true }, 'loop-detected', 'string replan does not count', { stageId: 'job_1_s0', replan: '1' })
      store.event('job_1', { owner: true }, 'loop-detected', 'plural field does not count', { stageId: 'job_1_s0', replans: 4, blocked: true })
      store.event('job_1', { owner: true }, 'note', 'budget restarted', { elapsedBudget: 'restarted' })
      store.event('job_1', { owner: true }, 'note', 'later restart', { elapsedBudget: 'restarted' })
      store.event('job_1', { owner: true }, 'retry', 'this stage', { stageId: 'job_1_s0', error: 'same' })
      store.event('job_1', { owner: true }, 'loop-detected', 'late replan', { stageId: 'job_1_s0', replan: 1 })
    })
    const oldest = store.events('job_1', undefined, 1_000)
    expect(oldest).toHaveLength(1_000)
    expect(oldest.some(event => event.message === 'budget restarted' || event.message === 'late replan')).toBe(false)
    expect(store.matchingEvents('job_1', { kind: 'note', dataEquals: { elapsedBudget: 'restarted' } }).map(event => event.message)).toEqual(['early restart', 'budget restarted', 'later restart'])
    expect(store.matchingEvents('job_1', { kind: 'note', dataEquals: { elapsedBudget: 'restarted' } }, 1).map(event => event.message)).toEqual(['later restart'])
    expect(store.matchingEvents('job_1', { kind: 'retry', stageId: 'job_1_s0', dataType: { error: 'string' } }).map(event => event.data?.error)).toEqual(['same'])
    expect(store.matchingEvents('job_1', { kind: 'loop-detected', stageId: 'job_1_s0', dataType: { replan: 'number' } }).map(event => event.message)).toEqual(['late replan'])
    expect(store.events('job_1', oldest.at(-1)!.id, 1_000).at(-1)?.message).toBe('late replan')
    store.close()
  })

  it('reloads the newest match after the database file is reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-store-')); dirs.push(dir)
    const path = join(dir, 'conductor.db')
    const first = new DurableJobStore(path)
    first.create(job(), [stage()], false)
    first.batch('job_1', () => {
      for (let i = 0; i < 1_000; i++) first.event('job_1', { owner: true }, 'note', `filler ${i}`)
      first.event('job_1', { owner: true }, 'note', 'persisted restart', { elapsedBudget: 'restarted', stageId: 'job_1_s0' })
    })
    first.close()
    const second = new DurableJobStore(path)
    try {
      const head = second.events('job_1', undefined, 1_000)
      expect(head.some(event => event.message === 'persisted restart')).toBe(false)
      expect(second.matchingEvents('job_1', { kind: 'note', dataEquals: { elapsedBudget: 'restarted' }, stageId: 'job_1_s0' }).map(event => event.message)).toEqual(['persisted restart'])
      expect(second.events('job_1', head.at(-1)!.id, 1_000).at(-1)?.message).toBe('persisted restart')
    } finally { second.close() }
  })

  it('does not return matching events from another job', () => {
    const store = new DurableJobStore(':memory:')
    store.create(job(), [stage()], false)
    store.create(job('job_2'), [stage('job_2')], false)
    store.batch('job_1', () => { for (let i = 0; i < 1_000; i++) store.event('job_1', { owner: true }, 'note', `filler ${i}`) })
    store.event('job_2', { owner: true }, 'note', 'other job restart', { elapsedBudget: 'restarted', stageId: 'job_1_s0' })
    store.event('job_2', { owner: true }, 'retry', 'other job retry', { stageId: 'job_1_s0', error: 'same' })
    store.event('job_2', { owner: true }, 'loop-detected', 'other job replan', { stageId: 'job_1_s0', replan: 1 })
    store.event('job_1', { owner: true }, 'note', 'this job restart', { elapsedBudget: 'restarted' })
    expect(store.matchingEvents('job_1', { kind: 'note', dataEquals: { elapsedBudget: 'restarted' } }).map(event => event.message)).toEqual(['this job restart'])
    expect(store.matchingEvents('job_1', { kind: 'retry', stageId: 'job_1_s0', dataType: { error: 'string' } })).toEqual([])
    expect(store.matchingEvents('job_1', { kind: 'loop-detected', stageId: 'job_1_s0', dataType: { replan: 'number' } })).toEqual([])
    expect(store.matchingEvents('job_2', { kind: 'note', dataEquals: { elapsedBudget: 'restarted' } }).map(event => event.message)).toEqual(['other job restart'])
    store.close()
  })

  it('returns the exact newest events beyond 20,000, oldest first, from one indexed bounded query', () => {
    const db = new DatabaseSync(':memory:')
    const store = new DurableJobStore(db)
    store.create(job(), [], false)
    store.create(job('job_2'), [], false)
    store.batch('job_1', () => { for (let i = 0; i < 20_500; i++) store.event('job_1', { owner: true }, 'note', `n${i}`) })
    store.event('job_2', { owner: true }, 'note', 'other job is newer')
    store.event('job_1', { owner: true }, 'note', 'late marker', { marker: true })
    const prefix = store.events('job_1', undefined, 1_000)
    expect(prefix.some(event => event.message === 'late marker')).toBe(false)

    const prepared: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => { prepared.push(sql); return prepare(sql) })
    const tail = store.latestEvents('job_1', 200)
    spy.mockRestore()
    expect(tail.map(event => event.message)).toEqual([...Array.from({ length: 199 }, (_, i) => `n${20_301 + i}`), 'late marker'])
    expect(tail.every(event => event.jobId === 'job_1')).toBe(true)
    expect(prepared).toHaveLength(1)
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${prepared[0]}`).all('job_1', 200) as Array<{ detail: string }>).map(row => row.detail).join('\n')
    expect(plan).toContain('durable_job_events_job_idx')
    expect(plan).not.toContain('TEMP B-TREE')

    expect(store.latestEvents('job_1', 1).map(event => event.message)).toEqual(['late marker'])
    expect(store.latestEvents('job_1', 50_000)).toHaveLength(1_000)
    expect(store.latestEvents('job_2', 200).map(event => event.message)).toEqual(['Created as queued', 'other job is newer'])
    expect(store.latestEvents('job_3', 200)).toEqual([])
    store.close()
  })

  it('reads the newest tail again after the database file is reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-store-')); dirs.push(dir)
    const path = join(dir, 'conductor.db')
    const first = new DurableJobStore(path)
    first.create(job(), [], false)
    first.batch('job_1', () => { for (let i = 0; i < 20_100; i++) first.event('job_1', { owner: true }, 'note', `n${i}`) })
    first.close()
    const second = new DurableJobStore(path)
    try {
      second.event('job_1', { owner: true }, 'note', 'after restart')
      expect(second.latestEvents('job_1', 3).map(event => event.message)).toEqual(['n20098', 'n20099', 'after restart'])
    } finally { second.close() }
  })
})

describe('DurableJobStore redaction', () => {
  const BEARER = 'Zq8vT3kLm9Wx2Rb7Np4Hs6Jd'
  const API_KEY = 'sk-proj-4f9QzX2mL8kV7nB3cR6tY1wP'
  const CONTROL = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const planted = `curl -H "Authorization: Bearer ${BEARER}" --api-key ${API_KEY} -d '{"token":"${CONTROL}"}'`

  it('never stores a bearer token, an API key or a control credential from tool arguments, errors, answers, next actions or handoffs', () => {
    const db = new DatabaseSync(':memory:')
    const store = new DurableJobStore(db)
    store.create(job(), [stage()], false)
    const guard = { owner: true } as const
    const operation = store.intend('job_1', guard, { stageId: 'job_1_s0', kind: 'shell', description: `run_command ${JSON.stringify({ command: planted })}` })
    store.settle('job_1', guard, operation.id, 'failed', `exit 1: ${planted}`)
    store.event('job_1', guard, 'note', `Tool output: ${planted}`, { stageId: 'job_1_s0', output: planted, nested: [{ args: { command: planted } }], apiKey: 'plain', token: CONTROL })
    store.saveStage('job_1', guard, { ...stage(), status: 'running', attempt: 1, result: `Answer: ${planted}`, error: `lastError: ${planted}` }, { kind: 'retry', message: `Stage failed: ${planted}`, data: { error: planted } })
    store.addStage('job_1', guard, { ...stage('job_1', 1), title: `Next ${API_KEY}`, objective: `Continue with ${planted}` })
    const handoff = { ...job().handoff, decisions: [planted], workDone: [planted], testResults: [`fail: ${planted}`], unresolvedIssues: [planted], nextAction: `Next: ${planted}`, artifacts: [{ path: 'C:/logs/a.log', kind: 'log' as const, note: planted }] }
    store.transition('job_1', 'running', `Resumed after ${planted}`, guard, { handoff }, { reason: planted })
    store.update('job_1', guard, { handoff: { ...handoff, nextAction: `Then ${planted}` } })
    store.transition('job_1', 'blocked', `Blocked: ${planted}`, guard)
    const rows = ['durable_jobs', 'durable_job_stages', 'durable_job_operations', 'durable_job_events', 'durable_job_checkpoints'].map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join('\n')
    for (const secret of [BEARER, API_KEY, '4f9QzX2mL8kV7nB3cR6tY1wP', CONTROL]) expect(rows).not.toContain(secret)
    // What is left is still the useful part of the record.
    expect(store.get('job_1').handoff.filesChanged).toEqual([])
    expect(store.get('job_1').handoff.artifacts[0]!.path).toBe('C:/logs/a.log')
    expect(store.stage('job_1_s0').error).toContain('lastError: curl -H "Authorization: [redacted]')
    expect(store.operations('job_1')[0]!.description).toContain('run_command')
    expect(store.events('job_1').some(event => event.message.startsWith('Tool output: curl'))).toBe(true)
    store.close()
  })
})
