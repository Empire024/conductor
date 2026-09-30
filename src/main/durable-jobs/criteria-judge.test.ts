import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompletionRequest } from '../local-models/client'
import type { CreateDurableJobInput } from '../../shared/durable-jobs'
import { collectEvidence, criterionPaths, localCriteriaJudge, parseVerdicts } from './criteria-judge'
import { DurableJobsServiceImpl } from './index'
import type { CriteriaJudgePort, CriteriaVerdict } from './ports'
import { DurableJobStore } from './store'
import { FakeRuntime, FakeWorktrees, tick, until, type ScriptedOutcome } from './test-fakes'

const dirs: string[] = []
const services: DurableJobsServiceImpl[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await new Promise(resolve => setTimeout(resolve, 30))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'durable-judge-')); dirs.push(dir); return dir }
const CRITERION = 'CROSSREF.md has a row for every import listed in notes/'

describe('criteria judge helpers', () => {
  it('finds the paths a criterion names', () => {
    expect(criterionPaths(CRITERION)).toEqual(['CROSSREF.md', 'notes/'])
    expect(criterionPaths('src/a.ts exports parse, and version 1.2 is kept')).toEqual(['src/a.ts'])
  })

  it('reads changed and named files inside the cwd only, bounded, and names what is missing', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'notes'))
    writeFileSync(join(dir, 'notes', 'alpha.md'), 'alpha imports parse from beta\n')
    writeFileSync(join(dir, 'notes', 'beta.md'), 'x'.repeat(10_000))
    writeFileSync(join(dir, 'CROSSREF.md'), '| alpha | beta | parse |\n')
    const evidence = await collectEvidence(dir, [CRITERION, 'OTHER.md exists and lists ../secret.txt'], ['CROSSREF.md', '../outside.md'], 6_000)
    expect(evidence.files.map(file => file.path)).toEqual(['CROSSREF.md', 'notes/alpha.md', 'notes/beta.md'])
    expect(evidence.files.find(file => file.path === 'notes/beta.md')!.truncated).toBe(true)
    expect(evidence.missing).toEqual(['OTHER.md'])
  })

  it('parses verdicts by criterion number; anything unreadable is unknown', () => {
    expect(parseVerdicts('<think>hm</think>{"verdicts":[{"criterion":2,"met":"no","missing":"rows for gamma"},{"criterion":1,"met":"yes","missing":""}]}', ['a', 'b', 'c'])).toEqual([
      { criterion: 'a', verdict: 'met', missing: '' },
      { criterion: 'b', verdict: 'not-met', missing: 'rows for gamma' },
      { criterion: 'c', verdict: 'unknown', missing: '' }
    ])
    expect(parseVerdicts('not json', ['a'])).toBeUndefined()
  })

  it('makes one bounded, schema-constrained call under the generation gate, and retries an unreadable answer once', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'CROSSREF.md'), '| alpha | beta | parse |\n')
    const requests: CompletionRequest[] = []
    const answers = ['garbage', '{"verdicts":[{"criterion":1,"met":"no","missing":"11 of 12 import rows"}]}']
    const gateCalls: string[] = []
    const judge = localCriteriaJudge({
      connection: model => ({ endpoint: 'http://127.0.0.1:9', apiKey: 'k', model, contextTokens: 32_768 }),
      complete: async request => { requests.push(request); return { content: answers.shift() ?? '', toolCalls: [], finishReason: 'stop' } as never },
      gate: { acquire: async jobId => { gateCalls.push(`take ${jobId}`); return { release: () => gateCalls.push('release') } } }
    })
    const job = { id: 'job_1', cwd: dir, model: { provider: 'local', model: 'local/m', escalation: 'never' } } as never
    const result = await judge.judge({ job, stage: { objective: 'Write CROSSREF.md' } as never, criteria: [CRITERION], filesChanged: ['CROSSREF.md'] })
    expect(result).toEqual({ verdicts: [{ criterion: CRITERION, verdict: 'not-met', missing: '11 of 12 import rows' }] })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ temperature: 0, maxTokens: 1_024, reasoningEffort: 'none' })
    expect(requests[0]!.jsonSchema).toBeTruthy()
    expect(requests[0]!.messages[1]!.content).toContain('=== CROSSREF.md ===\n| alpha | beta | parse |')
    expect(gateCalls).toEqual(['take job_1', 'release'])
  })

  it('reports a failed call or an unknown model as unavailable, never as a verdict', async () => {
    const failing = localCriteriaJudge({ connection: model => ({ endpoint: 'http://x', apiKey: '', model, contextTokens: 8_192 }), complete: async () => { throw new Error('connect ECONNREFUSED') } })
    const job = { id: 'job_1', cwd: tempDir(), model: { provider: 'local', model: 'local/m', escalation: 'never' } } as never
    expect(await failing.judge({ job, stage: { objective: 'o' } as never, criteria: ['c'], filesChanged: [] })).toEqual({ unavailable: 'the verifier call failed: connect ECONNREFUSED' })
    const unknown = localCriteriaJudge({ connection: () => null, complete: async () => { throw new Error('not called') } })
    expect(await unknown.judge({ job, stage: { objective: 'o' } as never, criteria: ['c'], filesChanged: [] })).toEqual({ unavailable: 'local/m is not configured on this machine' })
  })
})

