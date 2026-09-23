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

export interface ObservedCall { name: string; arguments: Record<string, unknown>; output: string; failed: boolean }

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

/** A call's identity for repetition: the tool and its arguments, with the command text
 *  whitespace-normalised so the same test run with a stray space still counts. */
export function callFingerprint(name: string, args: Record<string, unknown>): string {
  const normalised = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value]))
  return `${name}:${digest(stable(normalised))}`
}

/** Notices repetition without semantics: the same call again, the same failing result again,
 *  an edit that changed nothing, or a run of rounds that produced no new file change or command
 *  result. Warned once per pattern; stopped only when the pattern goes on past the policy. */
export class StagnationDetector {
  private readonly policy: StagnationPolicy
  private lastFingerprint = ''
  private repeats = 0
  private lastOutcome = ''
  private outcomeRepeats = 0
  private idleRounds = 0
  private warned = new Set<string>()
  private seenEvidence = new Set<string>()
  /** How many warnings this run has fired, for the stop report. */
  warnings = 0

  constructor(policy: StagnationPolicy) { this.policy = policy }

  observe(call: ObservedCall): StagnationVerdict {
    const fingerprint = callFingerprint(call.name, call.arguments)
    const outcome = digest(`${fingerprint}|${call.failed}|${call.output.slice(0, 2000)}`)
    if (fingerprint === this.lastFingerprint) this.repeats++
    else { this.lastFingerprint = fingerprint; this.repeats = 1 }
    if (outcome === this.lastOutcome) this.outcomeRepeats++
    else { this.lastOutcome = outcome; this.outcomeRepeats = 1 }

    // New evidence: a write that changed something, or a command whose result we have not seen.
    const noop = call.name === 'edit_file' && /\(0 replacements?\)|was not found/.test(call.output)
    const evidence = call.name === 'write_file' || call.name === 'edit_file' || call.name === 'apply_edits' ? (call.failed || noop ? '' : `write:${digest(stable(call.arguments))}`) : call.name === 'run_command' ? `run:${outcome}` : ''
    if (evidence && !this.seenEvidence.has(evidence)) { this.seenEvidence.add(evidence); this.idleRounds = 0 }
    else this.idleRounds++

    const repeated = Math.max(this.repeats, this.outcomeRepeats)
    const idle = this.idleRounds >= this.policy.idleRoundsWarnAt
    if (repeated >= this.policy.repeatStopAt) {
      return { repeats: repeated, idle, action: 'stop', message: `The same ${call.name} call has now produced the same result ${repeated} times in a row without progress.` }
    }
    if (repeated >= this.policy.repeatWarnAt && !this.warned.has(fingerprint)) {
      this.warned.add(fingerprint); this.warnings++
      return { repeats: repeated, idle, action: 'warn', message: `[Conductor] You appear to be repeating an unsuccessful action (${call.name}, ${repeated} times with the same result) without meaningful progress. Stop repeating it, reassess the evidence you already have, and choose a different approach: change the code, or read the specific lines the failure names.` }
    }
    if (idle && !this.warned.has('idle')) {
      this.warned.add('idle'); this.warnings++
      return { repeats: repeated, idle, action: 'warn', message: `[Conductor] The last ${this.idleRounds} tool calls changed no file and produced no new command result. Stop exploring: make the edit the task needs, then run its validation.` }
    }
    return { repeats: repeated, idle, action: 'none' }
  }
}
