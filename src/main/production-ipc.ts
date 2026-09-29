import { ipcMain } from 'electron'
import {
  PRODUCTION_IPC as channel,
  type AuditRequest, type ProductionRunSummary, type ProfileUpdate, type ReviewAnswer, type WaiverRequest, type WriteAuthorizationRequest,
} from '../shared/production'
import { OWNER_ACTOR, type ProductionService } from './production/index'
import type { RunRequestOutcome } from './production/triggers'

/**
 * The Production panel's handlers (docs/production-agent.md section 9). The renderer is the owner's
 * window, so every call acts with owner authority, as the Schedules panel does; the only check is the
 * project check every renderer channel makes. Sovereign gating applies to control-method callers
 * (production/control.ts), not here.
 */
export function registerProductionIpc(options: {
  service: ProductionService
  /** The sender is this app's own window (every channel). */
  trusted(event: Electron.IpcMainInvokeEvent): void
  /** The sender is trusted and the project is a local one (every project channel). */
  authorize(event: Electron.IpcMainInvokeEvent, projectId: string): void
  /** Opens a file with the system's default app (the report) or shows it in its folder (evidence). */
  open(path: string): Promise<void>
  reveal(path: string): void
  changed(projectId: string): void
}): () => void {
  const { service } = options
  const owner = { kind: 'owner' as const, agentSessionId: null, title: 'Owner' }
  const handlers: Array<[string, (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown]> = []
  const handle = (name: string, listener: (event: Electron.IpcMainInvokeEvent, projectId: string, ...args: any[]) => unknown): void => {
    handlers.push([name, (event, projectId: string, ...args) => { options.authorize(event, projectId); return listener(event, projectId, ...args) }])
  }
  const started = (outcome: RunRequestOutcome): ProductionRunSummary => {
    if (!outcome.run) throw new Error(outcome.outcome === 'dropped' ? outcome.reason : 'No run was started')
    return service.summary(outcome.run)
  }

  handle(channel.snapshot, (_event, projectId) => service.snapshot(projectId))
  handlers.push([channel.queue, event => { options.trusted(event); return service.queue() }])
  handlers.push([channel.registry, event => { options.trusted(event); return service.registry() }])
  handle(channel.designate, (_event, projectId, designation: { productionReady: boolean; environmentId: string | null; note: string }) => service.designate(projectId, designation, OWNER_ACTOR))
  handle(channel.updateProfile, (_event, projectId, update: ProfileUpdate) => service.updateProfile(projectId, update, OWNER_ACTOR))
  handle(channel.answerQuestion, (_event, projectId, questionId: string, answer: string) => service.answerQuestion(projectId, questionId, answer, OWNER_ACTOR))
  handle(channel.dismissQuestion, (_event, projectId, questionId: string, reason: string) => service.dismissQuestion(projectId, questionId, reason, OWNER_ACTOR))
  handle(channel.answerReview, (_event, projectId, itemId: string, answer: ReviewAnswer, note?: string) => service.answerReview(projectId, { itemId, answer, note: note ?? null }, OWNER_ACTOR))
  handle(channel.audit, async (_event, projectId, request: AuditRequest) => started(await service.audit(projectId, request ?? {}, OWNER_ACTOR)))
  handle(channel.retest, async (_event, projectId, findingIds: string[]) => started(await service.retest(projectId, findingIds, OWNER_ACTOR)))
  handle(channel.verify, async (_event, projectId, findingIds: string[]) => started(await service.verify(projectId, findingIds, OWNER_ACTOR)))
  handle(channel.pause, (_event, projectId, runId: string) => { service.pause(projectId, runId) })
  handle(channel.resume, (_event, projectId, runId: string) => { service.resume(projectId, runId) })
  handle(channel.cancel, (_event, projectId, runId: string, reason: string) => { service.cancel(projectId, runId, reason) })
  handle(channel.run, (_event, projectId, runId: string) => service.run(projectId, runId))
  handle(channel.createFixTasks, (_event, projectId, findingIds: string[]) => service.createFixTasks(projectId, findingIds).map(({ findingId, taskId, created }) => ({ findingId, taskId, created })))
  handle(channel.waive, (_event, projectId, request: WaiverRequest) => service.waive(projectId, request, owner))
  handle(channel.revokeWaiver, (_event, projectId, waiverId: string, reason: string) => service.revokeWaiver(projectId, waiverId, reason))
  handle(channel.authorizeWrites, (_event, projectId, request: WriteAuthorizationRequest) => service.authorizeWrites(projectId, request, { kind: 'owner', agentSessionId: null }))
  handle(channel.revokeWrites, (_event, projectId, authorizationId: string) => { service.revokeWrites(projectId, authorizationId, 'owner') })
  handle(channel.openEvidence, (_event, projectId, runId: string, evidenceId: string) => { options.reveal(service.evidencePath(projectId, runId, evidenceId)) })
  handle(channel.openReport, async (_event, projectId, runId: string) => {
    const paths = service.reportPaths(projectId, runId)
    if (!paths) throw new Error(`Run ${runId} has no report yet`)
    await options.open(paths.markdown)
  })

  for (const [name, listener] of handlers) ipcMain.handle(name, listener)
  // A run writes the store many times a second (steps, ledger, events); the panel hears one change
  // per project per quarter second.
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = service.onChanged(projectId => {
    pending.add(projectId)
    timer ??= setTimeout(() => { timer = null; const ids = [...pending]; pending.clear(); for (const id of ids) options.changed(id) }, 250)
  })
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
    for (const [name] of handlers) ipcMain.removeHandler(name)
  }
}
