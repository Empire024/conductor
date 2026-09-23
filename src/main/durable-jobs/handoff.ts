/**
 * Durable jobs: context budgeting and fresh-context stage handoff (Opus B). Pure, injectable
 * functions the job controller calls; nothing here owns state, starts a server or blocks on a
 * model call except `measureRequest`, which asks the live server's tokenizer and falls back to
 * the conservative estimate.
 *
 * The earlier overnight runs died on one request of 29,886 prompt tokens plus 4,096 reserved
 * output against a 32,768-token slot. The fix is bounded work, not a bigger window: every stage
 * starts a new worker context from the persisted handoff, the controller rolls over well before
 * the window is full, and long output stays on disk as a path plus a short excerpt.
 *
 * Exported surface (signatures are the contract with the controller):
 *
 *   modelWindow(model: ModelWindowSource, reserveTokens?): ModelWindow
 *   estimateRequest({ messages, tools, model, reserveTokens? }): RequestEstimate
 *   measureRequest({ messages, tools, model, reserveTokens?, endpoint, apiKey, countTokens? }): Promise<RequestEstimate>
 *   fitRequest({ messages, tools, model, reserveTokens? }): { messages; estimate } | throws ContextBudgetError
 *   shouldRollover(usage: { promptTokens }, capacity: ModelWindow, budgets: DurableJobBudgets): RolloverDecision
 *   usageFromStopReport(report: LocalStopReport): { promptTokens: number }
 *   buildStagePrompt(job, stage, handoff, model, options?): StagePromptResult  ({ ok: true, prompt, tokens, budgetTokens, trimmed } | { ok: false, error: StageTooLargeError })
 *   extractHandoff(previous, stopReport, taskState, evidence, options?): DurableJobHandoff
 *   excerpt({ logDir, name, raw, ... }): Promise<ExcerptResult>
 *   readRange(path, range, options?): Promise<{ text; ref }>
 *   stageKind(stage): DurableStageKind
 *   stageTooling(kind, workspace, grants?): StageTooling  ({ kind, scope, readOnly, grants, contract, systemPrompt, tools, schemaTokens })
 *   classifyResponse(completion): ResponseClassification
 *   classifyStageOutcome(outcome: { text; stopReason | report }): StageOutcomeClassification
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DurableJob, DurableJobArtifactRef, DurableJobBudgets, DurableJobHandoff, DurableJobStage, DurableStageKind } from '../../shared/durable-jobs.ts'
import type { LocalStopReason, LocalStopReport } from '../../shared/local-stop.ts'
import { argumentsAreObject, RESPONSE_RESERVE_TOKENS, systemPrompt, trimMessages } from '../local-models/agent.ts'
import { DEFAULT_LOCAL_AGENT_POLICY, type ToolOutputPolicy } from '../local-models/agent-policy.ts'
import { boundedFile } from '../local-models/bounded-files.ts'
import { runtimePromptTokens, type ChatMessage, type CompletionRequest, type CompletionResult, type ToolSpec } from '../local-models/client.ts'
import type { TaskContract, RunEvidence } from '../local-models/completion.ts'
import { ContextBudgetError, requestBudget } from '../local-models/context-budget.ts'
import type { TaskState } from '../local-models/context-manager.ts'
import type { LocalModelConfig } from '../local-models/config.ts'
import type { LocalResultStore } from '../local-models/result-artifacts.ts'
import { detectsTestRun, headAndTail, shapeToolOutput } from '../local-models/tool-output.ts'
import { NO_GRANTS, toolSpecs, type LocalGrants, type ToolScope } from '../local-models/tools.ts'

// ---------------------------------------------------------------------------------------------
// 1. Whole-request estimate against the live model's window
// ---------------------------------------------------------------------------------------------

/** The live model's config is authoritative for the window; only these fields are read. */
export type ModelWindowSource = Pick<LocalModelConfig, 'id' | 'contextTokens'>

export interface ModelWindow {
  modelId: string
  contextTokens: number
  /** Output tokens held back on every request (llama.cpp refuses a prompt that leaves none). */
  reserveTokens: number
  /** What the prompt may occupy: contextTokens - reserveTokens. */
  capacityTokens: number
}

export function modelWindow(model: ModelWindowSource, reserveTokens = RESPONSE_RESERVE_TOKENS): ModelWindow {
  if (!Number.isInteger(model.contextTokens) || model.contextTokens <= 0) throw new Error(`Invalid context size for ${model.id}`)
  if (!Number.isInteger(reserveTokens) || reserveTokens <= 0 || reserveTokens >= model.contextTokens) throw new Error(`Invalid output reserve for ${model.id}`)
  return { modelId: model.id, contextTokens: model.contextTokens, reserveTokens, capacityTokens: model.contextTokens - reserveTokens }
}

