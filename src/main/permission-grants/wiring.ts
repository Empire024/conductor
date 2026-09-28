import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { autoModeDenialOf } from '../../shared/auto-mode-denial'
import type { AgentSpec, LayoutNode, WorkspaceLayout } from '../../shared/models'
import type { PhoneNotification } from '../../shared/phone-access'
import { permissionGrantOf, type GrantCallIdentity, type GrantDecision, type PermissionGrantRequest, type PermissionGrantsState } from '../../shared/permission-grants'
import type { InteractionResponse, Json, SessionSettings, SessionProjection } from '../../shared/structured-agent'
import { SteeringUnavailableError } from '../providers/adapter'
import { ConductorMcpServer, type ControlCall } from './control-mcp'
import { PermissionGrants, type SavedPermissionGrants } from './service'
import { grantCallIdentity } from './identity'

/** What the grant service needs from StructuredSessions (index.ts passes agents.structured). */
export interface GrantSessions {
  notice(id: string, message: string, payload?: Json, itemId?: string): boolean
  applyPermissionRules(id: string): Promise<'applied' | 'unsupported' | 'offline'>
  resume(id: string): Promise<void>
  steerOrStart(id: string, text: string, settings: SessionSettings): Promise<unknown>
  /** Queues a message as the next turn of its own, behind a turn under way (never steered). */
  queue(id: string, text: string, settings: SessionSettings): Promise<void>
  /** Steers into the running turn only, confirmed by the runtime; throws instead of queueing. */
  steerAccepted(id: string, text: string, settings: SessionSettings): Promise<void>
  /** Stops the running turn; expediteSubmittedInput sends what waits in the queue straight after (Esc). */
  interrupt(id: string, expediteSubmittedInput?: boolean): Promise<void>
  cancelQueued(id: string, promptId?: string): unknown
  setPermissionGrants(grants: PermissionGrants): void
  setConductorMcp(server: { configure(spec: AgentSpec): string; release(agentSessionId: string): void }): void
  respond(response: InteractionResponse): Promise<void>
}
export interface GrantStore {
  spec<T>(id: string): T | null | undefined
  snapshot(id: string): Pick<SessionProjection, 'items' | 'phase' | 'settings' | 'queuedPrompts' | 'pendingSteering' | 'runtimeId' | 'nativeSessionId'> | null | undefined
}

export const permissionGrantsIpcChannels = ['permission-grants:state', 'permission-grants:decide', 'permission-grants:revoke', 'permission-grants:interrupt'] as const
/** Verify the provider still has the exact native request and tool arguments the owner saw. */
export function nativeResponseTarget(state: Pick<SessionProjection, 'items' | 'runtimeId' | 'nativeSessionId'> | null | undefined, call: GrantCallIdentity): boolean {
  if (!state || state.runtimeId !== call.runtimeId || state.nativeSessionId !== call.nativeSessionId || !call.requestId) return false
  const pending = state.items.filter(item => item.runtimeId === call.runtimeId && item.data.type === 'interaction' &&
    item.data.interaction.id === call.requestId).at(-1)
  const tool = state.items.filter(item => item.runtimeId === call.runtimeId && item.nativeItemId === call.toolUseId && item.data.type === 'tool').at(-1)
  if (!pending || pending.data.type !== 'interaction' || pending.data.interaction.status !== 'pending' ||
      !tool || tool.data.type !== 'tool' || tool.data.name !== call.tool || !tool.data.input) return false
  const digest = (input: Json): string => grantCallIdentity({ runtimeId: call.runtimeId, nativeSessionId: call.nativeSessionId,
    toolUseId: call.toolUseId, tool: call.tool, input, requestId: call.requestId }).argsDigest
  return digest(pending.data.interaction.input) === call.argsDigest && digest(tool.data.input) === call.argsDigest
}
/** Phases in which a message can only follow the turn (StructuredSessions.queue) or be steered into it. */
const TURN_UNDER_WAY = new Set(['starting', 'running', 'waiting_input', 'waiting_approval'])
/** Phases in which a steered message reaches the running turn itself (StructuredSessions.followup). */
const STEERABLE = new Set(['running', 'waiting_input', 'waiting_approval'])

