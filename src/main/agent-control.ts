import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { AgentControlLink, AgentControlScope, AgentControlTab, AgentControlUiRequest, AgentFileChange } from '../shared/agent-control'
import { conductorUri } from '../shared/agent-control'
import { isMemoryKind, MEMORY_KINDS, makeId, type AgentProviderInfo, type AgentSpec, type LayoutNode, type PaneKind, type PaneTab } from '../shared/models'
import type { PromptOrigin, SessionProjection, SessionSettings, StructuredProvider } from '../shared/structured-agent'
import { isSessionPermission, settingsForRuntime } from '../shared/structured-agent'
import { rememberedPermission } from './app-settings'
import type { CreateOrchestrationTaskInput, SaveRoutineInput, UpdateOrchestrationTaskInput } from '../shared/orchestration'
import type { ConductorDatabase } from './database'
import type { StructuredSessions } from './structured-sessions'
import type { OrchestrationStore } from './orchestration-store'
import type { AgentCollaborationStore } from './agent-collaboration-store'
import type { ProjectBacklogs } from './project-backlog'
import { projectTaskPriorities, type ProjectTaskPriority } from '../shared/project-backlog'
import { workspacePath } from './agent-artifacts'
import { writeEditorFile } from './editor-files'
import { readTextFile } from './text-files'
import { invalidateProjectFiles, searchProjectFiles } from './project-file-search'
import { inheritMachineId, machineRunsProject, tabMachineId } from './machines'
import { LOCAL_MACHINE_ID, type MachineDescriptor } from '../shared/remote-control'

type Args = Record<string, unknown>
const restricted = (settings?: SessionSettings): boolean => settings?.permission === 'read-only' || settings?.sandbox === 'read-only' || settings?.plan === true
const permissionOrder: SessionSettings['permission'][] = ['read-only', 'default', 'accept-edits', 'auto']
/** A controlled tab inherits its controller autonomy, never more, and only what the target provider
 *  offers. `requested` names a different starting point than the controller's own permission — an
 *  explicit ask or the owner's remembered mode for the target provider — but it is still clamped to
 *  the controller's ceiling and to what the provider actually advertises; omitted, behavior is
 *  unchanged from before requested existed (inherit the controller's own permission outright). */
const inheritedPermission = (source: SessionSettings, supported?: SessionSettings['permission'][], requested?: SessionSettings['permission']): SessionSettings['permission'] => {
  const ceiling = restricted(source) ? 'read-only' : source.permission
  const desired = requested ?? source.permission
  const cap = permissionOrder.indexOf(desired) <= permissionOrder.indexOf(ceiling) ? desired : ceiling
  const offered = supported?.length ? supported : permissionOrder
  const allowed = offered.filter(value => permissionOrder.indexOf(value) <= permissionOrder.indexOf(cap))
  return allowed.sort((a, b) => permissionOrder.indexOf(b) - permissionOrder.indexOf(a))[0] ?? 'default'
}
const text = (args: Args, key: string, maximum = 20000): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new Error(`Invalid ${key}`)
  return value
}
const object = (value: unknown): Args => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Args
}
const toolSignatures = {
  'tools.list': '() — discover these methods and arguments',
  'app.state': '() — current project, workspace, tabs, relationships, the machine each tab runs on, and the other projects open in this Conductor',
  'projects.list': '() — every project open in this Conductor with its workspaces; a sibling project accepts projectId on tabs.list/tabs.open, files.list/read/open, tasks.list and router.dispatch tasks',
  'machines.list': '() — this machine and the paired machines that can run a tab, with the projects each one accepts',
  'models.list': '() — available providers and model-specific effort choices; discovered runtime models take precedence',
  'tabs.list': '({projectId?,workspaceId?}) — open tabs in this workspace, including detached windows, or in a sibling project from projects.list',
  'tabs.open': '({kind?,provider?,model?,effort?,permission?,title?,machineId?,projectId?,workspaceId?}) — visible tab; agent default kind, provider/model must be available; a new agent tab opens on permission if given, else the owner’s remembered mode for that provider, else the controller’s own mode — always clamped to the controller’s autonomy and to what the target provider offers; runs on the controller machine unless machineId names another from machines.list; projectId hands work to a sibling project from projects.list, and only the controller that opened such a tab may steer it',
  'tabs.focus': '({tabId})',
  'tabs.rename': '({tabId,title})',
  'tabs.split': '({tabId,direction:"horizontal"|"vertical"})',
  'tabs.detach': '({tabId})',
  'tabs.close': '({tabId}) — asks the owner to confirm; never closes the caller or its ancestors',
  'agents.list': '() — visible native sessions with observedAt, workspace/tab IDs, phase and lastActivityAt, including tabs this caller opened in a sibling project',
  'agents.snapshot': '({agentSessionId}) — observed native state, pending/running tools and recent output/results; refresh to verify older briefing intents',
  'agents.history': '({agentSessionId,afterSequence?}) — incremental native events',
  'agents.configure': '({agentSessionId,model,effort?}) — while the controlled coworker is idle with no queued input, persist an exact models.list model/effort for its next turn and update its visible tab; provider and permissions never change',
  'agents.submit': '({agentSessionId,prompt}) — dispatch to a visible native tab with its existing permission settings',
  'agents.steer': '({agentSessionId,prompt}) — same steering/queue behavior as the user composer',
  'agents.interrupt': '({agentSessionId})',
  'agents.resume': '({agentSessionId}) ? reconnect an idle/disconnected native conversation with its existing settings',
  'agents.fork': '({agentSessionId,title?}) ? fork supported idle native history into a visible linked tab',
  'agents.release': '({agentSessionId}) — release this controller relationship',
  'files.list': '({query?,projectId?}) — indexed project search, at most 100 matches with stable URIs',
  'files.read': '({path,projectId?}) — UTF-8 text up to 1 MiB; projectId reads a sibling project from projects.list',
  'files.write': '({path,content,expectedContent}) — atomic compare-and-save in this project only; expectedContent:null creates a file; live views refresh. To change a sibling project, open a tab there with tabs.open({projectId}) and dispatch the work to it',
  'files.open': '({path,projectId?}) — open the file in a visible editor',
  'tasks.list': '({projectId?}) — feature-list.md bug/feature/idea tasks, their recorded owners and revision',
  'tasks.update': '({revision,id,status?:"todo"|"doing"|"done",title?,priority?:"high"|"normal"|"low"}) — optimistic update preserving markers and other agents’ claims',
  'memory.recall': '({query?})',
  'memory.remember': `({gist,kind?:${MEMORY_KINDS.map(kind => JSON.stringify(kind)).join('|')},cues?:string[]}) — writes agent-owned memory`,
  'memory.forget': '({id}) — agent-owned memory only; asks the owner to confirm',
  'orchestration.snapshot': '()',
  'orchestration.tasks.create': '({title,description?,priority?,status?,assignedAgentId?})',
  'orchestration.tasks.update': '({id,title?,description?,priority?,status?,assignedAgentId?})',
  'orchestration.routines.save': '({id?,name,description?,steps:[{title,instructions?,assignedAgentId?}]})',
  'workspace.rename': '({title})',
  'router.start': '({prompt,provider?,model?}) — create/reuse the project router definition, open its tab, dispatch the requested task',
  'router.dispatch': '({tasks:[{title,prompt,provider?,model?,effort?,permission?,projectTaskIds?:string[],projectId?,workspaceId?}]}) - one to four visible coworkers with actual models/efforts; each opens on permission if given, else the owner’s remembered mode for its provider, same as tabs.open; exact optional projectTaskIds transfer controller-owned or to-do claims after prompt acceptance, and cannot be combined with projectId because a claim belongs to the project that owns it'
} as const

