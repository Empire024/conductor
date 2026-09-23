import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_DURABLE_JOB_BUDGETS, type DurableJobHandoff, type DurableJobStage } from '../../shared/durable-jobs.ts'
import type { LocalStopReport } from '../../shared/local-stop.ts'
import { LocalAgentSession, systemPrompt } from '../local-models/agent.ts'
import type { ChatMessage } from '../local-models/client.ts'
import { toolSpecs } from '../local-models/tools.ts'
import { buildStagePrompt, classifyResponse, classifyStageOutcome, estimateRequest, excerpt, extractHandoff, fitRequest, measureRequest, modelWindow, readRange, shouldRollover, StageTooLargeError, stageKind, stageTooling, textTokens, TRIM_ORDER } from './handoff.ts'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()) })
const tempDir = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

const QWEN = { id: 'local/qwen3.6-35b-a3b', contextTokens: 32768 }
const job = { id: 'job-1', title: 'Port the parser', objective: 'Port the invoice parser to the new format and keep every test green.', logDir: 'C:/jobs/job-1/logs', budgets: DEFAULT_DURABLE_JOB_BUDGETS }
const stage = (index: number, title: string, objective: string, extra: Partial<DurableJobStage> = {}): DurableJobStage => ({ id: `s${index}`, jobId: 'job-1', index, title, objective, completionCriteria: ['npx vitest run parser passes'], inputs: [], status: 'pending', attempt: 1, ...extra })
const emptyHandoff = (objective = job.objective): DurableJobHandoff => ({ objective, constraints: [], decisions: [], workDone: [], filesChanged: [], testResults: [], unresolvedIssues: [], nextAction: 'Start on the stage objective.', artifacts: [], updatedAt: '2026-09-24T00:00:00.000Z' })

describe('whole-request estimate', () => {
  it('counts system prompt, tool schemas and large tool results, and fits a many-tools large-file request under 32,768 with 4,096 reserved', () => {
    const tools = toolSpecs(false, true, { git: true, research: true }, 'full')
    const bigFile = Array.from({ length: 3000 }, (_, n) => `export const value${n} = compute(${n}, "some realistic line of source code ${n}")`).join('\n')
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt('C:/work', false, { git: true, research: true }, 'full') },
      { role: 'user', content: 'Refactor the parser.' },
      { role: 'assistant', content: '', tool_calls: [0, 1, 2].map(n => ({ id: `c${n}`, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: `src/big${n}.ts` }) } })) },
      ...[0, 1, 2].map(n => ({ role: 'tool' as const, tool_call_id: `c${n}`, content: bigFile }))
    ]
    const raw = estimateRequest({ messages, tools, model: QWEN })
    expect(raw.fits).toBe(false)
    expect(raw.breakdown.toolSchemas).toBeGreaterThan(1000)
    expect(raw.breakdown.toolResults).toBeGreaterThan(raw.contextTokens)
    expect(raw.reserveTokens).toBe(4096)
    const fitted = fitRequest({ messages, tools, model: QWEN })
    expect(fitted.estimate.fits).toBe(true)
    expect(fitted.estimate.totalTokens).toBeLessThanOrEqual(32768)
    expect(fitted.estimate.promptTokens + 4096).toBeLessThanOrEqual(32768)
    // Every call keeps its result: the protocol group survives trimming.
    expect(fitted.messages.filter(m => m.role === 'tool')).toHaveLength(3)
  })

  it('reproduces the overnight failure with the runtime tokenizer count and demands a rollover', async () => {
    const estimate = await measureRequest({ messages: [{ role: 'user', content: 'x' }], tools: [], model: QWEN, endpoint: 'http://127.0.0.1:1', apiKey: 'k', countTokens: async () => 29886 })
    expect(estimate.method).toBe('runtime tokenizer')
    expect(estimate.totalTokens).toBe(29886 + 4096)
    expect(estimate.fits).toBe(false)
    expect(shouldRollover(estimate, estimate, DEFAULT_DURABLE_JOB_BUDGETS)).toMatchObject({ rollover: true, reason: 'overflow' })
    const fallback = await measureRequest({ messages: [{ role: 'user', content: 'x' }], tools: [], model: QWEN, endpoint: 'http://127.0.0.1:1', apiKey: 'k', countTokens: async () => undefined })
    expect(fallback.method).toBe('conservative estimate')
    expect(fallback.fits).toBe(true)
  })

  it('takes the window from the live model config', () => {
    expect(modelWindow({ id: 'local/x', contextTokens: 65536 })).toMatchObject({ contextTokens: 65536, reserveTokens: 4096, capacityTokens: 61440 })
    expect(() => modelWindow({ id: 'local/x', contextTokens: 4096 })).toThrow(/reserve/)
  })
})

