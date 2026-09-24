import {
  SCHEDULE_MAX_MINUTES,
  SCHEDULE_MIN_MINUTES,
  SCHEDULE_NAME_MAX,
  SCHEDULE_PROMPT_MAX,
  type ScheduleAgent,
  type ScheduleAgentOption,
  type ScheduleAgentProvider,
  type ScheduleCreator,
  type ScheduleDefinition,
  type ScheduleOutcome,
  type ScheduleRun,
  type ScheduleScript,
  type ScheduleScriptResult,
  type ScheduleTiming
} from '../../../../shared/schedules'

/**
 * Pure view logic for the Schedules panel: cadence units, labels, relative times and the task
 * form's draft/validation. Nothing here touches the bridge or the DOM, so all of it is tested in
 * schedule-helpers.test.ts.
 */

// ---------------------------------------------------------------------------------------------
// Time

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR

/** A span without direction: "40 s", "12 min", "3 h", "2 days". */
export function timeSpan(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < MINUTE) return `${Math.max(1, Math.round(abs / 1000))} s`
  const minutes = Math.round(abs / MINUTE)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(abs / HOUR)
  if (hours < 24) return `${hours} h`
  const days = Math.round(abs / DAY)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** "in 3 h", "12 min ago", "just now"; empty for a missing or unreadable timestamp. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const diff = at - now
  if (Math.abs(diff) < 45_000) return diff > 0 ? 'in a moment' : 'just now'
  return diff > 0 ? `in ${timeSpan(diff)}` : `${timeSpan(diff)} ago`
}

/** The full local date and time for a tooltip; empty when there is no timestamp. */
export const absoluteTime = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toLocaleString() : ''
}

