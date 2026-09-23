import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeDurableJobsService } from '../../shared/durable-jobs-fake'
import { buildDurableJobReport, generateDurableJobReport, parseTestResult, renderDurableJobReportMarkdown } from './report'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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
})
