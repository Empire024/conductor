import { IDEA_STATUSES, type IdeaActor, type IdeaLinkKind, type IdeaStatus } from '../../shared/ideas'
import type { IdeasService } from './service'

/** tools.list descriptions for ideas.* (docs/ideas.md). */
export const ideaSignatures: Record<string, string> = {
  'ideas.list': '({search?,status?,limit?}) — the owner\'s ideas (not project-scoped), newest first; search matches the note, briefs and linked work; archived only when status is "archived"',
  'ideas.get': '({ideaId}) — one idea: the owner\'s note and original text, status, worked-on flag, linked work with provenance, timeline, agent briefs and explorations',
  'ideas.capture': '({text}) — jot a new idea into the owner\'s Ideas inbox (only when the owner asked you to)',
  'ideas.link': '({ideaId,kind,targetId,label?,projectId?}) — record work you did for an idea: kind artifact (path or URL), task, memory, project or agent-session; your conversation is recorded as its provenance',
  'ideas.note': '({ideaId,title?,body}) — add a short durable finding to an idea as its own agent section; the owner\'s note is never edited',
  'ideas.explore': '({ideaId,intensity?}) — start a bounded, read-only exploration of the idea by a local model as a durable job (light or explore); never a cloud model',
  'ideas.work': '({ideaId,provider?,model?}) — open a visible conversation in this project briefed with the idea\'s note, latest brief, related memories and prior work, and link it to the idea'
}
export const ideaMethods = new Set(Object.keys(ideaSignatures))
/** For control-method-classes.ts. */
export const IDEA_READ_METHODS = ['ideas.list', 'ideas.get'] as const
export const IDEA_MUTATION_METHODS = ['ideas.capture', 'ideas.link', 'ideas.note', 'ideas.explore', 'ideas.work'] as const

const keys: Record<string, string[]> = {
  'ideas.list': ['search', 'status', 'limit'], 'ideas.get': ['ideaId'], 'ideas.capture': ['text'],
  'ideas.link': ['ideaId', 'kind', 'targetId', 'label', 'projectId'], 'ideas.note': ['ideaId', 'title', 'body'],
  'ideas.explore': ['ideaId', 'intensity'], 'ideas.work': ['ideaId', 'provider', 'model']
}

/** Who is calling, decided by agent-control from the authorized scope, never from the caller. */
export interface IdeasControlCaller {
  projectId: string
  agentSessionId: string
  title: string
  /** The owner's credential or a wizard tab. */
  sovereign: boolean
  /** A local model, or a read-only / planning conversation: reads only. */
  readOnly: boolean
  model?: string
}

const text = (args: Record<string, unknown>, name: string, max: number): string => {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be 1-${max} characters`)
  return value.trim()
}

export async function ideasCall(service: IdeasService, caller: IdeasControlCaller, method: string, rawArgs: unknown): Promise<unknown> {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>
  const allowed = keys[method]
  if (!allowed) throw new Error('Unknown ideas method; use tools.list')
  const extra = Object.keys(args).filter(key => !allowed.includes(key) && key !== 'sessionId' && !(key === 'projectId' && method !== 'ideas.link'))
  if (extra.length) throw new Error(`${method} does not accept ${extra.join(', ')}`)
  if (method === 'ideas.list') {
    const status = args.status === undefined ? undefined : String(args.status)
    if (status !== undefined && !IDEA_STATUSES.includes(status as IdeaStatus)) throw new Error(`status must be one of ${IDEA_STATUSES.join(', ')}`)
    return service.list({ ...(status ? { statuses: [status as IdeaStatus] } : {}), ...(args.search !== undefined ? { search: String(args.search) } : {}), limit: Math.min(Number(args.limit ?? 50) || 50, 200) })
  }
  if (method === 'ideas.get') return service.get(text(args, 'ideaId', 200))
  if (caller.readOnly && !caller.sovereign) throw new Error(`${method} changes the owner's ideas; a local model or a read-only conversation may only read them`)
  const actor: IdeaActor = caller.sovereign && !caller.agentSessionId ? { kind: 'owner' } : { kind: 'agent', agentSessionId: caller.agentSessionId, label: caller.title }
  if (method === 'ideas.capture') return service.capture({ text: text(args, 'text', 100_000), source: 'agent' }, actor)
  if (method === 'ideas.link') {
    return service.link(text(args, 'ideaId', 200), {
      kind: text(args, 'kind', 40) as IdeaLinkKind, targetId: text(args, 'targetId', 1_000), label: typeof args.label === 'string' ? args.label : '',
      projectId: typeof args.projectId === 'string' && args.projectId ? args.projectId : caller.projectId
    }, actor)
  }
  if (method === 'ideas.note') return service.note(text(args, 'ideaId', 200), { title: args.title, body: args.body }, { ...actor, ...(caller.model ? { model: caller.model } : {}) })
  if (method === 'ideas.explore') {
    const intensity = args.intensity === undefined ? undefined : String(args.intensity)
    if (intensity !== undefined && intensity !== 'light' && intensity !== 'explore') throw new Error('intensity must be light or explore')
    return service.explore({ ideaId: text(args, 'ideaId', 200), ...(intensity ? { intensity: intensity as 'light' | 'explore' } : {}) }, caller.sovereign ? 'owner' : 'agent', caller.agentSessionId || undefined)
  }
  const provider = args.provider === undefined ? undefined : String(args.provider)
  if (provider !== undefined && !['claude', 'codex', 'grok', 'local'].includes(provider)) throw new Error('provider must be claude, codex, grok or local')
  return service.work({ ideaId: text(args, 'ideaId', 200), projectId: caller.projectId, ...(provider ? { provider: provider as 'claude' } : {}), ...(typeof args.model === 'string' && args.model ? { model: args.model } : {}) }, actor)
}
