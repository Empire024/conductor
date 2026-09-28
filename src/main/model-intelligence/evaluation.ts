import { makeId } from '../../shared/models'
import {
  TASK_CATEGORIES, modelKeyId, type ExecutionOutcome, type ModelKey, type ModelStatus, type ReputationScore, type TaskCategory
} from '../../shared/model-routing'
import { outcome as outcomeRow } from './capture/common'
import { answerFiles, isRefusal } from './evaluation-ports'
import { isProven, type ReputationDimension } from './reputation'

/**
 * Evaluation (docs/model-routing.md, module D): a reusable suite of small deterministic jobs run
 * against one model key. Results are ordinary outcomes (source `evaluation`) that feed reputation;
 * nothing here changes a default. The key is `evaluating` while it runs, then `proven` when the
 * evidence reaches REPUTATION_POLICY.provenSamples, else `unproven`.
 */

// ---------------------------------------------------------------------------------------------
// Suites

/** The owner's evaluation areas; each maps to the TaskCategory its outcomes are recorded under. */
export const EVALUATION_AREAS = {
  'simple-coding': 'simple-coding', 'difficult-coding': 'difficult-coding', 'bug-fixing': 'debugging', 'repository-navigation': 'large-repo',
  'tool-usage': 'tool-calling', 'file-analysis': 'file-analysis', research: 'research', 'agentic-multi-step': 'terminal-use',
  'long-running': 'long-context', 'structured-output': 'structured-output',
} as const satisfies Record<string, TaskCategory>
export type EvaluationArea = keyof typeof EVALUATION_AREAS

export type JsonSchema = {
  type?: JsonType | JsonType[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  minItems?: number; maxItems?: number
  minLength?: number; maxLength?: number; pattern?: string
  minimum?: number; maximum?: number
}
type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export type Grader =
  | { kind: 'exact'; expected: string; caseInsensitive?: boolean }
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'json-schema'; schema: JsonSchema }
  /** A file the run left behind (EvaluationRun.files) must match. */
  | { kind: 'file-content'; path: string; regex: string; flags?: string }
  /** Runs through ports.command in a folder holding the job files, the run's files, `files` (hidden
   *  from the model) and, when `answerFile` is set, the answer's code under that name. */
  | { kind: 'command'; cmd: string; args: string[]; expectExit: number; timeoutSec: number; answerFile?: string; files?: Record<string, string> }

export interface EvaluationJob {
  id: string
  area?: EvaluationArea
  category: TaskCategory
  complexity: 1 | 2 | 3 | 4 | 5
  prompt: string
  /** Fixture files the model gets (in its workspace, or inlined by a chat-only runner). */
  files?: Record<string, string>
  grader: Grader
  /** Tokens (input + output) this job may spend under a capped run; defaults by complexity (JOB_TOKEN_BUDGET). */
  maxTokens?: number
}
export interface EvaluationSuite { name: string; description?: string; jobs: EvaluationJob[] }

const GRADER_KINDS = ['exact', 'regex', 'json-schema', 'file-content', 'command']
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isFiles = (value: unknown) => isRecord(value) && Object.values(value).every(content => typeof content === 'string')
const validRegex = (pattern: unknown, flags: unknown) => { try { new RegExp(String(pattern), flags === undefined ? undefined : String(flags)); return typeof pattern === 'string' } catch { return false } }

/** Throws naming the first problem; returns the suite typed. */
export function validateSuite(value: unknown): EvaluationSuite {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) throw new Error('A suite needs a name')
  if (!Array.isArray(value.jobs) || !value.jobs.length) throw new Error('A suite needs at least one job')
  const ids = new Set<string>()
  value.jobs.forEach((job: unknown, index) => {
    const where = `Job ${index + 1}`
    if (!isRecord(job) || typeof job.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(job.id)) throw new Error(`${where} needs a lowercase id`)
    if (ids.has(job.id)) throw new Error(`Duplicate job id ${job.id}`)
    ids.add(job.id)
    if (!(TASK_CATEGORIES as readonly unknown[]).includes(job.category)) throw new Error(`${job.id}: unknown category ${String(job.category)}`)
    if (job.area !== undefined && !(String(job.area) in EVALUATION_AREAS)) throw new Error(`${job.id}: unknown area ${String(job.area)}`)
    if (![1, 2, 3, 4, 5].includes(job.complexity as number)) throw new Error(`${job.id}: complexity must be 1..5`)
    if (typeof job.prompt !== 'string' || !job.prompt.trim()) throw new Error(`${job.id}: prompt is required`)
    if (job.files !== undefined && !isFiles(job.files)) throw new Error(`${job.id}: files must map paths to text`)
    if (job.maxTokens !== undefined && !(Number.isInteger(job.maxTokens) && (job.maxTokens as number) > 0)) throw new Error(`${job.id}: maxTokens must be a positive whole number`)
    const grader = job.grader
    if (!isRecord(grader) || !GRADER_KINDS.includes(String(grader.kind))) throw new Error(`${job.id}: unknown grader`)
    const bad = (grader.kind === 'exact' && typeof grader.expected !== 'string')
      || (grader.kind === 'regex' && !validRegex(grader.pattern, grader.flags))
      || (grader.kind === 'json-schema' && !isRecord(grader.schema))
      || (grader.kind === 'file-content' && (typeof grader.path !== 'string' || !validRegex(grader.regex, grader.flags)))
      || (grader.kind === 'command' && (typeof grader.cmd !== 'string' || !Array.isArray(grader.args) || !grader.args.every(arg => typeof arg === 'string')
        || !Number.isInteger(grader.expectExit) || !(typeof grader.timeoutSec === 'number' && grader.timeoutSec > 0 && grader.timeoutSec <= 600)
        || (grader.answerFile !== undefined && typeof grader.answerFile !== 'string') || (grader.files !== undefined && !isFiles(grader.files))))
    if (bad) throw new Error(`${job.id}: invalid ${String(grader.kind)} grader`)
  })
  return value as unknown as EvaluationSuite
}

