import {
  IDEA_RUN_DEFAULT_BUDGET, IDEA_RUN_DEFAULT_WEEKLY_CAPS, IDEA_STAGE_KINDS, type IdeaActionType, type IdeaRunPlan, type IdeaStageAgent,
  type IdeaStageKind, type IdeaStagePlan, type IdeaStageRecurrence
} from '../../shared/idea-runs'
import { SCHEDULE_MIN_MINUTES } from '../../shared/schedules'
import { BRAND_CHECK_RULE, CHECKPOINT_RULE, PROVENANCE_RULE, PUBLIC_ACTIONS, asksToStripProvenance, isActionType } from './policy'
import { fencedJson } from './report'

export const MAX_STAGES = 12
const STAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const DEFAULT_AGENT: IdeaStageAgent = { provider: 'claude', model: 'opus[1m]', effort: 'high' }

const str = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max) : ''
const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'stage'

function agentOf(value: unknown): IdeaStageAgent {
  if (!value || typeof value !== 'object') return { ...DEFAULT_AGENT }
  const entry = value as Record<string, unknown>
  const provider = entry.provider === 'codex' || entry.provider === 'local' || entry.provider === 'claude' ? entry.provider : 'claude'
  const model = str(entry.model, 120) || (provider === 'codex' ? 'gpt-6-astra' : provider === 'local' ? 'qwen3.6-35b-a3b' : DEFAULT_AGENT.model)
  const effort = str(entry.effort, 20)
  return { provider, model, ...(effort ? { effort } : {}) }
}

function recurrenceOf(value: unknown, warnings: string[], title: string): IdeaStageRecurrence | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = value as Record<string, unknown>
  const loop = (entry.loop && typeof entry.loop === 'object' ? entry.loop : {}) as Record<string, unknown>
  const steps = (Array.isArray(loop.steps) ? loop.steps : []).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const step = item as Record<string, unknown>
    const id = slug(str(step.id, 40)), role = str(step.role, 60) || id, model = str(step.model, 120)
    const done = str(step.done, 300)
    return id && model ? [{ id, role, model: model.includes(':') ? model : `claude:${model}`, ...(done ? { done } : {}) }] : []
  }).filter((step, index, all) => all.findIndex(other => other.id === step.id) === index).slice(0, 8)
  if (!steps.length) { warnings.push(`Stage "${title}" asked to recur but named no loop steps; it runs once instead.`); return undefined }
  const everyMinutes = Math.round(clamp(entry.everyMinutes, SCHEDULE_MIN_MINUTES, 7 * 1440, 1440))
  return { everyMinutes, times: Math.round(clamp(entry.times, 1, 60, 3)), loop: { title: str(loop.title, 120) || title, steps } }
}

/**
 * Turns a planner's draft into a plan Conductor will run, and says what it changed. The rules are
 * not negotiable: anything public comes after a brand/copyright check (one is inserted when the
 * draft has none), a public stage always pauses before publishing, provenance rules ride along in
 * every brief, and the weekly caps can only go below the owner's defaults.
 */