export interface RequestEstimate extends ModelWindow {
  /** The whole rendered request: system prompt, conversation, tool results, tool schemas, framing. */
  promptTokens: number
  /** promptTokens + reserveTokens; must not exceed contextTokens. */
  totalTokens: number
  fits: boolean
  method: 'runtime tokenizer' | 'conservative estimate'
  /** Conservative per-part figures (always estimated), to say what to shrink. */
  breakdown: { system: number; conversation: number; toolResults: number; toolSchemas: number }
}

/** Tokens of one text at the same pessimistic rate the wire guard uses (UTF-8 bytes / 3). */
export const textTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
const jsonTokens = (value: unknown): number => textTokens(JSON.stringify(value))

function breakdown(messages: ChatMessage[], tools: ToolSpec[]): RequestEstimate['breakdown'] {
  const part = (role: (m: ChatMessage) => boolean): number => messages.filter(role).reduce((sum, m) => sum + jsonTokens(m) + 16, 0)
  return { system: part(m => m.role === 'system'), conversation: part(m => m.role === 'user' || m.role === 'assistant'), toolResults: part(m => m.role === 'tool'), toolSchemas: tools.length ? jsonTokens({ tools, tool_choice: 'auto' }) : 0 }
}

function toEstimate(window: ModelWindow, promptTokens: number, method: RequestEstimate['method'], messages: ChatMessage[], tools: ToolSpec[]): RequestEstimate {
  const totalTokens = promptTokens + window.reserveTokens
  return { ...window, promptTokens, totalTokens, fits: totalTokens <= window.contextTokens, method, breakdown: breakdown(messages, tools) }
}

/** Conservative, synchronous estimate of the complete request, using the same formula as the
 *  client's last-line guard (context-budget.ts requestBudget). */
export function estimateRequest(input: { messages: ChatMessage[]; tools: ToolSpec[]; model: ModelWindowSource; reserveTokens?: number }): RequestEstimate {
  const window = modelWindow(input.model, input.reserveTokens)
  const budget = requestBudget(input.messages, input.tools, window.contextTokens, window.reserveTokens)
  return toEstimate(window, budget.promptTokens, 'conservative estimate', input.messages, input.tools)
}

/** The server-rendered count (apply-template + tokenize, the path chatCompletion uses) when the
 *  live server offers it, otherwise the conservative estimate. `countTokens` is injectable. */
export async function measureRequest(input: { messages: ChatMessage[]; tools: ToolSpec[]; model: ModelWindowSource; reserveTokens?: number; endpoint: string; apiKey: string; signal?: AbortSignal; countTokens?: (request: CompletionRequest) => Promise<number | undefined> }): Promise<RequestEstimate> {
  const window = modelWindow(input.model, input.reserveTokens)
  const count = input.countTokens ?? runtimePromptTokens
  const measured = await count({ endpoint: input.endpoint, apiKey: input.apiKey, model: input.model.id, messages: input.messages, tools: input.tools, measureTokens: true, signal: input.signal })
  if (measured !== undefined) return toEstimate(window, measured, 'runtime tokenizer', input.messages, input.tools)
  return estimateRequest(input)
}

/** Bring a request inside the window with the loop's own trimming (trimMessages), narrowing the
 *  share until the wire estimate fits. Throws ContextBudgetError when even the narrowest share
 *  does not fit: the controller should roll over to a fresh stage instead of sending. */
export function fitRequest(input: { messages: ChatMessage[]; tools: ToolSpec[]; model: ModelWindowSource; reserveTokens?: number }): { messages: ChatMessage[]; estimate: RequestEstimate } {
  let estimate = estimateRequest(input)
  if (estimate.fits) return { messages: input.messages, estimate }
  const overhead = estimate.breakdown.toolSchemas
  for (const share of [1, 0.85, 0.7, 0.55, 0.4]) {
    const messages = trimMessages(input.messages, estimate.contextTokens, overhead, share, estimate.reserveTokens)
    estimate = estimateRequest({ ...input, messages })
    if (estimate.fits) return { messages, estimate }
  }
  throw new ContextBudgetError({ promptTokens: estimate.promptTokens, responseTokens: estimate.reserveTokens, contextTokens: estimate.contextTokens, totalTokens: estimate.totalTokens })
}

// ---------------------------------------------------------------------------------------------
// 2. Rollover
// ---------------------------------------------------------------------------------------------

