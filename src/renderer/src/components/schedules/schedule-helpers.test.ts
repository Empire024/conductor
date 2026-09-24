import { describe, expect, it } from 'vitest'
import { SCHEDULE_MAX_MINUTES, SCHEDULE_NAME_MAX, SCHEDULE_PROMPT_MAX } from '../../../../shared/schedules'
import { AGENTS, at, DAY, HOUR, MIN, NOW, runFixture, scheduleFixture } from './schedule-test-fixtures'
import {
  agentLabel,
  canReview,
  churnChoices,
  churnModelLabel,
  creatorLabel,
  deferralText,
  deleteTaskQuestion,
  draftCadence,
  draftFromSchedule,
  effortChoices,
  firstLine,
  formatDuration,
  joinCadence,
  modelChoices,
  needsClamp,
  newTaskDraft,
  nextRunText,
  originLabel,
  outcomeTone,
  providerChoices,
  relativeTime,
  runDurationMs,
  sortRuns,
  splitCadence,
  timeSpan,
  validateTaskDraft,
  withModel,
  withProvider,
  type TaskDraft
} from './schedule-helpers'

const schedule = scheduleFixture, run = runFixture

const draft = (overrides: Partial<TaskDraft> = {}): TaskDraft => ({
  name: 'Nightly check', prompt: '', amount: '1', unit: 'days', timing: 'night', urgent: false,
  provider: 'claude', model: 'opus', effort: '', churnModel: '', brain: true, ...overrides
})

describe('time', () => {
  it('words spans and relative times in both directions', () => {
    expect(timeSpan(20_000)).toBe('20 s')
    expect(timeSpan(-12 * MIN)).toBe('12 min')
    expect(timeSpan(3 * HOUR)).toBe('3 h')
    expect(timeSpan(DAY)).toBe('1 day')
    expect(timeSpan(3 * DAY)).toBe('3 days')
    expect(relativeTime(at(3 * HOUR), NOW)).toBe('in 3 h')
    expect(relativeTime(at(-12 * MIN), NOW)).toBe('12 min ago')
    expect(relativeTime(at(-10_000), NOW)).toBe('just now')
    expect(relativeTime(at(10_000), NOW)).toBe('in a moment')
    expect(relativeTime(at(-2 * DAY), NOW)).toBe('2 days ago')
  })

  it('returns nothing for a missing or unreadable stamp', () => {
    expect(relativeTime(null, NOW)).toBe('')
    expect(relativeTime('not a date', NOW)).toBe('')
  })

  it('formats durations from milliseconds to hours', () => {
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(4_200)).toBe('4.2 s')
    expect(formatDuration(4_000)).toBe('4 s')
    expect(formatDuration(3 * MIN + 7_000)).toBe('3 min 07 s')
    expect(formatDuration(HOUR + 5 * MIN)).toBe('1 h 05 min')
    expect(formatDuration(-5)).toBe('0 ms')
  })

  it('measures finished runs only and sorts runs newest first', () => {
    expect(runDurationMs(run())).toBe(4_200)
    expect(runDurationMs(run({ finishedAt: null, outcome: 'running' }))).toBeNull()
    const sorted = sortRuns([run({ id: 'old', startedAt: at(-2 * DAY) }), run({ id: 'new', startedAt: at(-MIN) }), run({ id: 'mid', startedAt: at(-DAY) })])
    expect(sorted.map(entry => entry.id)).toEqual(['new', 'mid', 'old'])
  })

  it('says when a task runs next, including paused and overdue tasks', () => {
    expect(nextRunText(schedule(), NOW)).toBe('in 3 h')
    expect(nextRunText(schedule({ enabled: false }), NOW)).toBe('Paused')
    expect(nextRunText(schedule({ nextDueAt: null }), NOW)).toBe('Not scheduled yet')
    expect(nextRunText(schedule({ nextDueAt: at(-20_000) }), NOW)).toBe('Due now')
    expect(nextRunText(schedule({ nextDueAt: at(-40 * MIN) }), NOW)).toBe('Due 40 min ago')
  })

  it('explains a deferral with how long it has been held back', () => {
    expect(deferralText(schedule(), NOW)).toBe('')
    expect(deferralText(schedule({ deferredReason: '  ' }), NOW)).toBe('')
    expect(deferralText(schedule({ deferredAt: at(-20 * MIN), deferredReason: 'You are using this computer.' }), NOW)).toBe('Deferred for 20 min: You are using this computer.')
    expect(deferralText(schedule({ deferredAt: at(-10_000), deferredReason: 'Blender is rendering.' }), NOW)).toBe('Deferred: Blender is rendering.')
    expect(deferralText(schedule({ deferredAt: null, deferredReason: 'Waiting for the night.' }), NOW)).toBe('Deferred: Waiting for the night.')
  })
})

