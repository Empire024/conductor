import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DurableJob, DurableJobCheckpoint, DurableJobEvent, DurableJobReport, DurableJobsService, DurableJobStage } from '../../shared/durable-jobs'
import { checkpointsFromEvents } from '../../shared/durable-jobs-bridge'

/**
 * The final report of a durable job: a short factual account written beside the job's logs as
 * report.json and report.md. It names paths, never pastes log contents, and says a cloud model
 * was involved only when the job recorded one. Built from what the controller persisted (job,
 * stages, events, checkpoints), so it can be regenerated at any time, including for a job that
 * is still running or blocked.
 */

type JobWithStages = DurableJob & { stages: DurableJobStage[] }

/** One line of evidence, never a log: long messages are cut rather than carried into the report. */
const line = (value: string, maximum = 300): string => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > maximum ? flat.slice(0, maximum - 1) + '…' : flat
}
const unique = (values: Iterable<string>): string[] => [...new Set([...values].filter(Boolean))]

const TEST_OUTCOME = /^(.*?)\s*(?:[:=→-]|—)\s*(pass(?:ed)?|ok|fail(?:ed|ure)?|not[- ]run|skipped)\b(.*)$/i

/** A handoff test line such as "npx vitest run — passed (42 tests)" or "npm test: fail". */
export function parseTestResult(value: string): DurableJobReport['tests'][number] {
  const match = TEST_OUTCOME.exec(value.trim())
  if (!match) return { command: line(value, 200), outcome: 'not-run', detail: 'Outcome not recorded' }
  const word = match[2]!.toLowerCase()
  const outcome = word.startsWith('pass') || word === 'ok' ? 'pass' : word.startsWith('fail') ? 'fail' : 'not-run'
  const detail = match[3]!.replace(/^[\s,;:()-]+|[\s)]+$/g, '')
  return { command: line(match[1]!, 200), outcome, ...(detail ? { detail: line(detail, 200) } : {}) }
}

const testFromEvent = (event: DurableJobEvent): DurableJobReport['tests'][number] | null => {
  const test = event.data?.test as { command?: unknown; outcome?: unknown; detail?: unknown } | undefined
  if (!test || typeof test.command !== 'string') return null
  const outcome = test.outcome === 'pass' || test.outcome === 'fail' ? test.outcome : 'not-run'
  return { command: line(test.command, 200), outcome, ...(typeof test.detail === 'string' && test.detail ? { detail: line(test.detail, 200) } : {}) }
}

export interface BuildReportInput {
  job: JobWithStages
  events: readonly DurableJobEvent[]
  /** Checkpoints from the store when it offers them; otherwise read back from checkpoint events. */
  checkpoints?: readonly DurableJobCheckpoint[]
  now?: number
}

export function buildDurableJobReport({ job, events, checkpoints, now = Date.now() }: BuildReportInput): DurableJobReport {
  const stages = [...job.stages].sort((a, b) => a.index - b.index)
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now
  const elapsedMs = job.startedAt ? Math.max(0, end - Date.parse(job.startedAt)) : 0

  const results = stages.flatMap(stage => {
    if (stage.result) return [`${stage.title}: ${line(stage.result)}`]
    if (stage.status === 'failed' && stage.error) return [`${stage.title}: failed — ${line(stage.error)}`]
    if (stage.status === 'skipped') return [`${stage.title}: skipped`]
    return []
  })
  if (job.statusReason && !['completed'].includes(job.status)) results.push(`Job ${job.status}: ${line(job.statusReason)}`)

  const tests = new Map<string, DurableJobReport['tests'][number]>()
  for (const value of job.handoff.testResults) { const test = parseTestResult(value); tests.set(test.command, test) }
  // A structured test event is more precise than a handoff line about the same command.
  for (const event of events) { const test = testFromEvent(event); if (test) tests.set(test.command, test) }

  const recorded = checkpoints?.length ? [...checkpoints] : checkpointsFromEvents(events)
  const recoveries = events
    .filter(event => event.kind === 'recovery' || event.kind === 'loop-detected' || event.kind === 'server' && event.data?.recovered === true)
    .map(event => ({ at: event.at, message: line(event.message) }))

  const escalations = events.filter(event => event.kind === 'escalation' && event.data?.occurred === true)
  const occurred = job.counters.cloudEscalations > 0 || escalations.length > 0
  const cloudEscalation: DurableJobReport['cloudEscalation'] = occurred
    ? { occurred: true, detail: escalations.length ? escalations.map(event => line(event.message, 200)).join('; ') : `${job.counters.cloudEscalations} recorded escalation(s)` }
    : { occurred: false }

  const remainingWork = unique([
    ...job.handoff.unresolvedIssues.map(value => line(value)),
    ...stages.filter(stage => stage.status === 'pending' || stage.status === 'running' || stage.status === 'failed').map(stage => `Stage ${stage.index + 1} “${stage.title}” is ${stage.status}`),
    ...(job.status !== 'completed' && job.handoff.nextAction ? [`Next action: ${line(job.handoff.nextAction)}`] : [])
  ])

  const logPaths = unique([
    job.logDir,
    ...job.handoff.artifacts.filter(artifact => artifact.kind === 'log').map(artifact => artifact.path),
    ...stages.flatMap(stage => stage.inputs.filter(artifact => artifact.kind === 'log').map(artifact => artifact.path)),
    ...recorded.flatMap(checkpoint => checkpoint.artifacts.filter(artifact => artifact.kind === 'log').map(artifact => artifact.path))
  ])

  return {
    jobId: job.id,
    status: job.status,
    elapsedMs,
    activeMs: job.activeMs,
    modelsByStage: stages.filter(stage => stage.attempt > 0 || stage.model).map(stage => ({ stage: stage.title, model: stage.model ?? job.model.model, attempts: stage.attempt })),
    filesChanged: unique(job.handoff.filesChanged),
    results,
    tests: [...tests.values()],
    checkpoints: recorded.map(checkpoint => ({ id: checkpoint.id, createdAt: checkpoint.createdAt, ...(checkpoint.commit ? { commit: checkpoint.commit } : {}), reason: line(checkpoint.reason, 200) })),
    recoveries,
    remainingWork,
    cloudEscalation,
    logPaths,
    generatedAt: new Date(now).toISOString()
  }
}