export interface RolloverDecision {
  rollover: boolean
  /** below: keep going; fraction: past contextRolloverFraction; headroom: the next tool response
   *  would not fit beside the reserve; overflow: the request already does not fit. */
  reason: 'below' | 'fraction' | 'headroom' | 'overflow'
  promptTokens: number
  /** floor(contextTokens * contextRolloverFraction). */
  fractionTokens: number
  /** contextTokens - reserveTokens - contextSafetyMarginTokens. */
  headroomTokens: number
  /** promptTokens / contextTokens. */
  ratio: number
}

export function shouldRollover(usage: { promptTokens: number }, capacity: ModelWindow, budgets: Pick<DurableJobBudgets, 'contextRolloverFraction' | 'contextSafetyMarginTokens'>): RolloverDecision {
  const fraction = budgets.contextRolloverFraction
  if (!(fraction > 0 && fraction <= 1)) throw new Error('contextRolloverFraction must be a fraction between 0 and 1')
  if (!Number.isInteger(budgets.contextSafetyMarginTokens) || budgets.contextSafetyMarginTokens < 0) throw new Error('contextSafetyMarginTokens must be a nonnegative integer')
  const promptTokens = Math.max(0, usage.promptTokens)
  const fractionTokens = Math.floor(capacity.contextTokens * fraction)
  const headroomTokens = capacity.contextTokens - capacity.reserveTokens - budgets.contextSafetyMarginTokens
  const base = { promptTokens, fractionTokens, headroomTokens, ratio: promptTokens / capacity.contextTokens }
  if (promptTokens + capacity.reserveTokens > capacity.contextTokens) return { ...base, rollover: true, reason: 'overflow' }
  if (promptTokens >= headroomTokens) return { ...base, rollover: true, reason: 'headroom' }
  if (promptTokens >= fractionTokens) return { ...base, rollover: true, reason: 'fraction' }
  return { ...base, rollover: false, reason: 'below' }
}

/** The prompt size a finished stage last reported (exact when the server reported it). */
export const usageFromStopReport = (report: LocalStopReport): { promptTokens: number } => ({ promptTokens: report.context.usedTokens })

// ---------------------------------------------------------------------------------------------
// 3. Stage prompt from durable state only
// ---------------------------------------------------------------------------------------------

/** Sections the prompt may shrink, lowest value first: that is the trimming order. Within a
 *  section the oldest entries go first. Objective, stage objective, completion criteria,
 *  constraints and next action are never trimmed. */
export const TRIM_ORDER = ['workDone', 'testResults', 'decisions', 'artifacts', 'filesChanged', 'unresolvedIssues'] as const
export type TrimmableSection = (typeof TRIM_ORDER)[number]

export class StageTooLargeError extends Error {
  readonly code = 'stage-too-large'
  constructor(readonly requiredTokens: number, readonly budgetTokens: number, readonly suggestion: 'split-stage' | 'shrink-inputs') {
    super(`The stage cannot start in a fresh context: its objective, criteria, constraints and next action need about ${requiredTokens} tokens but the stage prompt budget is ${budgetTokens}. ${suggestion === 'split-stage' ? 'Split the stage into smaller stages.' : 'Shrink the stage inputs or constraints.'}`)
    this.name = 'StageTooLargeError'
  }
}

export type StagePromptResult =
  | { ok: true; prompt: string; tokens: number; budgetTokens: number; trimmed: Array<{ section: TrimmableSection; omitted: number }> }
  | { ok: false; error: StageTooLargeError }

export interface StagePromptOptions {
  /** Hard cap for the stage prompt. Default: a quarter of the window, at most 8,192. */
  budgetTokens?: number
  /** The stage's system prompt and tool schemas; with them the budget also keeps the whole
   *  first request under the rollover fraction, so a fresh stage does not start rolled over. */
  systemPrompt?: string
  tools?: ToolSpec[]
  reserveTokens?: number
  /** Longest single list entry (characters) before it is shortened. */
  itemChars?: number
}

export const defaultStagePromptBudget = (model: ModelWindowSource): number => Math.min(8192, Math.floor(model.contextTokens / 4))

const clip = (text: string, max: number): string => { const t = text.trim().replace(/\r\n/g, '\n'); return t.length > max ? `${t.slice(0, max - 3)}...` : t }

export function renderArtifactRef(ref: DurableJobArtifactRef): string {
  const range = ref.range ? ` lines ${ref.range.from}-${ref.range.to}` : ''
  return `${ref.path}${range} (${ref.kind})${ref.note ? `: ${clip(ref.note, 200)}` : ''}`
}

