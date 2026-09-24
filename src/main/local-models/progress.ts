import { createHash } from 'node:crypto'
import type { RoundPolicy, StagnationPolicy } from './agent-policy.ts'

/** How the loop paces a run: staged warnings before a hard stop, and a simple record of what
 *  each round did so the same unproductive action is noticed before it burns the window. Both
 *  are runtime enforcement, not prompt text: the field runs showed a 9B model ignoring "at most
 *  three test runs" in the task itself every time. */

export type RoundStage = 'normal' | 'soft' | 'strong' | 'finish' | 'limit'

export function roundStage(round: number, policy: RoundPolicy): RoundStage {
  if (round >= policy.hardLimit) return 'limit'
  if (round >= policy.finishAt) return 'finish'
  if (round >= policy.strongWarningAt) return 'strong'
  if (round >= policy.softWarningAt) return 'soft'
  return 'normal'
}

/** The message injected once when a stage is first reached. Round numbers are 1-based here so
 *  the model reads what the owner sees. */
export function roundStageMessage(stage: Exclude<RoundStage, 'normal' | 'limit'>, round: number, policy: RoundPolicy): string {
  const left = policy.hardLimit - round
  switch (stage) {
    case 'soft': return `[Conductor] You have used ${round} of ${policy.hardLimit} tool rounds. Reassess the remaining work now: name what is still unresolved, avoid further exploration, and only run tools that change the outcome.`
    case 'strong': return `[Conductor] ${left} tool rounds remain. Focus on the task requirements and the one unresolved failure. Do not inspect files you already read, and do not run debug probes; make the fix and run the decisive check.`
    case 'finish': return `[Conductor] Finish phase: ${left} tool rounds remain. Resolve the remaining blocker, run one decisive validation, then give your final answer with what was completed, what still fails and which files changed. If the last validation already passed, give the final answer now without any further tool call.`
  }
}

export interface ObservedCall { name: string; arguments: Record<string, unknown>; output: string; failed: boolean; analysis?: boolean }

export interface StagnationVerdict {
  /** Identical calls seen in a row (this one included). */
  repeats: number
  /** Whether the run has stopped producing new evidence. */
  idle: boolean
  action: 'none' | 'warn' | 'stop'
  message?: string
}

const stable = (value: unknown): string => JSON.stringify(value, Object.keys((value ?? {}) as object).sort())
const digest = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16)
const comparableOutput = (text: string): string => text.replace(/^\[(?:execution|result_artifact|script_artifact|environment)[^\n]*\n?/gm,'').replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'<id>').replace(/duration_ms=\d+/g,'duration_ms=#')

/** A call's identity for repetition: the tool and its arguments, with the command text
 *  whitespace-normalised so the same test run with a stray space still counts. */
export function callFingerprint(name: string, args: Record<string, unknown>): string {
  const normalised = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value]))
  return `${name}:${digest(stable(normalised))}`
}

/** The argument a failure is about, independent of which tool reported it: the path, or else the
 *  command/query/pattern text. Undefined when the call has none, so unrelated argument-less
 *  failures are never pooled across tools. */
function failureSubject(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'command', 'query', 'pattern']) {
    const value = args[key]
    if (typeof value !== 'string' || !value.trim()) continue
    return key === 'path' ? `path:${value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')}` : `${key}:${value.replace(/\s+/g, ' ').trim()}`
  }
  return undefined
}

/** Error text with the tool-specific parts removed: a leading `error: ` and the syscall suffix
 *  (`, open '…'` vs `, realpath '…'`), so ENOENTs from a write tool and a read tool compare equal. */
export function comparableFailure(output: string): string {
  return comparableOutput(output).trim()
    .replace(/^error:\s*/i, '')
    .replace(/,\s*(?:open|realpath|stat|lstat|scandir|access|opendir|readlink|mkdir|rmdir|unlink|rename|copyfile)\s+'[^'\n]*'(?:\s*->\s*'[^'\n]*')?/gi, '')
    .replace(/[a-f0-9]{32,64}/g, '#').replace(/\bline \d+|:\d+:\d+/g, 'line #')
    .slice(0, 400)
}

