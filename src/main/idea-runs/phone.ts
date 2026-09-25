import type { IdeaActor } from '../../shared/ideas'
import type { PhoneDevice } from '../../shared/phone-access'
import { PhoneAccessError } from '../phone-access'
import type { IdeaRunController } from './controller'

/**
 * /api/idea-runs for the phone (docs/idea-autopilot.md). A checkpoint's phone notification opens
 * #/idea-runs, which lists what is waiting with the exact action and answers it here. The phone
 * server has already authenticated the device; a paired, unlocked phone acts for the owner.
 */
export async function ideaRunsPhoneRoute(controller: IdeaRunController, method: string, path: string, body: Record<string, unknown>, device: Pick<PhoneDevice, 'id' | 'name'>): Promise<unknown> {
  const actor: IdeaActor = { kind: 'owner', label: `phone ${device.name}`.trim() }
  if (path === '/api/idea-runs' && method === 'GET') {
    return {
      pending: controller.pendingCheckpoints(),
      runs: controller.list().slice(0, 30).map(run => ({
        id: run.id, ideaId: run.ideaId, ideaTitle: run.ideaTitle, status: run.status, dryRun: run.dryRun, reason: run.reason, updatedAt: run.updatedAt,
        summary: run.plan?.summary ?? null, warnings: run.plan?.warnings ?? [],
        stages: run.stages.length ? run.stages.map(stage => ({ id: stage.id, title: stage.title, status: stage.status })) : (run.plan?.stages ?? []).map(stage => ({ id: stage.id, title: stage.title, status: 'pending' }))
      }))
    }
  }
  const checkpoint = path.match(/^\/api\/idea-runs\/checkpoints\/([^/]+)$/)
  if (checkpoint && method === 'POST') {
    const decision = body.decision
    if (decision !== 'approve' && decision !== 'deny') throw new PhoneAccessError('decision must be approve or deny.', 400)
    return controller.decide({ checkpointId: decodeURIComponent(checkpoint[1]!), decision, standing: body.standing === true, ...(typeof body.note === 'string' ? { note: body.note } : {}) }, actor)
  }
  const run = path.match(/^\/api\/idea-runs\/([^/]+)(?:\/(approve|pause|resume|stop))?$/)
  if (!run) throw new PhoneAccessError('Unknown route.', 404)
  const runId = decodeURIComponent(run[1]!), action = run[2]
  if (!action && method === 'GET') return controller.get(runId)
  if (!action || method !== 'POST') throw new PhoneAccessError('Unknown route.', 404)
  if (action === 'approve') return controller.approve(runId, actor)
  if (action === 'pause') return controller.pause(runId, actor)
  if (action === 'resume') return controller.resume(runId, actor)
  return controller.stop(runId, actor)
}