export function buildStagePrompt(job: Pick<DurableJob, 'id' | 'title' | 'objective' | 'logDir' | 'budgets'>, stage: Pick<DurableJobStage, 'index' | 'title' | 'objective' | 'completionCriteria' | 'inputs' | 'attempt'>, handoff: DurableJobHandoff, model: ModelWindowSource, options: StagePromptOptions = {}): StagePromptResult {
  const itemChars = options.itemChars ?? 400
  let budgetTokens = options.budgetTokens ?? defaultStagePromptBudget(model)
  if (options.systemPrompt !== undefined || options.tools) {
    const window = modelWindow(model, options.reserveTokens)
    const overhead = estimateRequest({ messages: [{ role: 'system', content: options.systemPrompt ?? '' }, { role: 'user', content: '' }], tools: options.tools ?? [], model, reserveTokens: window.reserveTokens }).promptTokens
    const ceiling = Math.min(Math.floor(window.contextTokens * job.budgets.contextRolloverFraction), window.capacityTokens - job.budgets.contextSafetyMarginTokens)
    budgetTokens = Math.min(budgetTokens, ceiling - overhead)
  }
  const list = (items: string[]): string[] => items.map(item => clip(item, itemChars)).filter(Boolean)
  const sections: Record<TrimmableSection, string[]> = {
    workDone: list(handoff.workDone),
    testResults: list(handoff.testResults),
    decisions: list(handoff.decisions),
    artifacts: [...stage.inputs, ...handoff.artifacts].map(renderArtifactRef),
    filesChanged: list(handoff.filesChanged),
    unresolvedIssues: list(handoff.unresolvedIssues)
  }
  const omitted: Record<TrimmableSection, number> = { workDone: 0, testResults: 0, decisions: 0, artifacts: 0, filesChanged: 0, unresolvedIssues: 0 }
  const titles: Record<TrimmableSection, string> = { workDone: 'WORK DONE IN EARLIER STAGES', testResults: 'TEST RESULTS', decisions: 'DECISIONS ALREADY MADE', artifacts: 'ARTIFACTS ON DISK (paths only; read the ranges you need, never whole logs)', filesChanged: 'FILES CHANGED SO FAR', unresolvedIssues: 'UNRESOLVED ISSUES' }
  const render = (): string => {
    const lines = [
      `[Conductor durable job "${clip(job.title, 200)}", stage ${stage.index + 1}: "${clip(stage.title, 200)}"${stage.attempt > 1 ? `, attempt ${stage.attempt}` : ''}. This is a fresh context: everything earlier stages established is below. Do not redo work listed as done.]`,
      '', 'JOB OBJECTIVE', handoff.objective || job.objective,
      '', 'THIS STAGE', stage.objective,
      '', 'STAGE IS COMPLETE WHEN', ...(stage.completionCriteria.length ? stage.completionCriteria.map(item => `- ${item}`) : ['- the stage objective is met and verified with a tool call'])
    ]
    if (handoff.constraints.length) lines.push('', 'CONSTRAINTS', ...handoff.constraints.map(item => `- ${item}`))
    for (const section of [...TRIM_ORDER].reverse()) {
      const items = sections[section]
      if (!items.length && !omitted[section]) continue
      lines.push('', titles[section], ...(omitted[section] ? [`- (${omitted[section]} earlier entries omitted; the full record is in ${job.logDir})`] : []), ...items.map(item => `- ${item}`))
    }
    lines.push('', 'NEXT ACTION', handoff.nextAction || 'Start on the stage objective.', '', 'Keep tool output small: read file ranges, search before reading, keep commands quiet. When the stage is complete, verify it with a tool call and give a short final answer stating what changed and what the verification showed.')
    return lines.join('\n')
  }
  let prompt = render()
  let tokens = textTokens(prompt)
  for (const section of TRIM_ORDER) {
    while (tokens > budgetTokens && sections[section].length) {
      sections[section].shift(); omitted[section]++
      prompt = render(); tokens = textTokens(prompt)
    }
    if (tokens <= budgetTokens) break
  }
  if (tokens > budgetTokens) {
    const criteriaTokens = textTokens(stage.objective + stage.completionCriteria.join('\n'))
    return { ok: false, error: new StageTooLargeError(tokens, Math.max(0, budgetTokens), criteriaTokens > budgetTokens / 2 ? 'split-stage' : 'shrink-inputs') }
  }
  return { ok: true, prompt, tokens, budgetTokens, trimmed: TRIM_ORDER.filter(section => omitted[section]).map(section => ({ section, omitted: omitted[section] })) }
}

