/** The single vocabulary for "what are this project's agents doing", shared by the main-process
 *  aggregation (which sees every project) and the renderer's Workspaces project rows. */
export type ProjectActivityStatus = 'attention' | 'waiting' | 'working' | 'done' | 'idle'

/** Status per project id. Every known project is present, so a project that fell quiet reports
 *  'idle' explicitly instead of leaving a stale entry behind in the renderer. */
export type ProjectActivitySnapshot = Record<string, ProjectActivityStatus>

/** One token above the displayed vocabulary: 'stalled' is what a tab that lost its connection
 *  mid-turn contributes to a roll-up. On its own it shows as the 'waiting' warning, because that
 *  conversation really was cut off - but unlike a failure it is the *absence* of work, so any
 *  sibling still running outranks it. Rolling it up as plain 'waiting' painted a warning over
 *  projects the owner could watch working. */
export type ActivityRollupStatus = ProjectActivityStatus | 'stalled'

/** Needs-attention beats a failure, which beats still-working, which beats a lost connection,
 *  which beats finished; 'idle' is the absence of all of them. */
const ROLLUP_PRIORITY: ActivityRollupStatus[] = ['attention', 'waiting', 'working', 'stalled', 'done']

/** Folds the states of everything inside one workspace or project into the single state its row
 *  shows, still in roll-up terms so an enclosing roll-up can fold the answer again. */
export const foldActivityStatuses = (statuses: Iterable<ActivityRollupStatus>): ActivityRollupStatus => {
  const seen = new Set(statuses)
  return ROLLUP_PRIORITY.find((status) => seen.has(status)) ?? 'idle'
}

/** What a row paints: a stalled roll-up is a warning like any other once nothing outranked it. */
export const displayActivityStatus = (status: ActivityRollupStatus): ProjectActivityStatus =>
  status === 'stalled' ? 'waiting' : status

/** "Viewing": the turn ended, but background tasks it started (a backgrounded shell running a
 *  smoke test, an armed watcher) are still running, and the runtime wakes the agent again when
 *  they report. It is not done, so every roll-up ranks it like working. The main process records
 *  it as the activity phase 'waiting_background'; the control API reports it as phase 'viewing'. */
export const VIEWING_LABEL = 'Viewing'
export const viewingDescription = (backgroundTasks?: number): string =>
  `Turn ended; ${backgroundTasks && backgroundTasks > 0 ? `${backgroundTasks} background task${backgroundTasks === 1 ? '' : 's'}` : 'background tasks'} still running; the agent continues when they finish`
/** Whether a conversation phase (session or activity vocabulary) is a settled one that still has
 *  background tasks running. */
export const isViewing = (phase: string | null | undefined, backgroundTasks: number | null | undefined): boolean =>
  (backgroundTasks ?? 0) > 0 && (phase === 'completed' || phase === 'complete' || phase === 'idle' || phase === 'waiting_background')
/** The phase to report to a caller that must not read a viewing conversation as finished. */
export const displaySessionPhase = <P extends string>(phase: P, backgroundTasks: number | null | undefined): P | 'viewing' =>
  isViewing(phase, backgroundTasks) ? 'viewing' : phase
