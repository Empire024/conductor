import type { RestartInitiator } from './restart-initiator'

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

/** How the restart is named to the conversations it brings back. */
export function restartReason(intent: RestartIntent | null, initiator: RestartInitiator | null): string {
  if (initiator?.method === 'app.restart.request') return 'the restart this wizard asked the owner for'
  if (initiator) return initiator.method === 'app.update.install' ? 'update installed by this wizard' : 'app.restart by this wizard'
  switch (intent?.kind) {
    case 'running': return 'crash relaunch: the previous Conductor ended without quitting'
    case 'quit': return 'the owner quit and reopened Conductor'
    case 'update-on-quit': return 'update installed on quit'
    case 'update-install': return 'update installed'
    case 'restart': return 'restart'
    default: return 'restart'
  }
}

export interface ResumePlan { reason: string; fromVersion: string; wizards: string[]; coworkers: string[] }

/** Who this launch brings back: the wizard that started or asked for the restart, and, unless the
 *  owner said "Stop work", every wizard that was working or waiting on its coworkers and the
 *  coworkers whose turns were cut. Null when nobody is. */
export function resumePlan(intent: RestartIntent | null, initiator: RestartInitiator | null, currentVersion: string): ResumePlan | null {
  const resume = intent?.resume === true
  const wizards = [...new Set([...(initiator ? [initiator.agentSessionId] : []), ...(resume ? intent!.wizards : [])])]
  const coworkers = resume ? intent!.coworkers.filter(id => !wizards.includes(id)) : []
  if (!wizards.length && !coworkers.length) return null
  return { reason: restartReason(intent, initiator), fromVersion: intent?.fromVersion ?? currentVersion, wizards, coworkers }
}

/** The one line every brought-back conversation starts from. */
export const restartLine = (reason: string, fromVersion: string, toVersion: string): string => `Conductor restarted (${reason}, ${fromVersion} -> ${toVersion})`

export function wizardResumeMessage(plan: ResumePlan, toVersion: string, coworkersResumed: number): string {
  return `[Conductor] ${restartLine(plan.reason, plan.fromVersion, toVersion)}; continue. This wizard tab was brought back${coworkersResumed ? ` and ${coworkersResumed === 1 ? '1 coworker whose turn was cut was' : `${coworkersResumed} coworkers whose turns were cut were`} resumed too` : ''}. Check app.state and agents.list first, then carry on from where you left off.`
}

export function coworkerResumeMessage(plan: ResumePlan, toVersion: string): string {
  return `[Conductor] ${restartLine(plan.reason, plan.fromVersion, toVersion)}; continue. The restart cut your turn: pick up your task from where you left off.`
}