// ---------------------------------------------------------------------------------------------
// 4. Handoff extraction from a finished stage
// ---------------------------------------------------------------------------------------------

export interface ExtractHandoffOptions {
  stage?: Pick<DurableJobStage, 'index' | 'title' | 'attempt'>
  /** The stage that follows, when the plan has one; sets the next action. */
  nextStage?: Pick<DurableJobStage, 'index' | 'title' | 'objective'>
  /** Excerpts and outputs this stage wrote to disk (see `excerpt`). */
  artifacts?: DurableJobArtifactRef[]
  /** The worker's final text; used only to classify it, never copied in as fact. */
  finalText?: string
  now?: () => Date
  /** Entries kept per list, newest last. */
  maxItems?: number
}

/** Prefixes of issues this module generates; a later clean stage replaces them. */
const AUTO_ISSUE = /^(Failing: |Stage \d+ stopped: |Repeated failure: |Unverified claim: )/

function merge(into: string[], add: Iterable<string>, max: number, itemChars = 400): string[] {
  const out = [...into]
  for (const raw of add) {
    const item = clip(raw, itemChars)
    if (!item) continue
    const at = out.indexOf(item)
    if (at >= 0) out.splice(at, 1)
    out.push(item)
  }
  return out.slice(-max)
}

const testKey = (entry: string): string => entry.replace(/^[^:]*: /, '')

export function extractHandoff(previous: DurableJobHandoff, stopReport: LocalStopReport | undefined, taskState: TaskState | undefined, evidence: RunEvidence | undefined, options: ExtractHandoffOptions = {}): DurableJobHandoff {
  const max = options.maxItems ?? 40
  const stageLabel = options.stage ? `Stage ${options.stage.index + 1} "${clip(options.stage.title, 120)}"` : 'Stage'
  const execution = taskState?.execution
  const outcome = stopReport ? classifyStageOutcome({ text: options.finalText ?? taskState?.conclusion ?? '', report: stopReport }) : undefined
  const clean = Boolean(outcome?.success) && !taskState?.currentFailure && evidence?.acceptance?.passed !== false

  const constraints = merge(previous.constraints, taskState?.constraints ?? [], max)
  const decisions = merge(previous.decisions, [...(execution?.corrections ?? []).map(c => `Owner correction: ${c}`), ...(taskState?.discoveries ?? [])], max)

  const filesChanged = merge(previous.filesChanged, [...(taskState?.filesChanged ?? []), ...(stopReport?.filesChanged ?? []), ...(evidence?.writes ?? []).map(w => w.path)], 200)

  const tests: string[] = []
  const commands = [...(taskState?.commands ?? []), ...(evidence?.commands ?? [])]
  for (const command of commands) if (detectsTestRun(command.command)) tests.push(`${command.ok ? 'pass' : `fail${command.exitCode === null ? '' : ` (exit ${command.exitCode})`}`}: ${command.command}`)
  const acceptance = evidence?.acceptance ?? stopReport?.acceptance
  if (acceptance) tests.push(`${acceptance.passed ? 'pass' : `fail (exit ${acceptance.exitCode})`}: ${acceptance.command}`)
  let testResults = [...previous.testResults]
  for (const entry of tests) { const key = testKey(clip(entry, 400)); testResults = testResults.filter(existing => testKey(existing) !== key); testResults.push(clip(entry, 400)) }
  testResults = testResults.slice(-max)

  const workLine = stopReport
    ? `${stageLabel}${options.stage && options.stage.attempt > 1 ? ` (attempt ${options.stage.attempt})` : ''}: ${outcome?.success ? 'completed' : stopReport.reason} - ${clip(stopReport.detail, 240)}${stopReport.filesChanged.length ? ` Changed ${stopReport.filesChanged.length} file(s).` : ''}${stopReport.commandsRun ? ` Ran ${stopReport.commandsRun} command(s).` : ''}`
    : undefined
  const workDone = merge(previous.workDone, workLine ? [workLine] : [], max)

  const issues: string[] = []
  if (taskState?.currentFailure) issues.push(`Failing: ${taskState.currentFailure.source} - ${clip(taskState.currentFailure.excerpt.split('\n').find(line => line.trim()) ?? '', 240)}`)
  for (const failure of execution?.failures ?? []) if (failure.count >= 2) issues.push(`Repeated failure: ${failure.method} (${failure.count}x) - ${clip(failure.error, 200)}`)
  if (stopReport?.unverified) issues.push(`Unverified claim: ${stopReport.unverified}`)
  if (stopReport && outcome && !outcome.success) issues.push(`Stage ${(options.stage?.index ?? 0) + 1} stopped: ${outcome.reason}`)
  const carried = clean ? previous.unresolvedIssues.filter(issue => !AUTO_ISSUE.test(issue)) : previous.unresolvedIssues
  const unresolvedIssues = merge(carried, issues, max)

  const artifacts: DurableJobArtifactRef[] = []
  const refKey = (ref: DurableJobArtifactRef): string => `${ref.path}#${ref.range?.from ?? ''}-${ref.range?.to ?? ''}`
  const produced: DurableJobArtifactRef[] = (execution?.artifacts ?? []).map(a => ({ path: a.path, kind: 'output', note: `sha256 ${a.fingerprint.slice(0, 12)}` }))
  for (const ref of [...previous.artifacts, ...(options.artifacts ?? []), ...produced]) {
    const at = artifacts.findIndex(existing => refKey(existing) === refKey(ref))
    if (at >= 0) artifacts.splice(at, 1)
    artifacts.push({ path: ref.path, kind: ref.kind, ...(ref.range ? { range: { ...ref.range } } : {}), ...(ref.note ? { note: clip(ref.note, 200) } : {}) })
  }

  let nextAction: string
  if (clean) nextAction = options.nextStage ? `Begin stage ${options.nextStage.index + 1} "${clip(options.nextStage.title, 120)}": ${clip(options.nextStage.objective, 600)}` : 'Verify that the job objective is met with a decisive check, then give the final report.'
  else if (taskState?.currentFailure) nextAction = `Fix the failure from ${clip(taskState.currentFailure.source, 160)}, then rerun that check.`
  else if (execution?.nextAction && execution.failures.length) nextAction = clip(execution.nextAction, 600)
  else if (outcome) nextAction = `Resume the unfinished stage (${outcome.reason}). Work in smaller steps: read ranges, not whole files.`
  else nextAction = previous.nextAction

  return { objective: previous.objective, constraints, decisions, workDone, filesChanged, testResults, unresolvedIssues, nextAction, artifacts: artifacts.slice(-max), updatedAt: (options.now?.() ?? new Date()).toISOString() }
}

