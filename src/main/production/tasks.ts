import type { CreateOrchestrationTaskInput, OrchestrationTask, OrchestrationTaskPriority, UpdateOrchestrationTaskInput } from '../../shared/orchestration'
import { CONTROL_TITLES, type Finding, type Severity } from '../../shared/production'
import type { ProductionStore } from './store'

/**
 * Fix tasks on the orchestration board (docs/production-agent.md sections 1 and 6): one task per
 * finding, tracked in `production_findings.task_id`. A finding that already has a live task keeps
 * it (dedup); one whose task was closed and that is open again gets that task reopened; a verified
 * fix closes its task. Creating or closing a task never changes a finding's status — only a verify
 * run does.
 */

/** What M8 adapts from OrchestrationStore (createTask, updateTask, and a lookup over listTasks). */
export interface FixTaskBoard {
  createTask(input: CreateOrchestrationTaskInput): OrchestrationTask
  updateTask(id: string, input: UpdateOrchestrationTaskInput): OrchestrationTask
  task(projectId: string, id: string): OrchestrationTask | null
}

export interface FixTaskOutcome { findingId: string; taskId: string; created: boolean; reopened: boolean }

const PRIORITY: Readonly<Record<Severity, OrchestrationTaskPriority>> = { critical: 'urgent', high: 'high', medium: 'normal', low: 'low', info: 'low' }
const CLOSED: readonly OrchestrationTask['status'][] = ['done', 'cancelled']
/** Findings the report step files automatically; medium and lower are filed only on request (createFixTasks). */
export const AUTO_TASK_SEVERITIES: readonly Severity[] = ['critical', 'high']
const OPEN: readonly Finding['status'][] = ['open', 'reopened', 'disputed']

export function taskTitle(finding: Finding): string {
  return `[${finding.controlId}] ${finding.title}`.slice(0, 300)
}

export function taskDescription(finding: Finding): string {
  return [
    `Production audit finding ${finding.id} (${finding.controlId} ${CONTROL_TITLES[finding.controlId]}, ${finding.category}, ${finding.severity}, ${finding.confidence}).`,
    finding.route ? `Where: ${finding.route}` : null,
    `Expected: ${finding.expected}`,
    `Observed: ${finding.observed}`,
    finding.reproduction.length ? `Reproduce:\n${finding.reproduction.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : null,
    finding.proposedFix ? `Proposed fix: ${finding.proposedFix}` : null,
    finding.legal ? `Legal sources: ${finding.legal.sources.map(source => `${source.title}${source.jurisdiction ? ` (${source.jurisdiction})` : ''}`).join('; ')}` : null,
    'When fixed, open a Verify run from the Production panel: only an independent verification marks the finding fixed.',
  ].filter((line): line is string => !!line).join('\n\n').slice(0, 20_000)
}

/** Ensures one live board task per finding; idempotent, so a resumed report step never duplicates a task. */
export function ensureFixTasks(store: ProductionStore, board: FixTaskBoard, projectId: string, findings: readonly Finding[]): FixTaskOutcome[] {
  const out: FixTaskOutcome[] = []
  for (const listed of findings) {
    const finding = store.finding(listed.id) ?? listed
    if (finding.projectId !== projectId) throw new Error(`Finding ${finding.id} is not a finding of ${projectId}`)
    const existing = finding.taskId ? board.task(projectId, finding.taskId) : null
    if (existing && !CLOSED.includes(existing.status)) { out.push({ findingId: finding.id, taskId: existing.id, created: false, reopened: false }); continue }
    if (existing && OPEN.includes(finding.status)) {
      const reopened = board.updateTask(existing.id, { status: 'ready', description: taskDescription(finding) })
      out.push({ findingId: finding.id, taskId: reopened.id, created: false, reopened: true })
      continue
    }
    if (existing) { out.push({ findingId: finding.id, taskId: existing.id, created: false, reopened: false }); continue }
    const task = board.createTask({ projectId, title: taskTitle(finding), description: taskDescription(finding), status: 'ready', priority: PRIORITY[finding.severity] })
    store.linkTask(finding.id, task.id)
    out.push({ findingId: finding.id, taskId: task.id, created: true, reopened: false })
  }
  return out
}

/** The findings the report step files: open, unwaived, critical or high. */
export function autoTaskFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter(finding => OPEN.includes(finding.status) && AUTO_TASK_SEVERITIES.includes(finding.severity))
}

/** A verified fix closes its task (the task never closes the finding). */
export function closeFixedTask(board: FixTaskBoard, finding: Finding): boolean {
  if (!finding.taskId || finding.status !== 'fixed') return false
  const task = board.task(finding.projectId, finding.taskId)
  if (!task || CLOSED.includes(task.status)) return false
  board.updateTask(task.id, { status: 'done' })
  return true
}

/** Whether the builder claims the finding fixed: its task was closed as done. */
export function claimedFixed(board: FixTaskBoard | null, finding: Finding): boolean {
  if (!board || !finding.taskId) return false
  return board.task(finding.projectId, finding.taskId)?.status === 'done'
}