/** The methods a caller may point at another project the owner has open in this window. Writes
 *  stay out: a change to a sibling project is made by a tab that lives there and shows its work. */
const crossProjectMethods: string[] = ['tabs.list', 'tabs.open', 'files.list', 'files.read', 'files.open', 'tasks.list']

export interface AgentControlDependencies {
  database: ConductorDatabase
  sessions: StructuredSessions
  orchestration: OrchestrationStore
  collaboration: AgentCollaborationStore
  backlogs: ProjectBacklogs
  providers(): AgentProviderInfo[]
  /** This machine plus any paired machines a tab may be placed on. */
  machines?(): MachineDescriptor[]
  /** Opens the tab on a paired machine and returns what it created there. */
  openRemote?(machineId: string, request: { projectId: string; sessionId: string; provider?: string; model?: string; effort?: string; title?: string }): Promise<{ tabId: string; agentSessionId?: string; machineName: string }>
  ui(request: AgentControlUiRequest): Promise<unknown>
  confirm(scope: AgentControlScope, message: string): Promise<boolean>
  fileChanged(change: AgentFileChange): void
  linksChanged?(scope: { projectId: string; sessionId: string }): void
}

/** A facade over the app's native state. Callers cannot supply or change their authority. */
export class AgentControl {
  constructor(private readonly deps: AgentControlDependencies) {}

  authorize(scope: AgentControlScope): AgentSpec {
    const { database } = this.deps
    const spec = database.structured.spec<AgentSpec>(scope.agentSessionId)
    const workspace = database.getSession(scope.sessionId)
    if (!spec || spec.projectId !== scope.projectId || spec.sessionId !== scope.sessionId || workspace?.projectId !== scope.projectId || !database.listSessions(scope.projectId).some(item => item.id === scope.sessionId)) throw new Error('Control scope is no longer active')
    if (!this.tabs(scope).some(tab => tab.resourceId === scope.agentSessionId)) throw new Error('The caller no longer has an open tab')
    return spec
  }

  tabs(scope: AgentControlScope): AgentControlTab[] {
    const workspace = this.deps.database.getSession(scope.sessionId)
    if (workspace?.projectId !== scope.projectId) throw new Error('Workspace is outside the authorized project')
    const tabs: AgentControlTab[] = []
    const visit = (node: LayoutNode, detachedId?: string): void => {
      if (node.type === 'split') { node.children.forEach(child => visit(child, detachedId)); return }
      node.tabs.forEach(tab => tabs.push({ ...tab, groupId: node.id, ...(detachedId ? { detachedId } : {}), uri: conductorUri(scope.projectId, 'tab', tab.id) }))
    }
    visit(workspace.layout.root)
    for (const window of this.deps.database.listDetachedWindows()) if (window.projectId === scope.projectId && window.sessionId === scope.sessionId) visit(window.layout.root, window.id)
    return tabs
  }

  /**
   * A claim only binds while its owner still has a tab open somewhere in the project. A
   * conversation that was closed or crashed mid-task would otherwise hold the item forever:
   * no other agent may move it, and the owner can never come back to release it.
   */
  private claimHolderIsOpen(projectId: string, agentSessionId: string): boolean {
    return this.deps.database.listSessions(projectId).some(workspace =>
      this.tabs({ projectId, sessionId: workspace.id, agentSessionId: '' }).some(tab => tab.resourceId === agentSessionId))
  }

  private tab(scope: AgentControlScope, id: string): AgentControlTab {
    const tab = this.tabs(scope).find(tab => tab.id === id)
    if (!tab) throw new Error('Tab is outside this workspace or closed')
    return tab
  }

  async openUri(uri: string): Promise<void> {
    const target = new URL(uri)
    if (target.protocol !== 'conductor:' || target.username || target.password || target.port || target.search || target.hash) throw new Error('Invalid Conductor link')
    const projectId = decodeURIComponent(target.hostname), parts = target.pathname.split('/').filter(Boolean)
    if (parts.length !== 2) throw new Error('Invalid Conductor link')
    const kind = parts[0], id = decodeURIComponent(parts[1]!)
    const project = this.deps.database.getProject(projectId)
    if (!project) throw new Error('This linked project is no longer loaded')
    const workspaces = this.deps.database.listSessions(projectId)
    if (kind === 'tab') {
      for (const workspace of workspaces) {
        const scope = { projectId, sessionId: workspace.id, agentSessionId: '' }
        if (this.tabs(scope).some(tab => tab.id === id)) { await this.ui(scope, 'tabs.focus', { tabId: id }); return }
      }
      throw new Error('This linked tab is no longer open')
    }
    const workspace = kind === 'workspace' ? workspaces.find(workspace => workspace.id === id) : workspaces[0]
    if (!workspace) throw new Error('This linked workspace is no longer open')
    const scope = { projectId, sessionId: workspace.id, agentSessionId: '' }
    if (kind === 'workspace') await this.ui(scope, 'workspace.focus', {})
    else if (kind === 'file') await this.ui(scope, 'files.open', { path: relative(await realpath(project.path), await workspacePath(project.path, id)).replaceAll('\\', '/') })
    else throw new Error('Unsupported Conductor link')
  }

  private observation(scope: AgentControlScope, tab: AgentControlTab, state: SessionProjection | null, observedAt: string) {
    const lastEvent = state?.sequence ? this.deps.database.structured.events(tab.resourceId!, state.sequence - 1)[0] : undefined
    return {
      observedAt, source: 'native-session' as const, projectId: scope.projectId, workspaceId: scope.sessionId,
      tabId: tab.id, agentSessionId: tab.resourceId, groupId: tab.groupId, detachedId: tab.detachedId,
      title: tab.title, provider: tab.state?.provider, uri: tab.uri, phase: state?.phase ?? null,
      lastActivityAt: lastEvent?.timestamp ?? null, sequence: state?.sequence ?? 0,
      lastEvent: lastEvent ? {
        sequence: lastEvent.sequence, timestamp: lastEvent.timestamp, type: lastEvent.data.type,
        ...(lastEvent.data.type === 'tool' ? { name: lastEvent.data.name, status: lastEvent.data.status, exitCode: lastEvent.data.exitCode } : {})
      } : null
    }
  }