// ---------------------------------------------------------------------------------------------
// 5. Excerpts: raw output on disk, a short excerpt plus path/range in the prompt
// ---------------------------------------------------------------------------------------------

export interface ExcerptResult {
  /** What enters the prompt: a header naming the file and range, then the excerpt. */
  text: string
  ref: DurableJobArtifactRef
  path: string
  totalLines: number
  rawChars: number
  excludedChars: number
  /** Present when the raw output was also saved to the local result store. */
  artifactId?: string
}

const FAILURE = /(Traceback|Error\b|Exception\b|FAIL\b|failed|AssertionError|panicked|^\s+at .+:\d+:\d+)/

/** Write `raw` under `<logDir>/excerpts/` (content-addressed, so a rewrite is idempotent) and
 *  return a bounded excerpt. Test and diff output is shaped by tool-output.ts; other output with
 *  a failure keeps the window around the first failure line (a stack trace), else head and tail.
 *  With `store`, the raw text is also saved to the result store so a sandboxed worker can page
 *  it with read_file { artifact, byte_offset } even when logDir is outside its workspace. */
export async function excerpt(input: { logDir: string; name: string; raw: string; kind?: DurableJobArtifactRef['kind']; command?: string; limitChars?: number; policy?: ToolOutputPolicy; store?: { owner: string; store: Pick<LocalResultStore, 'save'> } }): Promise<ExcerptResult> {
  const policy = input.policy ?? DEFAULT_LOCAL_AGENT_POLICY.toolOutput
  const limit = input.limitChars ?? policy.commandChars
  const raw = input.raw.replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  const totalLines = raw.endsWith('\n') ? lines.length - 1 : lines.length
  const hash = createHash('sha256').update(input.raw).digest('hex').slice(0, 12)
  const safe = input.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'output'
  const dir = join(input.logDir, 'excerpts')
  const path = join(dir, `${safe}-${hash}.log`)
  await mkdir(dir, { recursive: true })
  await writeFile(path, input.raw, { flag: 'w' })
  const artifactId = input.store ? input.store.store.save(input.store.owner, input.raw) : undefined

  let body: string
  let range = { from: 1, to: Math.max(1, totalLines) }
  if (raw.length <= limit) body = raw
  else if (input.command && (detectsTestRun(input.command) || /\bgit\s+(?:diff|show|log\s+-p)\b/.test(input.command))) body = shapeToolOutput('run_command', { command: input.command }, raw, { ...policy, commandChars: limit, testReportChars: limit }).text
  else {
    const first = lines.findIndex(line => FAILURE.test(line))
    if (first >= 0) {
      const from = Math.max(0, first - 5)
      let to = from, size = 0
      while (to < totalLines && size + lines[to]!.length + 1 <= limit) { size += lines[to]!.length + 1; to++ }
      if (to === from) { body = lines[from]!.slice(0, limit); to = from + 1 } else body = lines.slice(from, to).join('\n')
      range = { from: from + 1, to }
    } else body = headAndTail(raw, limit, 'The full output is in the file named above; read the line range you need.').text
  }
  const header = `[excerpt: file=${path}; lines ${range.from}-${range.to} of ${totalLines}; ${raw.length} characters total${artifactId ? `; artifact=${artifactId}` : ''}. The full output is on disk; read only the range you need.]`
  const text = `${header}\n${body}`
  return { text, ref: { path, kind: input.kind ?? 'log', range, note: clip(`${input.name}${input.command ? `: ${input.command}` : ''}`, 200) }, path, totalLines, rawChars: raw.length, excludedChars: Math.max(0, raw.length - body.length), ...(artifactId ? { artifactId } : {}) }
}