// ---------------------------------------------------------------------------------------------
// Grading

/** What one run produced. Only `answer` is required; the rest is what the runner could observe. */
export interface EvaluationRun {
  answer: string
  /** Files the run created or changed (workspace path -> content), for file-content and command graders. */
  files?: Record<string, string>
  effort?: string | null
  durationMs?: number | null
  tokens?: number | null
  costUsd?: number | null
  iterations?: number | null
  toolFailures?: number
  looped?: boolean
  contextFailure?: boolean
}
export interface CommandRequest { cmd: string; args: string[]; timeoutSec: number; files: Record<string, string>; signal?: AbortSignal }
/** `spawnFailed`: the check's runtime never started, which says nothing about the answer. */
export interface CommandResult { exitCode: number | null; timedOut?: boolean; output?: string; spawnFailed?: boolean }
/** `notGradable`: the check itself could not run (no runner, a refused command, a runtime that did not start);
 *  the job records no outcome rather than a failure the model did not cause. */
export interface Grade { pass: boolean; detail: string; invalidOutput?: boolean; notGradable?: boolean }

/** The answer without reasoning blocks. */
export const visibleAnswer = (text: string): string => {
  const body = text.replace(/<think>[\s\S]*?<\/think>/gi, ''), close = body.toLowerCase().lastIndexOf('</think>')
  return (close >= 0 ? body.slice(close + '</think>'.length) : body).trim()
}
/** The first fenced block's content (any info string, a file path too), else the whole visible answer. */
export const answerCode = (text: string): string => {
  const visible = visibleAnswer(text), fenced = /```[^\s`]*[^\S\n]*\n([\s\S]*?)```/.exec(visible)
  return (fenced ? fenced[1]! : visible).trim() + '\n'
}
const clip = (text: string, max = 200) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? line.slice(0, max - 1) + '…' : line }

const typeOf = (value: unknown): JsonType => value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value as JsonType
/** A minimal JSON Schema subset; returns the first violation's path, or null. */
export function schemaViolation(value: unknown, schema: JsonSchema, path = '$'): string | null {
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type], actual = typeOf(value)
    if (!allowed.some(type => type === actual || (type === 'number' && actual === 'integer'))) return `${path}: expected ${allowed.join('|')}, got ${actual}`
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return `${path}: expected ${JSON.stringify(schema.const)}`
  if (schema.enum && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) return `${path}: not one of ${JSON.stringify(schema.enum)}`
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path}: shorter than ${schema.minLength}`
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path}: longer than ${schema.maxLength}`
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return `${path}: does not match ${schema.pattern}`
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above ${schema.maximum}`
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: fewer than ${schema.minItems} items`
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: more than ${schema.maxItems} items`
    if (schema.items) for (const [index, item] of value.entries()) { const problem = schemaViolation(item, schema.items, `${path}[${index}]`); if (problem) return problem }
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) return `${path}.${key}: required`
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key]
      if (property) { const problem = schemaViolation(item, property, `${path}.${key}`); if (problem) return problem }
      else if (schema.additionalProperties === false) return `${path}.${key}: not allowed`
    }
  }
  return null
}

