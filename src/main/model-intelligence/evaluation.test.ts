import { describe, expect, it } from 'vitest'
import { REPUTATION_POLICY, type ExecutionOutcome, type ModelKey, type ModelStatus, type ReputationScore } from '../../shared/model-routing'
import { outcome as outcomeRow } from './capture/common'
import {
  EVALUATION_AREAS, JOB_TOKEN_BUDGET, answerCode, evaluate, grade, jobTokenBudget, minimumJobTokens, schemaViolation, validateSuite, type CommandRequest, type EvaluationJob, type EvaluationPorts,
  type EvaluationRun, type EvaluationSuite
} from './evaluation'
import defaultSuite from './suites/default.json'

const KEY: ModelKey = { provider: 'local', model: 'new-model-9b' }
const job = (id: string, grader: EvaluationJob['grader'], extra: Partial<EvaluationJob> = {}): EvaluationJob => ({ id, category: 'simple-coding', complexity: 2, prompt: `Do ${id}`, grader, ...extra })

describe('suite', () => {
  it('the default suite validates and covers every owner evaluation area with its category', () => {
    const suite = validateSuite(defaultSuite)
    const areas = new Set(suite.jobs.map(entry => entry.area))
    for (const area of Object.keys(EVALUATION_AREAS)) expect(areas, area).toContain(area)
    for (const entry of suite.jobs) expect(entry.category).toBe(EVALUATION_AREAS[entry.area!])
    expect(suite.jobs.length).toBeGreaterThanOrEqual(10)
  })
  it('rejects malformed suites', () => {
    expect(() => validateSuite({ name: 's', jobs: [] })).toThrow(/at least one job/)
    expect(() => validateSuite({ name: 's', jobs: [job('a', { kind: 'exact', expected: 'x' }), job('a', { kind: 'exact', expected: 'y' })] })).toThrow(/Duplicate job id a/)
    expect(() => validateSuite({ name: 's', jobs: [{ ...job('a', { kind: 'exact', expected: 'x' }), category: 'poetry' }] })).toThrow(/unknown category/)
    expect(() => validateSuite({ name: 's', jobs: [job('a', { kind: 'regex', pattern: '(' })] })).toThrow(/invalid regex grader/)
    expect(() => validateSuite({ name: 's', jobs: [job('a', { kind: 'command', cmd: 'node', args: [], expectExit: 0, timeoutSec: 0 })] })).toThrow(/invalid command grader/)
  })
})