/** A selective read of a large file: a bounded 1-based line window (bounded-files.ts streams
 *  it, so a huge file or a huge line never loads whole). */
export async function readRange(path: string, range: { from: number; to: number }, options: { signal?: AbortSignal; kind?: DurableJobArtifactRef['kind'] } = {}): Promise<{ text: string; ref: DurableJobArtifactRef }> {
  if (!Number.isSafeInteger(range.from) || range.from < 1 || !Number.isSafeInteger(range.to) || range.to < range.from) throw new Error('range must be 1-based with to >= from')
  const limit = Math.min(range.to - range.from + 1, DEFAULT_LOCAL_AGENT_POLICY.toolOutput.readMaxLines)
  const text = await boundedFile(path, { offset: range.from, limit, signal: options.signal })
  return { text, ref: { path, kind: options.kind ?? 'source', range: { from: range.from, to: range.from + limit - 1 } } }
}

/** Reads a whole excerpt file back (tests and the report writer; never a prompt). */
export const readExcerptFile = (path: string): Promise<string> => readFile(path, 'utf8')

// ---------------------------------------------------------------------------------------------
// 6. Tool exposure per stage kind
// ---------------------------------------------------------------------------------------------

/** agent.ts offers two scopes (tools.ts ToolScope): 'full' (file tools, web_read, conductor
 *  control, writes; web_search with the research grant) and 'coding' (read_file, list_files,
 *  search, plus write_file/edit_file/apply_edits/run_command unless read-only). A session is in
 *  the coding scope exactly when LocalAgentOptions.contract is set, so a stage passes a contract
 *  (at least `{}`). readOnly removes every mutating tool. */
export { DURABLE_STAGE_KINDS, type DurableStageKind } from '../../shared/durable-jobs.ts'

export const STAGE_TOOL_MAP: Readonly<Record<DurableStageKind, { scope: ToolScope; readOnly: boolean; research: boolean }>> = {
  plan: { scope: 'coding', readOnly: true, research: false },
  investigate: { scope: 'coding', readOnly: true, research: false },
  implement: { scope: 'coding', readOnly: false, research: false },
  verify: { scope: 'coding', readOnly: false, research: false },
  research: { scope: 'full', readOnly: true, research: true },
  report: { scope: 'coding', readOnly: true, research: false }
}

/** A stage without an explicit kind: inferred from the title and objective. */
export function stageKind(stage: Pick<DurableJobStage, 'title' | 'objective'>): DurableStageKind {
  const text = `${stage.title} ${stage.objective}`.toLowerCase()
  if (/\b(verify|validate|test|check|acceptance)\b/.test(stage.title.toLowerCase())) return 'verify'
  if (/\b(report|summari[sz]e|write[- ]?up)\b/.test(stage.title.toLowerCase())) return 'report'
  if (/\b(plan|design|outline)\b/.test(stage.title.toLowerCase())) return 'plan'
  if (/\b(research|web|search online|look up)\b/.test(text)) return 'research'
  if (/\b(investigate|inspect|read|explore|analy[sz]e|find|locate|diagnose)\b/.test(stage.title.toLowerCase())) return 'investigate'
  return 'implement'
}

export interface StageTooling { kind: DurableStageKind; scope: ToolScope; readOnly: boolean; grants: LocalGrants; contract?: TaskContract; systemPrompt: string; tools: ToolSpec[]; schemaTokens: number }

