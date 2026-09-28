import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { LocalModelRequest } from '../local-assist/contract'
import type { EvaluationJob } from './evaluation'
import { answerFiles, cloudRunPort, DEFAULT_FIXED_OVERHEAD_TOKENS, dockerCommandPort, evaluationPrompt, evaluationTokens, EvaluationRefused, EvaluationTurnError, fixedOverhead, isRefusal, localRunPort, type ExecFile } from './evaluation-ports'

const job: EvaluationJob = { id: 'add', category: 'simple-coding', complexity: 1, prompt: 'Write src/add.js exporting add(a, b).', files: { 'package.json': '{"type":"module"}' }, grader: { kind: 'file-content', path: 'src/add.js', regex: 'export function add' } }

describe('the fixed input overhead of a cloud turn (N9)', () => {
  it('is the reported input less the job prompt at four characters a token', () => {
    expect(fixedOverhead(39_115, { system: 's'.repeat(400), user: 'u'.repeat(3_600) })).toBe(38_115)
    expect(fixedOverhead(500, { system: 's'.repeat(4_000), user: '' })).toBe(0)
    expect(fixedOverhead(null, { system: '', user: '' })).toBeNull()
    expect(fixedOverhead(0, { system: '', user: '' })).toBeNull()
    expect(DEFAULT_FIXED_OVERHEAD_TOKENS).toBe(40_000)
  })
  it('comes back with the run, and with a failure that reported its input', async () => {
    const job: EvaluationJob = { id: 'j', category: 'simple-coding', complexity: 1, prompt: 'p'.repeat(400), grader: { kind: 'exact', expected: 'x' } }
    const prompt = evaluationPrompt(job), promptTokens = Math.ceil((prompt.system.length + prompt.user.length) / 4)
    const run = await cloudRunPort(async () => ({ answer: 'x', tokens: 40_100, costUsd: null, durationMs: 1, effort: 'low', inputTokens: 40_000 }))({ provider: 'claude', model: 'haiku' }, job, new AbortController().signal)
    expect(run.overheadTokens).toBe(40_000 - promptTokens)
    const silent = await cloudRunPort(async () => ({ answer: 'x', tokens: null, costUsd: null, durationMs: 1, effort: null }))({ provider: 'claude', model: 'haiku' }, job, new AbortController().signal)
    expect(silent).not.toHaveProperty('overheadTokens')
    const failed = cloudRunPort(async () => { throw new EvaluationTurnError('the evaluation turn ended failed', 6_000, 39_000) })({ provider: 'claude', model: 'haiku' }, job, new AbortController().signal)
    await expect(failed).rejects.toMatchObject({ tokens: 6_000, inputTokens: 39_000, overheadTokens: 39_000 - promptTokens })
  })
})

describe('cloud evaluation spend (N3)', () => {
  it('counts the whole prompt with cache reads and writes plus the output, without double counting', () => {
    // Adapters report cache tokens inside inputTokens (usage-accounting.ts).
    expect(evaluationTokens({ inputTokens: 10_000, cachedTokens: 8_000, cacheCreationTokens: 1_500, outputTokens: 400 })).toBe(10_400)
    // A report whose input leaves the cache out still counts it.
    expect(evaluationTokens({ inputTokens: 500, cachedTokens: 8_000, cacheCreationTokens: 1_500, outputTokens: 400 })).toBe(9_900)
    expect(evaluationTokens({ totalTokens: 1_234 })).toBe(1_234)
    expect(evaluationTokens({ outputTokens: 50 })).toBe(50)
    expect(evaluationTokens(undefined)).toBeNull()
  })
  it('hands the job budget to the cloud turn, and a failure keeps its tokens', async () => {
    const turn = vi.fn(async () => ({ answer: '```a.txt\nhi\n```', tokens: 700, costUsd: null, durationMs: 5, effort: 'low' }))
    const job: EvaluationJob = { id: 'j', category: 'simple-coding', complexity: 1, prompt: 'p', grader: { kind: 'exact', expected: 'x' } }
    const run = await cloudRunPort(turn)({ provider: 'codex', model: 'm' }, job, new AbortController().signal, { maxTokens: 6_000 })
    expect(turn.mock.calls[0]).toEqual([{ provider: 'codex', model: 'm' }, expect.any(Object), expect.any(AbortSignal), { maxTokens: 6_000 }])
    expect(run).toMatchObject({ tokens: 700, files: { 'a.txt': 'hi\n' }, effort: 'low' })
    const failed = cloudRunPort(async () => { throw new EvaluationTurnError('the evaluation turn ended failed', 6_000) })({ provider: 'codex', model: 'm' }, job, new AbortController().signal, { maxTokens: 6_000 })
    await expect(failed).rejects.toMatchObject({ message: 'the evaluation turn ended failed', tokens: 6_000 })
  })
})