describe('shouldRollover', () => {
  const window = modelWindow(QWEN)
  it('triggers at the rollover fraction, then at the headroom for the next tool response, then overflow', () => {
    const at = Math.floor(32768 * 0.7)
    expect(shouldRollover({ promptTokens: at - 1 }, window, DEFAULT_DURABLE_JOB_BUDGETS)).toMatchObject({ rollover: false, reason: 'below' })
    expect(shouldRollover({ promptTokens: at }, window, DEFAULT_DURABLE_JOB_BUDGETS)).toMatchObject({ rollover: true, reason: 'fraction', fractionTokens: at })
    expect(shouldRollover({ promptTokens: 32768 - 4096 - 2048 }, window, DEFAULT_DURABLE_JOB_BUDGETS)).toMatchObject({ rollover: true, reason: 'headroom' })
    expect(shouldRollover({ promptTokens: 28673 }, window, DEFAULT_DURABLE_JOB_BUDGETS)).toMatchObject({ rollover: true, reason: 'overflow' })
  })
  it('lets the safety margin win when the fraction is set high', () => {
    const budgets = { contextRolloverFraction: 0.95, contextSafetyMarginTokens: 4000 }
    expect(shouldRollover({ promptTokens: 25000 }, window, budgets)).toMatchObject({ rollover: true, reason: 'headroom' })
    expect(() => shouldRollover({ promptTokens: 1 }, window, { contextRolloverFraction: 1.5, contextSafetyMarginTokens: 0 })).toThrow(/fraction/)
  })
})

