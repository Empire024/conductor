import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SchedulerStatus } from './SchedulerStatus'
import { ScheduleRunHistory, ScheduleRunView } from './ScheduleRunView'
import { ScheduleScripts } from './ScheduleScripts'
import { ScheduleTaskCard, type ScheduleTaskCardProps } from './ScheduleTaskCard'
import { ScheduleTaskForm } from './ScheduleTaskForm'
import { AGENTS, at, DAY, HOUR, MIN, NOW, runFixture, scheduleFixture, scriptFixture } from './schedule-test-fixtures'

const noop = (): void => {}
const handlers = {
  onRunNow: noop, onToggleEnabled: noop, onEdit: noop, onCancelEdit: noop, onSave: noop, onDelete: noop,
  onAssign: noop, onDeleteScript: noop, onOpenArtifact: noop, onOpenConversation: noop
}
const card = (overrides: Partial<ScheduleTaskCardProps> = {}): string => renderToStaticMarkup(createElement(ScheduleTaskCard, {
  schedule: scheduleFixture(), runs: [], scripts: [], agents: AGENTS, running: null, runningElsewhere: '', now: NOW,
  busy: '', error: '', notice: '', editing: false, ...handlers, ...overrides
}))
/** The text of a button whose label contains `label`, with its disabled flag. */
const button = (html: string, label: string): { disabled: boolean } | null => {
  const match = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].find(entry => (entry[2] ?? '').replace(/<[^>]+>/g, '').includes(label))
  return match ? { disabled: /\sdisabled=""/.test(match[1] ?? '') } : null
}

describe('ScheduleTaskCard', () => {
  it('shows cadence, next run, agent, churn model and every action for an agent task', () => {
    const html = card()
    expect(html).toContain('Watch llama.cpp releases')
    expect(html).toContain('daily')
    expect(html).toContain('in 3 h')
    expect(html).toContain('Claude · Opus · high')
    expect(html).toContain('reviews changes')
    expect(html).toContain('First configured local model')
    expect(html).toContain('At night')
    for (const label of ['Run now', 'Pause', 'Edit', 'Delete', 'Assign agent to write scripts']) expect(button(html, label)).toEqual({ disabled: false })
    expect(html).toContain('Not run yet. First run in 3 h.')
  })

  it('marks a built-in task and offers no delete', () => {
    const html = card({ schedule: scheduleFixture({ kind: 'latest-models-methods', createdBy: { kind: 'conductor' } }) })
    expect(html).toContain('Built-in')
    expect(button(html, 'Delete')).toBeNull()
    expect(button(html, 'Edit')).toEqual({ disabled: false })
    expect(html).toContain('Created by Conductor')
  })

  it('explains a deferral and badges a paused, urgent task', () => {
    const html = card({ schedule: scheduleFixture({ enabled: false, urgent: true, deferredAt: at(-25 * MIN), deferredReason: 'You are using this computer.' }) })
    expect(html).toContain('Deferred for 25 min: You are using this computer.')
    expect(html).toContain('Paused')
    expect(html).toContain('Urgent')
    expect(button(html, 'Resume')).toEqual({ disabled: false })
  })

  it('shows the running indicator and blocks a second run', () => {
    const running = { scheduleId: 's1', runId: 'r9', startedAt: at(-2 * MIN) }
    const html = card({ running, runs: [runFixture({ id: 'r9', outcome: 'running', finishedAt: null, detail: '', startedAt: at(-2 * MIN) })] })
    expect(html).toContain('Running, started')
    expect(html).toContain('2 min ago')
    expect(html).toContain('Running its scripts…')
    expect(button(html, 'Run now')).toEqual({ disabled: true })
    const elsewhere = card({ running: { ...running, scheduleId: 's2' }, runningElsewhere: 'Nightly tests' })
    expect(elsewhere).toContain('Waiting for “Nightly tests” to finish.')
    expect(button(elsewhere, 'Run now')).toEqual({ disabled: true })
  })

  it('disables script assignment without an agent', () => {
    const html = card({ schedule: scheduleFixture({ agent: null, brain: false }) })
    expect(html).toContain('<dd>None</dd>')
    expect(button(html, 'Assign agent to write scripts')).toEqual({ disabled: true })
    expect(html).toContain('Choose an assigned agent first (Edit).')
  })

  it('surfaces a busy action, an error and a notice on the card', () => {
    const html = card({ busy: 'run:s1', error: 'The scheduler is not running.', notice: 'Opened a tab with Claude · Opus.' })
    expect(html).toContain('Starting…')
    expect(html).toContain('role="alert"')
    expect(html).toContain('The scheduler is not running.')
    expect(html).toContain('Opened a tab with Claude · Opus.')
    expect(button(html, 'Edit')).toEqual({ disabled: true })
  })

  it('renders the edit form in place of the card body', () => {
    const html = card({ editing: true })
    expect(html).toContain('Edit task')
    expect(html).toContain('value="Watch llama.cpp releases"')
    expect(button(html, 'Run now')).toBeNull()
  })

  it('shows the last result then the older runs as history', () => {
    const runs = [runFixture({ id: 'r3', startedAt: at(-HOUR), finishedAt: at(-HOUR + 3_000), outcome: 'changed', detail: 'New release b6001.' }), runFixture({ id: 'r2', detail: 'No new release.' }), runFixture({ id: 'r1', startedAt: at(-2 * DAY), outcome: 'failed', detail: 'fetch failed\nstack…' })]
    const html = card({ runs })
    expect(html).toContain('Last result')
    expect(html).toContain('New release b6001.')
    expect(html).toContain('History')
    expect(html).toContain('fetch failed')
    expect(html.indexOf('New release b6001.')).toBeLessThan(html.indexOf('History'))
  })
})