export async function grade(job: EvaluationJob, run: EvaluationRun, command?: (request: CommandRequest) => Promise<CommandResult>, signal?: AbortSignal): Promise<Grade> {
  const grader = job.grader, answer = visibleAnswer(run.answer)
  switch (grader.kind) {
    case 'exact': {
      const same = grader.caseInsensitive ? answer.toLowerCase() === grader.expected.trim().toLowerCase() : answer === grader.expected.trim()
      return { pass: same, detail: same ? 'exact match' : `expected ${JSON.stringify(grader.expected)}, got ${JSON.stringify(clip(answer, 80))}` }
    }
    case 'regex': {
      const pass = new RegExp(grader.pattern, grader.flags).test(answer)
      return { pass, detail: pass ? `matches /${grader.pattern}/` : `no match for /${grader.pattern}/ in ${JSON.stringify(clip(answer, 80))}` }
    }
    case 'json-schema': {
      let value: unknown
      try { value = JSON.parse(answerCode(run.answer)) } catch { return { pass: false, invalidOutput: true, detail: 'the answer is not JSON' } }
      const problem = schemaViolation(value, grader.schema)
      return problem ? { pass: false, invalidOutput: true, detail: problem } : { pass: true, detail: 'valid against the schema' }
    }
    case 'file-content': {
      const content = run.files?.[grader.path]
      if (content === undefined) return { pass: false, detail: `${grader.path} was not written` }
      const pass = new RegExp(grader.regex, grader.flags).test(content)
      return { pass, detail: pass ? `${grader.path} matches` : `${grader.path} does not match /${grader.regex}/` }
    }
    case 'command': {
      if (!command) return { pass: false, notGradable: true, detail: 'no command runner is available for this grader' }
      // The answer file is the block the answer named after it, else its first fenced block.
      const answered = grader.answerFile ? run.files?.[grader.answerFile] ?? answerCode(run.answer) : undefined
      const files = { ...job.files, ...run.files, ...grader.files, ...(grader.answerFile ? { [grader.answerFile]: answered! } : {}) }
      let result: CommandResult
      try { result = await command({ cmd: grader.cmd, args: grader.args, timeoutSec: grader.timeoutSec, files, ...(signal ? { signal } : {}) }) }
      catch (error) { return { pass: false, notGradable: true, detail: `the check could not run: ${error instanceof Error ? error.message : String(error)}` } }
      if (result.spawnFailed) return { pass: false, notGradable: true, detail: `the check could not start: ${clip(result.output ?? 'no output')}` }
      if (signal?.aborted) return { pass: false, notGradable: true, detail: 'the check was aborted' }
      if (result.timedOut) return { pass: false, detail: `the check timed out after ${grader.timeoutSec} s` }
      const pass = result.exitCode === grader.expectExit
      return { pass, detail: pass ? `${grader.cmd} exited ${result.exitCode}` : `${grader.cmd} exited ${result.exitCode ?? 'without a code'}, expected ${grader.expectExit}${result.output ? `: ${clip(result.output)}` : ''}` }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluation

export interface EvaluationPorts {
  /** Runs one job on the model: a parked local agent session for local keys, a tab for cloud keys. */
  run(key: ModelKey, job: EvaluationJob, signal: AbortSignal, budget?: { maxTokens: number }): Promise<EvaluationRun>
  /** Runs a command grader's check in an isolated folder holding the given files. */
  command?(request: CommandRequest): Promise<CommandResult>
  recordOutcome(outcome: ExecutionOutcome): void
  outcomeRecorded?(outcome: ExecutionOutcome): void
  setStatus(key: ModelKey, status: ModelStatus): void
  /** The key's earlier outcomes (any source), so proven counts all its evidence. */
  outcomes?(key: ModelKey): ExecutionOutcome[]
  reputation(key: ModelKey, dimension: ReputationDimension): ReputationScore | null
  /** Current alternatives to compare against in the report. */
  alternatives(key: ModelKey): ModelKey[]
  writeReport(name: string, markdown: string): void
  /** Input tokens a native turn of this provider carries before any task (system prompt, briefing), as last
   *  measured; DEFAULT_FIXED_OVERHEAD_TOKENS when unknown. A batched cloud run pays it once. */
  fixedOverheadTokens?(provider: string): number
  /** Journals what the run has spent so far, cumulatively for its runId: at its start, after every job and at its end,
   *  so a run cut short by a restart still counts against the daily cloud caps (the store upserts on runId). */
  recordSpend?(spend: EvaluationSpend): void
  now(): Date
}
export interface EvaluationOptions {
  signal?: AbortSignal
  /** Per job; the job is a timed-out failure after this. */
  jobTimeoutMs?: number
  maxJobs?: number
  /** Stops before the next job once the recorded costUsd sum exceeds this. */
  maxCostUsd?: number | null
  /** A hard per-run cap on tokens (input + output): a job starts only with a budget that fits what is left, its
   *  runner is told that budget, and the run stops, the jobs left not gradable, once none fits or a job overran. */
  maxTokens?: number | null
  /** One turn for every one-shot-gradable job (see batchPrompt). Defaults to true for cloud keys, whose native turns
   *  carry a large fixed input; local runs keep one job per turn. */
  batch?: boolean
  runId?: string
}
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000
/** A capped run's default budget for one job, by complexity 1..5. */
export const JOB_TOKEN_BUDGET = [6_000, 10_000, 16_000, 24_000, 32_000] as const
/** Room for an answer on top of reading the prompt and files; a smaller budget is not worth starting. */
const MIN_ANSWER_TOKENS = 1_000
const promptTokens = (job: EvaluationJob): number => Math.ceil((job.prompt.length + Object.values(job.files ?? {}).reduce((sum, text) => sum + text.length, 0)) / 4)
export const jobTokenBudget = (job: EvaluationJob): number => Math.max(job.maxTokens ?? JOB_TOKEN_BUDGET[job.complexity - 1]!, minimumJobTokens(job))
export const minimumJobTokens = (job: EvaluationJob): number => promptTokens(job) + MIN_ANSWER_TOKENS
/** A native cloud turn's fixed input (the CLI system prompt and Conductor's briefing) when nothing measured it: ~39k was seen. */
export const DEFAULT_FIXED_OVERHEAD_TOKENS = 40_000
/** What one job adds to a batched turn: its own prompt and files, and room for its answer, by complexity 1..5. */
const BATCH_ANSWER_TOKENS = [800, 1_500, 3_000, 6_000, 10_000] as const
export const batchJobTokens = (job: EvaluationJob): number => job.maxTokens ?? promptTokens(job) + BATCH_ANSWER_TOKENS[job.complexity - 1]!
export const BATCH_JOB_ID = 'batch'

/** The one prompt of a batched run: every job as a numbered section, and a strict answer format to split on. */
export function batchPrompt(jobs: EvaluationJob[]): EvaluationJob {
  const sections = jobs.map((job, index) => {
    const files = Object.entries(job.files ?? {}).map(([path, content]) => `--- ${path} ---\n${content}`).join('\n\n')
    return `## TASK ${index + 1} of ${jobs.length}: ${job.id}\n\n${job.prompt}${files ? `\n\nFiles for this task:\n\n${files}` : ''}`
  })
  const prompt = [
    `You are evaluated on ${jobs.length} independent tasks in one reply. Do not use tools. Answer every task, in order.`,
    'Start each answer with a line that is exactly "### JOB <task id>" (for example "### JOB ' + (jobs[0]?.id ?? 'x') + '") and put nothing before the first such line.',
    'Under each header follow that task\'s own instructions: when it asks for code or JSON only, give one fenced block; when it asks for a file, give it as a fenced block whose info string is its relative path.',
    // A command-graded job is checked by running its check over the files the answer gives; nothing runs during the turn.
    ...(jobs.some(job => job.grader.kind === 'command' || job.grader.kind === 'file-content')
      ? ['You cannot run anything. Where a task asks you to change, create or run files, give the complete content of every file it asks for, and of every file that run would write, each as a fenced block whose info string is its relative path; the files are checked afterwards.'] : []),
    '', ...sections,
  ].join('\n')
  return { id: BATCH_JOB_ID, category: 'general', complexity: Math.max(1, ...jobs.map(job => job.complexity)) as EvaluationJob['complexity'], prompt, grader: { kind: 'regex', pattern: '.' } }
}
/**
 * A job's header line: a markdown heading of any depth or a bold line naming JOB and the task, with the usual slips
 * forgiven ("### JOB: id", "### JOB `id`", "**JOB id**", "### JOB id (task 1)", any case). 1: opener, 2: id, 3: the rest.
 */
const BATCH_HEADER = /^[ \t]*(#{1,6}[ \t]*(?:\*\*|__)?|\*\*|__)[ \t]*JOB\b[ \t]*[:#\u2013\u2014-]?[ \t]*[`'"]?([\w.-]+)[`'"]?(.*)$/gim
const FENCE_LINE = /^[ \t]*(?:```|~~~)/, BARE_FENCE_LINE = /^[ \t]*(?:```|~~~)[ \t]*$/
/** A section's last line when it is a fence that closes nothing: the end of an answer wrapped whole in one fence. */
const dropStrayFence = (section: string): string => {
  const lines = section.split('\n')
  return lines.filter(line => FENCE_LINE.test(line)).length % 2 === 1 && BARE_FENCE_LINE.test(lines[lines.length - 1]!) ? lines.slice(0, -1).join('\n').trim() : section
}
/** Each job's section of a batched answer, by its "### JOB <id>" header; a job without one is absent. */
export function splitBatchAnswer(answer: string, ids: string[]): Record<string, string> {
  const visible = visibleAnswer(answer), known = new Set(ids), sections: Record<string, string> = {}
  const named = (raw: string): string | undefined => {
    const trimmed = raw.replace(/[._]+$/, '')
    return known.has(raw) ? raw : known.has(trimmed) ? trimmed : undefined
  }
  const matches = [...visible.matchAll(BATCH_HEADER)]
  // "### JOB 2" means the second task unless another header names that task by its id (N20: mixed styles).
  const namedIds = new Set(matches.flatMap(match => named(match[2]!) ?? []))
  const headers = matches.flatMap(match => {
    const numbered = /^\d+$/.test(match[2]!), nth = numbered ? ids[Number(match[2]) - 1] : undefined
    const id = named(match[2]!) ?? (nth !== undefined && !namedIds.has(nth) ? nth : undefined)
    // A numbered header that maps to no task still ends the section before it.
    return id === undefined && !numbered ? [] : [{ id, match }]
  })
  headers.forEach(({ id, match }, index) => {
    if (id === undefined || id in sections) return
    // A heading line is all title; a bold header may start the answer after its closing marker ("**JOB a** 4+6").
    const rest = match[3]!, close = match[1]!.includes('#') ? -1 : rest.search(/\*\*|__/)
    const inline = close < 0 ? '' : rest.slice(close + 2).replace(/^[ \t]*(?:\([^)\n]*\))?[ \t]*:?[ \t]*/, '')
    const end = headers[index + 1]?.match.index ?? visible.length
    sections[id] = dropStrayFence((inline + visible.slice(match.index! + match[0].length, end)).trim())
  })
  return sections
}

export type EvaluationJobOutcome = ExecutionOutcome['result'] | 'not-gradable'
export interface EvaluationJobResult { id: string; category: TaskCategory; result: EvaluationJobOutcome; detail: string; timedOut: boolean; durationMs: number; costUsd: number | null; tokens: number | null }
/** `refused`: the model's turn was refused before any model call (EvaluationRefused); the run spent nothing. */
export type EvaluationStop = 'budget' | 'token-cap' | 'aborted' | 'max-jobs' | 'refused'
export interface EvaluationResult {
  runId: string
  key: ModelKey
  status: ModelStatus
  jobs: EvaluationJobResult[]
  outcomes: ExecutionOutcome[]
  costUsd: number
  tokens: number
  stoppedBy: EvaluationStop | null
  /** Why the turn was refused, when stoppedBy is `refused`. */
  reason?: string
  reportName: string
}
/** One run's spend, journaled so caps can be audited. A `refused` run spent nothing and is not one of the day's runs. */
export interface EvaluationSpend { runId: string; key: ModelKey; at: string; tokens: number; costUsd: number; jobs: number; gradedJobs: number; stoppedBy: EvaluationStop | null; reason?: string }

class JobTimeout extends Error {}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** Tokens a run reported, else about a quarter of the characters it read and wrote. */
const runTokens = (job: EvaluationJob, run: EvaluationRun | undefined): number => run?.tokens ?? promptTokens(job) + Math.ceil((run?.answer.length ?? 0) / 4)

/** One job under its own deadline, linked to the evaluation's signal. */
async function runJob(ports: EvaluationPorts, key: ModelKey, job: EvaluationJob, timeoutMs: number, outer?: AbortSignal, budget?: { maxTokens: number }): Promise<EvaluationRun> {
  const controller = new AbortController(), abort = () => controller.abort(outer?.reason)
  outer?.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new JobTimeout(`timed out after ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}`)
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(expired); reject(expired) }, timeoutMs) })
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof JobTimeout ? controller.signal.reason : new Error('aborted')), { once: true }))
  try { return await Promise.race([budget ? ports.run(key, job, controller.signal, budget) : ports.run(key, job, controller.signal), deadline, aborted]) }
  finally { clearTimeout(timer); outer?.removeEventListener('abort', abort) }
}

