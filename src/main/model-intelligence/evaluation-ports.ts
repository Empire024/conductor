import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import type { ModelKey } from '../../shared/model-routing'
import type { TokenFigures } from '../../shared/usage-accounting'
import type { LocalModelRunner } from '../local-assist/contract'
import type { CommandRequest, CommandResult, EvaluationJob, EvaluationRun } from './evaluation'

/**
 * The ports models.evaluate hands module D (evaluation.ts): a one-shot local answer, and a grader
 * command that runs only inside the local-models docker sandbox image with no network. Where that
 * sandbox is missing there is no command port and command-graded jobs are not gradable here.
 */

const FIXTURE_CHARS = 40_000
const FILES_MAX_BYTES = 2 * 1024 * 1024
const OUTPUT_TAIL = 2_000
const SYSTEM = [
  'You are being evaluated on a small, self-contained task. Answer it directly and completely.',
  'When the task asks for a file, give each file as a fenced code block whose info string is exactly its relative path, for example ```src/add.js.',
  'When the task asks for code or JSON only, answer with one fenced block and nothing else.'
].join('\n')

export function evaluationPrompt(job: EvaluationJob): { system: string; user: string } {
  const fixtures = Object.entries(job.files ?? {}).map(([path, content]) => `--- ${path} ---\n${content}`).join('\n\n')
  const bounded = fixtures.length > FIXTURE_CHARS ? fixtures.slice(0, FIXTURE_CHARS) + '\n[… fixture files shortened …]' : fixtures
  return { system: SYSTEM, user: `${job.prompt}${bounded ? `\n\nFiles in your workspace:\n\n${bounded}` : ''}` }
}

const safePath = (path: string): string | null => {
  const clean = normalize(path.trim()).replaceAll('\\', '/')
  return clean && !isAbsolute(clean) && !/^[a-z]:/i.test(clean) && !clean.split('/').includes('..') && /^[\w./@+-]{1,200}$/.test(clean) ? clean : null
}