/** How an approval reaches a conversation (PermissionGrantPorts retry, headsUp, interrupt, turn,
 *  unqueue), over the structured sessions. */
export function grantDelivery(sessions: GrantSessions, store: GrantStore, timing: { settleMs?: number; pollMs?: number } = {}) {
  const state = (id: string) => {
    const current = store.snapshot(id)
    if (!current) throw new Error('The conversation is not registered')
    return current
  }
  return {
    tell: async (id: string, text: string): Promise<void> => { await sessions.steerOrStart(id, text, state(id).settings) },
    // A steered approval reaches the CLI as a mid-turn queued command, which its classifier did not
    // take as the owner's approval (docs/permissions-classifier.md, Evidence 2026-09-28). A turn
    // that is still stopping takes neither a queued nor a started message, so it is waited for
    // (bounded); if it has not stopped by then the grant service hands the retry over again later.
    retry: async (id: string, text: string): Promise<void> => {
      const deadline = Date.now() + (timing.settleMs ?? 30_000)
      while (state(id).phase === 'interrupting' && Date.now() < deadline) await new Promise(done => setTimeout(done, timing.pollMs ?? 500))
      const current = state(id)
      if (current.phase === 'interrupting') throw new Error('The conversation is still stopping its last turn')
      if (TURN_UNDER_WAY.has(current.phase)) await sessions.queue(id, text, current.settings)
      else await sessions.steerOrStart(id, text, current.settings)
    },
    retryQueued: (id: string, text: string): boolean => Boolean(store.snapshot(id)?.queuedPrompts?.some(prompt => prompt.text === text)),
    // Only into a turn that takes it now, confirmed by the runtime. A plain steer the runtime
    // cannot take falls back to the queue, behind the approval turn it announces, so the heads-up
    // arrived with or after the retry (Codex takes no steer while a turn is dispatching, compacting
    // or ending). steerAccepted never queues: refused, it is tried again on a later sweep.
    headsUp: async (id: string, text: string): Promise<boolean> => {
      const current = store.snapshot(id)
      if (!current || !STEERABLE.has(current.phase)) return false
      try {
        await sessions.steerAccepted(id, text, current.settings)
        return true
      } catch (error) {
        const left = (store.snapshot(id)?.pendingSteering ?? []).filter(input => input.text === text && ['cancelled', 'uncertain'].includes(input.status))
        // Refused by the runtime, so never read: its leftover record goes, and nothing is resent from it.
        if (error instanceof SteeringUnavailableError) {
          for (const input of left) { try { sessions.cancelQueued(id, input.id) } catch { /* already gone */ } }
          return false
        }
        // Sent but unconfirmed: the turn may have read it, so it counts as sent and is never sent twice.
        return left.length > 0
      }
    },
    interrupt: (id: string): Promise<void> => sessions.interrupt(id, true),
    turn: (id: string): { startedAt?: string; lastTool?: string } | undefined => {
      const items = store.snapshot(id)?.items ?? []
      let start = -1
      for (let index = items.length - 1; index >= 0; index--) if (items[index]!.data.type === 'text' && (items[index]!.data as { role?: string }).role === 'user') { start = index; break }
      const tool = items.slice(start + 1).reverse().find(item => item.data.type === 'tool')
      return { ...(start >= 0 ? { startedAt: items[start]!.timestamp } : {}), ...(tool && tool.data.type === 'tool' ? { lastTool: tool.data.name } : {}) }
    },
    unqueue: (id: string, text: string): boolean => {
      const prompt = store.snapshot(id)?.queuedPrompts?.find(entry => entry.text === text)
      if (!prompt) return false
      try { return Boolean(sessions.cancelQueued(id, prompt.id)) } catch { return false }
    }
  }
}

/** Starts the grant service and the `conductor` MCP server and hands both to the structured
 *  sessions. index.ts calls this once, before any conversation launches. */