export async function evaluate(key: ModelKey, suite: EvaluationSuite, ports: EvaluationPorts, options: EvaluationOptions = {}): Promise<EvaluationResult> {
  const runId = options.runId ?? makeId('evaluation'), timeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
  const jobs = suite.jobs.slice(0, options.maxJobs ?? suite.jobs.length), order = new Map(jobs.map((job, index) => [job.id, index]))
  const results: EvaluationJobResult[] = [], outcomes: ExecutionOutcome[] = []
  let spent = 0, tokens = 0, stoppedBy: EvaluationResult['stoppedBy'] = options.maxJobs !== undefined && options.maxJobs < suite.jobs.length ? 'max-jobs' : null
  let refusal: string | undefined
  const notGradable = (job: EvaluationJob, detail: string) => results.push({ id: job.id, category: job.category, result: 'not-gradable', detail, timedOut: false, durationMs: 0, costUsd: null, tokens: null })
  const cap = options.maxTokens ?? null, capText = cap === null ? '' : `${cap.toLocaleString('en-US')}-token`
  /** `reserved` pre-charges a turn about to start, so a restart mid-turn still leaves its budget in the journal;
   *  the next journal replaces it with what the turn really spent (nothing, when it was refused). */
  const journal = (reserved = 0): void => {
    try { ports.recordSpend?.({ runId, key, at: ports.now().toISOString(), tokens: tokens + reserved, costUsd: spent, jobs: results.length, gradedJobs: results.filter(result => result.result !== 'not-gradable').length, stoppedBy, ...(refusal !== undefined ? { reason: refusal } : {}) }) }
    catch { /* The journal is the caps' audit trail; the evaluation's outcomes are already recorded. */ }
  }
  const record = (job: EvaluationJob, row: Parameters<typeof outcomeRow>[0]): void => {
    const recorded = outcomeRow(row)
    ports.recordOutcome(recorded)
    ports.outcomeRecorded?.(recorded)
    outcomes.push(recorded)
  }
  /** The spend a turn that threw is charged: what its port measured, else (capped) its whole budget, else null. */
  const thrownTokens = (error: unknown, timedOut: boolean, budget: { maxTokens: number } | undefined): number | null => {
    const reported = (error as { tokens?: unknown } | null)?.tokens
    return !timedOut && typeof reported === 'number' && Number.isFinite(reported) ? reported : budget?.maxTokens ?? null
  }
  const needsCommand = (job: EvaluationJob) => job.grader.kind === 'command'

  // Budget exhaustion is never the model's failure: a job cut off by the cap, or one that never fitted, is not
  // gradable and writes no outcome. Only a wrong answer is a failure.
  const runBatched = async (): Promise<void> => {
    const batched: EvaluationJob[] = []
    // A command job rides in the same turn: its answer's files are checked afterwards by the command runner.
    for (const job of jobs) {
      if (needsCommand(job) && !ports.command) notGradable(job, 'not run: its check needs a command runner, which is not available here')
      else batched.push(job)
    }
    const overhead = ports.fixedOverheadTokens?.(key.provider) ?? DEFAULT_FIXED_OVERHEAD_TOKENS
    if (cap !== null) {
      // The fixed overhead is paid once; drop the largest jobs until the batch fits the run's cap.
      const need = () => overhead + batched.reduce((sum, job) => sum + batchJobTokens(job), 0)
      while (batched.length && need() > cap) {
        const largest = batched.reduce((big, job) => batchJobTokens(job) > batchJobTokens(big) ? job : big)
        notGradable(largest, `not run: dropped from the batch; a native turn's ${overhead.toLocaleString('en-US')} fixed tokens plus the batched jobs' ${(need() - overhead).toLocaleString('en-US')} pass the run's ${capText} cap`)
        batched.splice(batched.indexOf(largest), 1)
      }
      if (!batched.length) { stoppedBy = 'token-cap'; return }
    }
    if (!batched.length || options.signal?.aborted) { if (options.signal?.aborted) stoppedBy = 'aborted'; return }
    const budget = cap !== null ? { maxTokens: cap } : undefined, prompt = batchPrompt(batched), started = ports.now().getTime()
    journal(budget?.maxTokens ?? 0)
    let run: EvaluationRun
    try { run = await runJob(ports, key, prompt, timeoutMs * batched.length, options.signal, budget) }
    catch (error) {
      if (isRefusal(error)) {
        refusal = message(error); stoppedBy = 'refused'
        for (const job of batched) notGradable(job, `not run: the turn was refused before any model call: ${refusal}`)
        return
      }
      const timedOut = error instanceof JobTimeout, cancelled = !timedOut && !!options.signal?.aborted
      tokens += thrownTokens(error, timedOut, budget) ?? runTokens(prompt, undefined)
      if (cancelled) stoppedBy = 'aborted'
      else if (budget && tokens >= budget.maxTokens) stoppedBy = 'token-cap'
      // One turn answered for all of them: its failure cannot be pinned on any single job.
      const why = cancelled ? 'the run was aborted' : timedOut ? message(error) : `the batched turn failed: ${message(error)}`
      for (const job of batched) notGradable(job, `not graded: ${why}`)
      return
    }
    const used = run.tokens ?? budget?.maxTokens ?? runTokens(prompt, run), sections = splitBatchAnswer(run.answer, batched.map(job => job.id))
    tokens += used; spent += run.costUsd ?? 0
    if (budget && used > budget.maxTokens) stoppedBy = 'token-cap'
    // No section at all is a format slip over the whole reply, not N wrong answers: nothing is graded.
    if (!Object.keys(sections).length) {
      for (const job of batched) notGradable(job, 'not graded: the batched answer had no "### JOB <id>" section for any task')
      return
    }
    for (const job of batched) {
      const section = sections[job.id]
      const graded: Grade = section === undefined ? { pass: false, invalidOutput: true, detail: `no "### JOB ${job.id}" section in the batched answer` }
        // A check runs over this job's own files only, never another section's.
        : await grade(job, { answer: section, files: needsCommand(job) ? answerFiles(section) : { ...run.files, ...answerFiles(section) } }, ports.command?.bind(ports), options.signal)
      if (graded.notGradable) { notGradable(job, `not graded: ${graded.detail}`); continue }
      record(job, {
        key, source: 'evaluation', ref: `${runId}:${job.id}`, category: job.category, at: ports.now().toISOString(), result: graded.pass ? 'success' : 'failure',
        effort: run.effort ?? null, complexity: job.complexity, verifier: graded.pass ? 'pass' : 'fail', durationMs: null, tokens: null, costUsd: null,
        invalidOutput: graded.invalidOutput ?? false, detail: `${suite.name}/${job.id} (batched): ${graded.detail}`,
      })
      results.push({ id: job.id, category: job.category, result: graded.pass ? 'success' : 'failure', detail: graded.detail, timedOut: false, durationMs: run.durationMs ?? ports.now().getTime() - started, costUsd: null, tokens: null })
    }
  }

  const runEach = async (): Promise<void> => {
    for (const [index, job] of jobs.entries()) {
      if (options.signal?.aborted) { stoppedBy = 'aborted'; break }
      if (options.maxCostUsd != null && spent > options.maxCostUsd) { stoppedBy = 'budget'; break }
      // Grading it needs a sandboxed command runner; running the model first would only spend tokens.
      if (needsCommand(job) && !ports.command) { notGradable(job, 'not run: its check needs a sandboxed command runner, which is not available here'); continue }
      // A capped run never starts a job that could take it past the cap: the job gets what is left, or does not start.
      let budget: { maxTokens: number } | undefined
      if (cap !== null) {
        const left = Math.max(0, cap - tokens), need = minimumJobTokens(job)
        if (left < need) {
          stoppedBy = 'token-cap'
          for (const rest of jobs.slice(index)) notGradable(rest, `not run: ${left.toLocaleString('en-US')} tokens left of the run's ${capText} cap, below the ${minimumJobTokens(rest).toLocaleString('en-US')} this job needs`)
          break
        }
        budget = { maxTokens: Math.min(jobTokenBudget(job), left) }
      }
      const started = ports.now().getTime()
      journal(budget?.maxTokens ?? 0)
      let run: EvaluationRun | undefined, failure: string | undefined, timedOut = false, cancelled = false, failedTokens: number | null = null
      try { run = await runJob(ports, key, job, timeoutMs, options.signal, budget) }
      catch (error) {
        // Refused before any model call: nothing spent, nothing graded, and the next job would be refused too.
        if (isRefusal(error)) {
          refusal = message(error); stoppedBy = 'refused'
          for (const rest of jobs.slice(index)) notGradable(rest, `not run: the turn was refused before any model call: ${refusal}`)
          journal()
          break
        }
        timedOut = error instanceof JobTimeout; cancelled = !timedOut && !!options.signal?.aborted; failure = timedOut ? message(error) : `the run failed: ${message(error)}`
        // A failed capped turn is charged what its port measured (at least its budget); a timed-out one never
        // reports back, so it is charged its whole budget. Uncapped runs keep the text estimate.
        failedTokens = thrownTokens(error, timedOut, budget)
      }
      const used = run ? runTokens(job, run) : failedTokens ?? runTokens(job, undefined)
      // A turn stopped at its budget ran out of tokens; it says nothing about the model.
      const cutOff = !run && !timedOut && !cancelled && budget !== undefined && used >= budget.maxTokens
      tokens += used
      const graded: Grade | null = cutOff ? null : run ? await grade(job, run, ports.command?.bind(ports), options.signal) : { pass: false, detail: failure! }
      if (!graded) notGradable(job, `not graded: the turn was stopped at its ${budget!.maxTokens.toLocaleString('en-US')}-token budget (${failure})`)
      else if (graded.notGradable && !cancelled) {
        // The model answered, but its check could not run: the spend stands, the answer is not judged.
        notGradable(job, `not graded: ${graded.detail}`)
        results[results.length - 1]!.tokens = used
        spent += run?.costUsd ?? 0
      } else {
        const durationMs = run?.durationMs ?? ports.now().getTime() - started, costUsd = run?.costUsd ?? null
        const result = cancelled ? 'cancelled' : graded.pass ? 'success' : 'failure'
        record(job, {
          key, source: 'evaluation', ref: `${runId}:${job.id}`, category: job.category, at: ports.now().toISOString(), result,
          effort: run?.effort ?? null, complexity: job.complexity, verifier: cancelled ? 'none' : graded.pass ? 'pass' : 'fail', durationMs, tokens: run?.tokens ?? failedTokens, costUsd,
          iterations: run?.iterations ?? null, toolFailures: run?.toolFailures ?? 0, looped: run?.looped ?? false, contextFailure: run?.contextFailure ?? false,
          timedOut, invalidOutput: graded.invalidOutput ?? false, detail: `${suite.name}/${job.id}: ${graded.detail}`,
        })
        spent += costUsd ?? 0
        results.push({ id: job.id, category: job.category, result, detail: graded.detail, timedOut, durationMs, costUsd, tokens: used })
      }
      // The real spend stands, even past the budget; a runner that overran is not trusted with another job.
      const overran = budget && used > budget.maxTokens ? budget.maxTokens : null
      if (overran !== null) {
        stoppedBy = 'token-cap'
        for (const rest of jobs.slice(index + 1)) notGradable(rest, `not run: ${job.id} spent ${used.toLocaleString('en-US')} tokens against its ${overran.toLocaleString('en-US')}-token budget, so the run stopped`)
      }
      journal()
      if (cancelled) { stoppedBy = 'aborted'; break }
      if (overran !== null) break
    }
    const ran = results.filter(result => result.result !== 'not-gradable').length
    if (!stoppedBy && options.maxCostUsd != null && spent > options.maxCostUsd && ran < jobs.length) stoppedBy = 'budget'
  }

  ports.setStatus(key, 'evaluating')
  journal()
  let status: ModelStatus = 'unproven'
  try {
    await (options.batch ?? key.provider !== 'local' ? runBatched() : runEach())
    results.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  } finally {
    const seen = new Set(outcomes.map(row => row.id))
    const evidence = [...(ports.outcomes?.(key) ?? []).filter(row => !seen.has(row.id)), ...outcomes]
    status = isProven(evidence, ports.now()) ? 'proven' : 'unproven'
    ports.setStatus(key, status)
    journal()
  }
  const reportName = `${ports.now().toISOString().slice(0, 10)}-${modelKeyId(key).replace(/[^\w.-]+/g, '_')}-${runId}.md`
  ports.writeReport(reportName, report(key, suite, results, spent, tokens, stoppedBy, status, ports, refusal))
  return { runId, key, status, jobs: results, outcomes, costUsd: spent, tokens, stoppedBy, ...(refusal !== undefined ? { reason: refusal } : {}), reportName }
}

