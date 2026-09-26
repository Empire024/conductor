import type { SessionProjection, SessionSettings, TimelineItem } from '../../shared/structured-agent'
import { normaliseContract, pathAllowed, type TaskContract } from './completion.ts'
import { LOCAL_COWORKER_BRIEF } from './briefing.ts'

/**
 * Local swarms (local-model-swarms): a local-model conversation opens, steers, reads and finishes
 * coworkers of itself through app control. The rules here are what keeps that from being a way
 * around the opener's own limits:
 *
 * - a coworker is a local conversation on the opener's own model, so it shares the one llama.cpp
 *   server the machine runs (client.ts queues their requests); it never asks for a second server
 *   or a model switch that would evict the opener's;
 * - its permission, grants (repository writes, research) and task contract are the opener's or
 *   narrower, never wider; an anonymous opener opens anonymous coworkers;
 * - at most {@link LOCAL_SWARM_LIMITS.coworkers} open coworkers per opener, and depth 1: a
 *   coworker a local conversation opened cannot open coworkers of its own.
 */
export const LOCAL_SWARM_LIMITS = { coworkers: 3, depth: 1 } as const

export interface LocalOpener {
  /** The model the opener runs on; its coworkers run on the same one. */
  model: string | undefined
  settings: SessionSettings
  anonymous: boolean
  /** The opener was itself opened by a local conversation (it is at the depth limit). */
  openedByLocal: boolean
  /** Local coworkers this opener controls that are still open. */
  liveCoworkers: number
}

export interface LocalCoworkerPlan {
  /** Arguments for the ordinary tabs.open path. */
  open: Record<string, unknown>
  grants: { localGit: boolean; localResearch: boolean }
  prompt?: string
}

export const LOCAL_OPEN_FIELDS = ['title', 'prompt', 'permission', 'repository', 'research', 'contract', 'kind', 'provider', 'model']
const OPEN_FIELDS = LOCAL_OPEN_FIELDS
const PERMISSION_RANK: SessionSettings['permission'][] = ['read-only', 'default', 'accept-edits', 'auto']
const restricted = (settings: SessionSettings): boolean => settings.permission === 'read-only' || settings.sandbox === 'read-only' || settings.plan === true

const flag = (args: Record<string, unknown>, key: string): boolean | undefined => {
  if (args[key] === undefined) return undefined
  if (typeof args[key] !== 'boolean') throw new Error(`${key} must be true or false`)
  return args[key] as boolean
}

/** Whether every path the coworker may write is one the opener may write. */
function withinContract(opener: TaskContract, coworker: TaskContract): boolean {
  if (!opener.allowedPaths) return true
  if (!coworker.allowedPaths) return false
  return coworker.allowedPaths.every(path => path.endsWith('/')
    ? opener.allowedPaths!.some(allowed => allowed.endsWith('/') && path.startsWith(allowed))
    : pathAllowed(opener, path))
}