  /**
   * The tab an agents.* call names, and the workspace it actually lives in. Anything in the
   * caller's own workspace stays open to it as before. A tab somewhere else - another workspace,
   * or a sibling project the owner co-opened - is reachable only to the controller that opened it
   * there, so a project cannot reach sideways into conversations it did not create.
   */
  private target(scope: AgentControlScope, id: string, mutate = false): { tab: AgentControlTab; scope: AgentControlScope } {
    const spec = this.deps.database.structured.spec<AgentSpec>(id)
    const missing = new Error('Agent is outside this workspace or has no visible tab')
    if (!spec) throw missing
    const elsewhere = spec.projectId !== scope.projectId || spec.sessionId !== scope.sessionId
    const link = this.linkFor(id)
    if (elsewhere && link?.controllerAgentSessionId !== scope.agentSessionId) throw missing
    const target = elsewhere ? { projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: scope.agentSessionId } : scope
    const tab = this.tabs(target).find(tab => tab.kind === 'agent' && tab.resourceId === id)
    if (!tab) throw missing
    if (mutate) {
      const ancestors = new Set([scope.agentSessionId])
      for (let cursor = scope.agentSessionId;;) {
        const parent = this.linkFor(cursor)?.controllerAgentSessionId
        if (!parent || ancestors.has(parent)) break
        ancestors.add(parent); cursor = parent
      }
      if (ancestors.has(id)) throw new Error('An agent cannot control itself or an ancestor')
      if (link && link.controllerAgentSessionId !== scope.agentSessionId) throw new Error('Another agent already controls this tab; its controller must release it first')
    }
    return { tab, scope: target }
  }

  /** Settings are more durable than a prompt: changing an unclaimed neighbour would leave it
   * altered after this caller went away. Only a relationship the caller already owns qualifies. */
  private configuredTarget(scope: AgentControlScope, id: string): { tab: AgentControlTab; scope: AgentControlScope } {
    const target = this.target(scope, id, true)
    if (this.linkFor(id)?.controllerAgentSessionId !== scope.agentSessionId) throw new Error('Configure only a coworker this agent already controls')
    const spec = this.deps.database.structured.spec<AgentSpec>(id)
    // The durable spec is the execution owner. Old layouts may predate the machine badge, so
    // accepting a missing/local-looking tab stamp would turn a remote configuration into a local
    // settings-only lie. A remote tab stamp is likewise sufficient to fail closed.
    if (spec?.machineId && spec.machineId !== LOCAL_MACHINE_ID || tabMachineId(target.tab) !== LOCAL_MACHINE_ID) throw new Error('This coworker runs on another machine; agents.configure must be sent to its owning machine')
    return target
  }

  private configurableSettings(id: string, provider: StructuredProvider, args: Args): { previous: SessionSettings; next: SessionSettings; model: string; effort?: string } {
    const state = this.deps.database.structured.snapshot(id)
    if (!state) throw new Error('Agent session is no longer available')
    if (['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(state.phase) || state.queued || state.queuedPrompts?.length || state.pendingSteering?.length) {
      throw new Error('Wait until the coworker is idle and has no queued or pending input before changing its model and effort')
    }
    if (state.capabilities?.provider !== provider) throw new Error('The visible tab provider does not match the native conversation')
    const model = text(args, 'model', 160)
    const choice = state.capabilities.models.find(candidate => candidate.id === model)
    if (!choice) throw new Error('Choose an exact model advertised for this coworker by models.list')
    let effort: string | undefined
    if (choice.effort?.length) {
      effort = text(args, 'effort', 40)
      if (!choice.effort.includes(effort)) throw new Error('Choose an effort supported by this model')
    } else if (args.effort !== undefined) throw new Error('This model does not accept an effort setting')
    return { previous: structuredClone(state.settings), next: { ...state.settings, model, effort }, model, effort }
  }

  /**
   * Who controls this tab, wherever that controller sits. A link only binds while the controller
   * still has an open tab of its own; otherwise a closed or crashed controller would hold the tab
   * forever and nobody could take it over. A controller in a sibling project recorded its own
   * workspace on the link, so ownership is checked there rather than beside the controlled tab.
   */
  private linkFor(agentSessionId: string): AgentControlLink | null {
    const stored = this.deps.database.getSetting('agentControlParent:' + agentSessionId)
    if (!stored) return null
    let link: AgentControlLink
    try { link = JSON.parse(stored) as AgentControlLink } catch { return null }
    if (link.targetAgentSessionId !== agentSessionId) return null
    const projectId = link.controllerProjectId ?? link.projectId, sessionId = link.controllerSessionId ?? link.sessionId
    if (this.deps.database.getSession(sessionId)?.projectId !== projectId) return null
    return this.tabs({ projectId, sessionId, agentSessionId: '' }).some(tab => tab.resourceId === link.controllerAgentSessionId) ? link : null
  }

  listLinks(projectId: string, sessionId: string): AgentControlLink[] {
    const tabs = this.tabs({ projectId, sessionId, agentSessionId: '' }), ids = new Set(tabs.map(tab => tab.resourceId))
    return tabs.flatMap(tab => {
      // The cable is only drawn between two tabs of one workspace; a cross-project controller has
      // no tab here to draw it from, so its link stays invisible while still binding ownership.
      const link = tab.resourceId ? this.linkFor(tab.resourceId) : null
      return link && link.projectId === projectId && link.sessionId === sessionId && ids.has(link.controllerAgentSessionId)
        ? [{ ...link, controllerTitle: tabs.find(tab => tab.resourceId === link.controllerAgentSessionId)?.title, controlledTitle: tab.title }] : []
    })
  }

  /**
   * Focuses the concrete tab that originated a persisted coordinated message. This deliberately
   * searches durable tab/resource identity rather than control links: a release drops control
   * authority but must not make the owner-facing transcript lose its sender. A closed tab can be
   * restored only in its recorded workspace, never reconstructed from a label or a guessed ID.
   */
  async focusOrigin(agentSessionId: string): Promise<void> {
    if (!agentSessionId || agentSessionId.length > 160) throw new Error('Invalid originating agent')
    for (const project of this.deps.database.listProjects()) for (const workspace of this.deps.database.listSessions(project.id)) {
      const scope: AgentControlScope = { projectId: project.id, sessionId: workspace.id, agentSessionId: '' }
      const open = this.tabs(scope).find(tab => tab.kind === 'agent' && tab.resourceId === agentSessionId)
      if (open) { await this.ui(scope, 'tabs.focus', { tabId: open.id }); return }
      if (workspace.closedTabs.some(tab => tab.kind === 'agent' && tab.resourceId === agentSessionId)) {
        await this.ui(scope, 'tabs.focus-origin', { agentSessionId })
        return
      }
    }
    throw new Error('The originating agent tab is no longer available.')
  }

  releaseByOwner(targetAgentSessionId: string): void {
    const spec = this.deps.database.structured.spec<AgentSpec>(targetAgentSessionId)
    if (!spec) throw new Error('Agent not found')
    const stored = this.deps.database.getSetting('agentControlParent:' + targetAgentSessionId)
    this.deps.database.removeSetting('agentControlParent:' + targetAgentSessionId)
    if (stored) {
      const link = JSON.parse(stored) as AgentControlLink
      // Same rule as relationship(): there is no shared thread to post to when the controller
      // that was just released lives in another project.
      if (!link.controllerProjectId || link.controllerProjectId === spec.projectId && link.controllerSessionId === spec.sessionId) {
        this.deps.collaboration.postMessage({ projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: link.controllerAgentSessionId, toAgentSessionId: targetAgentSessionId, kind: 'handoff', body: 'The owner released this control relationship.', metadata: { control: 'detached', controllerTabId: link.controllerTabId, controlledTabId: link.controlledTabId } })
      } else this.deps.linksChanged?.({ projectId: link.controllerProjectId, sessionId: link.controllerSessionId ?? link.sessionId })
    }
    this.deps.linksChanged?.({ projectId: spec.projectId, sessionId: spec.sessionId })
  }

  private relationship(scope: AgentControlScope, target: AgentControlScope, tab: AgentControlTab, state: 'attached' | 'detached'): void {
    const source = this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)
    const together = target.projectId === scope.projectId && target.sessionId === scope.sessionId
    if (state === 'attached') {
      const link: AgentControlLink = { projectId: target.projectId, sessionId: target.sessionId, controllerAgentSessionId: scope.agentSessionId, targetAgentSessionId: tab.resourceId!, controllerTabId: source!.id, controlledTabId: tab.id, ...(together ? {} : { controllerProjectId: scope.projectId, controllerSessionId: scope.sessionId }) }
      this.deps.database.setSetting('agentControlParent:' + tab.resourceId, JSON.stringify(link))
    } else this.deps.database.removeSetting('agentControlParent:' + tab.resourceId)
    this.deps.linksChanged?.(target)
    if (!together) { this.deps.linksChanged?.(scope); return }
    // A collaboration message is a note between coworkers of one project; there is no shared
    // thread to post it to when the controller lives in another one.
    this.deps.collaboration.postMessage({ ...target, agentSessionId: scope.agentSessionId, toAgentSessionId: tab.resourceId, kind: 'handoff', body: state === 'attached' ? `Controlling ${tab.title}` : `Released ${tab.title}`, metadata: { control: state, controllerTabId: source?.id, controlledTabId: tab.id } })
  }

