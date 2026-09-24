import { useId, useState } from 'react'
import { Save, X } from 'lucide-react'
import { describeCadence, SCHEDULE_NAME_MAX, SCHEDULE_PROMPT_MAX, type ScheduleAgentOption, type ScheduleAgentProvider, type ScheduleDefinition } from '../../../../shared/schedules'
import { Chip } from './ScheduleParts'
import {
  CADENCE_UNITS,
  canReview,
  churnChoices,
  draftCadence,
  draftFromSchedule,
  effortChoices,
  FIRST_LOCAL_MODEL_LABEL,
  modelChoices,
  newTaskDraft,
  providerChoices,
  TIMING_OPTIONS,
  validateTaskDraft,
  withModel,
  withProvider,
  type CadenceUnit,
  type TaskDraft,
  type TaskFormValue
} from './schedule-helpers'

export interface ScheduleTaskFormProps {
  /** The task being edited; omitted for a new task. */
  schedule?: ScheduleDefinition
  agents: readonly ScheduleAgentOption[]
  busy: boolean
  error: string
  onSubmit(value: TaskFormValue): void
  onCancel(): void
}

/** Create and edit share this form; it validates locally and hands a clean value upward. */
export function ScheduleTaskForm({ schedule, agents, busy, error, onSubmit, onCancel }: ScheduleTaskFormProps): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<TaskDraft>(() => schedule ? draftFromSchedule(schedule) : newTaskDraft(agents))
  const [submitted, setSubmitted] = useState(false)
  const { value, errors } = validateTaskDraft(draft)
  const cadence = draftCadence(draft)
  const shown = submitted ? errors : { ...(errors.prompt ? { prompt: errors.prompt } : {}) }
  const set = <K extends keyof TaskDraft>(key: K, next: TaskDraft[K]): void => setDraft(current => ({ ...current, [key]: next }))

  const providers = providerChoices(agents, draft.provider)
  const models = modelChoices(agents, draft.provider, draft.model)
  const efforts = effortChoices(agents, draft.provider, draft.model)
  const churn = churnChoices(agents, draft.churnModel)
  const reviewable = canReview(draft.provider ? { provider: draft.provider } : null)
  const builtIn = Boolean(schedule && schedule.kind !== 'agent')
  const title = schedule ? `Edit “${schedule.name}”` : 'New scheduled task'
  const field = (name: string): string => `${id}-${name}`

  return <form className="schedule-form" aria-label={title} noValidate onSubmit={event => {
    event.preventDefault()
    setSubmitted(true)
    if (value && !busy) onSubmit(value)
  }}>
    <div className="schedule-form-title"><strong>{schedule ? 'Edit task' : 'New scheduled task'}</strong>{builtIn && <Chip>Built-in</Chip>}</div>

    <label className="schedule-field" htmlFor={field('name')}>Name</label>
    <input id={field('name')} value={draft.name} maxLength={SCHEDULE_NAME_MAX} placeholder="e.g. Watch llama.cpp releases"
      aria-invalid={Boolean(shown.name)} aria-describedby={shown.name ? field('name-error') : undefined}
      onChange={event => set('name', event.target.value)} />
    {shown.name && <p className="schedule-field-error" id={field('name-error')}>{shown.name}</p>}

    <label className="schedule-field" htmlFor={field('prompt')}>Goal<span className="schedule-count">{draft.prompt.trim().length.toLocaleString('en-US')} / {SCHEDULE_PROMPT_MAX.toLocaleString('en-US')}</span></label>
    <textarea id={field('prompt')} rows={3} value={draft.prompt}
      placeholder="What should the agent find out, check or keep an eye on? It writes scripts for this and reads only what changed."
      aria-invalid={Boolean(shown.prompt)} aria-describedby={shown.prompt ? field('prompt-error') : undefined}
      onChange={event => set('prompt', event.target.value)} />
    {shown.prompt && <p className="schedule-field-error" id={field('prompt-error')}>{shown.prompt}</p>}

    <fieldset className="schedule-fieldset">
      <legend>Runs every</legend>
      <div className="schedule-inline">
        <input className="schedule-amount" type="number" min={1} step={1} inputMode="numeric" aria-label="Cadence amount" value={draft.amount}
          aria-invalid={Boolean(shown.cadence)} aria-describedby={shown.cadence ? field('cadence-error') : field('cadence-hint')}
          onChange={event => set('amount', event.target.value)} />
        <select aria-label="Cadence unit" value={draft.unit} onChange={event => set('unit', event.target.value as CadenceUnit)}>
          {CADENCE_UNITS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
        </select>
        <span className="schedule-hint" id={field('cadence-hint')}>{cadence.minutes ? describeCadence(cadence.minutes) : ''}</span>
      </div>
      {shown.cadence && <p className="schedule-field-error" id={field('cadence-error')}>{shown.cadence}</p>}
    </fieldset>

    <fieldset className="schedule-fieldset">
      <legend>When</legend>
      {TIMING_OPTIONS.map(option => <label key={option.value} className="schedule-choice">
        <input type="radio" name={field('timing')} value={option.value} checked={draft.timing === option.value} onChange={() => set('timing', option.value)} />
        <span><strong>{option.label}</strong><small>{option.explanation}</small></span>
      </label>)}
      <label className="schedule-choice">
        <input type="checkbox" checked={draft.urgent} onChange={event => set('urgent', event.target.checked)} />
        <span><strong>Urgent</strong><small>Runs when due even while you are working at this computer.</small></span>
      </label>
    </fieldset>

    <fieldset className="schedule-fieldset">
      <legend>Assigned agent</legend>
      <p className="schedule-hint">Writes the task’s scripts and reviews what changed. A local agent keeps the whole task on this computer.</p>
      <div className="schedule-selects">
        <label>Provider
          <select value={draft.provider} onChange={event => setDraft(current => withProvider(current, event.target.value as ScheduleAgentProvider | '', agents))}>
            <option value="">None</option>
            {providers.map(choice => <option key={choice.provider} value={choice.provider}>{choice.label}{choice.available ? '' : ' (not available)'}</option>)}
          </select>
        </label>
        {draft.provider && <label>Model
          <select value={draft.model} aria-invalid={Boolean(shown.agent)} onChange={event => setDraft(current => withModel(current, event.target.value, agents))}>
            {!models.length && <option value="">No models offered</option>}
            {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>}
        {draft.provider && efforts.length > 0 && <label>Effort
          <select value={draft.effort} onChange={event => set('effort', event.target.value)}>
            <option value="">Default</option>
            {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </label>}
      </div>
      {shown.agent && <p className="schedule-field-error">{shown.agent}</p>}
      <label className="schedule-choice">
        <input type="checkbox" checked={reviewable && draft.brain} disabled={!reviewable} aria-describedby={field('brain-hint')} onChange={event => set('brain', event.target.checked)} />
        <span><strong>Review changes with the assigned agent</strong>
          <small id={field('brain-hint')}>{reviewable
            ? 'Only changed output, summarized locally, goes to the agent as one small request.'
            : draft.provider === 'local' ? 'A local agent does not review; the local summary is the result.' : 'Assign a cloud agent to have changes reviewed.'}</small>
        </span>
      </label>
      <label className="schedule-field-inline">Local summary model
        <select value={draft.churnModel} onChange={event => set('churnModel', event.target.value)}>
          <option value="">{FIRST_LOCAL_MODEL_LABEL}</option>
          {churn.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      <p className="schedule-hint">Summarizes changed script output on this computer; with no local model configured, the run keeps a plain diff.</p>
    </fieldset>

    {error && <p className="schedules-error" role="alert">{error}</p>}
    <div className="schedule-actions">
      <button type="submit" className="primary" disabled={busy || (submitted && !value)}><Save size={13} />{busy ? 'Saving…' : schedule ? 'Save' : 'Create task'}</button>
      <button type="button" onClick={onCancel} disabled={busy}><X size={13} />Cancel</button>
    </div>
  </form>
}
