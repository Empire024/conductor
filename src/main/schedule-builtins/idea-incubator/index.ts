import type { IdeaExploration } from '../../../shared/ideas'
import type { ScheduleExecutor } from '../../schedule-executor'
import type { BuiltinSchedule } from '../../schedule-store'
import type { IdeaStore } from '../../ideas/store'

/**
 * The Idea Incubator (docs/ideas.md): a built-in scheduled task that lets a local model make a
 * little progress on ideas nobody has touched. The schedule gate decides *when* (night window,
 * owner away, machine quiet); this executor decides *what*: at most one new exploration per run,
 * and at most `maxPerNight` in any 20 hours, oldest untouched idea first. It never uses a cloud
 * model: explorations are local durable jobs (src/main/ideas/explore.ts).
 */
export const IDEA_INCUBATOR_BUILTIN: BuiltinSchedule = {
  kind: 'idea-incubator',
  name: 'Idea Incubator',
  prompt: 'At night, explore a few untouched ideas with a local model: a short brief each (concept, open questions, next step, related memories). Local models only; settings live in the Ideas view.',
  everyMinutes: 30,
  timing: 'night',
  brain: false,
  timeoutMs: 5 * 60_000,
  agent: null,
  scripts: []
}

const NIGHT_MS = 20 * 60 * 60_000

export interface IdeaIncubatorDeps {
  store: Pick<IdeaStore, 'incubatorSettings' | 'incubatorCandidates' | 'explorationsStartedSince' | 'runningExplorations'>
  explore(ideaId: string, intensity: 'light' | 'explore'): Promise<IdeaExploration>
  now?(): Date
}

export function createIdeaIncubatorExecutor(deps: IdeaIncubatorDeps): ScheduleExecutor {
  return async () => {
    const settings = deps.store.incubatorSettings()
    if (!settings.enabled) return { outcome: 'skipped', detail: 'The Idea Incubator is switched off in the Ideas settings.' }
    const now = (deps.now?.() ?? new Date()).getTime()
    const started = deps.store.explorationsStartedSince(new Date(now - NIGHT_MS).toISOString(), 'incubator')
    if (started >= settings.maxPerNight) return { outcome: 'unchanged', detail: `${started} of at most ${settings.maxPerNight} ideas already explored tonight.` }
    // One at a time: the next starts on a later run, after this one's job is done.
    const running = deps.store.runningExplorations().filter(exploration => exploration.trigger === 'incubator')
    if (running.length) return { outcome: 'unchanged', detail: `An exploration is still running (job ${running[0]!.jobId}).` }
    const [candidate] = deps.store.incubatorCandidates(1)
    if (!candidate) return { outcome: 'unchanged', detail: 'No untouched ideas are waiting.' }
    try {
      const exploration = await deps.explore(candidate.id, settings.intensity)
      return { outcome: 'dispatched', detail: `Started a ${exploration.intensity} exploration of "${candidate.title}" on ${exploration.model} (local), job ${exploration.jobId}. ${started + 1} of ${settings.maxPerNight} tonight.` }
    } catch (error) {
      return { outcome: 'skipped', detail: `Could not explore "${candidate.title}": ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
