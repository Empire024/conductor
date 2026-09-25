import type { IdeaRunStage, IdeaStageAgent } from '../../shared/idea-runs'
import type { UsageReportForBudget } from '../logic-loops'

export interface WeeklyCapCheck { ok: boolean; reason?: string; usedPercent?: number; cap?: number }

/**
 * The run's weekly caps against the usage windows the providers last reported (usage.limits).
 * A local model is never capped; a provider with no current weekly window is allowed, with the
 * reason noted, exactly like a logic loop's "unknown" budget decision.
 */
export function weeklyCapCheck(agent: IdeaStageAgent, caps: { claude: number; codex: number }, reports: readonly UsageReportForBudget[]): WeeklyCapCheck {
  if (agent.provider === 'local') return { ok: true }
  const cap = caps[agent.provider]
  const report = reports.find(entry => entry.provider === agent.provider)
  const model = agent.model.toLowerCase()
  const windows = (report?.windows ?? []).filter(window => window.state === 'current' && window.kind === 'weekly' &&
    (window.scope === 'provider' || window.models?.some(selector => model.includes(selector.toLowerCase()))))
  if (!windows.length) return { ok: true, cap, reason: `No current weekly ${agent.provider} usage has been reported yet.` }
  const usedPercent = Math.max(...windows.map(window => window.usedPercent))
  if (usedPercent >= cap) return { ok: false, cap, usedPercent, reason: `${agent.provider === 'claude' ? 'Claude' : 'Codex'} weekly usage is ${usedPercent}%, at or above this run's cap of ${cap}%. The run waits for the weekly window to reset.` }
  return { ok: true, cap, usedPercent }
}

/** Why a running stage (or occurrence) must stop now, or null. */
export function stageOverBudget(stage: Pick<IdeaRunStage, 'budget' | 'startedAt' | 'turns' | 'spentEur' | 'title'>, now: Date): string | null {
  const { budget } = stage
  if (stage.spentEur > budget.maxEur) return `Stage "${stage.title}" spent €${stage.spentEur.toFixed(2)}, over its €${budget.maxEur.toFixed(2)} budget.`
  if (stage.turns > budget.maxTurns) return `Stage "${stage.title}" used ${stage.turns} turns, over its ${budget.maxTurns}-turn budget.`
  if (stage.startedAt) {
    const minutes = (now.getTime() - Date.parse(stage.startedAt)) / 60_000
    if (minutes > budget.maxMinutes) return `Stage "${stage.title}" has run ${Math.floor(minutes)} minutes, over its ${budget.maxMinutes}-minute budget.`
  }
  return null
}

/** Would approving this amount take the stage over its money budget? */
export function spendWouldExceed(stage: Pick<IdeaRunStage, 'budget' | 'spentEur'>, amountEur: number | undefined): boolean {
  return (amountEur ?? 0) > 0 && stage.spentEur + (amountEur ?? 0) > stage.budget.maxEur
}
