import { describe, expect, it } from 'vitest'
import { REPUTATION_POLICY, type ExecutionOutcome, type ModelKey, type ModelStatus, type ReputationScore } from '../../shared/model-routing'
import { outcome as outcomeRow } from './capture/common'
import {
  BATCH_JOB_ID, DEFAULT_FIXED_OVERHEAD_TOKENS, EVALUATION_AREAS, JOB_TOKEN_BUDGET, answerCode, batchJobTokens, batchPrompt, evaluate, grade, splitBatchAnswer, jobTokenBudget, minimumJobTokens, refusedBeforeTurn, schemaViolation, validateSuite, type CommandRequest, type EvaluationJob, type EvaluationPorts,
  type EvaluationRun, type EvaluationSpend, type EvaluationSuite
} from './evaluation'
import { EvaluationRefused } from './evaluation-ports'
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
    // N12: each job's budget is pre-charged before its turn, then reconciled to the real spend.
    expect(spends.map(spend => spend.tokens)).toEqual([0, ...[1, 2, 3, 4, 5, 6].flatMap(step => [step * 10_000, step * 10_000]), 60_000])
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
    // N9 (a): charged its whole budget, the turn was stopped by the cap, not by a wrong answer.
    expect(noTokens.jobs[0]).toMatchObject({ result: 'not-gradable', detail: expect.stringMatching(/^not graded: the turn was stopped at its 10,000-token budget/) })
    expect(noTokens.outcomes).toEqual([])
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

