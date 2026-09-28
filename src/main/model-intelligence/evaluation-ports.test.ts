import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { LocalModelRequest } from '../local-assist/contract'
import type { EvaluationJob } from './evaluation'
import { answerFiles, cloudRunPort, dockerCommandPort, evaluationPrompt, evaluationTokens, EvaluationTurnError, localRunPort, type ExecFile } from './evaluation-ports'

const job: EvaluationJob = { id: 'add', category: 'simple-coding', complexity: 1, prompt: 'Write src/add.js exporting add(a, b).', files: { 'package.json': '{"type":"module"}' }, grader: { kind: 'file-content', path: 'src/add.js', regex: 'export function add' } }

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