  /**
   * Every project open in this Conductor. Two projects side by side in one window is the owner's
   * own arrangement, so an agent may look across at a sibling and hand work to it; this never
   * reaches past this window, and writing into a sibling still goes through a tab opened there.
   */
  private projects(scope: AgentControlScope): Array<{ id: string; name: string; path: string; current: boolean; uri: string; workspaces: Array<{ id: string; name: string; uri: string; current: boolean }> }> {
    return this.deps.database.listProjects().map(project => ({
      id: project.id, name: project.name, path: project.path, current: project.id === scope.projectId,
      uri: conductorUri(project.id, 'workspace', this.deps.database.listSessions(project.id)[0]?.id ?? ''),
      workspaces: this.deps.database.listSessions(project.id).map(workspace => ({ id: workspace.id, name: workspace.name, uri: conductorUri(project.id, 'workspace', workspace.id), current: workspace.id === scope.sessionId }))
    }))
  }

  /** The tabs this caller opened outside its own workspace, so a handoff stays findable after the
   *  agentSessionId that tabs.open returned has scrolled out of the caller's context. */
  private controlledElsewhere(scope: AgentControlScope): Array<{ tab: AgentControlTab; scope: AgentControlScope }> {
    const found: Array<{ tab: AgentControlTab; scope: AgentControlScope }> = []
    for (const project of this.deps.database.listProjects()) {
      for (const workspace of this.deps.database.listSessions(project.id)) {
        if (project.id === scope.projectId && workspace.id === scope.sessionId) continue
        const target = { projectId: project.id, sessionId: workspace.id, agentSessionId: scope.agentSessionId }
        for (const tab of this.tabs(target)) {
          if (tab.kind !== 'agent' || !tab.resourceId) continue
          if (this.linkFor(tab.resourceId)?.controllerAgentSessionId === scope.agentSessionId) found.push({ tab, scope: target })
        }
      }
    }
    return found
  }