/** Notices repetition without semantics: the same call again, the same failing result again,
 *  an edit that changed nothing, or a run of rounds that produced no new file change or command
 *  result. Warned once per pattern; stopped only when the pattern goes on past the policy. */
export interface StagnationSnapshot {
  lastFingerprint: string
  repeats: number
  lastOutcome: string
  outcomeRepeats: number
  idleRounds: number
  warned: string[]
  seenEvidence: string[]
  failedApproaches: Array<[string, number]>
  crossToolFailures: Array<[string, { count: number; tools: string[] }]>
  warnings: number
}

export class StagnationDetector {
  private readonly policy: StagnationPolicy
  private lastFingerprint = ''
  private repeats = 0
  private lastOutcome = ''
  private outcomeRepeats = 0
  private idleRounds = 0
  private warned = new Set<string>()
  private seenEvidence = new Set<string>()
  private failedApproaches = new Map<string, number>()
  /** Failures on the same subject with the same error, whichever tool produced them. */
  private crossToolFailures = new Map<string, { count: number; tools: Set<string> }>()
  /** How many warnings this run has fired, for the stop report. */
  warnings = 0

  constructor(policy: StagnationPolicy) { this.policy = policy }

  /** Everything the detector has seen, as plain JSON, so a turn paused for a Conductor restart
   *  goes on noticing the repetition it had already counted (docs/runtime-host.md). */
  snapshot(): StagnationSnapshot {
    return {
      lastFingerprint: this.lastFingerprint, repeats: this.repeats, lastOutcome: this.lastOutcome, outcomeRepeats: this.outcomeRepeats, idleRounds: this.idleRounds,
      warned: [...this.warned], seenEvidence: [...this.seenEvidence], failedApproaches: [...this.failedApproaches],
      crossToolFailures: [...this.crossToolFailures].map(([key, entry]) => [key, { count: entry.count, tools: [...entry.tools] }]),
      warnings: this.warnings
    }
  }

  static restore(policy: StagnationPolicy, saved: StagnationSnapshot): StagnationDetector {
    const detector = new StagnationDetector(policy)
    detector.lastFingerprint = saved.lastFingerprint
    detector.repeats = saved.repeats
    detector.lastOutcome = saved.lastOutcome
    detector.outcomeRepeats = saved.outcomeRepeats
    detector.idleRounds = saved.idleRounds
    detector.warned = new Set(saved.warned)
    detector.seenEvidence = new Set(saved.seenEvidence)
    detector.failedApproaches = new Map(saved.failedApproaches)
    detector.crossToolFailures = new Map(saved.crossToolFailures.map(([key, entry]) => [key, { count: entry.count, tools: new Set(entry.tools) }]))
    detector.warnings = saved.warnings
    return detector
  }