describe('graders', () => {
  it('exact compares the visible, trimmed answer', async () => {
    const exact = job('e', { kind: 'exact', expected: '4+6' })
    expect(await grade(exact, { answer: '<think>2,4,6 then filter</think>\n 4+6 \n' })).toEqual({ pass: true, detail: 'exact match' })
    expect((await grade(exact, { answer: '4 + 6' })).pass).toBe(false)
    expect((await grade(job('c', { kind: 'exact', expected: 'Yes', caseInsensitive: true }), { answer: 'yes' })).pass).toBe(true)
  })
  it('regex tests the answer', async () => {
    const regex = job('r', { kind: 'regex', pattern: '^\\D*100\\D*;\\s*blog-post\\.md$', flags: 'i' })
    expect((await grade(regex, { answer: '100; Blog-Post.md' })).pass).toBe(true)
    expect(await grade(regex, { answer: '60; changelog.md' })).toMatchObject({ pass: false, detail: expect.stringMatching(/no match/) })
  })
  it('json-schema parses fenced JSON and reports the first violation', async () => {
    const schema = job('j', { kind: 'json-schema', schema: { type: 'object', required: ['n'], additionalProperties: false, properties: { n: { type: 'integer', minimum: 1 } } } })
    expect(await grade(schema, { answer: '```json\n{"n": 2}\n```' })).toEqual({ pass: true, detail: 'valid against the schema' })
    expect(await grade(schema, { answer: '{"n": 0}' })).toEqual({ pass: false, invalidOutput: true, detail: '$.n: below 1' })
    expect(await grade(schema, { answer: 'n is 2' })).toEqual({ pass: false, invalidOutput: true, detail: 'the answer is not JSON' })
  })
  it('the schema subset covers types, enum, const, strings, arrays and extra properties', () => {
    expect(schemaViolation(1.5, { type: 'integer' })).toBe('$: expected integer, got number')
    expect(schemaViolation(3, { type: 'number' })).toBeNull()
    expect(schemaViolation(null, { type: ['string', 'null'] })).toBeNull()
    expect(schemaViolation('b', { enum: ['a'] })).toBe('$: not one of ["a"]')
    expect(schemaViolation(['x'], { const: ['x'] })).toBeNull()
    expect(schemaViolation('2026-1-4', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' })).toMatch(/does not match/)
    expect(schemaViolation([1, 'a'], { type: 'array', items: { type: 'integer' } })).toBe('$[1]: expected integer, got string')
    expect(schemaViolation([], { minItems: 1 })).toBe('$: fewer than 1 items')
    expect(schemaViolation({ a: 1, b: 2 }, { properties: { a: {} }, additionalProperties: false })).toBe('$.b: not allowed')
    expect(schemaViolation({}, { required: ['a'] })).toBe('$.a: required')
  })
  it('file-content reads what the run wrote', async () => {
    const file = job('f', { kind: 'file-content', path: 'out/summary.json', regex: '"paid"\\s*:\\s*4' })
    expect((await grade(file, { answer: 'done', files: { 'out/summary.json': '{"paid": 4}' } })).pass).toBe(true)
    expect(await grade(file, { answer: 'done' })).toEqual({ pass: false, detail: 'out/summary.json was not written' })
    expect((await grade(file, { answer: 'done', files: { 'out/summary.json': '{"paid": 5}' } })).pass).toBe(false)
  })
  it('command runs only through the port, with job, run, hidden and answer files', async () => {
    const seen: CommandRequest[] = []
    const command = job('c', { kind: 'command', cmd: 'node', args: ['check.mjs'], expectExit: 0, timeoutSec: 5, answerFile: 'solution.mjs', files: { 'check.mjs': 'hidden' } }, { files: { 'data.txt': 'fixture' } })
    const port = async (request: CommandRequest) => { seen.push(request); return { exitCode: request.files['solution.mjs']!.includes('good') ? 0 : 1, output: 'AssertionError: nope' } }
    expect(await grade(command, { answer: 'Here:\n```js\nexport const good = 1\n```', files: { 'made.txt': 'x' } }, port)).toEqual({ pass: true, detail: 'node exited 0' })
    expect(seen[0]).toMatchObject({ cmd: 'node', args: ['check.mjs'], timeoutSec: 5, files: { 'data.txt': 'fixture', 'made.txt': 'x', 'check.mjs': 'hidden', 'solution.mjs': 'export const good = 1\n' } })
    expect(await grade(command, { answer: 'export const bad = 1' }, port)).toEqual({ pass: false, detail: 'node exited 1, expected 0: AssertionError: nope' })
    expect(await grade(command, { answer: 'x' }, async () => ({ exitCode: null, timedOut: true }))).toEqual({ pass: false, detail: 'the check timed out after 5 s' })
    expect(await grade(command, { answer: 'x' })).toEqual({ pass: false, detail: 'no command runner is available for this grader' })
  })
  it('extracts code from a fenced answer and strips reasoning', () => {
    expect(answerCode('<think>hmm</think>Sure:\n```javascript\nconst a = 1\n```\nDone')).toBe('const a = 1\n')
    expect(answerCode('const b = 2')).toBe('const b = 2\n')
  })
})

type Script = (job: EvaluationJob, signal: AbortSignal) => Promise<EvaluationRun> | EvaluationRun
const harness = (script: Script, extra: Partial<EvaluationPorts> = {}) => {
  let clock = Date.parse('2026-09-28T12:00:00Z')
  const statuses: ModelStatus[] = [], recorded: ExecutionOutcome[] = [], notified: string[] = [], reports: Array<[string, string]> = []
  const reputation = (key: ModelKey, dimension: string): ReputationScore | null => ({ key, dimension: dimension as ReputationScore['dimension'], mean: key.provider === 'local' ? 0.5 : 0.8, lower: 0.4, evidence: 3, priorMean: 0.6, priorSource: 'default', lastOutcomeAt: null })
  const ports: EvaluationPorts = {
    run: async (key, entry, signal) => { clock += 1000; return script(entry, signal) },
    recordOutcome: row => { recorded.push(row) }, outcomeRecorded: row => { notified.push(row.ref) },
    setStatus: (_key, status) => { statuses.push(status) }, reputation, alternatives: () => [{ provider: 'codex', model: 'gpt-5.6-sol' }],
    writeReport: (name, markdown) => { reports.push([name, markdown]) }, now: () => new Date(clock), ...extra,
  }
  return { ports, statuses, recorded, notified, reports }
}
const suite = (count: number): EvaluationSuite => ({ name: 'mini', jobs: Array.from({ length: count }, (_, index) => job(`job-${index + 1}`, { kind: 'exact', expected: 'ok' }, { category: index % 2 ? 'debugging' : 'simple-coding' })) })

describe('evaluate: a new model', () => {
  it('runs the suite, records graded outcomes and stays unproven below provenSamples', async () => {
    const { ports, statuses, recorded, notified, reports } = harness(entry => ({ answer: entry.id === 'job-2' ? 'nope' : 'ok', costUsd: 0, tokens: 120, effort: 'medium' }))
    const result = await evaluate(KEY, suite(3), ports, { runId: 'run1' })
    expect(statuses).toEqual(['evaluating', 'unproven'])
    expect(result).toMatchObject({ runId: 'run1', status: 'unproven', stoppedBy: null, costUsd: 0 })
    expect(recorded.map(row => [row.ref, row.source, row.category, row.result, row.verifier])).toEqual([
      ['run1:job-1', 'evaluation', 'simple-coding', 'success', 'pass'], ['run1:job-2', 'evaluation', 'debugging', 'failure', 'fail'], ['run1:job-3', 'evaluation', 'simple-coding', 'success', 'pass'],
    ])
    expect(recorded[1]).toMatchObject({ key: KEY, complexity: 2, tokens: 120, effort: 'medium', timedOut: false, detail: 'mini/job-2: expected "ok", got "nope"' })
    expect(new Set(recorded.map(row => row.id)).size).toBe(3)
    expect(notified).toEqual(['run1:job-1', 'run1:job-2', 'run1:job-3'])
    const [name, markdown] = reports[0]!
    expect(name).toBe('2026-09-28-local_new-model-9b-run1.md')
    expect(markdown).toContain('# Evaluation: local/new-model-9b')
    expect(markdown).toContain('2/3 graded jobs passed; 360 tokens, cost $0.00')
    expect(markdown).toContain('| Category | local/new-model-9b | codex/gpt-5.6-sol |')
    expect(markdown).toContain('| debugging | 50% (low 40%, n=3) | 80% (low 40%, n=3) |')
    expect(markdown).toContain('no default was changed')
  })
  it('becomes proven once its evidence reaches provenSamples, counting earlier outcomes', async () => {
    expect((await evaluate(KEY, suite(REPUTATION_POLICY.provenSamples), harness(() => ({ answer: 'ok' })).ports)).status).toBe('proven')
    const earlier = Array.from({ length: REPUTATION_POLICY.provenSamples - 2 }, (_, index) => outcomeRow({ key: KEY, source: 'turn', ref: `turn-${index}`, category: 'general', at: '2026-09-28T11:00:00Z', result: 'success' }))
    const { ports, statuses } = harness(() => ({ answer: 'ok' }), { outcomes: () => earlier })
    expect((await evaluate(KEY, suite(2), ports)).status).toBe('proven')
    expect(statuses).toEqual(['evaluating', 'proven'])
  })
  it('reports a command job with no command runner as not-gradable, without running it or recording an outcome', async () => {
    const ran: string[] = []
    const mixed: EvaluationSuite = { name: 'mixed', jobs: [job('plain', { kind: 'exact', expected: 'ok' }), job('checked', { kind: 'command', cmd: 'node', args: ['check.mjs'], expectExit: 0, timeoutSec: 5 })] }
    const { ports, recorded } = harness(entry => { ran.push(entry.id); return { answer: 'ok' } })
    const result = await evaluate(KEY, mixed, ports)
    expect(ran).toEqual(['plain'])
    expect(result.jobs.map(entry => [entry.id, entry.result])).toEqual([['plain', 'success'], ['checked', 'not-gradable']])
    expect(result.jobs[1]!.detail).toMatch(/needs a sandboxed command runner/)
    expect(recorded.map(row => row.ref.split(':')[1])).toEqual(['plain'])
  })
  // N2: the per-run cap is hard. A budgeted runner spends exactly what it is given.
  const budgeted = (budgets: number[], spend: (budget: number) => number = budget => budget) =>
    async (_key: ModelKey, _job: EvaluationJob, _signal: AbortSignal, budget?: { maxTokens: number }): Promise<EvaluationRun> => { budgets.push(budget!.maxTokens); return { answer: 'ok', tokens: spend(budget!.maxTokens) } }
  it('never starts a job that could take a capped run past its cap', async () => {
    const budgets: number[] = [], spends: Array<{ tokens: number; jobs: number; stoppedBy: string | null }> = []
    const { ports, recorded, reports } = harness(() => ({ answer: 'ok' }), { run: budgeted(budgets), recordSpend: spend => { spends.push(spend) } })
    const result = await evaluate(KEY, suite(8), ports, { maxTokens: 60_000, runId: 'capped' })
    expect(budgets).toEqual(Array(6).fill(JOB_TOKEN_BUDGET[1]))
    expect(result).toMatchObject({ stoppedBy: 'token-cap', tokens: 60_000 })
    expect(recorded).toHaveLength(6)
    expect(result.jobs.slice(6).map(entry => [entry.result, entry.detail])).toEqual([
      ['not-gradable', "not run: 0 tokens left of the run's 60,000-token cap, below the 1,002 this job needs"],
      ['not-gradable', "not run: 0 tokens left of the run's 60,000-token cap, below the 1,002 this job needs"],
    ])
    expect(reports[0]![1]).toContain('6/6 graded jobs passed of 8; 60,000 tokens')
    // N4: journaled at the start, after every job and at the end, cumulatively.
    expect(spends.map(spend => spend.tokens)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 60_000])
    expect(spends.at(-1)).toMatchObject({ jobs: 8, stoppedBy: 'token-cap' })
  })
  it('gives the last job only what is left, and skips it when that is below its minimum', async () => {
    const budgets: number[] = []
    const fits = await evaluate(KEY, suite(4), harness(() => ({ answer: 'ok' }), { run: budgeted(budgets) }).ports, { maxTokens: 25_000 })
    expect(budgets).toEqual([10_000, 10_000, 5_000])
    expect(fits).toMatchObject({ tokens: 25_000, stoppedBy: 'token-cap' })
    expect(minimumJobTokens(job('big', { kind: 'exact', expected: 'ok' }, { files: { 'a.txt': 'x'.repeat(8_000) } }))).toBe(3_002)
    expect(jobTokenBudget(job('small', { kind: 'exact', expected: 'ok' }, { maxTokens: 500 }))).toBe(1_002)
  })
  it('records a job that overran its budget at its real spend and stops the run', async () => {
    const budgets: number[] = [], spends: Array<{ tokens: number }> = []
    const { ports, recorded } = harness(() => ({ answer: 'ok' }), { run: budgeted(budgets, budget => budget + 15_000), recordSpend: spend => { spends.push(spend) } })
    const result = await evaluate(KEY, suite(5), ports, { maxTokens: 60_000 })
    expect(budgets).toEqual([10_000])
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.tokens).toBe(25_000)
    expect(result).toMatchObject({ stoppedBy: 'token-cap', tokens: 25_000 })
    expect(result.jobs.slice(1).every(entry => entry.result === 'not-gradable' && entry.detail === 'not run: job-1 spent 25,000 tokens against its 10,000-token budget, so the run stopped')).toBe(true)
    expect(spends.at(-1)!.tokens).toBe(25_000)
  })
  // N3: a failed capped turn is charged what its port measured, a timed-out one its whole budget.
  it('charges a failing capped job the tokens its error reports, and an uncapped one the estimate', async () => {
    const spends: Array<{ tokens: number }> = []
    const failing = Object.assign(new Error('turn failed'), { tokens: 7_500 })
    const { ports, recorded } = harness(() => { throw failing }, { recordSpend: spend => { spends.push(spend) } })
    const result = await evaluate(KEY, suite(2), ports, { maxTokens: 60_000 })
    expect(result.jobs.map(entry => [entry.result, entry.tokens])).toEqual([['failure', 7_500], ['failure', 7_500]])
    expect(recorded.map(row => row.tokens)).toEqual([7_500, 7_500])
    expect(spends.at(-1)!.tokens).toBe(15_000)
    const noTokens = await evaluate(KEY, suite(1), harness(() => { throw new Error('turn failed') }).ports, { maxTokens: 60_000 })
    expect(noTokens.tokens).toBe(JOB_TOKEN_BUDGET[1])
    const local = await evaluate(KEY, suite(1), harness(() => { throw failing }).ports)
    expect(local.tokens).toBe(7_500)
    const localNoTokens = await evaluate(KEY, suite(1), harness(() => { throw new Error('turn failed') }).ports)
    expect(localNoTokens.tokens).toBe(Math.ceil('Do job-1'.length / 4))
  })
  it('charges a timed-out capped job its whole budget, and an uncapped one the estimate', async () => {
    const hang = () => new Promise<EvaluationRun>(() => {})
    const capped = await evaluate(KEY, suite(1), harness(hang).ports, { maxTokens: 60_000, jobTimeoutMs: 20 })
    expect(capped.jobs[0]).toMatchObject({ result: 'failure', timedOut: true, tokens: JOB_TOKEN_BUDGET[1] })
    expect(capped.outcomes[0]!.tokens).toBe(JOB_TOKEN_BUDGET[1])
    const uncapped = await evaluate(KEY, suite(1), harness(hang).ports, { jobTimeoutMs: 20 })
    expect(uncapped.jobs[0]).toMatchObject({ timedOut: true, tokens: Math.ceil('Do job-1'.length / 4) })
    expect(uncapped.outcomes[0]!.tokens).toBeNull()
  })
  it('an uncapped (local) run gets no budget', async () => {
    const seen: Array<unknown> = []
    const { ports } = harness(() => ({ answer: 'ok' }), { run: async (...args) => { seen.push(args[3]); return { answer: 'ok' } } })
    await evaluate(KEY, suite(2), ports)
    expect(seen).toEqual([undefined, undefined])
  })
  it('estimates tokens from the text when a runner reports none, and journals the spend even when a run throws', async () => {
    const spends: Array<{ tokens: number }> = []
    const { ports } = harness(() => ({ answer: 'x'.repeat(400) }), { recordSpend: spend => { spends.push(spend) }, writeReport: () => { throw new Error('disk full') } })
    await expect(evaluate(KEY, suite(1), ports)).rejects.toThrow('disk full')
    expect(spends.at(-1)!.tokens).toBe(Math.ceil('Do job-1'.length / 4) + 100)
  })
  it('stops when the recorded cost exceeds the budget', async () => {
    const { ports, recorded, reports } = harness(() => ({ answer: 'ok', costUsd: 0.4 }))
    const result = await evaluate(KEY, suite(6), ports, { maxCostUsd: 1 })
    expect(result).toMatchObject({ stoppedBy: 'budget', costUsd: expect.closeTo(1.2, 9) })
    expect(recorded).toHaveLength(3)
    expect(reports[0]![1]).toContain('stopped by budget')
  })
  it('counts a job past its timeout as a timed-out failure and aborts the run', async () => {
    let signalled = false
    const { ports, recorded, statuses } = harness((entry, signal) => entry.id === 'job-1'
      ? new Promise(() => { signal.addEventListener('abort', () => { signalled = true }) }) : { answer: 'ok' })
    const result = await evaluate(KEY, suite(2), ports, { jobTimeoutMs: 20 })
    expect(recorded[0]).toMatchObject({ result: 'failure', verifier: 'fail', timedOut: true, detail: 'mini/job-1: timed out after 20 ms' })
    expect(result.jobs[0]).toMatchObject({ result: 'failure', timedOut: true })
    expect(recorded[1]).toMatchObject({ result: 'success' })
    expect(signalled).toBe(true)
    expect(statuses.at(-1)).toBe('unproven')
  })
  it('records a failing run, honours maxJobs, and on abort cancels and still restores the status', async () => {
    const { ports, recorded } = harness(entry => { if (entry.id === 'job-1') throw new Error('server refused'); return { answer: 'ok' } })
    const limited = await evaluate(KEY, suite(5), ports, { maxJobs: 2 })
    expect(limited.stoppedBy).toBe('max-jobs')
    expect(recorded.map(row => row.result)).toEqual(['failure', 'success'])
    expect(recorded[0]!.detail).toBe('mini/job-1: the run failed: server refused')

    const controller = new AbortController()
    const aborting = harness((entry, signal) => entry.id === 'job-2' ? new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped'))); controller.abort() }) : { answer: 'ok' })
    const result = await evaluate(KEY, suite(4), aborting.ports, { signal: controller.signal })
    expect(result.stoppedBy).toBe('aborted')
    expect(aborting.recorded.map(row => row.result)).toEqual(['success', 'cancelled'])
    expect(aborting.statuses).toEqual(['evaluating', 'unproven'])
  })
})