describe('batched cloud evaluation (N9)', () => {
  const CLOUD: ModelKey = { provider: 'claude', model: 'sonnet' }
  const mixed: EvaluationSuite = { name: 'mixed', jobs: [
    job('first', { kind: 'exact', expected: '4+6' }, { complexity: 1 }),
    job('checked', { kind: 'command', cmd: 'node', args: ['check.mjs'], expectExit: 0, timeoutSec: 5 }),
    job('json', { kind: 'json-schema', schema: { type: 'object', required: ['n'], properties: { n: { const: 2 } } } }),
    job('file', { kind: 'file-content', path: 'out/summary.json', regex: '"paid"\\s*:\\s*4' }),
    job('wrong', { kind: 'exact', expected: 'yes' }),
  ] }
  const answer = ['### JOB first', '4+6', '', '### JOB json', '```json', '{"n": 2}', '```', '### JOB file', '```out/summary.json', '{"paid": 4}', '```', '### JOB wrong', 'no'].join('\n')

  it('splits a batched answer by its "### JOB <id>" headers, ignoring reasoning and unknown ids', () => {
    expect(splitBatchAnswer('<think>### JOB a\nno</think>\npreamble\n### JOB a\none\n## JOB b:\ntwo\n### JOB ghost\nx', ['a', 'b'])).toEqual({ a: 'one', b: 'two\n### JOB ghost\nx' })
    const prompt = batchPrompt(mixed.jobs.slice(0, 2))
    expect(prompt).toMatchObject({ id: BATCH_JOB_ID, complexity: 2 })
    expect(prompt.prompt).toContain('## TASK 1 of 2: first')
    expect(prompt.prompt).toContain('"### JOB <task id>"')
  })
  it('forgives near-miss headers and an answer wrapped whole in one fence (N15)', () => {
    const ids = ['predict-output', 'log-timeouts'], both = { 'predict-output': '4+6', 'log-timeouts': '3' }
    const variants = [
      '### job predict-output\n4+6\n### job log-timeouts\n3',
      '### JOB: predict-output\n4+6\n### JOB: log-timeouts\n3',
      '### JOB `predict-output`\n4+6\n### JOB `log-timeouts`\n3',
      '**JOB predict-output**\n4+6\n**JOB log-timeouts**\n3',
      '**JOB predict-output** 4+6\n**JOB: log-timeouts** (task 2)\n3',
      '### JOB predict-output (task 1)\n4+6\n### JOB log-timeouts (task 2)\n3',
      '# JOB predict-output\n4+6\n###### JOB log-timeouts\n3',
      '### **JOB predict-output**\n4+6\n### **JOB log-timeouts.**\n3',
      '### JOB 1\n4+6\n### JOB 2\n3',
      'Here are my answers.\n\n### JOB predict-output\n4+6\n### JOB log-timeouts\n3',
      '```\n### JOB predict-output\n4+6\n### JOB log-timeouts\n3\n```',
      '```markdown\n### JOB predict-output\n4+6\n### JOB log-timeouts\n3\n```',
    ]
    for (const text of variants) expect(splitBatchAnswer(text, ids), text).toEqual(both)
    // A fenced block of the last job's own is kept whole; only a fence that closes nothing is dropped.
    expect(splitBatchAnswer('```\n### JOB a\none\n### JOB b\n```json\n{"n": 2}\n```\n```', ['a', 'b'])).toEqual({ a: 'one', b: '```json\n{"n": 2}\n```' })
    expect(splitBatchAnswer('### JOB a\n```js\nx\n```', ['a'])).toEqual({ a: '```js\nx\n```' })
    // A number among id headers is its task when no header names that task (N20); a number whose task is named, or
    // out of range, still ends the section before it. A heading of 7 hashes or a plain line is not a header.
    expect(splitBatchAnswer('### JOB a\nA\n### JOB 2\nB\n### JOB c\nC', ['a', 'b', 'c'])).toEqual({ a: 'A', b: 'B', c: 'C' })
    expect(splitBatchAnswer('### JOB a\none\n### JOB 1\nagain\n### JOB 9\nnine\n### JOB b\ntwo', ['a', 'b'])).toEqual({ a: 'one', b: 'two' })
    expect(splitBatchAnswer('### JOB b\ntwo\n### JOB 1\none', ['a', 'b'])).toEqual({ a: 'one', b: 'two' })
    expect(splitBatchAnswer('####### JOB a\nx\nJOB b\ny', ['a', 'b'])).toEqual({})
  })
  it('records nothing when no section is found for the whole batch (N15)', async () => {
    const spends: Array<{ tokens: number }> = []
    const { ports, recorded } = harness(() => ({ answer: 'Sure! 4+6, {"n": 2}, and no.', tokens: 41_000 }), { recordSpend: spend => { spends.push(spend) } })
    const result = await evaluate(CLOUD, mixed, ports, { maxTokens: 60_000 })
    expect(recorded).toEqual([])
    expect(result).toMatchObject({ tokens: 41_000, stoppedBy: null, outcomes: [] })
    expect(result.jobs.every(entry => entry.result === 'not-gradable')).toBe(true)
    expect(result.jobs.filter(entry => entry.id !== 'checked').map(entry => entry.detail)).toEqual(Array(4).fill('not graded: the batched answer had no "### JOB <id>" section for any task'))
    expect(spends.at(-1)!.tokens).toBe(41_000)
    // Near-miss headers through the whole run: graded, not N invalid-output failures.
    const slipped = await evaluate(CLOUD, mixed, harness(() => ({ answer: answer.split('### JOB ').join('### JOB: '), tokens: 41_000 })).ports, { maxTokens: 60_000 })
    expect(slipped.jobs.map(entry => entry.result)).toEqual(['success', 'not-gradable', 'success', 'success', 'failure'])
  })
  it('runs every one-shot job of a cloud run in one turn, pays the overhead once and grades each job separately', async () => {
    const turns: Array<{ job: EvaluationJob; budget?: { maxTokens: number } }> = [], spends: Array<{ tokens: number }> = []
    const { ports, recorded } = harness(() => ({ answer: 'unused' }), {
      run: async (_key, batch, _signal, budget) => { turns.push({ job: batch, ...(budget ? { budget } : {}) }); return { answer, tokens: 43_000 } },
      fixedOverheadTokens: () => 39_000, recordSpend: spend => { spends.push(spend) },
    })
    const result = await evaluate(CLOUD, mixed, ports, { maxTokens: 60_000, runId: 'b1' })
    expect(turns).toHaveLength(1)
    expect(turns[0]!.budget).toEqual({ maxTokens: 60_000 })
    expect(turns[0]!.job.prompt).not.toContain('TASK 2 of 4: checked')
    expect(result.jobs.map(entry => [entry.id, entry.result])).toEqual([['first', 'success'], ['checked', 'not-gradable'], ['json', 'success'], ['file', 'success'], ['wrong', 'failure']])
    expect(recorded.map(row => [row.ref, row.result])).toEqual([['b1:first', 'success'], ['b1:json', 'success'], ['b1:file', 'success'], ['b1:wrong', 'failure']])
    expect(result).toMatchObject({ tokens: 43_000, stoppedBy: null })
    // N12: the batch's budget is pre-charged before its turn, then reconciled.
    expect(spends.map(spend => spend.tokens)).toEqual([0, 60_000, 43_000])
  })
  it('drops the largest jobs when the fixed overhead plus the batch would pass the cap, and takes the overhead from the port', async () => {
    const sizes = mixed.jobs.filter(entry => entry.grader.kind !== 'command').map(batchJobTokens)
    const turns: EvaluationJob[] = []
    const { ports } = harness(() => ({ answer: 'unused' }), { run: async (_key, batch) => { turns.push(batch); return { answer, tokens: 50_000 } }, fixedOverheadTokens: provider => provider === 'claude' ? 55_000 : 0 })
    const result = await evaluate(CLOUD, mixed, ports, { maxTokens: 55_000 + sizes.reduce((a, b) => a + b, 0) - 1 })
    const dropped = result.jobs.filter(entry => entry.detail.startsWith('not run: dropped from the batch'))
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.detail).toMatch(/a native turn's 55,000 fixed tokens plus the batched jobs' [\d,]+ pass the run's [\d,]+-token cap/)
    expect(turns[0]!.prompt).not.toContain(`: ${dropped[0]!.id}\n`)
    const none = await evaluate(CLOUD, mixed, harness(() => ({ answer: 'unused' }), { fixedOverheadTokens: () => 70_000 }).ports, { maxTokens: 60_000 })
    expect(none).toMatchObject({ stoppedBy: 'token-cap', tokens: 0, outcomes: [] })
    expect(DEFAULT_FIXED_OVERHEAD_TOKENS).toBe(40_000)
  })
  it('never records a false failure when the batched turn is stopped by the cap or fails as a whole', async () => {
    const capped = await evaluate(CLOUD, mixed, harness(() => { throw Object.assign(new Error('the evaluation turn passed its 60000-token budget and was stopped'), { tokens: 61_200 }) }).ports, { maxTokens: 60_000 })
    expect(capped).toMatchObject({ tokens: 61_200, stoppedBy: 'token-cap', outcomes: [] })
    expect(capped.jobs.filter(entry => entry.id !== 'checked').every(entry => entry.result === 'not-gradable' && entry.detail.startsWith('not graded: the batched turn failed'))).toBe(true)
    const hung = await evaluate(CLOUD, mixed, harness(() => new Promise<EvaluationRun>(() => {})).ports, { maxTokens: 60_000, jobTimeoutMs: 5 })
    expect(hung).toMatchObject({ tokens: 60_000, outcomes: [] })
    // A missing section is the model's own omission: that one job fails, the rest are graded.
    const partial = await evaluate(CLOUD, mixed, harness(() => ({ answer: '### JOB first\n4+6', tokens: 41_000 })).ports, { maxTokens: 60_000 })
    expect(partial.jobs.map(entry => entry.result)).toEqual(['success', 'not-gradable', 'failure', 'failure', 'failure'])
    expect(partial.jobs[2]!.detail).toBe('no "### JOB json" section in the batched answer')
  })
  it('keeps one job per turn for local keys, or when batching is switched off', async () => {
    const turns: string[] = []
    const { ports } = harness(entry => { turns.push(entry.id); return { answer: 'ok' } })
    await evaluate(KEY, suite(3), ports)
    await evaluate(CLOUD, suite(2), ports, { batch: false })
    expect(turns).toEqual(['job-1', 'job-2', 'job-3', 'job-1', 'job-2'])
  })
})

