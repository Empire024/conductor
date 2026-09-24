import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ConductorDatabase, LoopRunRecord, LoopStepRunRecord } from '../database'

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
    return this.database.recordLoopStepRun({ runId: run.id, stepId: input.stepId, model: input.model.trim(), startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), outcome: input.outcome.trim(), tokens, note: input.note?.trim() || undefined })
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
