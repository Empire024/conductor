import { IDEA_ACTION_LABELS, IDEA_RUN_FINAL, IDEA_RUN_STATUS_LABELS, type IdeaRun, type IdeaRunStage } from '../../../../shared/idea-runs'

/** The run the panel shows: the one still going, else the newest. */
export function currentRun(runs: readonly IdeaRun[]): IdeaRun | null {
  return runs.find(run => !IDEA_RUN_FINAL.has(run.status)) ?? runs[0] ?? null
}

export const canStartRun = (runs: readonly IdeaRun[]): boolean => runs.every(run => IDEA_RUN_FINAL.has(run.status))

export const runStatusLabel = (run: IdeaRun): string => `${IDEA_RUN_STATUS_LABELS[run.status]}${run.dryRun ? ' · dry run' : ''}`

const STAGE_STATUS: Record<IdeaRunStage['status'], string> = {
  pending: 'Waiting', running: 'Running', 'waiting-owner': 'Waiting for you', recurring: 'Recurring', done: 'Done', failed: 'Failed', paused: 'Paused'
}

/** One line under a stage: status, agent, budget and spend, and the loop for a recurring stage. */
export function stageLine(stage: IdeaRunStage): string {
  const parts = [STAGE_STATUS[stage.status], `${stage.agent.provider} ${stage.agent.model}`, `${stage.budget.maxMinutes} min · ${stage.budget.maxTurns} turns · €${stage.budget.maxEur.toFixed(2)}`]
  if (stage.spentEur) parts.push(`spent €${stage.spentEur.toFixed(2)}`)
  if (stage.recurrence) parts.push(`every ${stage.recurrence.everyMinutes} min × ${stage.recurrence.times}${stage.loopId ? `, loop ${stage.loopId}, ${stage.occurrences} done` : ''}`)
  if (stage.status === 'recurring' && stage.nextDueAt) parts.push(`next ${new Date(stage.nextDueAt).toLocaleString()}`)
  return parts.join(' · ')
}

export const actionLabel = (type: keyof typeof IDEA_ACTION_LABELS): string => IDEA_ACTION_LABELS[type] ?? type