export const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60)
  if (hours) return `${hours} h ${minutes} min`
  if (minutes) return `${minutes} min ${seconds % 60} s`
  return `${seconds} s`
}

export function renderDurableJobReportMarkdown(report: DurableJobReport, job: Pick<DurableJob, 'title' | 'objective' | 'model' | 'statusReason' | 'worktree' | 'cwd'>): string {
  const list = (items: string[], empty: string): string => items.length ? items.map(item => `- ${item}`).join('\n') : `- ${empty}`
  return [
    `# ${job.title}`,
    '',
    `- Status: **${report.status}**${job.statusReason ? ` — ${line(job.statusReason)}` : ''}`,
    `- Elapsed: ${formatDuration(report.elapsedMs)} (active ${formatDuration(report.activeMs)})`,
    `- Local model: ${job.model.model}`,
    `- Cloud escalation: ${report.cloudEscalation.occurred ? `yes — ${report.cloudEscalation.detail ?? 'recorded'}` : 'none'}`,
    `- Working directory: ${job.worktree ? `${job.worktree.path} (branch ${job.worktree.branch}, base ${job.worktree.baseCommit.slice(0, 12)})` : job.cwd}`,
    `- Generated: ${report.generatedAt}`,
    '',
    '## Objective',
    '',
    line(job.objective, 2000),
    '',
    '## Results',
    '',
    list(report.results, 'No stage recorded a result.'),
    '',
    '## Models by stage',
    '',
    list(report.modelsByStage.map(entry => `${entry.stage}: ${entry.model} (${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'})`), 'No stage has run.'),
    '',
    '## Files changed',
    '',
    list(report.filesChanged.map(path => `\`${path}\``), 'None recorded.'),
    '',
    '## Tests',
    '',
    list(report.tests.map(test => `${test.outcome.toUpperCase()} \`${test.command}\`${test.detail ? ` — ${test.detail}` : ''}`), 'No test results recorded.'),
    '',
    '## Checkpoints',
    '',
    list(report.checkpoints.map(checkpoint => `${checkpoint.createdAt} ${checkpoint.commit ? `\`${checkpoint.commit.slice(0, 12)}\` ` : ''}${checkpoint.reason}`), 'None.'),
    '',
    '## Recoveries',
    '',
    list(report.recoveries.map(recovery => `${recovery.at} ${recovery.message}`), 'None.'),
    '',
    '## Remaining work',
    '',
    list(report.remainingWork, 'None.'),
    '',
    '## Logs',
    '',
    list(report.logPaths.map(path => `\`${path}\``), 'None.'),
    ''
  ].join('\n')
}

const writeAtomic = (path: string, content: string): void => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, path)
}

/** Writes report.json and report.md into job.logDir and returns the report with the Markdown path. */
export function writeDurableJobReport(report: DurableJobReport, job: JobWithStages): DurableJobReport & { reportPath: string } {
  mkdirSync(job.logDir, { recursive: true })
  const reportPath = join(job.logDir, 'report.md'), jsonPath = join(job.logDir, 'report.json')
  const withFiles: DurableJobReport = { ...report, logPaths: unique([...report.logPaths, jsonPath, reportPath]) }
  writeAtomic(jsonPath, JSON.stringify(withFiles, null, 2) + '\n')
  writeAtomic(reportPath, renderDurableJobReportMarkdown(withFiles, job))
  return { ...withFiles, reportPath }
}

/**
 * Reads every event oldest-forward. A single events() call is capped, so a short page is not the
 * end: the read stops only when the next page is empty. A page with no id, or a cursor that does
 * not move past one already seen, throws instead of returning a partial history.
 */
export function collectDurableJobEvents(read: (afterId?: string, limit?: number) => readonly DurableJobEvent[], pageSize = 500): DurableJobEvent[] {
  const size = Math.max(1, Math.floor(pageSize))
  const events: DurableJobEvent[] = []
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = read(after, size)
    if (page.length === 0) return events
    const cursor = page[page.length - 1]?.id
    if (!cursor) throw new Error('Durable job event page is missing an id')
    if (cursor === after || seen.has(cursor)) throw new Error('Durable job event page did not advance')
    seen.add(cursor)
    events.push(...page)
    after = cursor
  }
}

/**
 * The whole path for a job the service knows: read it, build, write. The service's own report()
 * may call this with its store's checkpoints; the control protocol and IPC call service.report().
 */
export function generateDurableJobReport(service: Pick<DurableJobsService, 'get' | 'events'> & Partial<Pick<DurableJobsService, 'checkpoints'>>, jobId: string, options: { checkpoints?: readonly DurableJobCheckpoint[]; now?: number } = {}): DurableJobReport & { reportPath: string } {
  const job = service.get(jobId)
  const events = collectDurableJobEvents((after, limit) => service.events(jobId, after, limit))
  return writeDurableJobReport(buildDurableJobReport({ job, events, checkpoints: options.checkpoints ?? service.checkpoints?.(jobId), now: options.now }), job)
}
