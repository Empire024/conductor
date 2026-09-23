import { createHash } from 'node:crypto'
import type { StagnationPolicy } from '../local-models/agent-policy.ts'
import { DEFAULT_LOCAL_AGENT_POLICY } from '../local-models/agent-policy.ts'
import { StagnationDetector, type ObservedCall } from '../local-models/progress.ts'
import type { DurableJobEventDraft, ProgressSignal } from './watchdog.ts'
import { boundedExcerpt, redactData, redactSensitive } from './watchdog.ts'

/**
 * Stops a stage that is going round in circles, with evidence, instead of letting it burn the
 * night. It watches the stage's tool calls and progress signals and returns a verdict the
 * controller acts on: continue, warn (inject the message into the worker), replan once (rebuild
 * the worker context from the handoff with the instruction added), or block with evidence.
 *
 * Exported surface (Opus A consumes the verdict; Opus B puts `instruction` into the handoff):
 *   interface LoopGuardOptions { stagnation: StagnationPolicy; nearIdenticalLimit; failedApproachLimit; idleRoundsLimit; idleStageMs; maxReplans }
 *   const DEFAULT_LOOP_GUARD_OPTIONS: LoopGuardOptions
 *   type LoopPattern = 'identical-calls' | 'near-identical-calls' | 'failed-approach' | 'no-progress-rounds' | 'no-progress-time'
 *   interface LoopEvidence { pattern; tool?; target?; count; sample: string[]; sinceProgressMs; roundsWithoutProgress }
 *   type LoopVerdict = { action: 'continue' }
 *     | { action: 'warn'; message }
 *     | { action: 'replan'; evidence; instruction; event: DurableJobEventDraft }
 *     | { action: 'block'; evidence; reason; nextAction; event: DurableJobEventDraft }
 *   interface LoopGuardSnapshot { stageId; replans; lastProgressAt }
 *   function nearCallKey(name, args): string
 *   function failureSignature(output): string
 *   class LoopGuard(stageId, now: () => number, options?, snapshot?: LoopGuardSnapshot)
 *     observeToolCall(call: ObservedCall): LoopVerdict   every executed tool call, with its output
 *     observeProgress(signal: ProgressSignal): void      file diff, test ran, decision, stage output
 *     observeChatRound(): LoopVerdict                    a model round with no tool call and no progress
 *     checkStage(): LoopVerdict                          on the watchdog tick: time without progress
 *     snapshot(): LoopGuardSnapshot                      persist with the stage; replans survive a restart
 *
 * Policy: the first detected loop in a stage is a replan (one 'loop-detected' event, counters
 * reset, the worker is rebuilt with the instruction); the next one in the same stage blocks the
 * job with the evidence. Progress is a stage output, a file diff, a test run or an explicit
 * decision; tokens, tool starts and repeated chat are not.
 */

export interface LoopGuardOptions {
  stagnation: StagnationPolicy
  /** Near-identical calls (same tool and target, trivial argument diffs, nothing new learned). */
  nearIdenticalLimit: number
  /** The same failing approach, not necessarily in a row. */
  failedApproachLimit: number
  /** Tool or chat rounds in a row with no progress signal. */
  idleRoundsLimit: number
  /** Active stage time with no progress signal. */
  idleStageMs: number
  maxReplans: number
}

export const DEFAULT_LOOP_GUARD_OPTIONS: LoopGuardOptions = {
  stagnation: DEFAULT_LOCAL_AGENT_POLICY.stagnation,
  nearIdenticalLimit: 4,
  failedApproachLimit: 3,
  idleRoundsLimit: 14,
  idleStageMs: 40 * 60_000,
  maxReplans: 1
}

export type LoopPattern = 'identical-calls' | 'near-identical-calls' | 'failed-approach' | 'no-progress-rounds' | 'no-progress-time'

export interface LoopEvidence {
  pattern: LoopPattern
  tool?: string
  target?: string
  count: number
  /** Redacted, bounded excerpts: the repeated call and what it kept returning. */
  sample: string[]
  sinceProgressMs: number
  roundsWithoutProgress: number
}

export type LoopVerdict =
  | { action: 'continue' }
  | { action: 'warn'; message: string }
  | { action: 'replan'; evidence: LoopEvidence; instruction: string; event: DurableJobEventDraft }
  | { action: 'block'; evidence: LoopEvidence; reason: string; nextAction: string; event: DurableJobEventDraft }

export interface LoopGuardSnapshot { stageId: string; replans: number; lastProgressAt: number }