describe('durable job controller with the criteria judge', () => {
  function setup(script: ScriptedOutcome[], verdicts: Array<CriteriaVerdict['verdict'] | 'unavailable'>) {
    const dir = tempDir()
    const store = new DurableJobStore(':memory:')
    const runtime = new FakeRuntime(script)
    const judged: Array<{ criteria: string[]; filesChanged: string[] }> = []
    const judge: CriteriaJudgePort = {
      async judge({ criteria, filesChanged }) {
        judged.push({ criteria, filesChanged })
        const next = verdicts.shift() ?? 'met'
        if (next === 'unavailable') return { unavailable: 'the verifier did not answer in time' }
        return { verdicts: criteria.map(criterion => ({ criterion, verdict: next, missing: next === 'not-met' ? 'rows for 10 of the 12 imports (beta→gamma parse, …)' : '' })) }
      }
    }
    const service = new DurableJobsServiceImpl({ store, runtime, worktrees: new FakeWorktrees(), logRoot: dir, projectPath: () => dir, ownerId: 'pid:test', sleep: tick, pollMs: 0, interruptGraceMs: 200, judge })
    services.push(service)
    return { service, store, runtime, judged, dir }
  }
  const input = (criteria: string[]): CreateDurableJobInput => ({ projectId: 'project_1', title: 'Crossref', objective: 'Cross-reference the modules', model: 'local/qwen3.6-35b-a3b', stages: [{ title: 'Write the cross-reference', objective: 'Write CROSSREF.md', completionCriteria: criteria }] })
  const done = (text = 'Wrote CROSSREF.md.\nJOB STATUS: DONE'): ScriptedOutcome => ({ kind: 'answer', text, filesChanged: ['CROSSREF.md'] })

  it('sends a rejected "done" back to the stage with what is missing, then completes once the verifier passes', async () => {
    const { service, runtime, judged, store } = setup([done(), done()], ['not-met', 'met'])
    const created = await service.create(input([CRITERION]))
    await until(() => service.status(created.id).status === 'completed')
    const job = service.get(created.id)
    expect(runtime.opened).toHaveLength(2)
    expect(judged).toEqual([{ criteria: [CRITERION], filesChanged: ['CROSSREF.md'] }, { criteria: [CRITERION], filesChanged: ['CROSSREF.md'] }])
    expect(runtime.prompts[1]).toContain('The verifier read the files and found completion criteria not met')
    expect(runtime.prompts[1]).toContain('rows for 10 of the 12 imports')
    expect(job.stages[0]).toMatchObject({ status: 'completed', attempt: 2 })
    expect(store.matchingEvents(created.id, { kind: 'note' }).map(event => event.data?.verify).filter(Boolean)).toEqual(['rejected', 'passed'])
  })

  it('fails the job honestly after the capped verifier retries instead of completing it', async () => {
    const { service, runtime } = setup([done(), done(), done(), done()], ['not-met', 'not-met', 'not-met', 'met'])
    const created = await service.create(input([CRITERION]))
    await until(() => service.status(created.id).status === 'failed')
    const job = service.get(created.id)
    expect(runtime.opened).toHaveLength(3)
    expect(job.statusReason).toContain('reported done 3 times')
    expect(job.statusReason).toContain('rows for 10 of the 12 imports')
    expect(job.stages[0]).toMatchObject({ status: 'failed', attempt: 3 })
    expect(job.counters.stagesCompleted).toBe(0)
    await until(() => Boolean(service.get(created.id).reportPath))
  })

  it('judges only the criteria the mechanical check cannot parse, and never on a mechanical failure', async () => {
    const { service, judged, dir } = setup([done(), done()], ['met'])
    const created = await service.create({ ...input(['CROSSREF.md exists', CRITERION]), budgets: { maxStageAttempts: 1 } })
    await until(() => service.status(created.id).status === 'blocked')
    expect(service.get(created.id).stages[0]!.error).toContain('CROSSREF.md does not exist')
    expect(judged).toEqual([])
    writeFileSync(join(dir, 'CROSSREF.md'), '| a | b | c |\n')
    await service.resume(created.id)
    await until(() => service.status(created.id).status === 'completed')
    expect(judged).toEqual([{ criteria: [CRITERION], filesChanged: ['CROSSREF.md'] }])
  })

  it('completes with the criterion recorded as unverified when the verifier is unavailable', async () => {
    const { service, store } = setup([done()], ['unavailable'])
    const created = await service.create(input([CRITERION]))
    await until(() => service.status(created.id).status === 'completed')
    const note = store.matchingEvents(created.id, { kind: 'note', dataEquals: { verify: 'unverified' } })
    expect(note).toHaveLength(1)
    expect(note[0]!.message).toContain('left unverified: the verifier did not answer in time')
  })
})