export async function startPermissionGrants(deps: {
  sessions: GrantSessions
  store: GrantStore
  control: ControlCall
  publish(channel: string, payload: unknown): void
  /** Phone access (phone-access.ts announce): an agent's shared, destructive or external request
   *  reaches the owner's phone; a classifier denial already does through phone-notifications. */
  announce?(notification: PhoneNotification): unknown
  /** The saved window layouts (index.ts passes the database): a grant ends when its tab is closed. */
  workspaces?: {
    getSession(id: string): { layout: WorkspaceLayout } | null | undefined
    listDetachedWindows(): Array<{ sessionId: string; layout: WorkspaceLayout }>
    listProjects?(): Array<{ id: string }>
    listSessions?(projectId: string): Array<{ layout: WorkspaceLayout }>
  }
  /** Where waiting requests and unspent grants survive a restart; permission-grants.json in userData. */
  file?: string
}): Promise<{ grants: PermissionGrants; mcp: ConductorMcpServer; close(): void }> {
  const spec = (id: string): AgentSpec | undefined => deps.store.spec<AgentSpec>(id) ?? undefined
  const file = deps.file ?? join(app.getPath('userData'), 'permission-grants.json')
  const grants = new PermissionGrants({
    persist: saved => saveGrants(file, saved),
    notice: (id, message, payload, itemId) => deps.sessions.notice(id, message, payload, itemId),
    denial: (id, itemId) => {
      const item = deps.store.snapshot(id)?.items.find(entry => entry.nativeItemId === itemId && entry.data.type === 'notice')
      return item ? autoModeDenialOf(item.data) : undefined
    },
    provider: id => spec(id)?.provider,
    title: id => spec(id)?.title,
    cwd: id => spec(id)?.cwd,
    apply: id => deps.sessions.applyPermissionRules(id),
    respondNative: async (id: string, call: GrantCallIdentity, decision: 'allow' | 'deny') => {
      const state = deps.store.snapshot(id)
      if (!nativeResponseTarget(state, call)) return 'stale'
      try { await deps.sessions.respond({ sessionId: id, runtimeId: call.runtimeId, requestId: call.requestId!, decision }) }
      catch (error) {
        if (error instanceof Error && /stale|no longer pending|already submitted/i.test(error.message)) return 'stale'
        throw error
      }
      return 'sent'
    },
    phase: id => deps.store.snapshot(id)?.phase,
    restart: id => deps.sessions.resume(id),
    ...grantDelivery(deps.sessions, deps.store),
    phone: (id, title, body) => { void deps.announce?.({ id: randomUUID(), kind: 'attention', sessionId: id, title, body, at: new Date().toISOString(), url: `/#/session/${encodeURIComponent(id)}` }) },
    changed: (state: PermissionGrantsState) => deps.publish('permission-grants:changed', state),
    // A parked smoke (scripts/smoke-grant-interrupt.mjs) reaches the waiting notice in seconds.
    ...(process.env.CONDUCTOR_TEST_USER_DATA && Number(process.env.CONDUCTOR_TEST_GRANT_NOTICE_MS) > 0 ? { retryNoticeMs: Number(process.env.CONDUCTOR_TEST_GRANT_NOTICE_MS) } : {}),
    ...(deps.workspaces ? { tabOpen: (id: string) => tabOpen(deps.workspaces!, spec(id), id) } : {})
  })
  // Before any runtime reattaches or resumes (index.ts starts this first), so a waiting card, a
  // grant's rule and the holder's "retry it now" work across the restart.
  const restored = grants.restore(loadGrants(file, () => recoverFromTimelines(deps)), id => Boolean(spec(id)))
  if (restored.requests || restored.grants || restored.dropped) console.log(`Permission grants restored: ${restored.requests} request(s), ${restored.grants} grant(s); ${restored.dropped} dropped`)
  const sweeper = setInterval(() => grants.sweep(), 1000)
  sweeper.unref?.()
  const mcp = new ConductorMcpServer(deps.control)
  await mcp.start()
  deps.sessions.setPermissionGrants(grants)
  deps.sessions.setConductorMcp(mcp)
  // Runs before the agents are disposed on quit (index.ts disposeRuntimeServices): the runtimes
  // stopping next end no conversation, so what is waiting stays saved for the next launch.
  return { grants, mcp, close: () => { grants.freeze(); clearInterval(sweeper); mcp.close() } }
}

function saveGrants(file: string, saved: SavedPermissionGrants): void {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(saved) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

/** The saved state, or, the first time this build runs (no file yet), what the timelines show. */
function loadGrants(file: string, recover: () => Pick<SavedPermissionGrants, 'requests'>): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return recover()
    console.warn('Saved permission grants could not be read; starting without them', error)
    return undefined
  }
}

