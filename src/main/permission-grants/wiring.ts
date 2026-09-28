import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { autoModeDenialOf } from '../../shared/auto-mode-denial'
import type { AgentSpec, LayoutNode, WorkspaceLayout } from '../../shared/models'
import type { PhoneNotification } from '../../shared/phone-access'
import { permissionGrantOf, type GrantDecision, type PermissionGrantRequest, type PermissionGrantsState } from '../../shared/permission-grants'
import type { Json, SessionSettings, SessionProjection } from '../../shared/structured-agent'
import { ConductorMcpServer, type ControlCall } from './control-mcp'
import { PermissionGrants, type SavedPermissionGrants } from './service'

/** What the grant service needs from StructuredSessions (index.ts passes agents.structured). */
export interface GrantSessions {
  notice(id: string, message: string, payload?: Json, itemId?: string): boolean
  applyPermissionRules(id: string): Promise<'applied' | 'unsupported' | 'offline'>
  resume(id: string): Promise<void>
  steerOrStart(id: string, text: string, settings: SessionSettings): Promise<unknown>
  /** Queues a message as the next turn of its own, behind a turn under way (never steered). */
  queue(id: string, text: string, settings: SessionSettings): Promise<void>
  setPermissionGrants(grants: PermissionGrants): void
  setConductorMcp(server: { configure(spec: AgentSpec): string; release(agentSessionId: string): void }): void
}
export interface GrantStore {
  spec<T>(id: string): T | null | undefined
  snapshot(id: string): Pick<SessionProjection, 'items' | 'phase' | 'settings' | 'queuedPrompts'> | null | undefined
}

export const permissionGrantsIpcChannels = ['permission-grants:state', 'permission-grants:decide', 'permission-grants:revoke'] as const
/** Phases in which a message can only follow the turn (StructuredSessions.queue) or be steered into it. */
const TURN_UNDER_WAY = new Set(['starting', 'running', 'waiting_input', 'waiting_approval'])

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
    phase: id => deps.store.snapshot(id)?.phase,
    restart: id => deps.sessions.resume(id),
    tell: async (id, text) => {
      const state = deps.store.snapshot(id)
      if (!state) throw new Error('The conversation is not registered')
      await deps.sessions.steerOrStart(id, text, state.settings)
    },
    // A steered approval reaches the CLI as a mid-turn queued command, which its classifier did not
    // take as the owner's approval (docs/permissions-classifier.md, Evidence 2026-09-28).
    retry: async (id, text) => {
      const state = deps.store.snapshot(id)
      if (!state) throw new Error('The conversation is not registered')
      if (TURN_UNDER_WAY.has(state.phase)) await deps.sessions.queue(id, text, state.settings)
      else await deps.sessions.steerOrStart(id, text, state.settings)
    },
    retryQueued: (id, text) => Boolean(deps.store.snapshot(id)?.queuedPrompts?.some(prompt => prompt.text === text)),
    phone: (id, title, body) => { void deps.announce?.({ id: randomUUID(), kind: 'attention', sessionId: id, title, body, at: new Date().toISOString(), url: `/#/session/${encodeURIComponent(id)}` }) },
    changed: (state: PermissionGrantsState) => deps.publish('permission-grants:changed', state),
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
  return () => { for (const channel of permissionGrantsIpcChannels) ipcMain.removeHandler(channel) }
}