describe('evaluation ports', () => {
  it('takes files from path-labelled fenced blocks and never outside the job folder', () => {
    const answer = '<think>```x.js\nnope```</think>Here:\n```src/add.js\nexport function add(a, b) { return a + b }\n```\n```js\nnot a file\n```\n```../escape.js\nbad\n```\n```C:/abs.js\nbad\n```'
    expect(answerFiles(answer)).toEqual({ 'src/add.js': 'export function add(a, b) { return a + b }\n' })
    expect(evaluationPrompt(job).user).toContain('--- package.json ---\n{"type":"module"}')
  })

  it('answers one job through the runner bound to the model under evaluation, and never credits another model', async () => {
    const asked: LocalModelRequest[] = []
    const reply = (model: string, text: string) => ({ ask: async (request: LocalModelRequest) => { asked.push(request); return { ok: true as const, answer: { text, model, inputTokens: 100, outputTokens: 20, durationMs: 900 } } } })
    const run = localRunPort(model => reply(model, '```src/add.js\nexport function add(a, b) { return a + b }\n```'))
    const signal = new AbortController().signal
    await expect(run({ provider: 'local', model: 'local/qwen' }, job, signal)).resolves.toEqual({ answer: expect.stringContaining('export function add'), files: { 'src/add.js': 'export function add(a, b) { return a + b }\n' }, durationMs: 900, tokens: 120, costUsd: 0 })
    expect(asked[0]).toMatchObject({ maxTokens: 4096, signal })
    await expect(localRunPort(() => reply('local/other', 'x'))({ provider: 'local', model: 'local/qwen' }, job, signal)).rejects.toThrow('local/other answered instead of local/qwen')
    await expect(localRunPort(() => ({ ask: async () => ({ ok: false as const, reason: 'another local turn needs the GPU' }) }))({ provider: 'local', model: 'local/qwen' }, job, signal)).rejects.toThrow('GPU')
  })

  it('runs a grader command in docker with no network over a temp folder it removes afterwards', async () => {
    let folder = '', seen: string[] = []
    const exec: ExecFile = (file, args, options, done) => {
      expect(file).toBe('docker')
      seen = args
      const mount = args[args.indexOf('-v') + 1]!
      folder = mount.slice(0, mount.lastIndexOf(':/work'))
      expect(readFileSync(`${folder}/src/add.js`, 'utf8')).toBe('export const x = 1\n')
      expect(options.timeout).toBe(25_000)
      done(Object.assign(new Error('exit 1'), { code: 1 }), 'ok 0\n', 'not ok 1\n')
    }
    const port = dockerCommandPort('conductor-local-sandbox:1', exec)
    const result = await port({ cmd: 'node', args: ['test.mjs'], timeoutSec: 10, files: { 'src/add.js': 'export const x = 1\n', 'test.mjs': 'import "./src/add.js"' } })
    expect(result).toEqual({ exitCode: 1, timedOut: false, output: 'ok 0\nnot ok 1\n' })
    expect(seen.slice(0, 2)).toEqual(['run', '--rm'])
    expect(seen).toEqual(expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL', '--read-only', 'conductor-local-sandbox:1', 'node', 'test.mjs']))
    expect(seen.join(' ')).not.toMatch(/sh -c|cmd \/c/)
    expect(existsSync(folder)).toBe(false)
  })

  it('force-removes a container past its timeout, and refuses shell-like commands and escaping paths', async () => {
    const calls: string[][] = []
    const exec: ExecFile = (_file, args, _options, done) => { calls.push(args); if (args[0] === 'run') done(Object.assign(new Error('killed'), { killed: true }), '', ''); else done(null, '', '') }
    const port = dockerCommandPort('image:1', exec)
    expect(await port({ cmd: 'node', args: ['loop.mjs'], timeoutSec: 1, files: {} })).toMatchObject({ exitCode: null, timedOut: true })
    expect(calls[1]!.slice(0, 2)).toEqual(['rm', '-f'])
    expect(calls[1]![2]).toBe(calls[0]![calls[0]!.indexOf('--name') + 1])
    await expect(port({ cmd: 'node; rm -rf /', args: [], timeoutSec: 1, files: {} })).rejects.toThrow(/plain program name/)
    await expect(port({ cmd: 'node', args: [], timeoutSec: 1, files: { '../outside.js': 'x' } })).rejects.toThrow(/leaves the job folder/)
    const exec2 = vi.fn()
    await expect(dockerCommandPort('image:1', exec2)({ cmd: 'node', args: ['a\0b'], timeoutSec: 1, files: {} })).rejects.toThrow(/plain text/)
    expect(exec2).not.toHaveBeenCalled()
  })
})

describe('a cloud turn refused before any model call (B5-G)', () => {
  const key = { provider: 'claude', model: 'opus[1m]' }
  it('reports what the turn threw before its prompt went out as a refusal that costs nothing', async () => {
    const refused = cloudRunPort(async () => { throw new Error('claude/opus[1m] is not offered on this machine now') })(key, job, new AbortController().signal, { maxTokens: 60_000 })
    await expect(refused).rejects.toBeInstanceOf(EvaluationRefused)
    await expect(refused).rejects.toMatchObject({ refused: true, tokens: 0, message: 'claude/opus[1m] is not offered on this machine now' })
    expect(isRefusal(new EvaluationRefused('x'))).toBe(true)
    expect(isRefusal(new Error('x'))).toBe(false)
  })
  it('keeps a failed turn an EvaluationTurnError, charged as measured (N3)', async () => {
    const failed = cloudRunPort(async () => { throw new EvaluationTurnError('the evaluation turn ended failed', 60_000) })(key, job, new AbortController().signal, { maxTokens: 60_000 })
    await expect(failed).rejects.toBeInstanceOf(EvaluationTurnError)
    await expect(failed).rejects.not.toBeInstanceOf(EvaluationRefused)
  })
  it('hands the turn the caller\'s scope with its budget', async () => {
    const turn = vi.fn(async () => ({ answer: 'x', tokens: 10, costUsd: null, durationMs: 1, effort: null }))
    await cloudRunPort(turn)(key, job, new AbortController().signal, { maxTokens: 9_000 }, { scope: { projectId: 'p1', workspaceId: 'w2' } })
    expect((turn.mock.calls[0] as unknown[])[3]).toEqual({ maxTokens: 9_000, scope: { projectId: 'p1', workspaceId: 'w2' } })
  })
})