/** What AgentControl.evaluationTurn and tab opening refuse with before a prompt goes out. */
const PRE_TURN_REFUSAL = /is not offered on this machine now|is unavailable here now|is not available here/
const BATCH_FAILED = 'not graded: the batched turn failed: '
/**
 * The refusal of a run written before refusals were recognised (B5-G), read from its report: every job not
 * gradable, at least one because its one batched turn failed, and every such failure a pre-turn refusal. Such a
 * run made no model call. Null for anything else, including a turn that started and failed.
 */
export function refusedBeforeTurn(markdown: string): string | null {
  const jobs = markdown.split(/^## /m).find(section => section.startsWith('Jobs')) ?? ''
  const rows = jobs.split('\n').filter(line => /^\| [a-z0-9][a-z0-9-]* \| /.test(line) && !line.startsWith('| Job |'))
    .map(line => line.split(/(?<!\\)\|/).map(cell => cell.trim())).filter(cells => cells.length >= 7)
  if (!rows.length || rows.some(cells => cells[3] !== 'not-gradable')) return null
  const failures = rows.map(cells => cells[4]!).filter(detail => detail.startsWith('not graded:'))
  if (!failures.length || failures.some(detail => !detail.startsWith(BATCH_FAILED) || !PRE_TURN_REFUSAL.test(detail))) return null
  return failures[0]!.slice(BATCH_FAILED.length).replace(/\\\|/g, '|')
}

const cell = (score: ReputationScore | null) => score ? `${Math.round(score.mean * 100)}% (low ${Math.round(score.lower * 100)}%, n=${Math.round(score.evidence)})` : '—'
function report(key: ModelKey, suite: EvaluationSuite, results: EvaluationJobResult[], spent: number, tokens: number, stoppedBy: EvaluationResult['stoppedBy'], status: ModelStatus, ports: EvaluationPorts, refusal?: string): string {
  const id = modelKeyId(key), alternatives = ports.alternatives(key).filter(other => modelKeyId(other) !== id)
  const categories = [...new Set(suite.jobs.map(job => job.category))], passed = results.filter(result => result.result === 'success').length, graded = results.filter(result => result.result !== 'not-gradable').length
  const escape = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return [
    `# Evaluation: ${id}`, '',
    `Suite **${suite.name}**, ${ports.now().toISOString()}. ${passed}/${graded} graded jobs passed${graded < suite.jobs.length ? ` of ${suite.jobs.length}` : ''}; ${tokens.toLocaleString('en-US')} tokens, cost $${spent.toFixed(2)}${stoppedBy ? `; stopped by ${stoppedBy}` : ''}${refusal !== undefined ? ` (${refusal}); the run is not counted against the daily caps` : ''}. Status now **${status}**.`,
    'Results feed reputation only; no default was changed.', '',
    '## Jobs', '', '| Job | Category | Result | Detail | Time | Cost |', '| --- | --- | --- | --- | --- | --- |',
    ...results.map(result => `| ${result.id} | ${result.category} | ${result.result}${result.timedOut ? ' (timed out)' : ''} | ${escape(result.detail)} | ${Math.round(result.durationMs / 1000)} s | ${result.costUsd == null ? '—' : '$' + result.costUsd.toFixed(3)} |`), '',
    '## Reputation against alternatives', '', `| Category | ${[id, ...alternatives.map(modelKeyId)].join(' | ')} |`, `| --- |${' --- |'.repeat(alternatives.length + 1)}`,
    ...categories.map(category => `| ${category} | ${[key, ...alternatives].map(other => cell(ports.reputation(other, category))).join(' | ')} |`), '',
  ].join('\n')
}
