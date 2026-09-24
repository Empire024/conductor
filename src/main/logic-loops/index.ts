import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ConductorDatabase, LoopRunRecord, LoopStepRunRecord } from '../database'
import { makeId } from '../../shared/models'

const execFileAsync = promisify(execFile)
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const STEP_KEYS = new Set(['id', 'role', 'model', 'effort', 'fallback', 'alternate', 'action', 'job', 'input', 'output', 'done', 'optional'])
const TOP_KEYS = new Set(['id', 'version', 'title', 'trigger', 'inputs', 'output', 'budget', 'steps', 'locked'])

export interface LogicLoopStep {
  id: string
  role: string
  model?: string
  effort?: string
  fallback?: string
  alternate?: string
  action?: string
  job?: string
  input?: string
  output?: string
  done?: string
  optional?: boolean
}

export interface LogicLoopDefinition {
  id: string
  version: number
  title: string
  trigger: string[]
  inputs: string[]
  output?: string
  budget: Record<string, number>
  steps: LogicLoopStep[]
  locked: string[]
  body: string
  path: string
}

export interface UsageWindowForBudget {
  key: string
  kind: string
  scope: 'provider' | 'model'
  models?: string[]
  usedPercent: number
  state: 'current' | 'reset'
}

export interface UsageReportForBudget {
  provider: string
  status: string
  windows: UsageWindowForBudget[]
  unknown?: string[]
}

export interface StepBudgetDecision {
  status: 'allowed' | 'fallback' | 'blocked' | 'unknown'
  requestedModel?: string
  model?: string
  provider?: string
  limit?: number
  usedPercent?: number
  reason?: string
}

export interface LoopBudgetCheck {
  status: 'ready' | 'paused'
  steps: Record<string, StepBudgetDecision>
}

type Scalar = string | number | boolean | string[]

function withoutComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if ((char === '"' || char === "'") && line[i - 1] !== '\\') quote = quote === char ? '' : quote || char
    if (char === '#' && !quote && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd()
  }
  return line.trimEnd()
}

