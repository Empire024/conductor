import { existsSync } from 'node:fs'
import { ipcMain } from 'electron'
import type { DurableJobsService, DurableJobStatus, DurableJobSummary } from '../shared/durable-jobs'
import { DURABLE_JOB_STATUSES } from '../shared/durable-jobs'
import { checkpointsFromEvents, DURABLE_JOB_CHANNELS, type DurableJobDetail, type DurableJobsBridge } from '../shared/durable-jobs-bridge'

type CreateRequest = Parameters<DurableJobsBridge['create']>[0]
const channels = Object.values(DURABLE_JOB_CHANNELS).filter(channel => channel !== DURABLE_JOB_CHANNELS.changed)

const text = (value: unknown, key: string, maximum: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new Error(`Invalid ${key}`)
  return value
}

/**
 * The owner's window reaching the durable job service. Every call names its project and is
 * authorized for it (the same trusted-window check the other panes use); a job of another
 * project reads as missing. The window creates jobs only on a local model — the renderer offers
 * nothing else, and main checks it again against the configured local models.
 */
export function registerDurableJobsIpc(options: {
  service: DurableJobsService
  authorize(event: Electron.IpcMainInvokeEvent, projectId: string): void
  /** The exact local model ids the owner may choose (models.list local entries). */
  localModels(): string[]
  /** Sends a changed summary to every window. */
  publish(channel: string, payload: unknown): void
  reveal(path: string): void
}): () => void {
  const service = (): DurableJobsService => options.service
  const owned = (projectId: string, jobId: unknown): DurableJobSummary => {
    const id = text(jobId, 'jobId', 160)
    let summary: DurableJobSummary
    try { summary = service().status(id) } catch { throw new Error('No durable job with that id in this project') }
    if (summary.projectId !== projectId) throw new Error('No durable job with that id in this project')
    return summary
  }
  const handle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, projectId: string, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (event, projectId: string, ...args: unknown[]) => { options.authorize(event, projectId); return listener(event, projectId, ...args) })
  }

  handle(DURABLE_JOB_CHANNELS.list, (_event, projectId, status?: DurableJobStatus[]) => {
    const filter = Array.isArray(status) ? status.filter(value => DURABLE_JOB_STATUSES.includes(value)) : undefined
    return service().list({ projectId, ...(filter?.length ? { status: filter } : {}) })
  })
  handle(DURABLE_JOB_CHANNELS.status, (_event, projectId, jobId) => owned(projectId, jobId))
  handle(DURABLE_JOB_CHANNELS.detail, (_event, projectId, jobId): DurableJobDetail => {
    const summary = owned(projectId, jobId)
    const jobs = service()
    // The view needs the recent tail plus every checkpoint; checkpoints come from the full stream.
    const events = []
    for (let after: string | undefined; ;) {
      const page = jobs.events(summary.id, after, 500)
      events.push(...page)
      if (page.length < 500 || events.length >= 20_000) break
      after = page[page.length - 1]!.id
    }
    return { job: jobs.get(summary.id), summary, events: events.slice(-200), checkpoints: jobs.checkpoints(summary.id) }
  })
  handle(DURABLE_JOB_CHANNELS.events, (_event, projectId, jobId, afterId?: string, limit?: number) => {
    const summary = owned(projectId, jobId)
    return service().events(summary.id, afterId === undefined ? undefined : text(afterId, 'afterId', 160), Math.min(Math.max(1, Number.isSafeInteger(limit) ? limit! : 100), 500))
  })
  handle(DURABLE_JOB_CHANNELS.create, (_event, projectId, request: CreateRequest) => {
    if (!request || request.projectId !== projectId) throw new Error('The job names another project')
    const model = text(request.model, 'model', 200)
    if (!options.localModels().includes(model)) throw new Error(`Durable jobs run on a local model only; ${model} is not one of the local models`)
    const constraints = Array.isArray(request.constraints) ? request.constraints.filter(item => typeof item === 'string' && item.trim()).slice(0, 50).map(item => item.slice(0, 2000)) : []
    const objective = text(request.objective, 'objective', 20000)
    return service().create({
      projectId, ...(typeof request.workspaceId === 'string' ? { workspaceId: request.workspaceId } : {}),
      title: typeof request.title === 'string' && request.title.trim() ? request.title.trim().slice(0, 120) : objective.replace(/\s+/g, ' ').trim().slice(0, 80),
      objective, model, ...(constraints.length ? { constraints } : {}),
      createdBy: { kind: 'owner', agentSessionId: 'owner', title: 'Owner (job view)' }
    })
  })
  handle(DURABLE_JOB_CHANNELS.pause, (_event, projectId, jobId, reason?: string) => service().pause(owned(projectId, jobId).id, typeof reason === 'string' ? reason.slice(0, 500) : undefined))
  handle(DURABLE_JOB_CHANNELS.resume, (_event, projectId, jobId) => service().resume(owned(projectId, jobId).id))
  handle(DURABLE_JOB_CHANNELS.cancel, (_event, projectId, jobId, reason?: string) => service().cancel(owned(projectId, jobId).id, typeof reason === 'string' ? reason.slice(0, 500) : undefined))
  handle(DURABLE_JOB_CHANNELS.report, (_event, projectId, jobId) => service().report(owned(projectId, jobId).id))
  handle(DURABLE_JOB_CHANNELS.reveal, (_event, projectId, jobId, target: 'logs' | 'report') => {
    const job = service().get(owned(projectId, jobId).id)
    const path = target === 'report' && job.reportPath && existsSync(job.reportPath) ? job.reportPath : job.logDir
    options.reveal(path)
  })

  const unsubscribe = options.service.onChange(summary => options.publish(DURABLE_JOB_CHANNELS.changed, summary))
  return () => {
    unsubscribe()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