/** Files the answer wrote: fenced blocks whose info string is a relative path with an extension. */
export function answerFiles(answer: string): Record<string, string> {
  const visible = answer.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const files: Record<string, string> = {}
  for (const match of visible.matchAll(/```([^\s`]+\.[A-Za-z0-9]+)[^\S\n]*\n([\s\S]*?)```/g)) {
    const path = safePath(match[1]!)
    if (path) files[path] = match[2]!
  }
  return files
}

/** One job, one bounded answer from the local runner bound to this model. The runner keeps its own
 *  admission rules (no server start during an interactive local turn); the answer must come from
 *  the model under evaluation, or the job fails rather than crediting another model. */
export function localRunPort(runnerFor: (modelId: string) => LocalModelRunner, budgets: { waitBudgetMs?: number; timeoutMs?: number; maxTokens?: number } = {}) {
  return async (key: ModelKey, job: EvaluationJob, signal: AbortSignal): Promise<EvaluationRun> => {
    const started = Date.now()
    const outcome = await runnerFor(key.model).ask({ ...evaluationPrompt(job), maxTokens: budgets.maxTokens ?? 4_096, waitBudgetMs: budgets.waitBudgetMs ?? 180_000, timeoutMs: budgets.timeoutMs ?? 8 * 60_000, signal })
    if (!outcome.ok) throw new Error(outcome.reason)
    if (outcome.answer.model !== key.model) throw new Error(`${outcome.answer.model} answered instead of ${key.model}`)
    const files = answerFiles(outcome.answer.text)
    return { answer: outcome.answer.text, ...(Object.keys(files).length ? { files } : {}), durationMs: outcome.answer.durationMs || Date.now() - started, tokens: outcome.answer.inputTokens + outcome.answer.outputTokens, costUsd: 0 }
  }
}

/** One evaluation turn on a cloud model (AgentControl.evaluationTurn): a native tab at the lowest effort.
 *  `maxTokens` is the job's budget: the turn is interrupted once its usage passes it, and a turn that
 *  fails, times out or reports no usage counts it as spent (a failure throws an EvaluationTurnError). */
export type CloudTurn = (key: ModelKey, prompt: { system: string; user: string }, signal: AbortSignal, options?: { maxTokens?: number }) => Promise<{ answer: string; tokens: number | null; costUsd: number | null; durationMs: number; effort: string | null; /** The input the fixed overhead is learned from (cache included): the turn's first API call where the provider reports calls, else the whole turn's; null when unreported. */ inputTokens?: number | null }>

/** A cloud job's run with the turn's fixed input overhead, when the turn reported its input. */
export type CloudRun = EvaluationRun & { overheadTokens?: number | null }
/** Before a cloud turn has been measured: a native CLI turn carries about 39k tokens of fixed input
 *  (system prompt, tools, project context) before the job itself (verification 2026-09-28, N9). */
export const DEFAULT_FIXED_OVERHEAD_TOKENS = 40_000
/** A turn's fixed input overhead: its reported input less the job prompt it was sent (at about four
 *  characters a token), since a job's own budget already covers its prompt. Null when unreported. */
export function fixedOverhead(inputTokens: number | null | undefined, prompt: { system: string; user: string }): number | null {
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens <= 0) return null
  return Math.max(0, Math.round(inputTokens - Math.ceil((prompt.system.length + prompt.user.length) / 4)))
}

/** What an evaluation turn spent against the caps: the whole prompt, cache reads and cache writes
 *  included, plus the output. Adapters already count cache tokens inside inputTokens
 *  (usage-accounting.ts), so they are only added where a report's input leaves them out. */
export function evaluationTokens(tokens: TokenFigures | undefined): number | null {
  if (!tokens) return null
  if (tokens.inputTokens === undefined && tokens.outputTokens === undefined) return tokens.totalTokens ?? null
  const cache = (tokens.cachedTokens ?? 0) + (tokens.cacheCreationTokens ?? 0)
  return Math.max(tokens.inputTokens ?? 0, cache) + (tokens.outputTokens ?? 0)
}

/** A failed evaluation turn that still spent tokens: its measured usage, else the worst case (the job's budget). */
export class EvaluationTurnError extends Error {
  constructor(message: string, readonly tokens: number | null, readonly inputTokens: number | null = null, readonly overheadTokens: number | null = null) { super(message) }
}

/** A job through the native provider path; files come from the answer's path-labelled blocks, as locally. */
export function cloudRunPort(turn: CloudTurn) {
  return async (key: ModelKey, job: EvaluationJob, signal: AbortSignal, budget?: { maxTokens: number }): Promise<CloudRun> => {
    const prompt = evaluationPrompt(job)
    let result: Awaited<ReturnType<CloudTurn>>
    try { result = await turn(key, prompt, signal, budget ? { maxTokens: budget.maxTokens } : {}) }
    catch (error) {
      // A failed turn still measured its overhead when it reported its input.
      if (error instanceof EvaluationTurnError && error.overheadTokens === null && error.inputTokens !== null)
        throw new EvaluationTurnError(error.message, error.tokens, error.inputTokens, fixedOverhead(error.inputTokens, prompt))
      throw error
    }
    const files = answerFiles(result.answer), overheadTokens = fixedOverhead(result.inputTokens, prompt)
    return { answer: result.answer, ...(Object.keys(files).length ? { files } : {}), durationMs: result.durationMs, tokens: result.tokens, costUsd: result.costUsd, effort: result.effort, ...(overheadTokens !== null ? { overheadTokens } : {}) }
  }
}

export type ExecFile = (file: string, args: string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean }, done: (error: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => void) => void

/** docker run --rm --network none over a temp folder holding only the job files; the folder is
 *  removed afterwards and a container that outlives its timeout is force-removed by name. */
export function dockerCommandPort(image: string, exec: ExecFile = execFile as unknown as ExecFile) {
  const docker = (args: string[], timeoutMs: number) => new Promise<{ code: number | null; timedOut: boolean; output: string }>(resolve => {
    exec('docker', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.slice(-OUTPUT_TAIL)
      if (!error) return resolve({ code: 0, timedOut: false, output })
      resolve({ code: typeof error.code === 'number' ? error.code : null, timedOut: error.killed === true, output: output || error.message.slice(0, OUTPUT_TAIL) })
    })
  })
  return async (request: CommandRequest): Promise<CommandResult> => {
    if (!/^[A-Za-z0-9._+-]{1,40}$/.test(request.cmd)) throw new Error(`Grader command ${JSON.stringify(request.cmd)} is not a plain program name`)
    if (request.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4_000)) throw new Error('Grader arguments must be plain text')
    const entries = Object.entries(request.files).map(([path, content]) => [safePath(path), content] as const)
    if (entries.some(([path]) => !path)) throw new Error('A grader file path leaves the job folder')
    if (entries.reduce((total, [, content]) => total + Buffer.byteLength(content), 0) > FILES_MAX_BYTES) throw new Error('Grader files exceed 2 MB')
    const folder = await mkdtemp(join(tmpdir(), 'conductor-eval-'))
    const name = `conductor-eval-${randomBytes(6).toString('hex')}`
    const abort = () => { void docker(['rm', '-f', name], 30_000) }
    request.signal?.addEventListener('abort', abort, { once: true })
    try {
      for (const [path, content] of entries) {
        const target = join(folder, ...path!.split('/'))
        if (!target.startsWith(folder + sep)) throw new Error('A grader file path leaves the job folder')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
      }
      const run = await docker(['run', '--rm', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
        '--memory', '1g', '--cpus', '2', '--read-only', '--tmpfs', '/tmp:rw,size=64m', '-v', `${folder}:/work`, '-w', '/work', image, request.cmd, ...request.args],
      request.timeoutSec * 1000 + 15_000)
      if (run.timedOut) await docker(['rm', '-f', name], 30_000)
      return { exitCode: run.timedOut ? null : run.code, timedOut: run.timedOut, output: run.output }
    } finally {
      request.signal?.removeEventListener('abort', abort)
      await rm(folder, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