function scalar(text: string, where: string): Scalar {
  const value = withoutComment(text).trim()
  if (!value) throw new Error(`${where} is empty`)
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error(`${where} has an unterminated array`)
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((entry, index) => {
      const parsed = scalar(entry, `${where}[${index}]`)
      if (typeof parsed !== 'string') throw new Error(`${where} must contain strings`)
      return parsed
    })
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

function pair(text: string, where: string): [string, Scalar] {
  const split = text.indexOf(':')
  if (split < 1) throw new Error(`${where} must be a key: value pair`)
  const key = text.slice(0, split).trim()
  return [key, scalar(text.slice(split + 1), `${where}.${key}`)]
}

const strings = (value: Scalar | undefined, field: string): string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${field} must be an inline list of non-empty strings`)
  return value
}
const string = (value: Scalar | undefined, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

/** Parses the deliberately small, reviewable YAML subset used by .conductor/loops/*.md. */
export function parseLogicLoop(source: string, fileName: string): LogicLoopDefinition {
  const normalized = source.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) throw new Error(`${fileName} must start with YAML front matter`)
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`${fileName} has unterminated front matter`)
  const lines = normalized.slice(4, end).split('\n')
  const top: Record<string, Scalar> = {}
  const budget: Record<string, number> = {}
  const rawSteps: Array<Record<string, Scalar>> = []
  let section: 'budget' | 'steps' | null = null
  let step: Record<string, Scalar> | null = null
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const raw = withoutComment(lines[lineNumber]!)
    if (!raw.trim()) continue
    const indent = /^ */.exec(raw)![0].length
    const where = `${fileName}:${lineNumber + 2}`
    if (indent === 0) {
      step = null
      const split = raw.indexOf(':')
      if (split < 1) throw new Error(`${where} must be a key: value pair`)
      const key = raw.slice(0, split).trim()
      if (!TOP_KEYS.has(key)) throw new Error(`${where} has unknown field ${key}`)
      const rest = raw.slice(split + 1).trim()
      if (key === 'budget' || key === 'steps') {
        if (rest) throw new Error(`${where} ${key} must be a block`)
        section = key
      } else {
        section = null
        top[key] = scalar(rest, `${where}.${key}`)
      }
      continue
    }
    if (section === 'budget' && indent === 2) {
      const [key, value] = pair(raw.trim(), where)
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${where}.${key} must be a non-negative number`)
      budget[key] = value
      continue
    }
    if (section === 'steps' && indent === 2 && raw.trimStart().startsWith('- ')) {
      step = {}
      rawSteps.push(step)
      const [key, value] = pair(raw.trimStart().slice(2), where)
      if (!STEP_KEYS.has(key)) throw new Error(`${where} has unknown step field ${key}`)
      step[key] = value
      continue
    }
    if (section === 'steps' && indent === 4 && step) {
      const [key, value] = pair(raw.trim(), where)
      if (!STEP_KEYS.has(key)) throw new Error(`${where} has unknown step field ${key}`)
      step[key] = value
      continue
    }
    throw new Error(`${where} has unsupported indentation or nesting`)
  }

  const id = string(top.id, `${fileName}.id`)
  const expected = basename(fileName, '.md')
  if (!ID.test(id)) throw new Error(`${fileName}.id must use lowercase letters, numbers and hyphens`)
  if (id !== expected) throw new Error(`${fileName}.id (${id}) must match its filename (${expected})`)
  if (!Number.isSafeInteger(top.version) || (top.version as number) < 1) throw new Error(`${fileName}.version must be a positive integer`)
  const title = string(top.title, `${fileName}.title`)
  const trigger = strings(top.trigger, `${fileName}.trigger`)
  const inputs = strings(top.inputs ?? [], `${fileName}.inputs`)
  if (new Set(inputs).size !== inputs.length || inputs.some(input => !/^[a-zA-Z][\w-]{0,79}$/.test(input))) throw new Error(`${fileName}.inputs must be unique names`)
  if (!rawSteps.length) throw new Error(`${fileName}.steps must contain at least one step`)
  const steps = rawSteps.map((raw, index): LogicLoopStep => {
    const prefix = `${fileName}.steps[${index}]`
    const parsed: LogicLoopStep = { id: string(raw.id, `${prefix}.id`), role: string(raw.role, `${prefix}.role`) }
    if (!ID.test(parsed.id)) throw new Error(`${prefix}.id is invalid`)
    for (const key of ['model', 'effort', 'fallback', 'alternate', 'action', 'job', 'input', 'output', 'done'] as const) if (raw[key] !== undefined) parsed[key] = string(raw[key], `${prefix}.${key}`)
    if (raw.optional !== undefined) {
      if (typeof raw.optional !== 'boolean') throw new Error(`${prefix}.optional must be true or false`)
      parsed.optional = raw.optional
    }
    if (!parsed.model && !parsed.action) throw new Error(`${prefix} must name model or action`)
    if (parsed.model && parsed.action) throw new Error(`${prefix} cannot name both model and action`)
    return parsed
  })
  const ids = steps.map(entry => entry.id)
  if (new Set(ids).size !== ids.length) throw new Error(`${fileName}.steps contains a duplicate step id`)
  const locked = strings(top.locked ?? [], `${fileName}.locked`)
  for (const field of locked) if (field !== 'budget' && !/^steps\.[a-z0-9][a-z0-9-]{0,79}$/.test(field)) throw new Error(`${fileName}.locked contains invalid field ${field}`)
  for (const field of locked.filter(field => field.startsWith('steps.'))) if (!ids.includes(field.slice(6))) throw new Error(`${fileName}.locked names unknown step ${field.slice(6)}`)
  return {
    id, version: top.version as number, title, trigger, inputs,
    ...(top.output === undefined ? {} : { output: string(top.output, `${fileName}.output`) }),
    budget, steps, locked, body: normalized.slice(end + 5).trim(), path: `.conductor/loops/${expected}.md`
  }
}

function capFor(loop: LogicLoopDefinition, provider: string): number | undefined {
  const prefix = provider.toLowerCase()
  const caps = Object.entries(loop.budget).filter(([key]) => key.toLowerCase() === `${prefix}weeklymax` || key.toLowerCase() === `${prefix}stopat`).map(([, value]) => value)
  return caps.length ? Math.min(...caps) : undefined
}