describe('cadence', () => {
  it('splits into the largest whole unit and joins back', () => {
    expect(splitCadence(1_440)).toEqual({ amount: 1, unit: 'days' })
    expect(splitCadence(10_080)).toEqual({ amount: 7, unit: 'days' })
    expect(splitCadence(120)).toEqual({ amount: 2, unit: 'hours' })
    expect(splitCadence(90)).toEqual({ amount: 90, unit: 'minutes' })
    expect(splitCadence(SCHEDULE_MAX_MINUTES)).toEqual({ amount: 365, unit: 'days' })
    for (const minutes of [5, 45, 60, 90, 360, 1_440, 4_320, SCHEDULE_MAX_MINUTES]) {
      const { amount, unit } = splitCadence(minutes)
      expect(joinCadence(amount, unit)).toBe(minutes)
    }
  })

  it('accepts whole numbers inside the scheduler range only', () => {
    expect(draftCadence({ amount: '6', unit: 'hours' })).toEqual({ minutes: 360, error: '' })
    expect(draftCadence({ amount: '5', unit: 'minutes' }).minutes).toBe(5)
    expect(draftCadence({ amount: '4', unit: 'minutes' }).error).toMatch(/every 5 minutes and every 365 days/)
    expect(draftCadence({ amount: '366', unit: 'days' }).error).toMatch(/365 days/)
    expect(draftCadence({ amount: '1.5', unit: 'hours' }).error).toBe('Enter a whole number.')
    expect(draftCadence({ amount: '', unit: 'hours' }).error).toBe('Enter a whole number.')
    expect(draftCadence({ amount: '0', unit: 'days' }).error).toBe('Enter a whole number.')
  })
})

describe('labels', () => {
  it('names the assigned agent the way the agents list does', () => {
    expect(agentLabel(null, AGENTS)).toBe('None')
    expect(agentLabel({ provider: 'claude', model: 'opus' }, AGENTS)).toBe('Claude · Opus')
    expect(agentLabel({ provider: 'claude', model: 'opus', effort: 'high' }, AGENTS)).toBe('Claude · Opus · high')
    expect(agentLabel({ provider: 'codex', model: 'gpt-6' }, AGENTS)).toBe('Codex · GPT-6 Astra')
    expect(agentLabel({ provider: 'claude', model: 'claude-unknown' }, AGENTS)).toBe('Claude · claude-unknown')
    expect(agentLabel({ provider: 'grok', model: 'grok-5' }, [])).toBe('Grok · grok-5')
  })

  it('names the churn model, defaulting to the first configured one', () => {
    expect(churnModelLabel(null, AGENTS)).toBe('First configured local model')
    expect(churnModelLabel('qwen3.6-35b', AGENTS)).toBe('Qwen 3.6 35B')
    expect(churnModelLabel('removed-model', AGENTS)).toBe('removed-model')
  })

  it('reviews only with a cloud agent', () => {
    expect(canReview(null)).toBe(false)
    expect(canReview({ provider: 'local' })).toBe(false)
    expect(canReview({ provider: 'codex' })).toBe(true)
  })

  it('names script origins and task creators', () => {
    expect(originLabel({ origin: 'conductor', author: { kind: 'conductor' } })).toBe('Conductor')
    expect(originLabel({ origin: 'agent', author: { kind: 'agent', title: 'Release watcher' } })).toBe('Agent · Release watcher')
    expect(originLabel({ origin: 'owner', author: { kind: 'owner' } })).toBe('You')
    expect(creatorLabel({ kind: 'owner' })).toBe('you')
    expect(creatorLabel({ kind: 'agent', title: 'Research' })).toBe('the agent in “Research”')
    expect(creatorLabel({ kind: 'wizard' })).toBe('the wizard tab')
  })

  it('tones outcomes so failures and news stand out', () => {
    expect(outcomeTone('failed')).toBe('bad')
    expect(outcomeTone('stale')).toBe('bad')
    expect(outcomeTone('changed')).toBe('news')
    expect(outcomeTone('dispatched')).toBe('news')
    expect(outcomeTone('unchanged')).toBe('good')
    expect(outcomeTone('running')).toBe('busy')
    expect(outcomeTone('skipped')).toBe('quiet')
  })

  it('clamps long detail and takes the first non-empty line for history', () => {
    expect(needsClamp('short')).toBe(false)
    expect(needsClamp('a\nb\nc\nd\ne\nf\ng')).toBe(true)
    expect(needsClamp('x'.repeat(500))).toBe(true)
    expect(firstLine('\n  \n  New release b6000\nsecond line')).toBe('New release b6000')
    expect(firstLine('')).toBe('')
  })

  it('names the task in the delete confirmation', () => {
    expect(deleteTaskQuestion('Watch releases')).toContain('“Watch releases”')
  })
})