/** What a local opener's tabs.open becomes, or the reason it is refused. */
export function planLocalCoworker(opener: LocalOpener, args: Record<string, unknown>): LocalCoworkerPlan {
  const unknown = Object.keys(args).filter(key => !OPEN_FIELDS.includes(key))
  if (unknown.length) throw new Error(`A sandboxed local conversation opens only local coworkers of itself; tabs.open accepts ${OPEN_FIELDS.join(', ')} (not ${unknown.join(', ')})`)
  // Naming what it would get anyway is fine; naming anything else is not.
  if (args.kind !== undefined && args.kind !== 'agent') throw new Error('A sandboxed local conversation opens only local coworkers of itself, not other tabs')
  if (args.provider !== undefined && args.provider !== 'local') throw new Error('A sandboxed local conversation opens only local coworkers of itself, never another provider')
  if (args.model !== undefined && opener.model !== undefined && String(args.model).replace(/^local\//, '') !== opener.model.replace(/^local\//, '')) throw new Error(`A local coworker runs on this conversation's own model (${opener.model}), which shares the one model server this machine runs; another model would need a second server or evict this one`)
  if (opener.openedByLocal) throw new Error(`A local coworker cannot open coworkers of its own: a local swarm is ${LOCAL_SWARM_LIMITS.depth} level deep. Report to your controller with agents.report instead.`)
  if (opener.liveCoworkers >= LOCAL_SWARM_LIMITS.coworkers) throw new Error(`This conversation already has ${opener.liveCoworkers} local coworkers open, the most a local swarm may have (${LOCAL_SWARM_LIMITS.coworkers}). Finish one with agents.finish first.`)
  if (!opener.model) throw new Error('This conversation has no local model to share with a coworker')
  if (restricted(opener.settings)) throw new Error('A read-only or planning local conversation cannot open coworkers')
  const title = args.title
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 120)) throw new Error('title must be 1 to 120 characters')
  const prompt = args.prompt
  if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000)) throw new Error('prompt must be 1 to 20000 characters')
  const permission = args.permission
  if (permission !== undefined && (typeof permission !== 'string' || !PERMISSION_RANK.includes(permission as SessionSettings['permission']))) throw new Error('permission must be read-only, default or accept-edits')
  if (permission !== undefined && PERMISSION_RANK.indexOf(permission as SessionSettings['permission']) > PERMISSION_RANK.indexOf(opener.settings.permission)) throw new Error(`A coworker gets the same permission as this conversation (${opener.settings.permission}) or less, never more`)
  const repository = flag(args, 'repository'), research = flag(args, 'research')
  if (repository && !opener.settings.localGit) throw new Error('A sandboxed local conversation without the repository-write grant cannot give it to a coworker; only the same grants or fewer')
  if (research && !opener.settings.localResearch) throw new Error('A sandboxed local conversation without the deep-research grant cannot give it to a coworker; only the same grants or fewer')
  const own = opener.settings.localContract ? normaliseContract(opener.settings.localContract) : undefined
  // A small model often sends a nested object as a JSON string; it is parsed, then held to the same rules.
  let requestedContract = args.contract
  if (typeof requestedContract === 'string') { try { requestedContract = JSON.parse(requestedContract) } catch { throw new Error('contract must be an object with allowedPaths and/or acceptance (not a string)') } }
  let contract = requestedContract === undefined ? undefined : normaliseContract(requestedContract)
  if (own?.allowedPaths) {
    // A bounded task's coworker stays inside the same bounds: named paths must be among the
    // opener's, and a coworker given none inherits the opener's list rather than none at all.
    contract = contract ? { ...contract, allowedPaths: contract.allowedPaths ?? own.allowedPaths } : { allowedPaths: own.allowedPaths }
    if (!withinContract(own, contract)) throw new Error(`A coworker may write only paths this conversation may write (${own.allowedPaths.join(', ')})`)
  }
  return {
    open: {
      kind: 'agent', provider: 'local', model: opener.model,
      ...(title !== undefined ? { title } : {}),
      ...(permission !== undefined ? { permission } : {}),
      ...(contract ? { contract } : {}),
      ...(opener.anonymous ? { anonymous: true } : {})
    },
    grants: { localGit: repository ?? Boolean(opener.settings.localGit), localResearch: research ?? Boolean(opener.settings.localResearch) },
    // The brief rides in front of the controller's words: report with agents.report, and report
    // numbers a tool computed. An 8B coworker left to itself summed in its head (VR8c: 2/8 right).
    ...(prompt !== undefined ? { prompt: `${LOCAL_COWORKER_BRIEF}

${prompt}` } : {})
  }
}

export interface CoworkerWatchDeps {
  snapshot(id: string): SessionProjection | null
  /** Delivers the automatic report to the controller, as agents.report would. */
  deliver(text: string): Promise<unknown>
  intervalMs?: number
}

const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'interrupted', 'idle'])
// A report Conductor held back (numbers not computed) or that failed never reached the controller.
const reported = (item: TimelineItem): boolean => item.data.type === 'tool' && item.data.name === 'conductor' && item.data.status !== 'failed' && JSON.stringify(item.data.input ?? null).includes('agents.report')

/**
 * A small model forgets to call agents.report, and then its controller waits for a message that
 * never comes. Each time a local coworker's turn settles without one, its controller is sent the
 * end of that turn's answer instead, labelled as automatic. A turn that did report is left alone.
 * Returns the stop function; the watch also ends by itself once the coworker is gone.
 */
export function watchLocalCoworker(id: string, title: string, deps: CoworkerWatchDeps): () => void {
  let handled = deps.snapshot(id)?.sequence ?? 0
  let delivering = false
  const tick = (): void => {
    const state = deps.snapshot(id)
    if (!state) { stop(); return }
    if (delivering || !SETTLED.has(state.phase) || state.sequence <= handled || state.queuedPrompts?.length) return
    const turn = state.items.filter(item => (item.updatedSequence ?? item.sequence) > handled)
    handled = state.sequence
    if (!turn.length || turn.some(reported)) return
    const answer = turn.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.type === 'text' ? item.data.text : '').join('\n').trim()
    const tools = turn.filter(item => item.data.type === 'tool').length
    if (!answer && !tools) return
    const text = `[Automatic report: ${title} ended its turn (${state.phase}) without agents.report] ${answer ? answer.slice(-1600) : `No answer text; it made ${tools} tool call${tools === 1 ? '' : 's'}.`}`
    delivering = true
    void deps.deliver(text.slice(0, 2000)).catch(() => undefined).finally(() => { delivering = false })
  }
  const timer = setInterval(tick, deps.intervalMs ?? 3000)
  timer.unref?.()
  const stop = (): void => clearInterval(timer)
  return stop
}