function decision(loop: LogicLoopDefinition, model: string, reports: UsageReportForBudget[]): StepBudgetDecision {
  const provider = model.split(':', 1)[0]!.toLowerCase()
  const limit = capFor(loop, provider)
  if (limit === undefined || provider === 'local') return { status: 'allowed', model, provider }
  const report = reports.find(entry => entry.provider === provider)
  const candidates = (report?.windows ?? []).filter(window => window.state === 'current' && window.kind === 'weekly' && (window.scope === 'provider' || window.models?.some(selector => model.toLowerCase().includes(selector.toLowerCase()))))
  if (!candidates.length) return { status: 'unknown', model, provider, limit, reason: `No current weekly ${provider} usage window has been reported.` }
  const usedPercent = Math.max(...candidates.map(window => window.usedPercent))
  return usedPercent >= limit
    ? { status: 'blocked', model, provider, limit, usedPercent, reason: `${provider} weekly usage is ${usedPercent}%, at or above the loop cap of ${limit}%.` }
    : { status: 'allowed', model, provider, limit, usedPercent }
}

export function checkLoopBudget(loop: LogicLoopDefinition, reports: UsageReportForBudget[]): LoopBudgetCheck {
  const steps: Record<string, StepBudgetDecision> = {}
  for (const step of loop.steps) {
    if (!step.model) { steps[step.id] = { status: 'allowed' }; continue }
    const primary = decision(loop, step.model, reports)
    if (primary.status !== 'blocked') { steps[step.id] = primary; continue }
    let selected: StepBudgetDecision | null = null
    for (const candidate of [step.fallback, step.alternate]) {
      if (!candidate) continue
      const next = decision(loop, candidate, reports)
      if (next.status !== 'blocked') { selected = { ...next, status: 'fallback', requestedModel: step.model, reason: primary.reason }; break }
    }
    steps[step.id] = selected ?? primary
  }
  return { status: Object.values(steps).some(entry => entry.status === 'blocked') ? 'paused' : 'ready', steps }
}

export type LoopMetric = 'tokens' | 'wallTime' | 'rounds' | 'reviewFindings'
export const LOOP_METRICS: LoopMetric[] = ['tokens', 'wallTime', 'rounds', 'reviewFindings']

export interface LoopChangeClassification { autoApplicable: boolean; reasons: string[] }

const PROTECTED_STEP = /review|test/i

/**
 * The apply rules from docs/logic-loops.md, as a default-deny comparison of two parsed loop
 * files: only the explicitly listed auto-safe edits (model/effort/wording on an unlocked step,
 * reordering unlocked steps, dropping a step marked optional) pass with no reasons; anything else
 * — a locked field, a budget change, removing a non-optional step, adding a step, or changing a
 * step's role/action/job — comes back with a reason an owner or wizard tab needs to see.
 */
export function classifyLoopChange(current: LogicLoopDefinition, proposed: LogicLoopDefinition): LoopChangeClassification {
  const reasons: string[] = []
  if (proposed.id !== current.id) reasons.push('the proposal changes the loop id')
  if (JSON.stringify(current.budget) !== JSON.stringify(proposed.budget)) reasons.push('budget changed')
  if (JSON.stringify([...current.locked].sort()) !== JSON.stringify([...proposed.locked].sort())) reasons.push('the locked list changed')
  if (current.trigger.join('\u0000') !== proposed.trigger.join('\u0000')) reasons.push('trigger changed')
  if (current.inputs.join('\u0000') !== proposed.inputs.join('\u0000')) reasons.push('inputs changed')
  if ((current.output ?? '') !== (proposed.output ?? '')) reasons.push('output changed')

  const currentById = new Map(current.steps.map(step => [step.id, step]))
  const proposedById = new Map(proposed.steps.map(step => [step.id, step]))
  const locked = new Set(current.locked.filter(field => field.startsWith('steps.')).map(field => field.slice(6)))

  for (const [id, step] of currentById) {
    if (proposedById.has(id)) continue
    if (locked.has(id)) { reasons.push(`removing locked step ${id}`); continue }
    if (step.optional) continue
    if (step.action === 'git.ship' || PROTECTED_STEP.test(step.role) || PROTECTED_STEP.test(step.id)) { reasons.push(`removing step ${id} (review, test or ship) needs owner approval`); continue }
    reasons.push(`removing required step ${id} needs owner approval`)
  }
  for (const id of proposedById.keys()) if (!currentById.has(id)) reasons.push(`adding step ${id} needs owner approval`)
  for (const [id, before] of currentById) {
    const after = proposedById.get(id)
    if (!after) continue
    if (locked.has(id)) { if (JSON.stringify(before) !== JSON.stringify(after)) reasons.push(`step ${id} is locked`); continue }
    if (before.role !== after.role) reasons.push(`step ${id} role changed`)
    if (before.action !== after.action) reasons.push(`step ${id} action changed`)
    if (before.job !== after.job) reasons.push(`step ${id} job changed`)
  }
  const lockedOrder = (steps: LogicLoopStep[]): string[] => steps.map(step => step.id).filter(id => locked.has(id))
  if (lockedOrder(current.steps).join('\u0000') !== lockedOrder(proposed.steps).join('\u0000')) reasons.push('the position of a locked step changed')

  return { autoApplicable: reasons.length === 0, reasons }
}

