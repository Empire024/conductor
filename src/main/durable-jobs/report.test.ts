import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DURABLE_JOB_BUDGETS, type DurableJob } from '../../shared/durable-jobs'
import { FakeDurableJobsService } from '../../shared/durable-jobs-fake'
import { DurableJobsServiceImpl } from './index'
import { buildDurableJobReport, collectDurableJobEvents, generateDurableJobReport, parseTestResult, renderDurableJobReportMarkdown } from './report'
import { DurableJobStore } from './store'
import { FakeRuntime, FakeWorktrees, tick, until } from './test-fakes'
import { reportPort } from './wiring'

const services: DurableJobsServiceImpl[] = []

const roots: string[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await new Promise(resolve => setTimeout(resolve, 30))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const T0 = Date.parse('2026-09-24T22:00:00.000Z')
function overnightJob() {
  let clock = T0
  const root = mkdtempSync(join(tmpdir(), 'conductor-job-report-'))
  roots.push(root)
  const service = new FakeDurableJobsService({ now: () => clock, logRoot: root })
  return { service, root, tick: (minutes: number) => { clock += minutes * 60_000 }, now: () => clock }
}

describe('durable job report', () => {
  it('reads test outcomes from handoff lines without inventing a pass', () => {
    expect(parseTestResult('npx vitest run src/foo — passed (42 tests)')).toEqual({ command: 'npx vitest run src/foo', outcome: 'pass', detail: '42 tests' })
    expect(parseTestResult('npm test: FAIL')).toEqual({ command: 'npm test', outcome: 'fail' })
    expect(parseTestResult('ran the linter')).toMatchObject({ outcome: 'not-run' })
  })

  it('writes a factual report.json and report.md with checkpoints, recoveries, models and log paths, never raw logs', async () => {
    const { service, root, tick, now } = overnightJob()
    const created = await service.create({ projectId: 'p1', title: 'Fix invoice parser', objective: 'Make the invoice parser accept Fio exports', model: 'local/qwen3.6-35b-a3b',
      stages: [{ title: 'Reproduce', objective: 'Reproduce the failure', completionCriteria: ['failing test'] }, { title: 'Fix', objective: 'Fix it', completionCriteria: ['tests pass'] }, { title: 'Document', objective: 'Docs', completionCriteria: ['docs'] }] })
    service.setStatus(created.id, 'running')
    service.advance(created.id, { status: 'running' })
    tick(30)
    service.advance(created.id, { status: 'completed', result: 'Failing test added in src/parser.test.ts', activeMs: 30 * 60_000 })
    service.checkpoint(created.id, { reason: 'Reproduced', commit: 'abcdef1234567890abcdef', artifacts: [{ path: join(root, 'stage-0.log'), kind: 'log' }] })
    service.advance(created.id, { status: 'running' })
    service.record(created.id, 'server', 'llama-server exited; restarted', { recovered: true })
    service.record(created.id, 'recovery', 'Resumed stage Fix after server restart')
    service.record(created.id, 'note', 'x'.repeat(5000))
    service.advance(created.id, { retry: true, model: 'local/qwen3.6-35b-a3b' })
    tick(60)
    service.mutate(created.id, job => {
      job.handoff.filesChanged = ['src/parser.ts', 'src/parser.test.ts', 'src/parser.ts']
      job.handoff.testResults = ['npx vitest run src/parser.test.ts — passed (12 tests)']
      job.handoff.unresolvedIssues = ['Headerless exports with a BOM are untested']
      job.handoff.nextAction = 'Write the docs stage'
      job.handoff.artifacts = [{ path: join(root, 'stage-1.log'), kind: 'log' }, { path: join(root, 'out.txt'), kind: 'output' }]
      job.activeMs += 60 * 60_000
    })
    service.record(created.id, 'note', 'Tests run', { test: { command: 'npm run typecheck', outcome: 'fail', detail: '2 errors' } })
    service.setStatus(created.id, 'blocked', 'Needs an approval to run npm install')

    const report = generateDurableJobReport(service, created.id, { now: now() })
    expect(report).toMatchObject({
      jobId: created.id, status: 'blocked', elapsedMs: 90 * 60_000, activeMs: 90 * 60_000,
      filesChanged: ['src/parser.ts', 'src/parser.test.ts'],
      cloudEscalation: { occurred: false },
      checkpoints: [{ commit: 'abcdef1234567890abcdef', reason: 'Reproduced' }]
    })
    expect(report.modelsByStage).toEqual([{ stage: 'Reproduce', model: 'local/qwen3.6-35b-a3b', attempts: 1 }, { stage: 'Fix', model: 'local/qwen3.6-35b-a3b', attempts: 2 }])
    expect(report.tests).toEqual([{ command: 'npx vitest run src/parser.test.ts', outcome: 'pass', detail: '12 tests' }, { command: 'npm run typecheck', outcome: 'fail', detail: '2 errors' }])
    expect(report.recoveries.map(entry => entry.message)).toEqual(['llama-server exited; restarted', 'Resumed stage Fix after server restart'])
    expect(report.results).toContain('Reproduce: Failing test added in src/parser.test.ts')
    expect(report.results).toContain('Job blocked: Needs an approval to run npm install')
    expect(report.remainingWork).toEqual(expect.arrayContaining(['Headerless exports with a BOM are untested', 'Stage 2 “Fix” is running', 'Stage 3 “Document” is pending', 'Next action: Write the docs stage']))
    const job = service.get(created.id)
    expect(report.logPaths).toEqual(expect.arrayContaining([job.logDir, join(root, 'stage-0.log'), join(root, 'stage-1.log'), join(job.logDir, 'report.json'), join(job.logDir, 'report.md')]))
    expect(report.logPaths).not.toContain(join(root, 'out.txt'))
    expect(report.reportPath).toBe(join(job.logDir, 'report.md'))

    const json = JSON.parse(readFileSync(join(job.logDir, 'report.json'), 'utf8'))
    expect(json).toMatchObject({ jobId: created.id, status: 'blocked' })
    const markdown = readFileSync(report.reportPath, 'utf8')
    expect(markdown).toContain('Status: **blocked** — Needs an approval to run npm install')
    expect(markdown).toContain('Elapsed: 1 h 30 min (active 1 h 30 min)')
    expect(markdown).toContain('Cloud escalation: none')
    expect(markdown).toContain('`abcdef123456` Reproduced')
    expect(markdown).not.toContain('x'.repeat(400))
    expect(existsSync(join(job.logDir, 'report.json.' + process.pid + '.tmp'))).toBe(false)
  })

  it('reports a cloud escalation only when one was recorded', async () => {
    const { service, now } = overnightJob()
    const created = await service.create({ projectId: 'p1', title: 'T', objective: 'O', model: 'local/qwen' })
    service.record(created.id, 'escalation', 'Blocked; the owner may hand this to a cloud model', { occurred: false })
    const quiet = buildDurableJobReport({ job: service.get(created.id), events: service.events(created.id), now: now() })
    expect(quiet.cloudEscalation).toEqual({ occurred: false })
    service.record(created.id, 'escalation', 'Owner handed stage 2 to Claude Opus', { occurred: true })
    const loud = buildDurableJobReport({ job: service.get(created.id), events: service.events(created.id), now: now() })
    expect(loud.cloudEscalation).toEqual({ occurred: true, detail: 'Owner handed stage 2 to Claude Opus' })
    expect(renderDurableJobReportMarkdown(loud, service.get(created.id))).toContain('Cloud escalation: yes — Owner handed stage 2 to Claude Opus')
  })

  it('prefers the store checkpoints when given and reports a queued job with zero elapsed time', async () => {
    const { service, now } = overnightJob()
    const created = await service.create({ projectId: 'p1', title: 'T', objective: 'O', model: 'local/qwen' })
    const report = buildDurableJobReport({ job: service.get(created.id), events: service.events(created.id), checkpoints: [{ id: 'c1', jobId: created.id, createdAt: '2026-09-24T22:05:00.000Z', reason: 'Before broad edit', artifacts: [] }], now: now() })
    expect(report.elapsedMs).toBe(0)
    expect(report.checkpoints).toEqual([{ id: 'c1', createdAt: '2026-09-24T22:05:00.000Z', reason: 'Before broad edit' }])
    expect(report.modelsByStage).toEqual([])
  })

  it('pages until an empty page, including a history that fills its pages exactly', () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => ({ id: `e${index}`, jobId: 'job', at: '2026-09-24T00:00:00.000Z', kind: 'note' as const, message: `n${index}` }))
    const read = (after?: string, limit = 500) => {
      const start = after ? rows.findIndex(event => event.id === after) + 1 : 0
      return rows.slice(start, start + limit)
    }
    expect(collectDurableJobEvents(read).map(event => event.id)).toEqual(rows.map(event => event.id))
    expect(collectDurableJobEvents(read, 500).at(-1)?.id).toBe('e999')
    expect(collectDurableJobEvents(() => []).map(event => event.id)).toEqual([])
  })

  it('keeps reading when the reader returns fewer rows than requested', () => {
    const at = '2026-09-24T00:00:00.000Z'
    const stored: DurableJob = {
      id: 'job_cap', projectId: 'p', cwd: 'C:/work', title: 'Cap', objective: 'O', status: 'queued',
      model: { provider: 'local', model: 'local/qwen', escalation: 'never' }, budgets: DEFAULT_DURABLE_JOB_BUDGETS,
      handoff: { objective: 'O', constraints: [], decisions: [], workDone: [], filesChanged: [], testResults: [], unresolvedIssues: [], nextAction: '', artifacts: [], updatedAt: at },
      createdAt: at, updatedAt: at, activeMs: 0,
      counters: { stagesCompleted: 0, retries: 0, recoveries: 0, contextRollovers: 0, loopsDetected: 0, cloudEscalations: 0 },
      logDir: 'C:/logs/job_cap'
    }
    const store = new DurableJobStore(':memory:')
    store.create(stored, [], false)
    store.batch('job_cap', () => { for (let i = 0; i < 1_500; i++) store.event('job_cap', { owner: true }, 'note', `n${i}`) })
    const events = collectDurableJobEvents((after, limit) => store.events('job_cap', after, limit), 2_000)
    expect(store.events('job_cap', undefined, 2_000)).toHaveLength(1_000)
    expect(events).toHaveLength(1_501)
    expect(events[0]?.kind).toBe('transition')
    expect(events.at(-1)?.message).toBe('n1499')
    store.close()
  })

  it('throws when an event page has no id or does not advance', () => {
    const stuck = { id: 'e0', jobId: 'job', at: '2026-09-24T00:00:00.000Z', kind: 'note' as const, message: 'stuck' }
    expect(() => collectDurableJobEvents(() => [stuck], 10)).toThrow(/did not advance/)
    expect(() => collectDurableJobEvents(() => [{ ...stuck, id: '' }], 10)).toThrow(/missing an id/)
  })

  it('pages the service report through a history longer than 1000 events, keeping both ends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-job-report-')); roots.push(root)
    const store = new DurableJobStore(':memory:')
    const runtime = new FakeRuntime([{ kind: 'hang' }])
    const service = new DurableJobsServiceImpl({ store, runtime, worktrees: new FakeWorktrees(), logRoot: root, projectPath: () => root, sleep: tick, pollMs: 0, report: reportPort })
    services.push(service)
    const created = await service.create({ projectId: 'p1', title: 'Long history', objective: 'Keep every record', model: 'local/qwen' })
    await until(() => runtime.opened.length === 1)
    store.batch(created.id, () => {
      store.event(created.id, { owner: true }, 'recovery', 'EARLY-RECOVERY-MARKER')
      store.event(created.id, { owner: true }, 'escalation', 'not a cloud run', { occurred: false })
      for (let i = 0; i < 2_500; i++) {
        if (i === 1_250) store.event(created.id, { owner: true }, 'note', 'middle test', { test: { command: 'middle-suite', outcome: 'pass', detail: 'kept' } })
        else store.event(created.id, { owner: true }, 'note', `filler ${i}`)
      }
      store.event(created.id, { owner: true }, 'recovery', 'LATE-RECOVERY-MARKER')
      store.event(created.id, { owner: true }, 'escalation', 'LATE-CLOUD-MARKER', { occurred: true })
    })
    const head = service.events(created.id, undefined, 1_000)
    expect(head.some(event => event.message === 'EARLY-RECOVERY-MARKER')).toBe(true)
    expect(head.some(event => event.message === 'LATE-RECOVERY-MARKER' || event.message === 'middle test')).toBe(false)
    const report = await service.report(created.id)
    expect(report.recoveries.map(entry => entry.message)).toEqual(['EARLY-RECOVERY-MARKER', 'LATE-RECOVERY-MARKER'])
    expect(report.tests).toEqual(expect.arrayContaining([{ command: 'middle-suite', outcome: 'pass', detail: 'kept' }]))
    expect(report.cloudEscalation).toEqual({ occurred: true, detail: 'LATE-CLOUD-MARKER' })
    const markdown = readFileSync(report.reportPath, 'utf8')
    expect(markdown).toContain('EARLY-RECOVERY-MARKER')
    expect(markdown).toContain('LATE-RECOVERY-MARKER')
    expect(markdown).toContain('middle-suite')
    expect(markdown).toContain('LATE-CLOUD-MARKER')
  })

  it('keeps a bearer token, an API key and a control credential out of jobs.report, report.json and report.md, even from rows written before redaction', async () => {
    const BEARER = 'Zq8vT3kLm9Wx2Rb7Np4Hs6Jd', API_KEY = 'sk-proj-4f9QzX2mL8kV7nB3cR6tY1wP', CONTROL = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const planted = `curl -H "Authorization: Bearer ${BEARER}" --api-key ${API_KEY} -d '{"token":"${CONTROL}"}'`
    const root = mkdtempSync(join(tmpdir(), 'conductor-job-report-redact-'))
    roots.push(root)
    const db = new DatabaseSync(':memory:')
    const store = new DurableJobStore(db)
    const runtime = new FakeRuntime([{ kind: 'hang' }])
    const service = new DurableJobsServiceImpl({ store, runtime, worktrees: new FakeWorktrees(), logRoot: root, projectPath: () => root, sleep: tick, pollMs: 0, report: reportPort })
    services.push(service)
    const created = await service.create({ projectId: 'p1', title: 'Probe the API', objective: 'Find why the upload is refused', model: 'local/qwen' })
    await until(() => runtime.opened.length === 1)
    // Through the store: redacted as it is written.
    store.event(created.id, { owner: true }, 'recovery', `Recovered after ${planted}`)
    store.event(created.id, { owner: true }, 'note', 'Test fail', { test: { command: planted, outcome: 'fail', detail: planted } })
    // Rows a build without redaction wrote: the report must still not carry them.
    db.prepare("UPDATE durable_jobs SET data = json_set(data, '$.statusReason', ?, '$.handoff.nextAction', ?, '$.handoff.unresolvedIssues', json_array(?), '$.handoff.testResults', json_array(?)) WHERE id = ?").run(`Waiting: ${planted}`, `Next: ${planted}`, `Issue: ${planted}`, `fail: ${planted}`, created.id)
    db.prepare("UPDATE durable_job_stages SET data = json_set(data, '$.result', ?) WHERE job_id = ?").run(`Answer: ${planted}`, created.id)
    const legacy = (kind: string, message: string, data: Record<string, unknown>) => db.prepare('INSERT INTO durable_job_events (id, job_id, at, kind, data) VALUES (?, ?, ?, ?, ?)').run(`legacy_${kind}`, created.id, '2026-09-24T23:00:00.000Z', kind, JSON.stringify({ id: `legacy_${kind}`, jobId: created.id, at: '2026-09-24T23:00:00.000Z', kind, message, data }))
    legacy('recovery', `Legacy recovery ${planted}`, {})
    legacy('escalation', `Legacy escalation ${planted}`, { occurred: true })
    legacy('note', 'Legacy test', { test: { command: `legacy ${planted}`, outcome: 'pass', detail: planted } })
    const report = await service.report(created.id)
    const outputs = { 'jobs.report': JSON.stringify(report), 'report.json': readFileSync(report.reportPath.replace(/report\.md$/, 'report.json'), 'utf8'), 'report.md': readFileSync(report.reportPath, 'utf8') }
    for (const [name, text] of Object.entries(outputs)) for (const secret of [BEARER, API_KEY, '4f9QzX2mL8kV7nB3cR6tY1wP', CONTROL]) expect(text, `${name} leaks ${secret}`).not.toContain(secret)
    // Redacted, not dropped: the evidence around the credential stays.
    expect(outputs['report.md']).toContain('Legacy recovery curl -H "Authorization: [redacted]')
    expect(report.cloudEscalation.occurred).toBe(true)
    expect(report.remainingWork.some(entry => entry.startsWith('Next action: Next: curl'))).toBe(true)
  })
})