const digest = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16)
const TARGET_KEYS = ['path', 'file', 'filePath', 'target', 'command', 'cmd', 'url', 'query', 'pattern'] as const

const trivial = (value: string): string => value.toLowerCase().replace(/["'`]/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()

function targetOf(args: Record<string, unknown>): string {
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return key === 'command' || key === 'cmd' ? value.replace(/\s+/g, ' ').replace(/["']/g, '').trim() : value.replace(/\\/g, '/').trim()
  }
  const paths = args.paths ?? args.files
  return Array.isArray(paths) ? paths.map(String).sort().join(',') : ''
}

/** Same tool, same target path or command; every other argument compared with case, quotes,
 *  whitespace and numbers erased, so `-n 20` vs `-n 40` or an extra space is the same call. */
export function nearCallKey(name: string, args: Record<string, unknown>): string {
  const target = targetOf(args)
  const rest = Object.entries(args).filter(([key]) => !(TARGET_KEYS as readonly string[]).includes(key)).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${trivial(typeof value === 'string' ? value : JSON.stringify(value) ?? '')}`)
  return `${name}|${target}|${digest(rest.join('&'))}`
}

/** The failure's shape without its incidental detail: the first error-looking lines with paths'
 *  line/column numbers, hashes, durations and ids erased. */
export function failureSignature(output: string): string {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const errors = lines.filter(line => /error|fail|exception|not found|cannot|denied|refused|timed? ?out|assert/i.test(line))
  const picked = (errors.length ? errors : lines).slice(0, 3).join(' | ')
  return trivial(picked.replace(/[a-f0-9]{7,64}/gi, 'h').replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, 't')).slice(0, 300)
}

const PROGRESS_KINDS: ReadonlySet<ProgressSignal['kind']> = new Set(['file-diff', 'test-ran', 'decision', 'stage-output'])

export class LoopGuard {
  private readonly stageId: string
  private readonly now: () => number
  private readonly options: LoopGuardOptions
  private replans: number
  private lastProgressAt: number
  private detector!: StagnationDetector
  private nearCounts!: Map<string, number>
  private failedApproaches!: Map<string, { count: number; tool: string; target: string; sample: string }>
  private seenOutputs!: Set<string>
  private idleRounds!: number
  private lastCall?: { name: string; target: string; sample: string }

  constructor(stageId: string, now: () => number, options: Partial<LoopGuardOptions> = {}, snapshot?: LoopGuardSnapshot) {
    this.stageId = stageId
    this.now = now
    this.options = { ...DEFAULT_LOOP_GUARD_OPTIONS, ...options, stagnation: { ...DEFAULT_LOOP_GUARD_OPTIONS.stagnation, ...options.stagnation } }
    const restored = snapshot?.stageId === stageId ? snapshot : undefined
    this.replans = restored?.replans ?? 0
    // A restart is not progress, but neither is the downtime: the idle clock restarts on load.
    this.lastProgressAt = now()
    this.reset()
  }

  private reset(): void {
    this.detector = new StagnationDetector(this.options.stagnation)
    this.nearCounts = new Map()
    this.failedApproaches = new Map()
    this.seenOutputs = new Set()
    this.idleRounds = 0
    this.lastProgressAt = this.now()
  }

  snapshot(): LoopGuardSnapshot { return { stageId: this.stageId, replans: this.replans, lastProgressAt: this.lastProgressAt } }

  observeProgress(signal: ProgressSignal): void {
    if (!PROGRESS_KINDS.has(signal.kind)) return
    this.lastProgressAt = this.now()
    this.idleRounds = 0
    this.nearCounts.clear()
  }

  observeChatRound(): LoopVerdict {
    this.idleRounds++
    return this.idleVerdict()
  }

  checkStage(): LoopVerdict {
    const since = this.now() - this.lastProgressAt
    if (since >= this.options.idleStageMs) return this.detected({ pattern: 'no-progress-time', count: this.idleRounds, sample: this.lastCall ? [this.lastCall.sample] : [], ...this.base() })
    return { action: 'continue' }
  }

  observeToolCall(call: ObservedCall): LoopVerdict {
    const target = targetOf(call.arguments)
    const sample = boundedExcerpt(`${call.name} ${target || JSON.stringify(call.arguments)} -> ${call.failed ? 'failed: ' : ''}${call.output}`, 300)
    this.lastCall = { name: call.name, target, sample }
    const stagnation = this.detector.observe(call)

    // Near-identical only counts when the call taught nothing new: it failed, or its output
    // (normalised) has been seen before. Reading the next window of a file is not a loop.
    const outputKey = digest(`${call.name}|${target}|${failureSignature(call.output)}|${call.failed ? '' : digest(call.output.replace(/\b\d+(?:\.\d+)?\s*m?s\b|duration_ms=\d+|[a-f0-9]{8}-[a-f0-9-]{27,}/gi, '#'))}`)
    const repeatedOutput = this.seenOutputs.has(outputKey)
    this.seenOutputs.add(outputKey)
    const near = nearCallKey(call.name, call.arguments)
    const nearCount = call.failed || repeatedOutput ? (this.nearCounts.get(near) ?? 0) + 1 : 1
    this.nearCounts.set(near, nearCount)

    let failed = 0
    if (call.failed) {
      const approach = `${call.name}|${target}|${failureSignature(call.output)}`
      const entry = this.failedApproaches.get(approach) ?? { count: 0, tool: call.name, target, sample }
      entry.count++
      entry.sample = sample
      this.failedApproaches.set(approach, entry)
      failed = entry.count
    }

    if (!repeatedOutput && !call.failed && ['write_file', 'edit_file', 'apply_edits', 'run_command'].includes(call.name)) this.idleRounds = 0
    else this.idleRounds++

    if (failed >= this.options.failedApproachLimit) return this.detected({ pattern: 'failed-approach', tool: call.name, target, count: failed, sample: [sample], ...this.base() })
    if (stagnation.action === 'stop') return this.detected({ pattern: 'identical-calls', tool: call.name, target, count: stagnation.repeats, sample: [sample, redactSensitive(stagnation.message ?? '')], ...this.base() })
    if (nearCount >= this.options.nearIdenticalLimit) return this.detected({ pattern: 'near-identical-calls', tool: call.name, target, count: nearCount, sample: [sample], ...this.base() })
    const idle = this.idleVerdict()
    if (idle.action !== 'continue') return idle
    if (stagnation.action === 'warn' && stagnation.message) return { action: 'warn', message: stagnation.message }
    return { action: 'continue' }
  }

  private base(): Pick<LoopEvidence, 'sinceProgressMs' | 'roundsWithoutProgress'> {
    return { sinceProgressMs: this.now() - this.lastProgressAt, roundsWithoutProgress: this.idleRounds }
  }

  private idleVerdict(): LoopVerdict {
    if (this.idleRounds >= this.options.idleRoundsLimit) return this.detected({ pattern: 'no-progress-rounds', count: this.idleRounds, sample: this.lastCall ? [this.lastCall.sample] : [], ...this.base() })
    return { action: 'continue' }
  }

  private detected(raw: LoopEvidence): LoopVerdict {
    const evidence = redactData({ ...raw, target: raw.target ? boundedExcerpt(raw.target, 200) : raw.target })
    const what = describe(evidence)
    if (this.replans < this.options.maxReplans) {
      this.replans++
      this.reset()
      const instruction = `The previous attempt at this stage looped: ${what}. Do not repeat that approach. State in one line why it failed, choose a materially different approach (different file, different command, or a smaller step whose result you can check), and record the decision before acting.`
      return { action: 'replan', evidence, instruction, event: { kind: 'loop-detected', message: `Loop detected in stage ${this.stageId}: ${what}. Replanning once with a fresh worker context.`, data: { stageId: this.stageId, replan: this.replans, evidence } } }
    }
    const reason = `Stage ${this.stageId} looped again after a replan: ${what}.`
    const nextAction = 'Read the loop evidence and the stage log, then narrow the stage objective, supply the missing fact or fix the blocker by hand, and resume the job.'
    return { action: 'block', evidence, reason, nextAction, event: { kind: 'loop-detected', message: `${reason} Blocking the job with evidence.`, data: { stageId: this.stageId, replans: this.replans, blocked: true, evidence } } }
  }
}

function describe(evidence: LoopEvidence): string {
  const on = evidence.tool ? ` ${evidence.tool}${evidence.target ? ` on ${evidence.target}` : ''}` : ''
  switch (evidence.pattern) {
    case 'identical-calls': return `the same call${on} repeated ${evidence.count} times with the same result`
    case 'near-identical-calls': return `near-identical calls${on} ${evidence.count} times with nothing new learned`
    case 'failed-approach': return `the same failing approach${on} tried ${evidence.count} times`
    case 'no-progress-rounds': return `${evidence.count} rounds without a file change, test run, stage output or decision`
    case 'no-progress-time': return `${Math.round(evidence.sinceProgressMs / 60_000)} minutes without a file change, test run, stage output or decision`
  }
}