function stepMetric(metric: LoopMetric, step: LoopStepRunRecord): number {
  switch (metric) {
    case 'tokens': return step.tokens?.total ?? ((step.tokens?.input ?? 0) + (step.tokens?.output ?? 0))
    case 'wallTime': return Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt))
    case 'rounds': return 1
    case 'reviewFindings': { const match = /^(\d+)/.exec((step.note ?? '').trim()); return match ? Number(match[1]) : 0 }
  }
}

/** Higher is always worse for every metric this loop system knows, so one comparison serves all four. */
export function runMetricValue(metric: LoopMetric, steps: LoopStepRunRecord[]): number {
  const scoped = metric === 'reviewFindings' ? steps.filter(step => PROTECTED_STEP.test(step.stepId)) : steps
  return scoped.reduce((sum, step) => sum + stepMetric(metric, step), 0)
}

export interface RecordedRunMetric { runId: string; value: number }
export interface RevertVerdict { revert: boolean; reason?: string }

/**
 * Pure over loop_step_runs: once two runs have been recorded since an applied change, both worse
 * than the baseline the proposal cited reverts it. One run is not enough signal either way, and a
 * tie (equal to baseline) does not count as worse.
 */
export function evaluateAutoRevert(baseline: number, runsAfterApply: RecordedRunMetric[]): RevertVerdict {
  if (runsAfterApply.length < 2) return { revert: false }
  const [first, second] = runsAfterApply
  if (first!.value > baseline && second!.value > baseline) {
    return { revert: true, reason: `the next two recorded runs (${first!.value}, ${second!.value}) were worse than the baseline (${baseline})` }
  }
  return { revert: false }
}

function bumpVersionLine(text: string, toVersion: number): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const replaced = normalized.replace(/^version:\s*\d+\s*$/m, `version: ${toVersion}`)
  if (replaced === normalized) throw new Error('Could not find a top-level version line to bump')
  return replaced
}

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0]!.trim()

function appendRunLogEntry(text: string, entry: string): string {
  if (!/^## Run log/m.test(text)) throw new Error('The loop file has no "## Run log" section to append to')
  return `${text.replace(/\n+$/, '')}\n${entry}\n`
}

/** bumpVersionLine/appendRunLogEntry work in normalized LF text; every checked-in loop file is
 *  CRLF (this repository's line ending), so the write-back matches whatever the file on disk used
 *  instead of turning one field's worth of edit into a whole-file diff. */
const matchLineEndings = (sample: string, text: string): string => /\r\n/.test(sample) ? text.replace(/\n/g, '\r\n') : text

export interface LoopProposalRecord {
  id: string
  loopId: string
  change: string
  evidence: string
  metric?: LoopMetric
  status: 'pending' | 'applied' | 'rejected' | 'reverted'
  createdAt: string
  decidedAt?: string
  appliedBy?: 'agent' | 'owner' | 'wizard'
  appliedVersion?: number
  previousVersion?: number
  previousContent?: string
  baselineMetric?: number
  revertReason?: string
  reasons?: string[]
}

export interface LogicLoopDependencies {
  usage(): UsageReportForBudget[]
  git(args: string[], cwd: string): Promise<string>
}

export interface LoopRecordInput {
  runId: string
  stepId: string
  model: string
  startedAt: string
  finishedAt: string
  outcome: string
  tokens?: unknown
  note?: string
}

const defaultGit = async (args: string[], cwd: string): Promise<string> => {
  try { return (await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })).stdout }
  catch (error) { throw new Error(`Could not read loop history: ${error instanceof Error ? error.message : String(error)}`) }
}

