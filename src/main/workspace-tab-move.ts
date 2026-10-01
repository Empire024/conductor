/** The main-process half of dragging tabs between workspaces of one project (feature-list
 * ee0fbf15; the layout half is src/renderer/src/layout/workspace-tab-move.ts). One call moves the
 * conversations behind the tabs to the new workspace and writes both layouts, target first, so
 * a move is on disk the moment it shows and a live conversation is never missing from both. */
import type { WorkspaceTabMoveRequest, WorkspaceTabMoveResult } from '../shared/ipc'
import type { AgentControlLink } from '../shared/agent-control'
import type { AgentSpec, LayoutNode, PaneTab, SessionRecord, WorkspaceLayout } from '../shared/models'

export interface WorkspaceTabMoveDeps {
  getSession(id: string): SessionRecord | null | undefined
  spec(agentSessionId: string): AgentSpec | null | undefined
  /** A conversation placed on another machine: its host owns where it lives. */
  isRemote(agentSessionId: string): boolean
  /** The guarded layout write sessions:save uses (it may restore a live tab a save would drop). */
  save(sessionId: string, layout: WorkspaceLayout, maximizedGroupId: string | null, closedTabs: PaneTab[]): { restoredTabIds: string[]; layout: WorkspaceLayout }
  /** StructuredSessions.moveWorkspace plus the app-control credential's rescope. */
  moveConversation(agentSessionId: string, sessionId: string): void
  /** AgentControl.workspaceMoved. */
  linksMoved(projectId: string, agentSessionIds: string[], from: string, to: string): void
  notifyTabs?(projectId: string, sessionId: string): void
}

/** A control link after the conversations in `moved` went to workspace `to` of `projectId`: each
 * moved end names `to`; a link whose ends now differ records the controller's side
 * (controllerProjectId/controllerSessionId), one whose ends meet again drops it. The same link
 * object comes back when neither end moved. */
export function movedControlLink(link: AgentControlLink, moved: ReadonlySet<string>, projectId: string, to: string): AgentControlLink {
  const targetMoved = moved.has(link.targetAgentSessionId) && link.projectId === projectId
  const { controllerProjectId: recordedProject, controllerSessionId: recordedSession, ...rest } = link
  const controllerProjectId = recordedProject ?? link.projectId
  const controllerMoved = moved.has(link.controllerAgentSessionId) && controllerProjectId === projectId
  if (!targetMoved && !controllerMoved) return link
  const controllerSessionId = controllerMoved ? to : recordedSession ?? link.sessionId
  const sessionId = targetMoved ? to : link.sessionId
  const together = controllerProjectId === link.projectId && controllerSessionId === sessionId
  return { ...rest, sessionId, ...(together ? {} : { controllerProjectId, controllerSessionId }) }
}

const tabsOf = (node: LayoutNode): PaneTab[] => node.type === 'split' ? node.children.flatMap(tabsOf) : node.tabs

export function moveTabsBetweenWorkspaces(deps: WorkspaceTabMoveDeps, request: WorkspaceTabMoveRequest): WorkspaceTabMoveResult {
  const { projectId, source, target } = request
  const tabIds = [...new Set(request.tabIds)]
  if (!tabIds.length) throw new Error('No tab to move')
  if (source.id === target.id) throw new Error('The tab is already in that workspace')
  const from = deps.getSession(source.id), to = deps.getSession(target.id)
  if (!from || !to) throw new Error('That workspace is no longer open')
  if (from.projectId !== projectId || to.projectId !== projectId) throw new Error('Tabs move only between workspaces of one project')
  const arrived = tabsOf(target.layout.root), left = new Set(tabsOf(source.layout.root).map(tab => tab.id))
  const moved = tabIds.map(id => arrived.find(tab => tab.id === id))
  if (moved.some(tab => !tab) || tabIds.some(id => left.has(id))) throw new Error('The move no longer matches the open tabs; nothing was moved')
  const conversations = moved.flatMap(tab => tab!.kind === 'agent' && tab!.resourceId ? [tab!.resourceId] : [])
  // Everything is checked before anything changes, so a refused move changes nothing.
  for (const id of conversations) {
    const spec = deps.spec(id)
    if (spec && spec.projectId !== projectId) throw new Error('Tabs move only between workspaces of one project')
    if (deps.isRemote(id)) throw new Error('A conversation running on another machine cannot move between workspaces; switch the tab to its host machine first')
  }
  const rebound = conversations.filter(id => deps.spec(id))
  for (const id of rebound) deps.moveConversation(id, target.id)
  deps.linksMoved(projectId, rebound, source.id, target.id)
  const repairs: WorkspaceTabMoveResult['repairs'] = []
  for (const side of [target, source]) {
    const repaired = deps.save(side.id, side.layout, side.maximizedGroupId, side.closedTabs)
    if (repaired.restoredTabIds.length) repairs.push({ sessionId: side.id, ...repaired })
    deps.notifyTabs?.(projectId, side.id)
  }
  return { moved: tabIds, conversations: rebound, repairs }
}