describe('buildStagePrompt', () => {
  const rich = (): DurableJobHandoff => ({
    ...emptyHandoff(),
    constraints: ['Only src/parser/ may change.'],
    decisions: Array.from({ length: 20 }, (_, n) => `decision ${n}: ${'d'.repeat(200)}`),
    workDone: Array.from({ length: 30 }, (_, n) => `work ${n}: ${'w'.repeat(300)}`),
    filesChanged: ['src/parser/a.ts', 'src/parser/b.ts'],
    testResults: Array.from({ length: 20 }, (_, n) => `fail (exit 1): npx vitest run t${n} ${'t'.repeat(150)}`),
    unresolvedIssues: ['Failing: parser.test.ts - currency column missing'],
    nextAction: 'Add the currency column to the row mapper.',
    artifacts: [{ path: 'C:/jobs/job-1/logs/excerpts/vitest-abc.log', kind: 'log', range: { from: 120, to: 180 }, note: 'first failure' }]
  })

  it('renders every durable section, artifacts as path and range only', () => {
    const result = buildStagePrompt(job, stage(1, 'Fix currency', 'Add the currency column.'), rich(), QWEN, { budgetTokens: 20000 })
    if (!result.ok) throw result.error
    for (const heading of ['JOB OBJECTIVE', 'THIS STAGE', 'STAGE IS COMPLETE WHEN', 'CONSTRAINTS', 'DECISIONS ALREADY MADE', 'WORK DONE', 'FILES CHANGED SO FAR', 'TEST RESULTS', 'UNRESOLVED ISSUES', 'ARTIFACTS ON DISK', 'NEXT ACTION']) expect(result.prompt).toContain(heading)
    expect(result.prompt).toContain('C:/jobs/job-1/logs/excerpts/vitest-abc.log lines 120-180 (log): first failure')
    expect(result.trimmed).toEqual([])
    expect(result.tokens).toBe(textTokens(result.prompt))
  })

  it('trims lowest-value sections first, oldest entries first, and never the required ones', () => {
    const full = buildStagePrompt(job, stage(1, 'Fix currency', 'Add the currency column.'), rich(), QWEN, { budgetTokens: 20000 })
    if (!full.ok) throw full.error
    const result = buildStagePrompt(job, stage(1, 'Fix currency', 'Add the currency column.'), rich(), QWEN, { budgetTokens: full.tokens - 2000 })
    if (!result.ok) throw result.error
    expect(result.tokens).toBeLessThanOrEqual(full.tokens - 2000)
    expect(result.trimmed.map(t => t.section)).toEqual(['workDone'])
    expect(result.prompt).not.toContain('work 0:')
    expect(result.prompt).toContain('work 29:')
    const deeper = buildStagePrompt(job, stage(1, 'Fix currency', 'Add the currency column.'), rich(), QWEN, { budgetTokens: 1200 })
    if (!deeper.ok) throw deeper.error
    const order = deeper.trimmed.map(t => t.section)
    expect(order).toEqual(TRIM_ORDER.filter(section => order.includes(section)))
    expect(order.slice(0, 2)).toEqual(['workDone', 'testResults'])
    for (const kept of ['Only src/parser/ may change.', 'Add the currency column.', 'npx vitest run parser passes', 'Add the currency column to the row mapper.', job.objective]) expect(deeper.prompt).toContain(kept)
    expect(deeper.prompt).toMatch(/earlier entries omitted; the full record is in C:\/jobs\/job-1\/logs/)
  })

  it('returns a typed error when the stage itself cannot fit', () => {
    const huge = stage(1, 'Everything', 'Do everything. ' + 'x'.repeat(40000), { completionCriteria: ['all of it'] })
    const result = buildStagePrompt(job, huge, rich(), QWEN)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(StageTooLargeError)
    expect(result.error.code).toBe('stage-too-large')
    expect(result.error.suggestion).toBe('split-stage')
    expect(result.error.budgetTokens).toBe(8192)
  })

  it('shrinks the budget so system prompt, tools and stage prompt start below the rollover fraction', () => {
    const tooling = stageTooling('implement', 'C:/work')
    const result = buildStagePrompt(job, stage(1, 'Fix currency', 'Add the currency column.'), rich(), QWEN, { budgetTokens: 30000, systemPrompt: tooling.systemPrompt, tools: tooling.tools })
    if (!result.ok) throw result.error
    const first = estimateRequest({ messages: [{ role: 'system', content: tooling.systemPrompt }, { role: 'user', content: result.prompt }], tools: tooling.tools, model: QWEN })
    expect(shouldRollover(first, first, DEFAULT_DURABLE_JOB_BUDGETS).rollover).toBe(false)
  })
})