describe('task form', () => {
  it('starts a new task on the first available cloud agent, reviewed, daily at night', () => {
    expect(newTaskDraft(AGENTS)).toMatchObject({ amount: '1', unit: 'days', timing: 'night', provider: 'claude', model: 'opus', effort: '', churnModel: '', brain: true })
    const localOnly = AGENTS.filter(option => option.provider === 'local' || option.provider === 'grok')
    expect(newTaskDraft(localOnly)).toMatchObject({ provider: '', model: '', brain: false })
  })

  it('round-trips an existing task through the draft unchanged', () => {
    const task = schedule({ everyMinutes: 360, timing: 'idle', urgent: true, churnModel: 'qwen3.6-35b' })
    const { value, errors } = validateTaskDraft(draftFromSchedule(task))
    expect(errors).toEqual({})
    expect(value).toEqual({ name: task.name, prompt: task.prompt, everyMinutes: 360, timing: 'idle', urgent: true, agent: task.agent, churnModel: 'qwen3.6-35b', brain: true })
  })

  it('never carries review for a local or missing agent', () => {
    expect(draftFromSchedule(schedule({ agent: { provider: 'local', model: 'qwen3.6-35b' }, brain: true })).brain).toBe(false)
    expect(validateTaskDraft(draft({ provider: 'local', model: 'qwen3.6-35b', brain: true })).value?.brain).toBe(false)
    expect(validateTaskDraft(draft({ provider: '', model: '', brain: true })).value).toMatchObject({ agent: null, brain: false })
  })

  it('reports each invalid field', () => {
    const { value, errors } = validateTaskDraft(draft({ name: '   ', prompt: 'x'.repeat(SCHEDULE_PROMPT_MAX + 1), amount: '2', unit: 'minutes', provider: 'claude', model: '' }))
    expect(value).toBeNull()
    expect(errors.name).toBe('Give the task a name.')
    expect(errors.prompt).toMatch(/8,000 characters \(8,001 now\)/)
    expect(errors.cadence).toMatch(/every 5 minutes/)
    expect(errors.agent).toMatch(/Choose a model/)
    expect(validateTaskDraft(draft({ name: 'n'.repeat(SCHEDULE_NAME_MAX + 1) })).errors.name).toMatch(/120 characters/)
  })

  it('trims text, maps selects to the contract and omits an empty effort', () => {
    const { value } = validateTaskDraft(draft({ name: '  Nightly  ', prompt: '  goal  ', amount: '2', unit: 'hours', effort: 'high', churnModel: 'gemma-4-12b' }))
    expect(value).toEqual({ name: 'Nightly', prompt: 'goal', everyMinutes: 120, timing: 'night', urgent: false, agent: { provider: 'claude', model: 'opus', effort: 'high' }, churnModel: 'gemma-4-12b', brain: true })
    expect(validateTaskDraft(draft()).value?.agent).toEqual({ provider: 'claude', model: 'opus' })
  })

  it('switches providers and models without leaving stale choices behind', () => {
    const toCodex = withProvider(draft({ effort: 'high', brain: false }), 'codex', AGENTS)
    expect(toCodex).toMatchObject({ provider: 'codex', model: 'gpt-6', effort: '', brain: false })
    expect(withProvider(draft(), 'local', AGENTS)).toMatchObject({ provider: 'local', model: 'default', brain: false })
    expect(withProvider(draft({ provider: '', model: '', brain: false }), 'claude', AGENTS)).toMatchObject({ model: 'opus', brain: true })
    expect(withProvider(draft(), '', AGENTS)).toMatchObject({ provider: '', model: '', brain: false })
    expect(withModel(draft({ effort: 'high' }), 'sonnet', AGENTS).effort).toBe('')
    expect(withModel(draft({ provider: 'codex', model: 'gpt-6', effort: 'high' }), 'gpt-6', AGENTS).effort).toBe('high')
  })

  it('offers available providers and keeps the current choices a list no longer names', () => {
    expect(providerChoices(AGENTS, '').map(choice => choice.provider)).toEqual(['local', 'claude', 'codex'])
    expect(providerChoices(AGENTS, 'grok')).toContainEqual({ provider: 'grok', label: 'Grok', available: false })
    expect(modelChoices(AGENTS, 'claude', 'opus-4').map(model => model.id)).toEqual(['opus', 'sonnet', 'opus-4'])
    expect(modelChoices(AGENTS, '', '')).toEqual([])
    expect(effortChoices(AGENTS, 'claude', 'opus')).toEqual(['low', 'medium', 'high'])
    expect(effortChoices(AGENTS, 'claude', 'sonnet')).toEqual([])
    expect(churnChoices(AGENTS, '').map(model => model.id)).toEqual(['qwen3.6-35b', 'gemma-4-12b'])
    expect(churnChoices(AGENTS, 'old-local').map(model => model.id)).toContain('old-local')
  })
})