export function normalizePlan(raw: unknown, context: { ideaText: string; author: IdeaRunPlan['author'] }): IdeaRunPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The plan must be a JSON object with a stages list')
  const value = raw as Record<string, unknown>
  const warnings: string[] = []
  const drafts = Array.isArray(value.stages) ? value.stages : []
  if (!drafts.length) throw new Error('The plan has no stages')
  if (drafts.length > MAX_STAGES) warnings.push(`The draft had ${drafts.length} stages; only the first ${MAX_STAGES} are kept.`)
  const used = new Set<string>()
  const unique = (base: string): string => { let id = base, n = 2; while (used.has(id)) id = `${base.slice(0, 36)}-${n++}`; used.add(id); return id }
  let stages: IdeaStagePlan[] = drafts.slice(0, MAX_STAGES).map((item, index) => {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const title = str(entry.title, 120) || `Stage ${index + 1}`
    const rawId = str(entry.id, 40)
    const id = unique(STAGE_ID.test(rawId) ? rawId : slug(rawId || title))
    const kind: IdeaStageKind = (IDEA_STAGE_KINDS as readonly string[]).includes(String(entry.kind)) ? entry.kind as IdeaStageKind : 'create'
    const budget = (entry.budget && typeof entry.budget === 'object' ? entry.budget : {}) as Record<string, unknown>
    const checkpoints = [...new Set((Array.isArray(entry.checkpoints) ? entry.checkpoints : []).filter(isActionType))] as IdeaActionType[]
    const goal = str(entry.goal, 4000) || title
    const doneCriteria = (Array.isArray(entry.doneCriteria) ? entry.doneCriteria : []).map(item => str(item, 500)).filter(Boolean).slice(0, 12)
    if (!doneCriteria.length) { doneCriteria.push(`The goal is met: ${goal.slice(0, 200)}`); warnings.push(`Stage "${title}" had no done-criteria; its goal stands in.`) }
    const recurrence = recurrenceOf(entry.recurrence, warnings, title)
    return {
      id, title, kind, goal, doneCriteria, agent: agentOf(entry.agent),
      budget: {
        maxMinutes: Math.round(clamp(budget.maxMinutes, 1, 24 * 60, IDEA_RUN_DEFAULT_BUDGET.maxMinutes)),
        maxTurns: Math.round(clamp(budget.maxTurns, 1, 30, IDEA_RUN_DEFAULT_BUDGET.maxTurns)),
        maxEur: clamp(budget.maxEur, 0, 10_000, IDEA_RUN_DEFAULT_BUDGET.maxEur)
      },
      checkpoints, generatesMedia: entry.generatesMedia === true, ...(recurrence ? { recurrence } : {})
    }
  })

  // A public stage always pauses before it publishes.
  for (const stage of stages) {
    if (stage.kind === 'public' && !stage.checkpoints.includes('publish')) stage.checkpoints.push('publish')
  }
  // Nothing public before a brand/copyright check.
  const firstPublic = stages.findIndex(stage => stage.kind === 'public' || stage.checkpoints.some(type => PUBLIC_ACTIONS.has(type)))
  if (firstPublic >= 0 && !stages.slice(0, firstPublic).some(stage => stage.kind === 'brand-check')) {
    const check: IdeaStagePlan = {
      id: unique('brand-check'), title: 'Brand and copyright check', kind: 'brand-check',
      goal: 'Check the brand name, logo, product design and every piece of media made so far for trademark, copyright and platform-policy problems before anything is public; confirm AI-generated media keeps its labels.',
      doneCriteria: ['Each name, logo and asset is listed with its risk and the reason it is acceptable or the change made', 'AI-generated media is confirmed to carry its AI labels and metadata'],
      agent: { ...DEFAULT_AGENT }, budget: { maxMinutes: 45, maxTurns: 4, maxEur: 0 }, checkpoints: [], generatesMedia: false
    }
    stages = [...stages.slice(0, firstPublic), check, ...stages.slice(firstPublic)]
    warnings.push(`Inserted "${check.title}" before "${stages[firstPublic + 1]!.title}": nothing public runs before a brand/copyright check.`)
  }
  if (asksToStripProvenance(context.ideaText) || stages.some(stage => asksToStripProvenance(`${stage.goal}\n${stage.doneCriteria.join('\n')}`))) {
    warnings.push('Refused part of the idea: it asks to strip or hide AI disclosure from media. Generated media keeps its AI labels and metadata, as platforms and the EU AI Act require; the run proceeds without that step.')
  }
  const caps = (value.weeklyCaps && typeof value.weeklyCaps === 'object' ? value.weeklyCaps : {}) as Record<string, unknown>
  const weeklyCaps = {
    claude: clamp(caps.claude, 1, IDEA_RUN_DEFAULT_WEEKLY_CAPS.claude, IDEA_RUN_DEFAULT_WEEKLY_CAPS.claude),
    codex: clamp(caps.codex, 1, IDEA_RUN_DEFAULT_WEEKLY_CAPS.codex, IDEA_RUN_DEFAULT_WEEKLY_CAPS.codex)
  }
  const extraRules = (Array.isArray(value.rules) ? value.rules : []).map(item => str(item, 500)).filter(Boolean).filter(rule => !asksToStripProvenance(rule)).slice(0, 10)
  return {
    summary: str(value.summary, 2000) || 'Plan for this idea',
    stages, weeklyCaps, rules: [PROVENANCE_RULE, BRAND_CHECK_RULE, CHECKPOINT_RULE, ...extraRules], warnings, author: context.author
  }
}

/** The planner's answer: the last ```idea-run-plan block, normalized. */
export function parsePlanAnswer(text: string, context: Parameters<typeof normalizePlan>[1]): IdeaRunPlan {
  const raw = fencedJson(text, 'idea-run-plan')
  if (raw === null) throw new Error('The answer has no ```idea-run-plan block of valid JSON')
  return normalizePlan(raw, context)
}