describe('ScheduleRunView', () => {
  const props = { agents: AGENTS, now: NOW, busy: '', onOpenArtifact: noop, onOpenConversation: noop }

  it('lays out script results, the local summary and the agent review with their evidence', () => {
    const html = renderToStaticMarkup(createElement(ScheduleRunView, { ...props, run: runFixture({
      outcome: 'dispatched', trigger: 'manual', detail: 'A new CUDA build landed: b6001.', artifactPath: 'C:/evidence/r1.json',
      scripts: [
        { name: 'fetch-releases', status: 'ok', exitCode: 0, durationMs: 850, outputDigest: 'd1', changed: true, excerpt: 'b6001' },
        { name: 'run-tests', status: 'timeout', exitCode: null, durationMs: 120_000, outputDigest: null, changed: false, excerpt: '', error: 'Timed out after 120 s' }
      ],
      churn: { provider: 'local', model: 'qwen3.6-35b', ok: true },
      brain: { provider: 'claude', model: 'opus', ok: true, agentSessionId: 'sess-1', note: 'Answered in 1 request.' }
    }) }))
    expect(html).toContain('Sent to agent')
    expect(html).toContain('Run manually')
    expect(html).toContain('took 4.2 s')
    expect(html).toContain('fetch-releases')
    expect(html).toContain('changed')
    expect(html).toContain('exit 0')
    expect(html).toContain('850 ms')
    expect(html).toContain('Timed out')
    expect(html).toContain('Timed out after 120 s')
    expect(html).toContain('Local · Qwen 3.6 35B')
    expect(html).toContain('Claude · Opus')
    expect(html).toContain('Answered in 1 request.')
    expect(button(html, 'Open conversation')).toEqual({ disabled: false })
    expect(button(html, 'Open saved evidence')).toEqual({ disabled: false })
  })

  it('offers no conversation or evidence buttons when the run has none', () => {
    const html = renderToStaticMarkup(createElement(ScheduleRunView, { ...props, run: runFixture({ brain: { provider: 'codex', model: 'gpt-6', ok: false, note: 'Weekly limit reached.' } }) }))
    expect(html).toContain('No result')
    expect(html).toContain('Weekly limit reached.')
    expect(button(html, 'Open conversation')).toBeNull()
    expect(button(html, 'Open saved evidence')).toBeNull()
  })

  it('clamps a long detail behind Show more', () => {
    const html = renderToStaticMarkup(createElement(ScheduleRunView, { ...props, run: runFixture({ detail: Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n') }) }))
    expect(html).toContain('class="clamped"')
    expect(button(html, 'Show more')).toEqual({ disabled: false })
  })

  it('pages older runs in the history', () => {
    const runs = Array.from({ length: 7 }, (_, index) => runFixture({ id: `r${index}`, detail: `Run ${index}` }))
    const html = renderToStaticMarkup(createElement(ScheduleRunHistory, { ...props, runs }))
    expect(html).toContain('Run 4')
    expect(html).not.toContain('Run 5')
    expect(button(html, 'Show 2 older')).toEqual({ disabled: false })
  })
})

describe('ScheduleScripts', () => {
  const props = { schedule: scheduleFixture(), busy: '', assignBlocked: '', onAssign: noop, onDeleteScript: noop }

  it('explains the empty state and offers the assignment', () => {
    const html = renderToStaticMarkup(createElement(ScheduleScripts, { ...props, scripts: [] }))
    expect(html).toContain('none yet')
    expect(html).toContain('writes this task’s scripts through app control')
    expect(button(html, 'Assign agent to write scripts')).toEqual({ disabled: false })
  })

  it('lists scripts in order with their code, deletable unless Conductor owns them', () => {
    const html = renderToStaticMarkup(createElement(ScheduleScripts, { ...props, scripts: [
      scriptFixture({ name: 'run-tests', order: 1, runWhen: 'changed', language: 'powershell' }),
      scriptFixture({ name: 'catalog', order: 0, origin: 'conductor', author: { kind: 'conductor' } })
    ] }))
    expect(html.indexOf('catalog')).toBeLessThan(html.indexOf('run-tests'))
    expect(html).toContain('only after a change')
    expect(html).toContain('Agent · Release watcher')
    expect(html).toContain('View code')
    expect(html).toContain('api.github.com')
    expect(html).toContain('aria-label="Delete script run-tests"')
    expect(html).not.toContain('aria-label="Delete script catalog"')
  })
})

describe('ScheduleTaskForm', () => {
  const props = { agents: AGENTS, busy: false, error: '', onSubmit: noop, onCancel: noop }

  it('opens a new task on the first cloud agent with its effort choices', () => {
    const html = renderToStaticMarkup(createElement(ScheduleTaskForm, props))
    expect(html).toContain('New scheduled task')
    expect(html).toMatch(/<option value="claude" selected="">Claude<\/option>/)
    expect(html).toContain('Effort')
    expect(html).toContain('>daily<')
    expect(html).toContain('Review changes with the assigned agent')
    expect(html).not.toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*aria-describedby/)
    expect(button(html, 'Create task')).toEqual({ disabled: false })
    expect(html).not.toContain('grok')
  })

  it('disables review for a local agent and keeps an unavailable provider visible', () => {
    const local = renderToStaticMarkup(createElement(ScheduleTaskForm, { ...props, schedule: scheduleFixture({ agent: { provider: 'local', model: 'qwen3.6-35b' }, brain: false }) }))
    expect(local).toContain('A local agent does not review')
    expect(local).toMatch(/<input type="checkbox" disabled=""/)
    const grok = renderToStaticMarkup(createElement(ScheduleTaskForm, { ...props, schedule: scheduleFixture({ agent: { provider: 'grok', model: 'grok-5' } }) }))
    expect(grok).toContain('Grok (not available)')
  })

  it('badges a built-in task and shows a save error', () => {
    const html = renderToStaticMarkup(createElement(ScheduleTaskForm, { ...props, error: 'Name already used', schedule: scheduleFixture({ kind: 'latest-models-methods', everyMinutes: 360 }) }))
    expect(html).toContain('Built-in')
    expect(html).toContain('value="6"')
    expect(html).toMatch(/<option value="hours" selected="">hours<\/option>/)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Name already used')
  })
})

describe('SchedulerStatus', () => {
  it('says what due work is waiting for, with its signals', () => {
    const html = renderToStaticMarkup(createElement(SchedulerStatus, { now: NOW, running: null, runningName: '', gate: {
      allowed: false, reason: 'You are using this computer', signals: ['owner idle 0 min', 'CPU 64% (blender.exe)'], checkedAt: at(-MIN), retryAt: at(5 * MIN)
    } }))
    expect(html).toContain('Waiting: You are using this computer')
    expect(html).toContain('CPU 64% (blender.exe)')
    expect(html).toContain('looks again in 5 min')
  })

  it('reports a running task first and before any check says so', () => {
    const running = renderToStaticMarkup(createElement(SchedulerStatus, { now: NOW, runningName: 'Watch releases', running: { scheduleId: 's1', runId: 'r1', startedAt: at(-MIN) }, gate: {
      allowed: true, reason: 'Night window and the computer is idle', signals: [], checkedAt: at(-MIN), retryAt: null
    } }))
    expect(running).toContain('Running “Watch releases”')
    expect(running).toContain('Ready: Night window and the computer is idle')
    const unchecked = renderToStaticMarkup(createElement(SchedulerStatus, { now: NOW, running: null, runningName: '', gate: null }))
    expect(unchecked).toContain('Scheduler: not checked yet')
  })
})