export function stageTooling(kind: DurableStageKind, workspace: string, grants: LocalGrants = NO_GRANTS, contract: TaskContract = {}): StageTooling {
  const entry = STAGE_TOOL_MAP[kind]
  const effective: LocalGrants = { git: grants.git, research: entry.research && grants.research }
  const tools = toolSpecs(entry.readOnly, false, effective, entry.scope)
  return { kind, scope: entry.scope, readOnly: entry.readOnly, grants: effective, ...(entry.scope === 'coding' ? { contract } : {}), systemPrompt: systemPrompt(workspace, entry.readOnly, effective, entry.scope), tools, schemaTokens: tools.length ? jsonTokens({ tools, tool_choice: 'auto' }) : 0 }
}

// ---------------------------------------------------------------------------------------------
// 7. Empty, truncated and reasoning-only responses never count as success
// ---------------------------------------------------------------------------------------------

export type ResponseKind = 'answer' | 'tool-calls' | 'empty' | 'reasoning-only' | 'truncated' | 'malformed-calls' | 'rumination' | 'malformed-stream'

export interface ResponseClassification { kind: ResponseKind; usable: boolean; detail: string }

/** Strip a reasoning block some templates leave in content (Qwen `<think>`), reporting whether
 *  it was left open (generation stopped inside it). */
export function visibleContent(content: string): { text: string; openThink: boolean } {
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const open = /<think>/i.test(text)
  if (open) text = text.replace(/<think>[\s\S]*$/i, '')
  return { text: text.trim(), openThink: open }
}

export function classifyResponse(completion: Pick<CompletionResult, 'content' | 'reasoning' | 'toolCalls' | 'finishReason'> & { stream?: CompletionResult['stream'] }): ResponseClassification {
  const { text, openThink } = visibleContent(completion.content)
  const calls = completion.toolCalls
  if (completion.stream && completion.stream.events > 0 && completion.stream.malformed >= completion.stream.events && !text && !calls.length) return { kind: 'malformed-stream', usable: false, detail: 'Every streamed event was malformed.' }
  if (completion.finishReason === 'rumination' && !calls.length) return { kind: 'rumination', usable: false, detail: 'Generation was cut off for circular reasoning.' }
  if (calls.length && calls.some(call => !argumentsAreObject(call.arguments))) return { kind: completion.finishReason === 'length' ? 'truncated' : 'malformed-calls', usable: false, detail: completion.finishReason === 'length' ? 'A tool call was cut off at the output limit.' : 'A tool call\'s arguments were not a JSON object (a stub the server could not parse).' }
  if (calls.length) return { kind: 'tool-calls', usable: true, detail: `${calls.length} tool call(s).` }
  if (completion.finishReason === 'length' || openThink) return { kind: 'truncated', usable: false, detail: openThink ? 'The answer stopped inside an unclosed reasoning block.' : 'The answer reached the output token limit.' }
  if (!text && (completion.reasoning.trim() || /<think>/i.test(completion.content))) return { kind: 'reasoning-only', usable: false, detail: 'The model produced reasoning but no answer.' }
  if (!text) return { kind: 'empty', usable: false, detail: 'The model returned an empty answer.' }
  return { kind: 'answer', usable: true, detail: 'A complete answer.' }
}

export interface StageOutcomeClassification { success: boolean; retryable: boolean; reason: string }

const RETRYABLE: ReadonlySet<LocalStopReason> = new Set<LocalStopReason>(['round_limit', 'context_limit', 'output_limit', 'provider_error', 'empty_answer', 'stagnation'])

/** A stage succeeds only on a completed stop with a non-empty, non-truncated final answer.
 *  `completed` with no visible text (all reasoning) is an empty answer, not a success. */
export function classifyStageOutcome(outcome: { text: string; stopReason?: LocalStopReason; report?: Pick<LocalStopReport, 'reason' | 'detail'> }): StageOutcomeClassification {
  const reason = outcome.report?.reason ?? outcome.stopReason
  if (!reason) return { success: false, retryable: false, reason: 'no stop report' }
  const { text, openThink } = visibleContent(outcome.text ?? '')
  if (reason !== 'completed') return { success: false, retryable: RETRYABLE.has(reason), reason: `${reason}${outcome.report?.detail ? `: ${clip(outcome.report.detail, 200)}` : ''}` }
  if (openThink) return { success: false, retryable: true, reason: 'truncated: the final answer stopped inside a reasoning block' }
  if (!text) return { success: false, retryable: true, reason: 'empty_answer: the stage completed without a visible final answer' }
  return { success: true, retryable: false, reason: 'completed' }
}