  observe(call: ObservedCall): StagnationVerdict {
    const fingerprint = callFingerprint(call.name, call.arguments)
    const comparable = comparableOutput(call.output)
    const outcome = digest(`${fingerprint}|${call.failed}|${comparable.slice(0, 2000)}`)
    if (fingerprint === this.lastFingerprint) this.repeats++
    else { this.lastFingerprint = fingerprint; this.repeats = 1 }
    if (outcome === this.lastOutcome) this.outcomeRepeats++
    else { this.lastOutcome = outcome; this.outcomeRepeats = 1 }
    const failedMethod = `${call.name}:${String(call.arguments.path ?? '')}:${comparable.replace(/[a-f0-9]{32,64}/g, '#').replace(/\bline \d+|:\d+:\d+/g,'line #').slice(0, 400)}`
    const failures = call.failed ? (this.failedApproaches.get(failedMethod) ?? 0) + 1 : 0
    if (call.failed) this.failedApproaches.set(failedMethod, failures)
    const subject = call.failed ? failureSubject(call.arguments) : undefined
    const failure = subject === undefined ? '' : comparableFailure(call.output)
    const crossKey = subject === undefined ? '' : `cross:${subject}|${digest(failure)}`
    const cross = crossKey ? this.crossToolFailures.get(crossKey) ?? { count: 0, tools: new Set<string>() } : undefined
    if (cross) { cross.count++; cross.tools.add(call.name); this.crossToolFailures.set(crossKey, cross) }
    const crossToolFailures = cross?.count ?? 0

    // New evidence: a write that changed something, or a command whose result we have not seen.
    const noop = call.name === 'edit_file' && /\(0 replacements?\)|was not found/.test(call.output)
    const evidence = call.failed || noop ? '' : !call.analysis && ['write_file','edit_file','apply_edits'].includes(call.name) ? `write:${digest(stable(call.arguments))}` : ['read_file','search','list_files','process_files'].includes(call.name) ? `source:${outcome}` : call.name === 'run_command' ? `run:${digest(comparable)}` : ''
    if (evidence && !this.seenEvidence.has(evidence)) { this.seenEvidence.add(evidence); this.idleRounds = 0 }
    else this.idleRounds++

    const repeated = Math.max(this.repeats, this.outcomeRepeats, failures, crossToolFailures)
    const idle = this.idleRounds >= this.policy.idleRoundsWarnAt
    // The same failure on the same subject reached through more than one tool is one pattern:
    // it is named as such, and warned once rather than once per tool.
    const crossTriggered = crossToolFailures >= this.policy.repeatWarnAt
    const acrossTools = !!cross && cross.tools.size > 1 && crossToolFailures === repeated
    const where = subject?.replace(/^[a-z]+:/, '') ?? ''
    const tools = cross ? [...cross.tools].join(', ') : call.name
    const excerpt = failure.split('\n').find(line => line.trim())?.trim().slice(0, 160) ?? ''
    if (call.analysis && this.idleRounds >= this.policy.idleRoundsWarnAt * 2) return { repeats: repeated, idle, action:'stop',message:'Repeated script changes and calls produced no new source evidence or execution result. Processing remains unvalidated.' }
    if (repeated >= this.policy.repeatStopAt) {
      return { repeats: repeated, idle, action: 'stop', message: acrossTools
        ? `Equivalent failures on ${where} ${repeated} times across ${tools}; the run was ended.`
        : `The ${call.name} approach has produced equivalent results ${repeated} times without progress, including intervening attempts.` }
    }
    if (repeated >= this.policy.repeatWarnAt && !this.warned.has(fingerprint) && !(crossTriggered && this.warned.has(crossKey))) {
      this.warned.add(fingerprint); this.warnings++
      if (crossTriggered) this.warned.add(crossKey)
      return { repeats: repeated, idle, action: 'warn', message: acrossTools
        ? `[Conductor] The same failure has now happened ${repeated} times on ${where} across ${tools} (${excerpt}). Trying another tool on the same target fails the same way. If the owner asked for this target, report the failure and stop; otherwise continue with what the owner actually asked.`
        : `[Conductor] You appear to be repeating an unsuccessful action (${call.name}, ${repeated} times with the same result) without meaningful progress. Stop repeating it, reassess the evidence you already have, and choose a different approach: change the code, or read the specific lines the failure names.` }
    }
    if (idle && !this.warned.has('idle')) {
      this.warned.add('idle'); this.warnings++
      return { repeats: repeated, idle, action: 'warn', message: `[Conductor] The last ${this.idleRounds} tool calls produced no new source evidence or execution result. Script rewrites alone are not progress. Check a raw record or a failing parser example before another full run.` }
    }
    return { repeats: repeated, idle, action: 'none' }
  }
}