  /** Resolves an optional projectId/workspaceId onto a co-open project. Omitting both always
   *  means the caller's own workspace, so every existing call keeps its exact meaning. */
  private sibling(scope: AgentControlScope, args: Args): AgentControlScope {
    if (args.projectId === undefined && args.workspaceId === undefined) return scope
    const projectId = args.projectId === undefined ? scope.projectId : text(args, 'projectId', 160)
    // Co-opening two projects is the owner's consent for this window's own agents. A conversation
    // a paired machine is driving stays inside the one project that machine was granted, which is
    // what the pairing approval promised.
    if (projectId !== scope.projectId && this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)?.state?.remotePeerId) throw new Error('This conversation is driven by a paired machine and stays inside the project shared with it')
    if (!this.deps.database.getProject(projectId)) throw new Error('No project with that id is open in this Conductor; use projects.list')
    const workspaces = this.deps.database.listSessions(projectId)
    const sessionId = args.workspaceId === undefined ? projectId === scope.projectId ? scope.sessionId : workspaces[0]?.id : text(args, 'workspaceId', 160)
    if (!sessionId || !workspaces.some(workspace => workspace.id === sessionId)) throw new Error('That workspace is not open in the requested project; use projects.list')
    return { projectId, sessionId, agentSessionId: scope.agentSessionId }
  }

  private ui(scope: AgentControlScope, action: AgentControlUiRequest['action'], params: Args): Promise<unknown> {
    return this.deps.ui({ ...scope, id: randomUUID(), action, params })
  }

  private catalog(scope: AgentControlScope): Array<{ provider: StructuredProvider; available: boolean; source: 'runtime' | 'configured'; models: Array<{ id: string; label: string; effort?: string[]; defaultEffort?: string; isDefault?: boolean }> }> {
    return this.deps.providers().filter(provider => provider.id === 'codex' || provider.id === 'claude' || provider.id === 'local').map(provider => {
      const runtime = this.tabs(scope).filter(tab => tab.kind === 'agent' && tab.state?.provider === provider.id).map(tab => this.deps.database.structured.snapshot(tab.resourceId!)?.capabilities).find(capabilities => capabilities?.models.length)
      return { provider: provider.id as StructuredProvider, available: provider.available, source: runtime ? 'runtime' : 'configured', models: runtime?.models ?? provider.models.filter(model => !['default', 'auto'].includes(model.id)).map(model => ({ ...model, effort: provider.efforts.map(effort => effort.id).filter(id => id !== 'auto') })) }
    })
  }

  private machines(): MachineDescriptor[] {
    return this.deps.machines?.() ?? [{ id: LOCAL_MACHINE_ID, name: 'This machine', kind: 'local', status: 'online', accountLogin: null, projects: [] }]
  }

  /** Where the caller itself is running; a tab it opens follows unless it says otherwise. */
  private callerMachineId(scope: AgentControlScope): string {
    return tabMachineId(this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId))
  }

  private async open(scope: AgentControlScope, args: Args): Promise<AgentControlTab & { projectId: string; workspaceId: string }> {
    const kind = (args.kind ?? 'agent') as PaneKind
    const allowed: PaneKind[] = ['agent', 'terminal', 'file-tree', 'browser', 'tasks', 'memory', 'routine', 'logs']
    if (!allowed.includes(kind)) throw new Error('Unsupported tab kind; use files.open for editors')
    // Where the tab is going. Only the caller's own scope is ever authorized; the target only
    // says which open workspace receives the tab.
    const target = this.sibling(scope, args)
    const machines = this.machines()
    const machineId = inheritMachineId(this.callerMachineId(scope), args.machineId, machines)
    if (machineId !== LOCAL_MACHINE_ID) return this.openOnMachine(scope, target, machineId, machines, args) as Promise<AgentControlTab & { projectId: string; workspaceId: string }>
    const title = args.title === undefined ? kind === 'agent' ? 'Agent' : kind : text(args, 'title', 120)
    const tab: PaneTab = { id: makeId('tab'), kind, title }
    if (kind === 'agent') {
      const source = this.authorize(scope)
      const catalog = this.catalog(scope)
      const provider = (args.provider ?? source.provider) as StructuredProvider
      const entry = catalog.find(entry => entry.provider === provider && entry.available)
      if (!entry) throw new Error('This native provider is unavailable')
      const model = typeof args.model === 'string' ? entry.models.find(model => model.id === args.model) : entry.models.find(model => model.isDefault) ?? entry.models[0]
      if (!model) throw new Error('Choose a model from models.list')
      const effort = args.effort === undefined ? model.defaultEffort : text(args, 'effort', 40)
      if (effort && !model.effort?.includes(effort)) throw new Error('Choose an effort supported by this model')
      if (args.permission !== undefined && !isSessionPermission(args.permission)) throw new Error('Invalid permission mode')
      const explicitPermission = args.permission as SessionSettings['permission'] | undefined
      tab.resourceId = makeId('agent')
      tab.title = args.title === undefined ? model.label : title
      tab.state = { provider, model: model.id, effort: effort ?? 'auto', viewMode: 'visual', machineId }
      // A tab handed to a sibling project belongs to that project and works in its folder, not in
      // the folder of whoever asked for it.
      const cwd = target.projectId === scope.projectId ? source.cwd : this.deps.database.getProject(target.projectId)!.path
      const spec: AgentSpec = { id: tab.resourceId, projectId: target.projectId, sessionId: target.sessionId, provider, model: model.id, title: tab.title, cwd }
      const result = this.deps.sessions.ensure(spec)
      if (!result.available) throw new Error(result.message || 'Provider unavailable')
      const created = this.deps.database.structured.snapshot(spec.id)!
      if (explicitPermission && !created.capabilities?.permissions?.includes(explicitPermission)) throw new Error('Choose a permission mode supported by this provider')
      const sourceSettings = settingsForRuntime(this.deps.database.structured.snapshot(scope.agentSessionId)!.settings)
      // An explicit ask always wins; otherwise a new tab opens on the owner's remembered mode for
      // this provider (permission-memory.ts on the renderer side, mirrored via app-settings.ts) —
      // still capped by the controller's own autonomy and by what this provider actually offers.
      const requested = explicitPermission ?? rememberedPermission(key => this.deps.database.getSetting(key), provider)
      const permission = inheritedPermission(sourceSettings, created.capabilities?.permissions, requested)
      const settings: SessionSettings = { ...created.settings, model: model.id, effort, permission, ...(permission === 'read-only' ? { sandbox: 'read-only' as const } : {}), plan: restricted(sourceSettings) && provider === 'claude' }
      this.deps.database.structured.update(spec.id, { settings })
    } else {
      if (kind === 'terminal') tab.resourceId = makeId('terminal')
      tab.state = { ...tab.state, machineId }
    }
    await this.ui(target, 'tabs.open', { tab, ...(args.focus === false ? { focus: false } : {}) })
    const opened = this.tab(target, tab.id)
    if (kind === 'agent') this.relationship(scope, target, opened, 'attached')
    return { ...opened, projectId: target.projectId, workspaceId: target.sessionId }
  }

  /**
   * Places the tab on a paired machine instead of this one. The tab is created and shown over
   * there; what comes back identifies it so the caller can steer it through the same machine.
   */
  private async openOnMachine(scope: AgentControlScope, target: AgentControlScope, machineId: string, machines: MachineDescriptor[], args: Args): Promise<unknown> {
    const machine = machines.find(candidate => candidate.id === machineId)!
    // Refused before anything is dialled, and refused again against a live answer inside
    // openRemote; the message names which identity rule stopped it so the owner can act on it.
    // The identity that has to match is the project the tab is for, not the caller's own.
    const placement = machineRunsProject(machine, target.projectId)
    if (!placement.ok) throw new Error(placement.message)
    if (!this.deps.openRemote) throw new Error('Remote machine placement is unavailable in this window')
    if (args.kind !== undefined && args.kind !== 'agent') throw new Error('Only agent tabs can be opened on another machine')
    const created = await this.deps.openRemote(machineId, {
      projectId: target.projectId,
      sessionId: target.sessionId,
      ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
      ...(typeof args.model === 'string' ? { model: args.model } : {}),
      ...(typeof args.effort === 'string' ? { effort: args.effort } : {}),
      ...(args.title === undefined ? {} : { title: text(args, 'title', 120) })
    })
    return { machineId, machineName: created.machineName, remote: true, tabId: created.tabId, agentSessionId: created.agentSessionId, projectId: target.projectId, workspaceId: target.sessionId,
      note: `This tab runs on ${created.machineName}. Steer it with agents.* through that machine; it is not a local tab.` }
  }

  async call(scope: AgentControlScope, method: string, rawArgs: unknown = {}): Promise<unknown> {
    const source = this.authorize(scope), args = object(rawArgs), { database, sessions, backlogs, orchestration } = this.deps
    if (process.env.CONDUCTOR_LIVE_TESTS === '1') throw new Error('App control is disabled during isolated live acceptance tests')
    if (args.sessionId !== undefined && args.sessionId !== scope.sessionId) throw new Error('Requested scope differs from the authorized session')
    // Naming another project is only meaningful for the methods that were opened to a sibling;
    // everywhere else it is still an attempt to act outside the authorized scope.
    if (args.projectId !== undefined && args.projectId !== scope.projectId && !crossProjectMethods.includes(method)) throw new Error('This method only runs in the authorized project. Use projects.list to see what else is open, and hand work to a sibling project with tabs.open({projectId}).')
    if (method === 'tools.list') return toolSignatures
    if (method === 'projects.list') return this.projects(scope)
    if (method === 'app.state') return { observedAt: new Date().toISOString(), projectId: scope.projectId, workspaceId: scope.sessionId, project: database.getProject(scope.projectId), workspace: database.getSession(scope.sessionId), tabs: this.tabs(scope), relationships: this.listLinks(scope.projectId, scope.sessionId).map(link => ({ agentSessionId: link.targetAgentSessionId, controllerAgentSessionId: link.controllerAgentSessionId })), machineId: this.callerMachineId(scope), machines: this.machines(), projects: this.projects(scope) }
    if (method === 'machines.list') {
      return this.machines().map(machine => {
        const placement = machineRunsProject(machine, scope.projectId)
        return { ...machine, current: machine.id === this.callerMachineId(scope), runsThisProject: placement.ok, projectNote: !placement.ok ? placement.message : machine.kind === 'local' ? 'Runs every project open in this Conductor; projects.list names them.' : null }
      })
    }
    if (method === 'models.list') return this.catalog(scope)
    if (method === 'tabs.list') return this.tabs(this.sibling(scope, args))
    if (method === 'tabs.open') return this.open(scope, args)
    if (['tabs.focus', 'tabs.rename', 'tabs.split', 'tabs.detach', 'tabs.close'].includes(method)) {
      const tab = this.tab(scope, text(args, 'tabId', 160))
      if (method !== 'tabs.focus' && tab.kind === 'agent') this.target(scope, tab.resourceId!, true)
      if (method === 'tabs.rename') text(args, 'title', 120)
      if (method === 'tabs.split' && !['horizontal', 'vertical'].includes(String(args.direction))) throw new Error('Invalid split direction')
      if (method === 'tabs.close' && !await this.deps.confirm(scope, `${source.title} wants to close the tab “${tab.title}”.`)) throw new Error('The owner declined to close this tab')
      this.authorize(scope); this.tab(scope, tab.id)
      if (method !== 'tabs.focus' && tab.kind === 'agent') this.target(scope, tab.resourceId!, true)
      const result = await this.ui(scope, method as AgentControlUiRequest['action'], args)
      if (method === 'tabs.close' && tab.kind === 'agent') this.relationship(scope, scope, tab, 'detached')
      return result
    }
    if (method === 'agents.list') {
      const observedAt = new Date().toISOString()
      const own = this.tabs(scope).filter(tab => tab.kind === 'agent').map(tab => this.observation(scope, tab, database.structured.snapshot(tab.resourceId!), observedAt))
      // A tab this caller handed to another open project is still its own work to follow, and it
      // would otherwise be unfindable after the id that came back from tabs.open is forgotten.
      return [...own, ...this.controlledElsewhere(scope).map(({ tab, scope: target }) => ({ ...this.observation(target, tab, database.structured.snapshot(tab.resourceId!), observedAt), crossProject: true }))]
    }
    if (method.startsWith('agents.')) {
      const id = text(args, 'agentSessionId', 160), mutate = !['agents.snapshot', 'agents.history'].includes(method)
      const { tab, scope: target } = this.target(scope, id, mutate), state = database.structured.snapshot(id)!
      if (method === 'agents.snapshot') {
        const recent = [...state.items].sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence)).slice(0, 60)
        const activeTools = state.items.filter(item => item.data.type === 'tool' && ['preparing', 'running', 'awaiting_approval'].includes(item.data.status))
        return { ...this.observation(target, tab, state, new Date().toISOString()), ...state, activeTools, items: recent.sort((a, b) => a.sequence - b.sequence), truncated: state.truncated || state.items.length > recent.length }
      }
      if (method === 'agents.history') return database.structured.events(id, typeof args.afterSequence === 'number' && Number.isSafeInteger(args.afterSequence) && args.afterSequence >= 0 ? args.afterSequence : 0).slice(0, 100)
      if (method === 'agents.configure') {
        if (Object.keys(args).some(key => !['agentSessionId', 'model', 'effort'].includes(key))) throw new Error('agents.configure accepts only agentSessionId, model, and effort')
        const spec = database.structured.spec<AgentSpec>(id)
        if (!spec || !['codex', 'claude', 'local'].includes(spec.provider)) throw new Error('This native provider does not support structured model configuration')
        const provider = spec.provider as StructuredProvider
        if (provider !== tab.state?.provider) throw new Error('The visible tab provider does not match the native conversation')
        const configured = this.configuredTarget(scope, id)
        const desired = this.configurableSettings(id, provider, args)
        const visibleBefore = { provider, model: String(configured.tab.state?.model ?? desired.previous.model ?? ''), ...(configured.tab.state?.effort === undefined ? {} : { effort: String(configured.tab.state.effort) }) }
        await this.ui(configured.scope, 'agents.configure', { tabId: configured.tab.id, agentSessionId: id, provider, model: desired.model, ...(desired.effort === undefined ? {} : { effort: desired.effort }) })
        try {
          this.authorize(scope)
          const current = this.configuredTarget(scope, id)
          if (current.tab.id !== configured.tab.id) throw new Error('The controlled tab changed while its settings were being applied')
          const fresh = this.configurableSettings(id, provider, args)
          if (JSON.stringify(fresh.previous) !== JSON.stringify(desired.previous)) throw new Error('The coworker settings changed while its model and effort were being applied')
          sessions.saveSettings(id, desired.next)
        } catch (error) {
          // Compensation is compare-and-set too. A relationship release can race this renderer
          // round trip, and the owner may immediately choose something newer. Restore the old tab
          // metadata only while both durable settings and visible metadata are still exactly the
          // values this call observed/applied.
          const currentState = database.structured.snapshot(id)
          const currentTab = this.tabs(configured.scope).find(candidate => candidate.id === configured.tab.id && candidate.resourceId === id)
          const visibleIsOurs = currentTab?.state?.provider === provider && currentTab.state.model === desired.model && (currentTab.state.effort === desired.effort || desired.effort === undefined && currentTab.state.effort === 'auto')
          if (currentState && JSON.stringify(currentState.settings) === JSON.stringify(desired.previous) && visibleIsOurs) {
            await this.ui(configured.scope, 'agents.configure', { tabId: configured.tab.id, agentSessionId: id, ...visibleBefore, expectedModel: desired.model, expectedEffort: desired.effort ?? 'auto' }).catch(() => undefined)
          }
          throw error
        }
        await this.ui(configured.scope, 'agents.configure-confirmed', { tabId: configured.tab.id, agentSessionId: id, model: desired.model, ...(desired.effort === undefined ? {} : { effort: desired.effort }) })
        const saved = database.structured.snapshot(id)!
        return { agentSessionId: id, tabId: configured.tab.id, uri: configured.tab.uri, projectId: configured.scope.projectId, workspaceId: configured.scope.sessionId, provider, model: saved.settings.model, effort: saved.settings.effort ?? null, effective: 'next-turn', phase: saved.phase }
      }
      if (method === 'agents.resume' || method === 'agents.fork') {
        if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings) && !restricted(state.settings)) throw new Error('A read-only controller cannot resume or fork a writable conversation')
        if (method === 'agents.resume') { await sessions.resume(id, state.settings); return { agentSessionId: id, phase: database.structured.snapshot(id)?.phase } }
        const forkId = await sessions.fork(id)
        const forkTab: PaneTab = { id: makeId('tab'), kind: 'agent', resourceId: forkId, title: args.title === undefined ? tab.title + ' (fork)' : text(args, 'title', 120), state: { ...tab.state, viewMode: 'visual' } }
        await this.ui(target, 'tabs.open', { tab: forkTab })
        const opened = this.tab(target, forkTab.id)
        this.relationship(scope, target, opened, 'attached')
        return { ...opened, projectId: target.projectId, workspaceId: target.sessionId }
      }
      if (method === 'agents.release') { this.relationship(scope, target, tab, 'detached'); return { released: true } }
      if (method === 'agents.interrupt') { await sessions.interrupt(id); return { interrupted: true } }
      if (method === 'agents.submit' || method === 'agents.steer') {
        const prompt = text(args, 'prompt')
        if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings) && !restricted(state.settings)) throw new Error('A read-only controller cannot dispatch to a writable conversation')
        this.relationship(scope, target, tab, 'attached')
        // A coordinated prompt is not the owner's message. Record the controlling tab so the
        // conversation attributes it to that coworker instead of to "You".
        const controller = this.tabs(scope).find(candidate => candidate.resourceId === scope.agentSessionId)
        const label = controller?.title || 'Another Conductor tab'
        const origin: PromptOrigin = { agentSessionId: scope.agentSessionId, label: target.projectId === scope.projectId ? label : `${label} (${database.getProject(scope.projectId)?.name ?? 'another project'})` }
        try {
          if (method === 'agents.submit') await sessions.submit(id, prompt, state.settings, [], origin)
          else await sessions.steer(id, prompt, state.settings, [], origin)
        } catch (error) { this.relationship(scope, target, tab, 'detached'); throw error }
        return { agentSessionId: id, tabId: tab.id, uri: tab.uri, projectId: target.projectId, workspaceId: target.sessionId, phase: database.structured.snapshot(id)?.phase }
      }
    }
    if (method === 'files.list') {
      const target = this.sibling(scope, args)
      return (await searchProjectFiles([database.getProject(target.projectId)!], typeof args.query === 'string' ? args.query.slice(0, 300) : '', { showHidden: true })).map(file => ({ ...file, projectId: target.projectId, uri: conductorUri(target.projectId, 'file', file.path) }))
    }
    if (['files.read', 'files.write', 'files.open'].includes(method)) {
      const target = this.sibling(scope, args)
      const foreign = target.projectId !== scope.projectId
      // Reading across co-open projects is fine; changing one is not. A sibling's files are
      // edited by a tab that lives there, where the owner can see the work being done.
      if (foreign && method === 'files.write') throw new Error('files.write only writes in this project. Open a tab in the other project with tabs.open({projectId}) and dispatch the change to it.')
      const root = foreign ? database.getProject(target.projectId)!.path : source.cwd
      const path = await workspacePath(root, text(args, 'path', 4000), method === 'files.write')
      if (method !== 'files.write' && (!statSync(path).isFile() || statSync(path).size > 1024 * 1024)) throw new Error('Only text files up to 1 MiB are supported')
      // Match workspacePath's native resolver, including Windows 8.3 folder aliases.
      const relativePath = relative(await realpath(root), path).replaceAll('\\', '/')
      this.authorize(scope)
      if (method === 'files.open') return this.ui(target, 'files.open', { path: relativePath })
      // Same guard the editor uses: an agent asking for a binary file gets a
      // clear refusal rather than a megabyte of mojibake it will act on.
      if (method === 'files.read') return { path: relativePath, projectId: target.projectId, content: readTextFile(path), uri: conductorUri(target.projectId, 'file', relativePath) }
      if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 1024 * 1024 || !(args.expectedContent === null || typeof args.expectedContent === 'string' && Buffer.byteLength(args.expectedContent) <= 1024 * 1024)) throw new Error('Provide content and the exact expectedContent (null for a new file), up to 1 MiB')
      const lease = this.deps.collaboration.announcePresence({ ...scope, path: relativePath, intent: args.expectedContent === null ? 'create' : 'edit', ttlSeconds: 90 })
      if (!lease.granted) throw new Error('Another agent holds an active edit lease for this file')
      const saved = writeEditorFile(path, args.content, args.expectedContent)
      if (saved.status === 'saved') { invalidateProjectFiles(source.cwd); this.deps.fileChanged({ ...scope, path: relativePath }) }
      return saved
    }
    if (method === 'tasks.list') return backlogs.get(this.sibling(scope, args).projectId)
    if (method === 'tasks.update') {
      if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
      const board = await backlogs.get(scope.projectId), id = text(args, 'id', 160), task = board.tasks.find(task => task.id === id)
      if (!task) throw new Error('Task not found')
      if (task.agentId && task.agentId !== scope.agentSessionId && task.status === 'doing' && this.claimHolderIsOpen(scope.projectId, task.agentId)) throw new Error('Another agent owns this task')
      const status = args.status === undefined ? task.status : args.status
      if (!['todo', 'doing', 'done'].includes(String(status))) throw new Error('Invalid task status')
      // parsePriority would quietly degrade a typo to 'normal'; an agent deserves to hear that its edit did nothing.
      if (args.priority !== undefined && !projectTaskPriorities.includes(args.priority as ProjectTaskPriority)) throw new Error('Invalid task priority')
      const updated = await backlogs.edit(scope.projectId, text(args, 'revision', 100), { type: 'update', id, status: status as 'todo' | 'doing' | 'done', ...(args.title === undefined ? {} : { title: text(args, 'title', 8000) }), ...(args.priority === undefined ? {} : { priority: args.priority as ProjectTaskPriority }), agentId: scope.agentSessionId }, { actor: 'agent', agentId: scope.agentSessionId, sessionId: scope.sessionId })
      this.deps.fileChanged({ ...scope, path: 'feature-list.md' })
      return updated
    }
    if (method === 'memory.recall') return database.recall(scope.projectId, typeof args.query === 'string' ? args.query.slice(0, 4000) : '', undefined, 12)
    if (method === 'memory.remember') {
      const kind = args.kind ?? 'semantic'
      if (!isMemoryKind(kind)) throw new Error('Invalid memory kind')
      if (args.cues !== undefined && (!Array.isArray(args.cues) || args.cues.length > 20 || args.cues.some(cue => typeof cue !== 'string' || cue.length > 160))) throw new Error('Invalid memory cues')
      return database.remember({
        projectId: scope.projectId, kind, source: 'agent',
        // Attribution comes from the authorized scope, never from the caller's arguments.
        origin: { agentSessionId: scope.agentSessionId, workspaceId: scope.sessionId, title: source.title, provider: source.provider },
        gist: text(args, 'gist', 4000), cues: args.cues as string[] | undefined
      })
    }
    if (method === 'memory.forget') {
      const memory = database.listMemories(scope.projectId).find(memory => memory.id === args.id)
      if (!memory || memory.source !== 'agent') throw new Error('Only agent-authored memories from this project can be forgotten')
      if (!await this.deps.confirm(scope, `${source.title} wants to forget this agent memory:\n${memory.gist}`)) throw new Error('The owner declined to forget this memory')
      this.authorize(scope); database.removeMemory(memory.id); return { removed: true }
    }
    if (method === 'orchestration.snapshot') return orchestration.snapshot(scope.projectId)
    if (method === 'orchestration.tasks.create') return orchestration.createTask({ ...args, projectId: scope.projectId, title: text(args, 'title', 300) } as CreateOrchestrationTaskInput)
    if (method === 'orchestration.tasks.update') {
      const id = text(args, 'id', 160)
      if (!orchestration.listTasks(scope.projectId).some(task => task.id === id)) throw new Error('Task is outside this project')
      return orchestration.updateTask(id, args as UpdateOrchestrationTaskInput)
    }
    if (method === 'orchestration.routines.save') {
      if (!Array.isArray(args.steps) || args.steps.length > 100) throw new Error('Invalid routine steps')
      return orchestration.saveRoutine({ ...args, projectId: scope.projectId, name: text(args, 'name', 200) } as unknown as SaveRoutineInput)
    }
    if (method === 'workspace.rename') return this.ui(scope, 'workspace.rename', { title: text(args, 'title', 120) })
    if (method === 'router.start') return this.startRouter(scope, args)
    if (method === 'router.dispatch') return this.dispatchRouter(scope, args)
    throw new Error('Unknown control method; use tools.list')
  }

  private router(scope: AgentControlScope, provider: StructuredProvider, model: string) {
    const { orchestration } = this.deps
    const existing = orchestration.listAgents(scope.projectId).find(agent => agent.role === 'conductor-router')
    const agent = orchestration.saveAgent({ id: existing?.id, projectId: scope.projectId, name: 'Conductor router', provider, model, role: 'conductor-router', instructions: 'Coordinate the user task. Read models.list and app.state once. Choose available models deliberately for up to four independent tasks; use router.dispatch with explicit provider/model and clear bounded prompts. Wait by reading agents.history incrementally; avoid polling excessively. Review results, integrate, and report. Use tasks.update for checklist progress and memory.remember only for reusable findings. Do not spawn another router or duplicate assigned work.' })
    let routine = orchestration.listRoutines(scope.projectId).find(routine => routine.name === 'Conductor router')
    if (!routine) routine = orchestration.saveRoutine({ projectId: scope.projectId, name: 'Conductor router', description: 'Select native models, dispatch visible coworker tabs, then integrate their results.', steps: [{ title: 'Route and coordinate the task', instructions: agent.instructions, assignedAgentId: agent.id }] })
    return { agent, routine }
  }

  private async startRouter(scope: AgentControlScope, args: Args): Promise<unknown> {
    const prompt = text(args, 'prompt')
    const tab = await this.open(scope, { ...args, kind: 'agent', title: 'Conductor router' })
    const { agent, routine } = this.router(scope, tab.state!.provider as StructuredProvider, String(tab.state!.model))
    const started = this.deps.orchestration.startRoutine(routine.id), task = started.tasks[0]!
    this.deps.orchestration.updateTask(task.id, { status: 'in_progress', description: prompt })
    try { await this.call(scope, 'agents.submit', { agentSessionId: tab.resourceId, prompt: agent.instructions + '\n\nTask: ' + prompt + '\n\nYour orchestration task ID is ' + task.id + '. Mark it done only after integrating the results.' }) }
    catch (error) { this.deps.orchestration.updateTask(task.id, { status: 'blocked' }); throw error }
    return { tab, agent, routine, run: started.run, taskId: task.id }
  }

  private async dispatchRouter(scope: AgentControlScope, args: Args): Promise<unknown> {
    if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 4) throw new Error('Route one to four bounded tasks per call')
    const seen = new Set<string>()
    const requests: Array<Args & { projectTaskIds: string[] }> = args.tasks.map(value => {
      const request = object(value); text(request, 'title', 120); text(request, 'prompt')
      const ids = request.projectTaskIds ?? []
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string' || !id || id.length > 160 || seen.has(id) || !seen.add(id))) throw new Error('Provide distinct exact project task IDs across this dispatch')
      // A checklist claim is owned by the project whose feature-list.md holds it, and only an
      // agent of that project can be seen to still hold it. Handing one across would strand it.
      if (ids.length && request.projectId !== undefined && request.projectId !== scope.projectId) throw new Error('A worker in another project cannot take this project’s task claims; dispatch it without projectTaskIds')
      return { ...request, projectTaskIds: ids as string[] }
    })
    if (seen.size && restricted(this.deps.database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('A read-only or planning controller cannot assign project tasks')
    const board = seen.size ? await this.deps.backlogs.get(scope.projectId) : undefined
    const selected = new Map((board?.tasks ?? []).filter(task => seen.has(task.id)).map(task => [task.id, task]))
    const claimable = (task: NonNullable<typeof board>['tasks'][number] | undefined): boolean => Boolean(task && task.status !== 'done' && (task.agentId === scope.agentSessionId || task.status === 'todo'))
    for (const id of seen) if (!claimable(selected.get(id))) throw new Error('A selected project task is missing, finished, or owned by another active agent')
    const results: unknown[] = []
    // Whoever is dispatching, if they are themselves a roster identity (the Conductor router, the
    // Auto Fixer), owns every run started here.
    const dispatcherAgentId = this.deps.orchestration.snapshot(scope.projectId).agents
      .find(agent => agent.role === 'conductor-router' || agent.role === 'auto-fixer')?.id ?? null
    for (const request of requests) {
      const tab = await this.open(scope, { ...request, kind: 'agent', ...(request.projectTaskIds.length ? { focus: false } : {}) })
      // A dispatched coworker is a run of this work, not a new identity. Minting an agent per
      // dispatch turned the roster into a task log; the task row below already records the run,
      // and it is attributed to the reusable agent that dispatched it when there is one.
      const task = this.deps.orchestration.createTask({ projectId: scope.projectId, title: String(request.title), description: String(request.prompt), status: 'in_progress', assignedAgentId: dispatcherAgentId })
      let accepted = false
      try {
        await this.deps.sessions.connectSession(tab.resourceId!)
        const state = this.deps.database.structured.snapshot(tab.resourceId!)!
        const model = state.capabilities?.models.find(model => model.id === tab.state!.model)
        if (!model || state.settings.effort && !model.effort?.includes(state.settings.effort)) throw new Error('The native runtime did not advertise the selected model and effort; no worker prompt was sent')
        if (request.projectTaskIds.length) {
          const current = await this.deps.backlogs.get(scope.projectId)
          for (const id of request.projectTaskIds) {
            const before = selected.get(id)!, latest = current.tasks.find(task => task.id === id)
            if (!claimable(latest) || latest?.title !== before.title || latest?.status !== before.status || latest?.agentId !== before.agentId) throw new Error('A selected task changed before native dispatch; review its current owner before retrying')
          }
        }
        const ownership = request.projectTaskIds.length ? '\n\nExact Project tasks assigned to this worker: ' + request.projectTaskIds.join(', ') + '. Read tasks.list before updating these IDs. Ownership is transferred immediately after prompt acceptance; wait for the handoff if it is not visible yet. Do not seize unrelated claims.' : ''
        // The orchestration row belongs to the dispatching project, so a worker handed to a
        // sibling project is not asked to close a task it cannot even see; its controller does that.
        const coordination = tab.projectId === scope.projectId
          ? tab.state!.provider === 'local'
            ? '\n\nConductor orchestration task: ' + task.id + '. When finished, report concrete evidence, tests, and remaining limitations to your controller ' + scope.agentSessionId + '. Your controller updates the orchestration task.'
            : '\n\nConductor orchestration task: ' + task.id + '. Mark it done with orchestration.tasks.update only after finishing. Your controller is ' + scope.agentSessionId + '; coordinate through the provided app protocol.'
          : '\n\nThis work was handed to the ' + (this.deps.database.getProject(tab.projectId)?.name ?? 'this') + ' project by a coworker in ' + (this.deps.database.getProject(scope.projectId)?.name ?? 'another project') + '. You work only in this project; your controller is ' + scope.agentSessionId + ' and tracks the task on its own side, so report your result here rather than looking for its task board.'
        await this.call(scope, 'agents.submit', { agentSessionId: tab.resourceId, prompt: String(request.prompt) + ownership + coordination })
        accepted = true
        if (request.projectTaskIds.length) {
          let current = await this.deps.backlogs.get(scope.projectId)
          for (const id of request.projectTaskIds) {
            const latest = current.tasks.find(task => task.id === id)
            if (latest?.agentId === tab.resourceId) continue
            if (!claimable(latest)) throw new Error('Worker prompt accepted, but task ownership changed. Inspect the worker; do not submit the task again.')
            current = await this.deps.backlogs.edit(scope.projectId, current.revision, { type: 'update', id, status: 'doing', agentId: tab.resourceId! }, { actor: 'agent', agentId: scope.agentSessionId, sessionId: scope.sessionId })
          }
          this.deps.fileChanged({ ...scope, path: 'feature-list.md' })
        }
        results.push({ tabId: tab.id, agentSessionId: tab.resourceId, taskId: task.id, projectTaskIds: request.projectTaskIds, projectId: tab.projectId, workspaceId: tab.workspaceId, provider: tab.state!.provider, model: tab.state!.model, effort: state.settings.effort, uri: tab.uri, accepted })
      } catch (error) {
        this.deps.orchestration.updateTask(task.id, { status: 'blocked' })
        results.push({ tabId: tab.id, agentSessionId: tab.resourceId, taskId: task.id, projectTaskIds: request.projectTaskIds, projectId: tab.projectId, workspaceId: tab.workspaceId, accepted, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }
}