/** A build that kept grants in memory only left its waiting agent requests as pending cards in the
 *  tabs' timelines (a runtime stopping at quit writes no card), so the first launch of this one
 *  takes those back from the open tabs rather than orphaning them. */
export function recoverFromTimelines(deps: Parameters<typeof startPermissionGrants>[0]): Pick<SavedPermissionGrants, 'requests'> {
  const workspaces = deps.workspaces
  if (!workspaces?.listProjects || !workspaces.listSessions) return { requests: [] }
  const layouts = [...workspaces.listProjects().flatMap(project => workspaces.listSessions!(project.id).map(session => session.layout)), ...workspaces.listDetachedWindows().map(window => window.layout)]
  const ids = new Set<string>()
  const collect = (node: LayoutNode): void => { if (node.type === 'split') node.children.forEach(collect); else for (const tab of node.tabs) if (tab.resourceId) ids.add(tab.resourceId) }
  for (const layout of layouts) collect(layout.root)
  const requests: SavedPermissionGrants['requests'] = []
  for (const agentSessionId of ids) {
    if (deps.store.spec<AgentSpec>(agentSessionId)?.provider !== 'claude') continue
    // A card restated after its runtime restarted is a later item of its own, so the last one decides.
    const latest = new Map<string, PermissionGrantRequest>()
    for (const item of deps.store.snapshot(agentSessionId)?.items ?? []) {
      const request = permissionGrantOf(item.data)
      if (request?.source === 'agent' && request.id.startsWith('grant:')) latest.set(request.id, request)
    }
    for (const request of latest.values()) if (request.status === 'pending') requests.push({ ...request, agentSessionId })
  }
  return { requests }
}

/** Whether a conversation's tab is in its workspace's layout or one of that workspace's detached windows. */
function tabOpen(workspaces: NonNullable<Parameters<typeof startPermissionGrants>[0]['workspaces']>, spec: AgentSpec | undefined, id: string): boolean {
  if (!spec) return false
  const holds = (node: LayoutNode): boolean => node.type === 'split' ? node.children.some(holds) : node.tabs.some(tab => tab.resourceId === id)
  const workspace = workspaces.getSession(spec.sessionId)
  if (workspace && holds(workspace.layout.root)) return true
  return workspaces.listDetachedWindows().some(window => window.sessionId === spec.sessionId && holds(window.layout.root))
}

/** The owner's window: the card's buttons and the grants list. Only the trusted renderer reaches
 *  these channels (authorize), so a decision here is the owner's own. */
export function registerPermissionGrantsIpc(service: () => PermissionGrants | undefined, authorize: (event: Electron.IpcMainInvokeEvent) => void): () => void {
  const grants = (): PermissionGrants => {
    const current = service()
    if (!current) throw new Error('Permission grants are not available yet')
    return current
  }
  ipcMain.handle('permission-grants:state', event => { authorize(event); return service()?.state() ?? { requests: [], grants: [] } })
  ipcMain.handle('permission-grants:decide', (event, agentSessionId: unknown, requestId: unknown, decision: unknown) => {
    authorize(event)
    if (typeof agentSessionId !== 'string' || typeof requestId !== 'string' || typeof decision !== 'string') throw new Error('Invalid permission decision')
    return grants().decide(agentSessionId, requestId, decision as GrantDecision, 'owner')
  })
  ipcMain.handle('permission-grants:revoke', (event, agentSessionId: unknown, grantId: unknown) => {
    authorize(event)
    if (typeof agentSessionId !== 'string' || typeof grantId !== 'string') throw new Error('Invalid grant')
    return grants().revoke(agentSessionId, grantId)
  })
  ipcMain.handle('permission-grants:interrupt', (event, agentSessionId: unknown, grantId: unknown) => {
    authorize(event)
    if (typeof agentSessionId !== 'string' || typeof grantId !== 'string') throw new Error('Invalid grant')
    return grants().interruptForRetry(agentSessionId, grantId)
  })
  return () => { for (const channel of permissionGrantsIpcChannels) ipcMain.removeHandler(channel) }
}