/** A script or run duration: "850 ms", "4.2 s", "3 min 07 s", "1 h 05 min". */
export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms))
  if (value < 1000) return `${value} ms`
  if (value < MINUTE) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')} s`
  const totalSeconds = Math.floor(value / 1000)
  if (value < HOUR) return `${Math.floor(totalSeconds / 60)} min ${String(totalSeconds % 60).padStart(2, '0')} s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  return `${Math.floor(totalMinutes / 60)} h ${String(totalMinutes % 60).padStart(2, '0')} min`
}

/** How long a finished run took; null while it is still running or the stamps are unreadable. */
export function runDurationMs(run: Pick<ScheduleRun, 'startedAt' | 'finishedAt'>): number | null {
  if (!run.finishedAt) return null
  const started = Date.parse(run.startedAt), finished = Date.parse(run.finishedAt)
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null
}

/** Runs newest first, whatever order the snapshot delivered them in. */
export const sortRuns = (runs: readonly ScheduleRun[]): ScheduleRun[] =>
  [...runs].sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))

/** The task card's "Next run" value. */
export function nextRunText(schedule: Pick<ScheduleDefinition, 'enabled' | 'nextDueAt'>, now: number): string {
  if (!schedule.enabled) return 'Paused'
  if (!schedule.nextDueAt) return 'Not scheduled yet'
  const at = Date.parse(schedule.nextDueAt)
  if (!Number.isFinite(at)) return 'Not scheduled yet'
  if (at <= now) return now - at < MINUTE ? 'Due now' : `Due ${timeSpan(now - at)} ago`
  return relativeTime(schedule.nextDueAt, now)
}

/** "Deferred for 20 min: You are using this computer." — empty when nothing is held back. */
export function deferralText(schedule: Pick<ScheduleDefinition, 'deferredAt' | 'deferredReason'>, now: number): string {
  const reason = schedule.deferredReason?.trim()
  if (!reason) return ''
  const at = schedule.deferredAt ? Date.parse(schedule.deferredAt) : NaN
  const since = Number.isFinite(at) && now - at >= MINUTE ? ` for ${timeSpan(now - at)}` : ''
  return `Deferred${since}: ${reason}`
}

// ---------------------------------------------------------------------------------------------
// Cadence

export const CADENCE_UNITS = ['minutes', 'hours', 'days'] as const
export type CadenceUnit = (typeof CADENCE_UNITS)[number]
const UNIT_MINUTES: Record<CadenceUnit, number> = { minutes: 1, hours: 60, days: 1_440 }

/** The largest unit that divides the cadence evenly: 1440 -> 1 day, 90 -> 90 minutes. */
export function splitCadence(everyMinutes: number): { amount: number; unit: CadenceUnit } {
  const minutes = Math.max(1, Math.floor(everyMinutes))
  if (minutes % UNIT_MINUTES.days === 0) return { amount: minutes / UNIT_MINUTES.days, unit: 'days' }
  if (minutes % UNIT_MINUTES.hours === 0) return { amount: minutes / UNIT_MINUTES.hours, unit: 'hours' }
  return { amount: minutes, unit: 'minutes' }
}

export const joinCadence = (amount: number, unit: CadenceUnit): number => amount * UNIT_MINUTES[unit]

export const CADENCE_RANGE_TEXT = `Choose between every ${SCHEDULE_MIN_MINUTES} minutes and every ${SCHEDULE_MAX_MINUTES / UNIT_MINUTES.days} days.`

// ---------------------------------------------------------------------------------------------
// Labels

const PROVIDER_FALLBACK: Record<ScheduleAgentProvider, string> = { local: 'Local', claude: 'Claude', codex: 'Codex', grok: 'Grok' }

export const providerLabel = (provider: ScheduleAgentProvider, agents: readonly ScheduleAgentOption[]): string =>
  agents.find(option => option.provider === provider)?.label || PROVIDER_FALLBACK[provider] || provider

/** A model's label without a repeated provider prefix ("Claude Opus" under Claude reads "Opus"). */
export function modelLabel(provider: ScheduleAgentProvider, model: string, agents: readonly ScheduleAgentOption[]): string {
  const label = agents.find(option => option.provider === provider)?.models.find(entry => entry.id === model)?.label || model
  const prefix = `${providerLabel(provider, agents)} `
  return label.toLowerCase().startsWith(prefix.toLowerCase()) && label.length > prefix.length ? label.slice(prefix.length) : label
}

/** "Claude · Opus", "Codex · GPT-6 · high", or "None". */
export function agentLabel(agent: ScheduleAgent | null | undefined, agents: readonly ScheduleAgentOption[]): string {
  if (!agent) return 'None'
  return [providerLabel(agent.provider, agents), modelLabel(agent.provider, agent.model, agents), agent.effort].filter(Boolean).join(' · ')
}

export const FIRST_LOCAL_MODEL_LABEL = 'First configured local model'

export function churnModelLabel(churnModel: string | null, agents: readonly ScheduleAgentOption[]): string {
  if (!churnModel) return FIRST_LOCAL_MODEL_LABEL
  return agents.find(option => option.provider === 'local')?.models.find(entry => entry.id === churnModel)?.label || churnModel
}

/** Whether an assigned agent can review changes: a brain request needs a non-local agent. */
export const canReview = (agent: Pick<ScheduleAgent, 'provider'> | null | undefined): boolean =>
  Boolean(agent && agent.provider !== 'local')

export const TIMING_OPTIONS: ReadonlyArray<{ value: ScheduleTiming; label: string; explanation: string }> = [
  { value: 'night', label: 'At night', explanation: 'Waits for the night window, when you are away and the computer is quiet.' },
  { value: 'idle', label: 'When idle', explanation: 'Any time you are away and nothing heavy (a Blender render, a build) is running.' }
]
export const timingLabel = (timing: ScheduleTiming): string => TIMING_OPTIONS.find(option => option.value === timing)?.label ?? timing

export const OUTCOME_LABELS: Record<ScheduleOutcome, string> = {
  running: 'Running',
  unchanged: 'Unchanged',
  changed: 'Changed',
  dispatched: 'Sent to agent',
  skipped: 'Skipped',
  failed: 'Failed',
  stale: 'Stale'
}
export const outcomeLabel = (outcome: ScheduleOutcome): string => OUTCOME_LABELS[outcome] ?? outcome

/** Chip tone for an outcome or a script status; the stylesheet colours by tone. */
export type Tone = 'good' | 'quiet' | 'news' | 'bad' | 'busy'
export function outcomeTone(outcome: ScheduleOutcome): Tone {
  if (outcome === 'failed' || outcome === 'stale') return 'bad'
  if (outcome === 'changed' || outcome === 'dispatched') return 'news'
  if (outcome === 'running') return 'busy'
  if (outcome === 'unchanged') return 'good'
  return 'quiet'
}
export function scriptStatusTone(status: ScheduleScriptResult['status']): Tone {
  if (status === 'ok') return 'good'
  if (status === 'skipped') return 'quiet'
  return 'bad'
}
export const SCRIPT_STATUS_LABELS: Record<ScheduleScriptResult['status'], string> = { ok: 'OK', failed: 'Failed', invalid: 'Invalid output', timeout: 'Timed out', skipped: 'Skipped' }

export const runWhenLabel = (runWhen: ScheduleScript['runWhen']): string => runWhen === 'changed' ? 'only after a change' : 'every run'

const ORIGIN_LABELS: Record<ScheduleScript['origin'], string> = { conductor: 'Conductor', agent: 'Agent', owner: 'You' }
/** "Conductor", "Agent · Research tab", "You". */
export function originLabel(script: Pick<ScheduleScript, 'origin' | 'author'>): string {
  const title = script.author?.title?.trim()
  return [ORIGIN_LABELS[script.origin] ?? script.origin, script.origin !== 'owner' && script.origin !== 'conductor' ? title : ''].filter(Boolean).join(' · ')
}

export function creatorLabel(creator: ScheduleCreator): string {
  const title = creator.title?.trim()
  if (creator.kind === 'owner') return 'you'
  if (creator.kind === 'conductor') return 'Conductor'
  if (creator.kind === 'wizard') return title ? `the wizard tab “${title}”` : 'the wizard tab'
  return title ? `the agent in “${title}”` : 'an agent'
}

/** Whether a detail text is long enough to clamp behind "Show more". */
export const needsClamp = (text: string, lines = 6, chars = 420): boolean =>
  text.length > chars || text.split(/\r?\n/).length > lines

/** The first line of a detail text, for a compact history row. */
export const firstLine = (text: string): string => text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''

// ---------------------------------------------------------------------------------------------
// Task form

/** The form's editable state. Selects hold '' for "none"/"default"/"first configured". */
export interface TaskDraft {
  name: string
  prompt: string
  amount: string
  unit: CadenceUnit
  timing: ScheduleTiming
  urgent: boolean
  provider: ScheduleAgentProvider | ''
  model: string
  effort: string
  churnModel: string
  brain: boolean
}

/** What the form hands to create/update once it validates. */
export interface TaskFormValue {
  name: string
  prompt: string
  everyMinutes: number
  timing: ScheduleTiming
  urgent: boolean
  agent: ScheduleAgent | null
  churnModel: string | null
  brain: boolean
}

export type TaskFormErrors = Partial<Record<'name' | 'prompt' | 'cadence' | 'agent', string>>

const optionFor = (agents: readonly ScheduleAgentOption[], provider: ScheduleAgentProvider | ''): ScheduleAgentOption | undefined =>
  provider ? agents.find(option => option.provider === provider) : undefined

/** A new task: daily at night, reviewed by the first available cloud agent when there is one. */
export function newTaskDraft(agents: readonly ScheduleAgentOption[]): TaskDraft {
  const cloud = agents.find(option => option.available && option.provider !== 'local' && option.models.length)
  return {
    name: '', prompt: '', amount: '1', unit: 'days', timing: 'night', urgent: false,
    provider: cloud?.provider ?? '', model: cloud?.models[0]?.id ?? '', effort: '', churnModel: '', brain: Boolean(cloud)
  }
}

export function draftFromSchedule(schedule: ScheduleDefinition): TaskDraft {
  const cadence = splitCadence(schedule.everyMinutes)
  return {
    name: schedule.name, prompt: schedule.prompt, amount: String(cadence.amount), unit: cadence.unit,
    timing: schedule.timing, urgent: schedule.urgent,
    provider: schedule.agent?.provider ?? '', model: schedule.agent?.model ?? '', effort: schedule.agent?.effort ?? '',
    churnModel: schedule.churnModel ?? '', brain: schedule.brain && canReview(schedule.agent)
  }
}

/** Choosing a provider picks its first model and turns review on or off with the provider. */
export function withProvider(draft: TaskDraft, provider: ScheduleAgentProvider | '', agents: readonly ScheduleAgentOption[]): TaskDraft {
  const reviewable = Boolean(provider && provider !== 'local')
  const wasReviewable = Boolean(draft.provider && draft.provider !== 'local')
  return {
    ...draft, provider, model: optionFor(agents, provider)?.models[0]?.id ?? '', effort: '',
    brain: reviewable ? (wasReviewable ? draft.brain : true) : false
  }
}

/** Choosing a model keeps the effort only when the new model offers it. */
export function withModel(draft: TaskDraft, model: string, agents: readonly ScheduleAgentOption[]): TaskDraft {
  const efforts = effortChoices(agents, draft.provider, model)
  return { ...draft, model, effort: efforts.includes(draft.effort) ? draft.effort : '' }
}

/** Providers to offer: the available ones, plus the task's current one if it is not available. */
export function providerChoices(agents: readonly ScheduleAgentOption[], current: ScheduleAgentProvider | ''): Array<{ provider: ScheduleAgentProvider; label: string; available: boolean }> {
  const choices = agents.filter(option => option.available).map(option => ({ provider: option.provider, label: option.label, available: true }))
  if (current && !choices.some(choice => choice.provider === current)) {
    choices.push({ provider: current, label: providerLabel(current, agents), available: false })
  }
  return choices
}

/** A provider's models, keeping a current model the list no longer names so an edit never changes it silently. */
export function modelChoices(agents: readonly ScheduleAgentOption[], provider: ScheduleAgentProvider | '', current: string): Array<{ id: string; label: string }> {
  const models = (optionFor(agents, provider)?.models ?? []).map(entry => ({ id: entry.id, label: entry.label }))
  if (current && !models.some(entry => entry.id === current)) models.push({ id: current, label: current })
  return models
}

export const effortChoices = (agents: readonly ScheduleAgentOption[], provider: ScheduleAgentProvider | '', model: string): string[] =>
  optionFor(agents, provider)?.models.find(entry => entry.id === model)?.effort ?? []

/** Local models the churn step can use ('default'/'auto' are what "first configured" already means). */
export function churnChoices(agents: readonly ScheduleAgentOption[], current: string): Array<{ id: string; label: string }> {
  const models = (optionFor(agents, 'local')?.models ?? []).filter(entry => entry.id !== 'default' && entry.id !== 'auto').map(entry => ({ id: entry.id, label: entry.label }))
  if (current && !models.some(entry => entry.id === current)) models.push({ id: current, label: current })
  return models
}

/** The draft's cadence in minutes, or why it is not one. */
export function draftCadence(draft: Pick<TaskDraft, 'amount' | 'unit'>): { minutes: number; error: '' } | { minutes: null; error: string } {
  const amount = draft.amount.trim() === '' ? NaN : Number(draft.amount)
  if (!Number.isInteger(amount) || amount <= 0) return { minutes: null, error: 'Enter a whole number.' }
  const minutes = joinCadence(amount, draft.unit)
  if (minutes < SCHEDULE_MIN_MINUTES || minutes > SCHEDULE_MAX_MINUTES) return { minutes: null, error: CADENCE_RANGE_TEXT }
  return { minutes, error: '' }
}

export function validateTaskDraft(draft: TaskDraft): { value: TaskFormValue | null; errors: TaskFormErrors } {
  const errors: TaskFormErrors = {}
  const name = draft.name.trim(), prompt = draft.prompt.trim()
  if (!name) errors.name = 'Give the task a name.'
  else if (name.length > SCHEDULE_NAME_MAX) errors.name = `Keep the name to ${SCHEDULE_NAME_MAX} characters.`
  if (prompt.length > SCHEDULE_PROMPT_MAX) errors.prompt = `Keep the goal to ${SCHEDULE_PROMPT_MAX.toLocaleString('en-US')} characters (${prompt.length.toLocaleString('en-US')} now).`
  const cadence = draftCadence(draft)
  if (cadence.error) errors.cadence = cadence.error
  const everyMinutes = cadence.minutes ?? 0
  if (draft.provider && !draft.model) errors.agent = 'Choose a model for the assigned agent.'
  if (Object.keys(errors).length) return { value: null, errors }
  const agent: ScheduleAgent | null = draft.provider
    ? { provider: draft.provider, model: draft.model, ...(draft.effort ? { effort: draft.effort } : {}) }
    : null
  return {
    value: {
      name, prompt, everyMinutes, timing: draft.timing, urgent: draft.urgent, agent,
      churnModel: draft.churnModel || null, brain: draft.brain && canReview(agent)
    },
    errors
  }
}

// ---------------------------------------------------------------------------------------------
// Pane state

/** Busy keys: one action at a time, named by verb and the task or run it acts on. */
export const busyKey = (verb: string, id: string): string => `${verb}:${id}`

/** The confirmation sentences, kept here so the wording is tested and consistent. */
export const deleteTaskQuestion = (name: string): string =>
  `Delete the scheduled task “${name}”? Its scripts and run history are deleted with it.`
export const deleteScriptQuestion = (script: string, task: string): string =>
  `Delete the script “${script}” from “${task}”? Later runs no longer run it.`