// A streaming OpenAI-shaped endpoint, as in local-models/recovery.test.ts.
async function endpoint(reply: (n: number, body: any) => any): Promise<{ url: string; requests: any[] }> {
  const requests: any[] = []
  const server = createServer((req, res) => { let body = ''; req.on('data', b => body += b); req.on('end', () => { const parsed = JSON.parse(body); const message = reply(requests.length, parsed); requests.push(parsed); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`) }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, requests }
}
const call = (id: string, name: string, args: unknown) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] })
const sessionOptions = (url: string, root: string, taskId: string) => ({ endpoint: url, apiKey: 'k'.repeat(64), model: QWEN.id, workspace: root, sandbox: null, readOnly: false, timeoutSec: 5, contextTokens: QWEN.contextTokens, taskId, contract: {} })

describe('extractHandoff', () => {
  it('lets a second worker continue from the handoff alone, without the prior transcript', async () => {
    const root = tempDir('durable-handoff-')
    const stage1 = stage(0, 'Record the constant', 'Write the parser constant to notes.txt.')
    const stage2 = stage(1, 'Report the constant', 'Read the file stage 1 wrote and state the constant.')
    // Worker 1: writes a file, then finishes with narration only it should remember.
    const s1 = await endpoint(n => n === 0 ? call('w1', 'write_file', { path: 'notes.txt', content: 'alpha=42\n' }) : { content: 'Done. STAGE1-PRIVATE-NARRATION: I considered alpha=41 first.' })
    const first = new LocalAgentSession(sessionOptions(s1.url, root, 'stage-1'))
    const p1 = buildStagePrompt(job, stage1, emptyHandoff(), QWEN)
    if (!p1.ok) throw p1.error
    const outcome1 = await first.run(p1.prompt, {})
    expect(outcome1.stopReason).toBe('completed')

    const handoff = extractHandoff(emptyHandoff(), outcome1.report, first.state(), undefined, { stage: stage1, nextStage: stage2, finalText: outcome1.text, now: () => new Date('2026-09-24T01:00:00Z') })
    expect(handoff.filesChanged).toContain('notes.txt')
    expect(handoff.workDone[0]).toMatch(/^Stage 1 "Record the constant": completed/)
    expect(handoff.nextAction).toContain('Begin stage 2 "Report the constant"')
    expect(handoff.updatedAt).toBe('2026-09-24T01:00:00.000Z')
    // Durable state survives serialization; the controller persists exactly this.
    const persisted: DurableJobHandoff = JSON.parse(JSON.stringify(handoff))

    // Worker 2: a new session and task id; it gets only the stage prompt built from the handoff.
    const s2 = await endpoint((n, body) => {
      if (n === 0) {
        const user = body.messages.find((m: any) => m.role === 'user').content as string
        const path = /FILES CHANGED SO FAR\n- (\S+)/.exec(user)?.[1] ?? 'missing'
        return call('r1', 'read_file', { path })
      }
      const result = body.messages.find((m: any) => m.role === 'tool').content as string
      return { content: `The constant is ${/alpha=(\d+)/.exec(result)?.[1] ?? 'unknown'}.` }
    })
    const p2 = buildStagePrompt(job, stage2, persisted, QWEN)
    if (!p2.ok) throw p2.error
    const outcome2 = await new LocalAgentSession(sessionOptions(s2.url, root, 'stage-2')).run(p2.prompt, {})
    const firstRequest = JSON.stringify(s2.requests[0].messages)
    expect(s2.requests[0].messages.every((m: any) => m.role === 'system' || m.role === 'user')).toBe(true)
    expect(firstRequest).not.toContain('STAGE1-PRIVATE-NARRATION')
    expect(firstRequest).not.toContain('alpha=42')
    expect(firstRequest).toContain('notes.txt')
    expect(outcome2.text).toBe('The constant is 42.')
    expect(classifyStageOutcome(outcome2).success).toBe(true)
  })

  it('records failures, tests and repeated errors, and does not call an unfinished stage clean', () => {
    const report = { reason: 'round_limit', detail: 'Reached 24 tool rounds.', rounds: 24, hardLimit: 24, context: { usedTokens: 20000, capacityTokens: 28672, reserveTokens: 4096, windowTokens: 32768, percent: 70, estimated: false }, compactions: 1, recoveredTokens: 0, loopWarnings: 0, filesChanged: ['src/parser/a.ts'], commandsRun: 2, excludedOutputChars: 0, timeline: [] } satisfies LocalStopReport
    const previous = { ...emptyHandoff(), testResults: ['pass: npx vitest run parser'], unresolvedIssues: ['Owner wants CZK only.'] }
    const state = { task: 't', constraints: ['Only src/parser/ may change.'], filesChanged: ['src/parser/a.ts'], commands: [{ command: 'npx vitest run parser', exitCode: 1, ok: false }], currentFailure: { source: 'npx vitest run parser', excerpt: '\nAssertionError: expected 3 to be 4\n  at parser.test.ts:10:3' }, discoveries: ['Rows use ; as delimiter.'], compactions: 1 }
    const handoff = extractHandoff(previous, report, state, { writes: [{ path: 'src/parser/b.ts', tool: 'write_file', sha256: 'x' }], commands: [] }, { stage: stage(2, 'Fix', 'fix'), artifacts: [{ path: 'C:/logs/excerpts/vitest.log', kind: 'log', range: { from: 1, to: 40 } }] })
    expect(handoff.testResults).toEqual(['fail (exit 1): npx vitest run parser'])
    expect(handoff.filesChanged).toEqual(['src/parser/a.ts', 'src/parser/b.ts'])
    expect(handoff.decisions).toContain('Rows use ; as delimiter.')
    expect(handoff.constraints).toContain('Only src/parser/ may change.')
    expect(handoff.unresolvedIssues).toEqual(['Owner wants CZK only.', 'Failing: npx vitest run parser - AssertionError: expected 3 to be 4', 'Stage 3 stopped: round_limit: Reached 24 tool rounds.'])
    expect(handoff.nextAction).toMatch(/^Fix the failure from npx vitest run parser/)
    expect(handoff.artifacts).toEqual([{ path: 'C:/logs/excerpts/vitest.log', kind: 'log', range: { from: 1, to: 40 } }])
    // A later clean stage clears the generated issues but keeps the owner's.
    const cleanReport = { ...report, reason: 'completed' as const, detail: 'The model gave its final answer.' }
    const next = extractHandoff(handoff, cleanReport, { ...state, currentFailure: undefined, commands: [{ command: 'npx vitest run parser', exitCode: 0, ok: true }] }, undefined, { stage: stage(2, 'Fix', 'fix', { attempt: 2 }), finalText: 'Fixed.' })
    expect(next.unresolvedIssues).toEqual(['Owner wants CZK only.'])
    expect(next.testResults).toEqual(['pass: npx vitest run parser'])
    expect(next.workDone.at(-1)).toMatch(/^Stage 3 "Fix" \(attempt 2\): completed/)
  })
})

describe('excerpt and selective reads', () => {
  it('keeps the raw log on disk and hands over the window around the first failure with its line range', async () => {
    const logDir = tempDir('durable-logs-')
    const lines = [...Array.from({ length: 2000 }, (_, n) => `info line ${n}`), 'TypeError: cannot read properties of undefined', '    at parse (src/parser/a.ts:10:3)', ...Array.from({ length: 2000 }, (_, n) => `later line ${n}`)]
    const raw = lines.join('\n') + '\n'
    const saved: string[] = []
    const result = await excerpt({ logDir, name: 'build output', raw, limitChars: 1500, store: { owner: 'ws\0job', store: { save: (_owner, value) => { saved.push(value); return '00000000-0000-4000-8000-000000000001' } } } })
    expect(readFileSync(result.path, 'utf8')).toBe(raw)
    expect(result.path.startsWith(join(logDir, 'excerpts'))).toBe(true)
    expect(result.ref.range!.from).toBe(1996)
    expect(result.ref.range!.to).toBeGreaterThan(2002)
    expect(result.text).toContain('TypeError: cannot read properties')
    expect(result.text).toContain(`lines ${result.ref.range!.from}-${result.ref.range!.to} of 4002`)
    expect(result.text).toContain('artifact=00000000-0000-4000-8000-000000000001')
    expect(result.text.length).toBeLessThan(1500 + 400)
    expect(saved).toEqual([raw])
    const again = await excerpt({ logDir, name: 'build output', raw, limitChars: 1500 })
    expect(again.path).toBe(result.path)
  })

  it('shapes test output, keeps short output whole, and reads a large file by range', async () => {
    const logDir = tempDir('durable-logs-')
    const test = Array.from({ length: 800 }, (_, n) => ` ✓ passes case ${n}`).join('\n') + '\n FAIL parser.test.ts > currency\nAssertionError: expected 3 to be 4\nTests: 1 failed, 800 passed'
    const shaped = await excerpt({ logDir, name: 'vitest', raw: test, command: 'npx vitest run parser', limitChars: 2000 })
    expect(shaped.text).toContain('800 passing-test lines omitted')
    expect(shaped.text).toContain('AssertionError')
    const short = await excerpt({ logDir, name: 'ok', raw: 'all good\n' })
    expect(short.text.endsWith('all good\n')).toBe(true)
    expect(short.ref.range).toEqual({ from: 1, to: 1 })

    const file = join(logDir, 'large.txt')
    writeFileSync(file, Array.from({ length: 5000 }, (_, n) => `row ${n + 1}`).join('\n'))
    const read = await readRange(file, { from: 100, to: 120 })
    expect(read.ref).toMatchObject({ path: file, range: { from: 100, to: 120 } })
    expect(read.text).toContain('returned_lines=100-120')
    expect(read.text).toContain('row 100\n')
    expect(read.text).not.toContain('row 121')
  })
})

describe('stage tooling', () => {
  it('narrows tools by stage kind and counts their schema cost', () => {
    const investigate = stageTooling('investigate', 'C:/work')
    expect(investigate.tools.map(t => t.function.name)).toEqual(['read_file', 'list_files', 'search'])
    expect(investigate.contract).toEqual({})
    const implement = stageTooling('implement', 'C:/work')
    expect(implement.tools.map(t => t.function.name)).toEqual(['read_file', 'list_files', 'search', 'write_file', 'edit_file', 'apply_edits', 'run_command'])
    const research = stageTooling('research', 'C:/work', { git: false, research: true })
    expect(research.tools.map(t => t.function.name)).toContain('web_search')
    expect(research.contract).toBeUndefined()
    expect(investigate.schemaTokens).toBeLessThan(implement.schemaTokens)
    expect(stageKind({ title: 'Verify the fix', objective: 'run tests' })).toBe('verify')
    expect(stageKind({ title: 'Investigate the parser', objective: 'read' })).toBe('investigate')
    expect(stageKind({ title: 'Add currency support', objective: 'edit the mapper' })).toBe('implement')
  })
})

describe('response classification', () => {
  const base = { content: '', reasoning: '', toolCalls: [], finishReason: 'stop' }
  it('never treats empty, reasoning-only, truncated or stub responses as usable', () => {
    expect(classifyResponse(base)).toMatchObject({ kind: 'empty', usable: false })
    expect(classifyResponse({ ...base, reasoning: 'thinking...' })).toMatchObject({ kind: 'reasoning-only', usable: false })
    expect(classifyResponse({ ...base, content: '<think>still going' })).toMatchObject({ kind: 'truncated', usable: false })
    expect(classifyResponse({ ...base, content: '<think>done</think>' })).toMatchObject({ kind: 'reasoning-only', usable: false })
    expect(classifyResponse({ ...base, content: 'The answer is', finishReason: 'length' })).toMatchObject({ kind: 'truncated', usable: false })
    expect(classifyResponse({ ...base, toolCalls: [{ id: 'a', name: 'read_file', arguments: '{' }] })).toMatchObject({ kind: 'malformed-calls', usable: false })
    expect(classifyResponse({ ...base, toolCalls: [{ id: 'a', name: 'write_file', arguments: '{"path":"a","content":"x' }], finishReason: 'length' })).toMatchObject({ kind: 'truncated', usable: false })
    expect(classifyResponse({ ...base, content: 'x', finishReason: 'rumination' })).toMatchObject({ kind: 'rumination', usable: false })
    expect(classifyResponse({ ...base, stream: { events: 3, malformed: 3 } })).toMatchObject({ kind: 'malformed-stream', usable: false })
    expect(classifyResponse({ ...base, content: '<think>ok</think>Done: 42.' })).toMatchObject({ kind: 'answer', usable: true })
    expect(classifyResponse({ ...base, toolCalls: [{ id: 'a', name: 'read_file', arguments: '{"path":"a"}' }] })).toMatchObject({ kind: 'tool-calls', usable: true })
  })
  it('does not report a stage successful on an empty or truncated final answer', () => {
    expect(classifyStageOutcome({ text: '', stopReason: 'completed' })).toMatchObject({ success: false, retryable: true })
    expect(classifyStageOutcome({ text: '<think>almost', stopReason: 'completed' })).toMatchObject({ success: false })
    expect(classifyStageOutcome({ text: 'Half an answ', stopReason: 'output_limit' })).toMatchObject({ success: false, retryable: true })
    expect(classifyStageOutcome({ text: 'Claimed.', stopReason: 'unverified_claim' })).toMatchObject({ success: false, retryable: false })
    expect(classifyStageOutcome({ text: 'Done.', stopReason: 'completed' })).toMatchObject({ success: true })
  })
})