describe('a turn refused before any model call (B5-G)', () => {
  const CLOUD: ModelKey = { provider: 'claude', model: 'opus[1m]' }
  const refusal = 'claude/opus[1m] is not offered on this machine now; models.list shows what is, or omit route and name provider and model'
  const refused = () => { throw new EvaluationRefused(refusal) }

  it('charges nothing, grades nothing and stops as refused with the reason, releasing the pre-charged budget', async () => {
    const spends: EvaluationSpend[] = []
    const { ports, recorded, reports } = harness(refused, { recordSpend: spend => { spends.push(spend) }, fixedOverheadTokens: () => 40_000 })
    const result = await evaluate(CLOUD, suite(3), ports, { maxTokens: 60_000, runId: 'r1' })
    expect(result).toMatchObject({ tokens: 0, costUsd: 0, stoppedBy: 'refused', reason: refusal, outcomes: [] })
    expect(result.jobs.every(entry => entry.result === 'not-gradable' && entry.detail === `not run: the turn was refused before any model call: ${refusal}`)).toBe(true)
    expect(recorded).toEqual([])
    // The budget is pre-charged before the turn (N12) and released once the refusal is known.
    expect(spends.map(spend => spend.tokens)).toEqual([0, 60_000, 0])
    expect(spends.at(-1)).toMatchObject({ stoppedBy: 'refused', reason: refusal, gradedJobs: 0 })
    expect(reports[0]![1]).toContain(`0 tokens, cost $0.00; stopped by refused (${refusal}); the run is not counted against the daily caps`)
  })
  it('stops a one-job-per-turn run at the first refusal, charging nothing', async () => {
    const ran: string[] = []
    const { ports, recorded } = harness(entry => { ran.push(entry.id); throw new EvaluationRefused('the tab could not open') })
    const result = await evaluate(KEY, suite(3), ports, { maxTokens: 60_000 })
    expect(ran).toEqual(['job-1'])
    expect(result).toMatchObject({ tokens: 0, stoppedBy: 'refused', reason: 'the tab could not open' })
    expect(result.jobs.map(entry => entry.result)).toEqual(['not-gradable', 'not-gradable', 'not-gradable'])
    expect(recorded).toEqual([])
  })
  it('keeps charging a turn that started and failed (N3)', async () => {
    const failed = await evaluate(CLOUD, suite(2), harness(() => { throw Object.assign(new Error('the evaluation turn ended failed'), { tokens: 60_000 }) }).ports, { maxTokens: 60_000 })
    expect(failed).toMatchObject({ tokens: 60_000, stoppedBy: 'token-cap' })
    expect(failed).not.toHaveProperty('reason')
  })

  // The report of evaluation_mulp6jy2_hn5iazu (2026-09-28), trimmed.
  const phantom = [
    '# Evaluation: claude/opus[1m]', '',
    'Suite **default**, 2026-09-28T20:26:06.396Z. 0/0 graded jobs passed of 14; 60,000 tokens, cost $0.00; stopped by token-cap. Status now **unproven**.', '',
    '## Jobs', '', '| Job | Category | Result | Detail | Time | Cost |', '| --- | --- | --- | --- | --- | --- |',
    '| slugify | simple-coding | not-gradable | not run: a batched cloud run grades one-shot answers; this job\'s check needs a command runner | 0 s | — |',
    `| predict-output | simple-coding | not-gradable | not graded: the batched turn failed: ${refusal} | 0 s | — |`,
    '| find-definition | large-repo | not-gradable | not run: dropped from the batch; a native turn\'s 51,491 fixed tokens plus the batched jobs\' 9,018 pass the run\'s 60,000-token cap | 0 s | — |',
    `| classify-lines | structured-output | not-gradable | not graded: the batched turn failed: ${refusal} | 0 s | — |`, '',
    '## Reputation against alternatives', '', '| Category | claude/opus[1m] |', '| --- | --- |', '| simple-coding | 60% (low 39%, n=0) |', '',
  ].join('\n')
  it('recognises a journaled run whose one turn was refused, from its report, and nothing else', () => {
    expect(refusedBeforeTurn(phantom)).toBe(refusal)
    expect(refusedBeforeTurn(phantom.replaceAll(refusal, 'the evaluation turn ended failed'))).toBeNull()
    expect(refusedBeforeTurn(phantom.replaceAll(refusal, 'the evaluation turn passed its 60000-token budget and was stopped'))).toBeNull()
    expect(refusedBeforeTurn(phantom.replace('| predict-output | simple-coding | not-gradable |', '| predict-output | simple-coding | success |'))).toBeNull()
    expect(refusedBeforeTurn(phantom.split('\n').filter(line => !line.includes('not graded')).join('\n'))).toBeNull()
    expect(refusedBeforeTurn('# Evaluation: x\n\nno jobs')).toBeNull()
  })
})
