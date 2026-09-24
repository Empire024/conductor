import { IDEA_STATUSES, type IdeaActor, type IdeaStatus } from '../../shared/ideas'
import type { PhoneDevice } from '../../shared/phone-access'
import { PhoneAccessError } from '../phone-access'
import type { IdeasService } from './service'

/**
 * /api/ideas for the phone app (docs/ideas.md). The phone server authenticates the device before
 * any of this runs; a paired phone acts for the owner, so it may do what the Ideas view does.
 */
export async function ideasPhoneRoute(service: IdeasService, method: string, path: string, body: Record<string, unknown>, query: URLSearchParams, device: Pick<PhoneDevice, 'id' | 'name'>): Promise<unknown> {
  const actor: IdeaActor = { kind: 'owner', label: `phone ${device.name}`.trim() }
  const get = method === 'GET', post = method === 'POST'
  if (path === '/api/ideas') {
    if (get) {
      const status = query.get('status') ?? undefined
      if (status && !IDEA_STATUSES.includes(status as IdeaStatus)) throw new PhoneAccessError('Unknown status.', 400)
      return { ideas: service.list({ ...(status ? { statuses: [status as IdeaStatus] } : {}), search: query.get('search') ?? undefined, limit: 200 }) }
    }
    if (post) return service.capture({ text: typeof body.text === 'string' ? body.text : '', source: 'phone' }, actor)
  }
  const match = path.match(/^\/api\/ideas\/([^/]+)(?:\/(explore|task|work))?$/)
  if (!match) throw new PhoneAccessError('Unknown route.', 404)
  const ideaId = decodeURIComponent(match[1]!), action = match[2]
  if (!service.store.exists(ideaId)) throw new PhoneAccessError('That idea no longer exists.', 404)
  if (!action && get) return service.get(ideaId)
  if (!post) throw new PhoneAccessError('Unknown route.', 404)
  if (!action) {
    const status = body.status === undefined ? undefined : String(body.status)
    if (status !== undefined && !IDEA_STATUSES.includes(status as IdeaStatus)) throw new PhoneAccessError('Unknown status.', 400)
    return service.update(ideaId, { ...(typeof body.text === 'string' ? { text: body.text } : {}), ...(status ? { status: status as IdeaStatus } : {}) }, actor)
  }
  if (action === 'explore') return service.explore({ ideaId }, 'owner')
  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  if (action === 'task') return service.createTask({ ideaId, projectId }, actor)
  return service.work({ ideaId, projectId }, actor)
}
