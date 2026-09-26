import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { autoModeDenialOf } from '../../shared/auto-mode-denial'
import type { AgentSpec, LayoutNode, WorkspaceLayout } from '../../shared/models'
import type { PhoneNotification } from '../../shared/phone-access'
import type { GrantDecision, PermissionGrantsState } from '../../shared/permission-grants'
import type { Json, SessionSettings, SessionProjection } from '../../shared/structured-agent'
import { ConductorMcpServer, type ControlCall } from './control-mcp'
import { PermissionGrants } from './service'

/** What the grant service needs from StructuredSessions (index.ts passes agents.structured). */
export interface GrantSessions {
  notice(id: string, message: string, payload?: Json, itemId?: string): boolean
  applyPermissionRules(id: string): Promise<'applied' | 'unsupported' | 'offline'>
  resume(id: string): Promise<void>
  steerOrStart(id: string, text: string, settings: SessionSettings): Promise<unknown>
  setPermissionGrants(grants: PermissionGrants): void
  setConductorMcp(server: { configure(spec: AgentSpec): string; release(agentSessionId: string): void }): void
}
export interface GrantStore {
  spec<T>(id: string): T | null | undefined
  snapshot(id: string): Pick<SessionProjection, 'items' | 'phase' | 'settings'> | null | undefined
}

export const permissionGrantsIpcChannels = ['permission-grants:state', 'permission-grants:decide', 'permission-grants:revoke'] as const

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
  workspaces?: { getSession(id: string): { layout: WorkspaceLayout } | null | undefined; listDetachedWindows(): Array<{ sessionId: string; layout: WorkspaceLayout }> }
}): Promise<{ grants: PermissionGrants; mcp: ConductorMcpServer; close(): void }> {
  const spec = (id: string): AgentSpec | undefined => deps.store.spec<AgentSpec>(id) ?? undefined
  const grants = new PermissionGrants({
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
    phone: (id, title, body) => { void deps.announce?.({ id: randomUUID(), kind: 'attention', sessionId: id, title, body, at: new Date().toISOString(), url: `/#/session/${encodeURIComponent(id)}` }) },
    changed: (state: PermissionGrantsState) => deps.publish('permission-grants:changed', state),
    ...(deps.workspaces ? { tabOpen: (id: string) => tabOpen(deps.workspaces!, spec(id), id) } : {})
  })
  const sweeper = setInterval(() => grants.sweep(), 1000)
  sweeper.unref?.()
  const mcp = new ConductorMcpServer(deps.control)
  await mcp.start()
  deps.sessions.setPermissionGrants(grants)
  deps.sessions.setConductorMcp(mcp)
  return { grants, mcp, close: () => { clearInterval(sweeper); mcp.close() } }
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