export class LogicLoops {
  private readonly deps: LogicLoopDependencies
  constructor(private readonly root: string, private readonly projectId: string, private readonly database: ConductorDatabase, deps: Partial<LogicLoopDependencies> = {}) {
    this.deps = { usage: () => [], git: defaultGit, ...deps }
  }

  list(): Array<Omit<LogicLoopDefinition, 'body' | 'steps'> & { stepCount: number }> {
    const directory = join(this.root, '.conductor', 'loops')
    if (!existsSync(directory)) return []
    return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => this.read(entry.name)).sort((a, b) => a.id.localeCompare(b.id)).map(({ body: _body, steps, ...loop }) => ({ ...loop, stepCount: steps.length }))
  }

  get(id: string): LogicLoopDefinition { return this.read(`${this.validId(id)}.md`) }

  async history(id: string): Promise<Array<{ commit: string; at: string; subject: string }>> {
    const loop = this.get(id)
    const output = await this.deps.git(['log', '--follow', '--format=%H%x00%aI%x00%s', '--', loop.path], this.root)
    return output.split(/\r?\n/).filter(Boolean).map(line => {
      const [commit, at, ...subject] = line.split('\0')
      return { commit: commit ?? '', at: at ?? '', subject: subject.join('\0') }
    })
  }

  run(id: string, inputs: unknown): { runId: string; status: 'ready' | 'paused'; loop: { id: string; version: number; title: string }; inputs: Record<string, unknown>; budget: LoopBudgetCheck; steps: Array<LogicLoopStep & { requestedModel?: string; budget: StepBudgetDecision }> } {
    const loop = this.get(id)
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('loops.run inputs must be an object')
    const values = inputs as Record<string, unknown>
    const missing = loop.inputs.filter(key => !(key in values))
    const extra = Object.keys(values).filter(key => !loop.inputs.includes(key))
    if (missing.length) throw new Error(`loops.run is missing input(s): ${missing.join(', ')}`)
    if (extra.length) throw new Error(`loops.run has unknown input(s): ${extra.join(', ')}`)
    const budget = checkLoopBudget(loop, this.deps.usage())
    const run = this.database.createLoopRun({ projectId: this.projectId, loopId: loop.id, loopVersion: loop.version, inputs: values, status: budget.status })
    const steps = loop.steps.map(step => {
      const gate = budget.steps[step.id]!
      const model = gate.status === 'fallback' ? gate.model : step.model
      return { ...step, ...(model ? { model } : {}), ...(gate.requestedModel ? { requestedModel: gate.requestedModel } : {}), budget: gate }
    })
    return { runId: run.id, status: budget.status, loop: { id: loop.id, version: loop.version, title: loop.title }, inputs: values, budget, steps }
  }

  record(input: LoopRecordInput): LoopStepRunRecord {
    const run = this.database.getLoopRun(input.runId)
    if (!run || run.projectId !== this.projectId) throw new Error('No logic-loop run with that id exists in this project')
    const loop = this.get(run.loopId)
    if (!loop.steps.some(step => step.id === input.stepId)) throw new Error(`Loop ${loop.id} has no step ${input.stepId}`)
    const started = Date.parse(input.startedAt), finished = Date.parse(input.finishedAt)
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) throw new Error('startedAt and finishedAt must be ISO timestamps in chronological order')
    if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200) throw new Error('model must be a non-empty string')
    if (typeof input.outcome !== 'string' || !input.outcome.trim() || input.outcome.length > 100) throw new Error('outcome must be a non-empty string')
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 4000)) throw new Error('note must be at most 4000 characters')
    let tokens: Record<string, number> | undefined
    if (input.tokens !== undefined) {
      if (!input.tokens || typeof input.tokens !== 'object' || Array.isArray(input.tokens)) throw new Error('tokens must be an object')
      const raw = input.tokens as Record<string, unknown>
      if (Object.keys(raw).some(key => !['input', 'output', 'total'].includes(key)) || Object.values(raw).some(value => !Number.isSafeInteger(value) || (value as number) < 0)) throw new Error('tokens accepts non-negative integer input, output and total values')
      tokens = raw as Record<string, number>
    }
    const recorded = this.database.recordLoopStepRun({ runId: run.id, stepId: input.stepId, model: input.model.trim(), startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), outcome: input.outcome.trim(), tokens, note: input.note?.trim() || undefined })
    this.noteRun(run.loopId, run.id, run.createdAt)
    this.maybeAutoRevert(run.loopId)
    return recorded
  }

  propose(input: { id: string; change: string; evidence: string; metric?: string }): LoopProposalRecord {
    const loop = this.get(input.id)
    if (typeof input.change !== 'string' || !input.change.trim() || input.change.length > 20_000) throw new Error('change must be the full proposed loop file, up to 20,000 characters')
    if (typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 4000) throw new Error('evidence must be a non-empty string, up to 4,000 characters')
    if (input.metric !== undefined && !LOOP_METRICS.includes(input.metric as LoopMetric)) throw new Error(`metric must be one of ${LOOP_METRICS.join(', ')}`)
    let proposed: LogicLoopDefinition
    try { proposed = parseLogicLoop(input.change, `${loop.id}.md`) } catch (error) { throw new Error(`change does not parse as a valid loop file: ${error instanceof Error ? error.message : String(error)}`) }
    if (proposed.version !== loop.version) throw new Error(`change must be authored against the current version (${loop.version}); loops.apply bumps the version`)
    const record: LoopProposalRecord = { id: makeId('loopproposal'), loopId: loop.id, change: input.change, evidence: input.evidence.trim(), ...(input.metric ? { metric: input.metric as LoopMetric } : {}), status: 'pending', createdAt: new Date().toISOString() }
    this.upsertProposal(record)
    return record
  }

  apply(proposalId: string, sovereign: boolean, appliedBy: 'agent' | 'owner' | 'wizard'): LoopProposalRecord {
    if (typeof proposalId !== 'string' || !proposalId.trim()) throw new Error('proposalId must be a non-empty string')
    const proposal = this.getProposal(proposalId)
    if (proposal.status !== 'pending') throw new Error(`Proposal ${proposalId} is already ${proposal.status}`)
    const current = this.get(proposal.loopId)
    const proposed = parseLogicLoop(proposal.change, `${current.id}.md`)
    if (proposed.version !== current.version) throw new Error('This loop changed since the proposal was written; propose again against the current version')
    const classification = classifyLoopChange(current, proposed)
    if (!classification.autoApplicable && !sovereign) throw new Error(`This change needs the owner or a wizard tab: ${classification.reasons.join('; ')}`)
    const path = join(this.root, current.path)
    const previousContent = readFileSync(path, 'utf8')
    const nextVersion = current.version + 1
    const entry = `- ${new Date().toISOString().slice(0, 10)} v${nextVersion} (loops.apply ${proposal.id}): ${firstLine(proposal.evidence)}`
    writeFileSync(path, matchLineEndings(previousContent, appendRunLogEntry(bumpVersionLine(proposal.change, nextVersion), entry)))
    const updated: LoopProposalRecord = {
      ...proposal, status: 'applied', decidedAt: new Date().toISOString(), appliedBy,
      appliedVersion: nextVersion, previousVersion: current.version, previousContent,
      ...(proposal.metric ? { baselineMetric: this.currentMetric(proposal.loopId, proposal.metric) } : {})
    }
    this.upsertProposal(updated)
    return updated
  }

  reject(proposalId: string): LoopProposalRecord {
    if (typeof proposalId !== 'string' || !proposalId.trim()) throw new Error('proposalId must be a non-empty string')
    const proposal = this.getProposal(proposalId)
    if (proposal.status !== 'pending') throw new Error(`Proposal ${proposalId} is already ${proposal.status}`)
    const updated: LoopProposalRecord = { ...proposal, status: 'rejected', decidedAt: new Date().toISOString() }
    this.upsertProposal(updated)
    return updated
  }

  listProposals(loopId?: string): LoopProposalRecord[] {
    const list = this.listProposalsRaw()
    return loopId ? list.filter(entry => entry.loopId === loopId) : list
  }

  /** The most recent recorded runs of a loop, newest first, each with its recorded steps — what
   *  the Scheduled tasks and Project tasks panels show under a loop. */
  recentRuns(loopId: string, limit = 5): Array<LoopRunRecord & { steps: LoopStepRunRecord[] }> {
    return this.runIndex(loopId).slice(-limit).reverse().flatMap(entry => {
      const run = this.database.getLoopRun(entry.runId)
      return run ? [{ ...run, steps: this.database.listLoopStepRuns(run.id) }] : []
    })
  }

  private currentMetric(loopId: string, metric: LoopMetric): number {
    const runs = this.runIndex(loopId)
    const latest = runs.at(-1)
    return latest ? runMetricValue(metric, this.database.listLoopStepRuns(latest.runId)) : 0
  }

  /** Reverts silently reverts nothing until two runs have landed since the last applied change;
   *  called from record() so it never needs its own poll loop. */
  private maybeAutoRevert(loopId: string): void {
    const latest = [...this.listProposalsRaw()].reverse().find(entry => entry.loopId === loopId && entry.status === 'applied')
    if (!latest || latest.metric === undefined || latest.baselineMetric === undefined || !latest.decidedAt || !latest.previousContent || latest.previousVersion === undefined) return
    const since = this.runIndex(loopId).filter(entry => entry.createdAt > latest.decidedAt!)
    if (since.length < 2) return
    const metrics: RecordedRunMetric[] = since.slice(0, 2).map(entry => ({ runId: entry.runId, value: runMetricValue(latest.metric!, this.database.listLoopStepRuns(entry.runId)) }))
    const verdict = evaluateAutoRevert(latest.baselineMetric, metrics)
    if (!verdict.revert) return
    const current = this.get(loopId)
    const path = join(this.root, current.path)
    const nextVersion = current.version + 1
    const entry = `- ${new Date().toISOString().slice(0, 10)} v${nextVersion} (auto-revert of proposal ${latest.id}): ${verdict.reason}.`
    writeFileSync(path, matchLineEndings(latest.previousContent, appendRunLogEntry(bumpVersionLine(latest.previousContent, nextVersion), entry)))
    this.upsertProposal({ ...latest, status: 'reverted', revertReason: verdict.reason })
  }

  private proposalsKey(): string { return `logicLoopProposals:${this.projectId}` }
  private runIndexKey(loopId: string): string { return `logicLoopRuns:${this.projectId}:${loopId}` }

  private listProposalsRaw(): LoopProposalRecord[] {
    const raw = this.database.getSetting(this.proposalsKey())
    if (!raw) return []
    try { const parsed: unknown = JSON.parse(raw); return Array.isArray(parsed) ? parsed as LoopProposalRecord[] : [] } catch { return [] }
  }

  private upsertProposal(record: LoopProposalRecord): void {
    const list = this.listProposalsRaw()
    const index = list.findIndex(entry => entry.id === record.id)
    if (index >= 0) list[index] = record; else list.push(record)
    this.database.setSetting(this.proposalsKey(), JSON.stringify(list.slice(-200)))
  }

  private getProposal(id: string): LoopProposalRecord {
    const found = this.listProposalsRaw().find(entry => entry.id === id)
    if (!found) throw new Error('No logic-loop proposal with that id exists in this project')
    return found
  }

  private runIndex(loopId: string): Array<{ runId: string; createdAt: string }> {
    const raw = this.database.getSetting(this.runIndexKey(loopId))
    if (!raw) return []
    try { const parsed: unknown = JSON.parse(raw); return Array.isArray(parsed) ? parsed as Array<{ runId: string; createdAt: string }> : [] } catch { return [] }
  }

  private noteRun(loopId: string, runId: string, createdAt: string): void {
    const list = this.runIndex(loopId)
    if (list.some(entry => entry.runId === runId)) return
    list.push({ runId, createdAt })
    this.database.setSetting(this.runIndexKey(loopId), JSON.stringify(list.slice(-50)))
  }

  private validId(id: string): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Loop id must use lowercase letters, numbers and hyphens')
    return id
  }

  private read(fileName: string): LogicLoopDefinition {
    const id = basename(fileName, '.md')
    this.validId(id)
    const path = join(this.root, '.conductor', 'loops', `${id}.md`)
    if (!existsSync(path)) throw new Error(`No logic loop ${id} exists in this project`)
    return parseLogicLoop(readFileSync(path, 'utf8'), `${id}.md`)
  }
}

export type { LoopRunRecord }
