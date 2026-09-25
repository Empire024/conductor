import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FakeDurableJobsService } from '../../../shared/durable-jobs-fake'
import { checkpointsFromEvents, type DurableJobDetail } from '../../../shared/durable-jobs-bridge'
import { DurableJobCreateForm, DurableJobLauncherOption, DurableJobList, DurableJobView, elapsedMs, formatDuration, jobControls, problems, type DurableJobViewProps } from './DurableJobsPane'

const T0 = Date.parse('2026-09-24T21:00:00.000Z')
const noop = (): void => {}

/** The renderer story: an overnight job driven through the fake service the way the controller would. */
async function overnight() {
  let clock = T0
  const service = new FakeDurableJobsService({ now: () => clock, logRoot: 'C:/Users/owner/AppData/Roaming/Conductor/jobs' })
  const created = await service.create({ projectId: 'p1', title: 'Fix invoice parser', objective: 'Accept Fio exports', model: 'local/qwen3.6-35b-a3b',
    stages: [{ title: 'Reproduce', objective: 'r', completionCriteria: [] }, { title: 'Fix', objective: 'f', completionCriteria: [] }, { title: 'Document', objective: 'd', completionCriteria: [] }] })
  service.setStatus(created.id, 'running')
  service.advance(created.id, { status: 'running' })
  clock += 40 * 60_000
  service.advance(created.id, { status: 'completed', result: 'Failing test added', activeMs: 40 * 60_000 })
  service.checkpoint(created.id, { reason: 'Reproduced', commit: '0123456789abcdef0123', artifacts: [] })
  service.advance(created.id, { status: 'running' })
  service.record(created.id, 'server', 'llama-server stopped answering; restarted', { recovered: true })
  service.record(created.id, 'recovery', 'Resumed Fix from checkpoint')
  service.advance(created.id, { retry: true })
  clock += 20 * 60_000
  const detail = (): DurableJobDetail => {
    const events = service.events(created.id)
    return { job: service.get(created.id), summary: service.status(created.id), events, checkpoints: checkpointsFromEvents(events) }
  }
  return { service, id: created.id, detail, now: () => clock, tick: (minutes: number) => { clock += minutes * 60_000 } }
}

const render = (props: Partial<DurableJobViewProps> & Pick<DurableJobViewProps, 'detail' | 'now'>): string => renderToStaticMarkup(createElement(DurableJobView, {
  busy: '', error: '', report: null, onPause: noop, onResume: noop, onCancel: noop, onReport: noop, onReveal: noop, ...props
}))

describe('durable job view', () => {
  it('shows status, elapsed and active time, stage and attempt, milestones, checkpoints, models, retries and recoveries', async () => {
    const story = await overnight()
    const html = render({ detail: story.detail(), now: story.now() })
    expect(html).toContain(`data-job-id="${story.id}"`)
    expect(html).toContain('data-status="running"')
    expect(html).toContain('>1 h 00 min<')
    expect(html).toContain('>40 min 00 s<')
    expect(html).toContain('2/3 Fix · attempt 2/3')
    expect(html).toContain('Failing test added')
    expect(html).toContain('0123456789')
    expect(html).toContain('local/qwen3.6-35b-a3b')
    expect(html).toMatch(/data-fact="retries">1 \(max 3 attempts a stage\)/)
    expect(html).toContain('llama-server stopped answering; restarted')
    expect(html).toContain('Resumed Fix from checkpoint')
    expect(html).toContain('C:/Users/owner/AppData/Roaming/Conductor/jobs/' + story.id)
    expect(html).toContain('data-fact="escalation">none')
  })

  it('offers only the controls the contract allows for each status', async () => {
    expect(jobControls('running')).toEqual({ pause: true, resume: false, cancel: true })
    expect(jobControls('paused')).toEqual({ pause: false, resume: true, cancel: true })
    expect(jobControls('blocked')).toEqual({ pause: false, resume: true, cancel: true })
    expect(jobControls('completed')).toEqual({ pause: false, resume: false, cancel: false })
    const story = await overnight()
    story.service.setStatus(story.id, 'blocked', 'Needs approval to run npm install')
    const html = render({ detail: story.detail(), now: story.now() })
    expect(html).toContain('Needs approval to run npm install')
    expect(html).toMatch(/<button type="button" disabled=""><svg[^>]*>.*?<\/svg>Pause<\/button>/)
    expect(html).toMatch(/<button type="button"><svg[^>]*>.*?<\/svg>Resume<\/button>/)
    expect(html).toContain('Write report')
  })

  it('stops the clock when the job finishes and lists errors newest first', async () => {
    const story = await overnight()
    story.service.advance(story.id, { status: 'failed', error: 'Tests still fail after 3 attempts' })
    story.service.setStatus(story.id, 'failed', 'Stage attempts exhausted')
    const finished = story.detail()
    story.tick(120)
    expect(elapsedMs(finished.job, story.now())).toBe(60 * 60_000)
    const issues = problems(finished.job.stages, finished.events)
    expect(issues[0]!.message).toBe('Fix: Tests still fail after 3 attempts')
    expect(issues.map(issue => issue.kind)).toEqual(expect.arrayContaining(['retry', 'recovery', 'server']))
  })

  it('lists jobs with their stage and marks the selected one, and the create form offers local models only', async () => {
    const story = await overnight()
    const list = renderToStaticMarkup(createElement(DurableJobList, { jobs: story.service.list(), selected: story.id, now: story.now(), onSelect: noop }))
    expect(list).toContain('class="active"')
    expect(list).toContain('Fix · attempt 2')
    expect(renderToStaticMarkup(createElement(DurableJobList, { jobs: [], selected: null, now: 0, onSelect: noop }))).toContain('No durable jobs')
    const form = renderToStaticMarkup(createElement(DurableJobCreateForm, { models: [{ id: 'local/qwen3.5-9b', label: 'Qwen 9B' }, { id: 'local/qwen3.6-35b-a3b', label: 'Qwen 35B' }], busy: false, onCreate: noop }))
    expect(form).toContain('<option value="local/qwen3.6-35b-a3b" selected="">Qwen 35B</option>')
    expect(renderToStaticMarkup(createElement(DurableJobCreateForm, { models: [], busy: false, onCreate: noop }))).toContain('No local model is configured')
  })

  it('formats durations compactly', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(65_000)).toBe('1 min 05 s')
    expect(formatDuration(8 * 3_600_000 + 7 * 60_000)).toBe('8 h 07 min')
  })

  it('offers durable execution collapsed behind a toggle, not a bare disclosure', () => {
    const html = renderToStaticMarkup(createElement(DurableJobLauncherOption, {
      model: { id: 'local/qwen3.6-35b-a3b', label: 'Qwen 35B' }, busy: false, onCreate: noop
    }))
    expect(html).toContain('Run as durable job')
    expect(html).toContain('staged, resumable, overnight')
    expect(html).not.toContain('<details')
    // Collapsed by default: the form (and its fixed model) is not in the markup until opened.
    expect(html).not.toContain('Job objective')
  })
})
