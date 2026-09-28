import type { RestartInitiator } from './restart-initiator'
import { recoveryNote, type RecoveryReport } from './recovery/protocol'

/* Any Conductor restart brings back the wizard tabs that were working or waiting on their
 * coworkers, and the coworkers whose turns the restart cut (feature-list.md:
 * resume-after-any-restart). The running app keeps a `running` record of that working set up to
 * date, so a crash leaves it behind; every quit path replaces it with the kind of stop it was.
 * The next launch reads it once and clears it. */
export const RESTART_INTENT_KEY = 'restartIntent'
export const RESTART_INTENT_MAX_AGE_MS = 24 * 60 * 60_000

/** `running` is the live record: a launch that finds it knows the previous process never quit. */
export type RestartKind = 'running' | 'quit' | 'update-on-quit' | 'update-install' | 'restart'
export interface RestartIntent {
  kind: RestartKind
  /** The version that was running, recorded by that process before it quit: after an update the
   *  launch reading this is already the new version and cannot know the old one any other way. */
  fromVersion: string
  /** The version an update installs on the way out. */
  toVersion?: string
  at: string
  /** False when the owner answered "Stop work" in the quit dialog. */
  resume: boolean
  wizards: string[]
  coworkers: string[]
}

/** One open agent tab as the working-set rule sees it. */
export interface ResumeCandidate {
  id: string
  wizard: boolean
  working: boolean
  /** The conversation that dispatched and controls this one (agentControlParent link). */
  controller?: string
}

/** The wizard tabs that were working or waiting on a working coworker, and those coworkers. */
export function workingSet(candidates: ResumeCandidate[]): { wizards: string[]; coworkers: string[] } {
  const wizards = candidates.filter(candidate => candidate.wizard && (candidate.working || candidates.some(other => other.controller === candidate.id && other.working))).map(candidate => candidate.id)
  const coworkers = candidates.filter(candidate => candidate.working && candidate.controller && wizards.includes(candidate.controller) && !wizards.includes(candidate.id)).map(candidate => candidate.id)
  return { wizards, coworkers }
}

export function encodeRestartIntent(intent: RestartIntent): string { return JSON.stringify(intent) }

const ids = (value: unknown): string[] | null => Array.isArray(value) && value.every(id => typeof id === 'string' && id.trim()) ? value as string[] : null
const KINDS: RestartKind[] = ['running', 'quit', 'update-on-quit', 'update-install', 'restart']

export function parseRestartIntent(raw: string | null | undefined, now: Date): RestartIntent | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<RestartIntent> | null
    if (!value || typeof value !== 'object' || !KINDS.includes(value.kind as RestartKind) || typeof value.fromVersion !== 'string' || typeof value.at !== 'string' || typeof value.resume !== 'boolean') return null
    const wizards = ids(value.wizards), coworkers = ids(value.coworkers)
    if (!wizards || !coworkers) return null
    const age = now.getTime() - Date.parse(value.at)
    if (!Number.isFinite(age) || age < 0 || age > RESTART_INTENT_MAX_AGE_MS) return null
    return { kind: value.kind!, fromVersion: value.fromVersion, ...(typeof value.toVersion === 'string' && value.toVersion ? { toVersion: value.toVersion } : {}), at: value.at, resume: value.resume, wizards, coworkers }
  } catch { return null }
}

/** Whether the live record needs writing again: the working set changed, or it is getting old. */
export function watchChanged(previous: RestartIntent | null, next: RestartIntent, refreshMs = 10 * 60_000): boolean {
  if (!previous) return true
  const same = previous.kind === next.kind && previous.fromVersion === next.fromVersion && previous.resume === next.resume
    && previous.wizards.join() === next.wizards.join() && previous.coworkers.join() === next.coworkers.join()
  return !same || Date.parse(next.at) - Date.parse(previous.at) >= refreshMs
}

/** A downloaded update installs on quit only when that cuts no running work the owner was not
 *  asked about; otherwise it waits for the next quit, when the work is idle. Work kept in the
 *  runtime host survives the installer, so only work that is not kept counts. */
export function mayInstallOnQuit(state: { updateReady: boolean; unkeptWork: boolean; ownerAnswered: boolean }): boolean {
  return !state.updateReady || !state.unkeptWork || state.ownerAnswered
}

/** How the restart is named to the conversations it brings back. `recovered`: recovery mode's
 *  watchdog brought the app back (docs/recovery-mode.md). */
export function restartReason(intent: RestartIntent | null, initiator: RestartInitiator | null, recovered = false): string {
  if (initiator?.method === 'app.restart.request') return 'the restart this wizard asked the owner for'
  if (initiator) return initiator.method === 'app.update.install' ? 'update installed by this wizard' : 'app.restart by this wizard'
  switch (intent?.kind) {
    case 'running': return recovered ? 'crash, recovered by recovery mode' : 'crash, the previous Conductor ended without quitting'
    case 'quit': return 'the owner quit and reopened Conductor'
    case 'update-on-quit': return 'update installed on quit'
    case 'update-install': return 'update installed'
    case 'restart': return 'restart'
    default: return 'restart'
  }
}

/** `fromVersion` is absent when the previous process left no record of what it ran, such as a
 *  version from before these records existed. */
export interface ResumePlan {
  reason: string; fromVersion?: string; wizards: string[]; coworkers: string[]
  /** The previous process crashed: whatever its conversations were running was cut. */
  crash?: boolean
  /** Recovery mode's sentence and report path, when the watchdog had to bring the app back. */
  recovery?: string
}

/** Who this launch brings back: the wizard that started or asked for the restart, and, unless the
 *  owner said "Stop work", every wizard that was working or waiting on its coworkers and the
 *  coworkers whose turns were cut. Null when nobody is. */
export function resumePlan(intent: RestartIntent | null, initiator: RestartInitiator | null, recovery: RecoveryReport | null = null): ResumePlan | null {
  const resume = intent?.resume === true
  const wizards = [...new Set([...(initiator ? [initiator.agentSessionId] : []), ...(resume ? intent!.wizards : [])])]
  const coworkers = resume ? intent!.coworkers.filter(id => !wizards.includes(id)) : []
  if (!wizards.length && !coworkers.length) return null
  const crash = !initiator && intent?.kind === 'running'
  const note = recoveryNote(recovery).trim().replace(/\.$/, '')
  return { reason: restartReason(intent, initiator, crash && recovery !== null && recovery.outcome !== 'down'), ...(intent ? { fromVersion: intent.fromVersion } : {}), wizards, coworkers, ...(crash ? { crash } : {}), ...(note ? { recovery: note } : {}) }
}

/** What the reattach brief did for a conversation this launch reattached: `steered` delivered the
 *  restart into its kept turn (or queued it behind that turn); `failed` was refused or not
 *  confirmed. Absent when it was not briefed because its turn had already settled. */
export type ReattachBrief = 'steered' | 'failed'

/** One conversation of the resume plan, as the launch finds it. */
export interface ResumeTarget {
  open: boolean
  /** It has a spec and, for a native provider, a native conversation to resume. */
  resumable: boolean
  /** Brought back as a wizard: only while it still is one. */
  wizard: boolean
  wizardActive: boolean
  /** This launch reattached it to the turn the previous process kept running in the runtime host. */
  reattached: boolean
  brief?: ReattachBrief
  /** Its turn or queue is still under way (hasSessionWork). */
  working: boolean
  /** It has a runtime in this process: a reattached one still holds its kept provider process. */
  live: boolean
}

/** `wait`: the brief did not reach a turn that is still running, so the resume message follows once
 *  it settles. `submit` sends it to the runtime the conversation already holds; resuming there would
 *  replace the kept process with a new one. */
export type ResumeAction = 'none' | 'wait' | 'submit' | 'resume-and-submit'

/** How a launch brings back one conversation of its resume plan. A reattached conversation whose
 *  kept turn ended while no app ran (2026-09-28: the wizard that installed an update) was never
 *  told on reattach, so it is brought back like any other. */
export function resumeAction(target: ResumeTarget): ResumeAction {
  if (!target.open || !target.resumable) return 'none'
  if (target.wizard && !target.wizardActive) return 'none'
  if (target.reattached && target.brief === 'steered') return 'none'
  if (target.working) return target.reattached && target.brief === 'failed' ? 'wait' : 'none'
  return target.reattached && target.live ? 'submit' : 'resume-and-submit'
}

/** The one line every brought-back conversation starts from. The old version is only ever the
 *  one the previous process recorded; without it the line names the running version alone rather
 *  than claiming `new -> new` across an update. */
export const restartLine = (reason: string, fromVersion: string | undefined, toVersion: string): string =>
  fromVersion ? `Conductor restarted (${reason}, ${fromVersion} -> ${toVersion})` : `Conductor restarted (${reason}, now ${toVersion})`

/** `[Conductor] Conductor restarted (<reason>, <old> -> <new>); <recovery report>; continue.` */
const resumeLead = (plan: ResumePlan, toVersion: string): string =>
  `[Conductor] ${restartLine(plan.reason, plan.fromVersion, toVersion)}${plan.recovery ? `; ${plan.recovery}` : ''}; continue.`

export function wizardResumeMessage(plan: ResumePlan, toVersion: string, coworkersResumed: number): string {
  return `${resumeLead(plan, toVersion)}${plan.crash ? ' The crash cut whatever this conversation was running; its native conversation was resumed.' : ''} This wizard tab was brought back${coworkersResumed ? ` and ${coworkersResumed === 1 ? '1 coworker whose turn was cut was' : `${coworkersResumed} coworkers whose turns were cut were`} resumed too` : ''}. Check app.state and agents.list first, then carry on from where you left off.`
}

export function coworkerResumeMessage(plan: ResumePlan, toVersion: string): string {
  return `${resumeLead(plan, toVersion)} The restart cut your turn: pick up your task from where you left off.`
}
