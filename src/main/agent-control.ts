import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { AgentControlLink, AgentControlScope, AgentControlTab, AgentControlUiRequest, AgentFileChange } from '../shared/agent-control'
import { conductorUri } from '../shared/agent-control'
import { makeId, type AgentProviderInfo, type AgentSpec, type LayoutNode, type PaneKind, type PaneTab } from '../shared/models'
import type { SessionSettings, StructuredProvider } from '../shared/structured-agent'
import type { CreateOrchestrationTaskInput, SaveRoutineInput, UpdateOrchestrationTaskInput } from '../shared/orchestration'
import type { ConductorDatabase } from './database'
import type { StructuredSessions } from './structured-sessions'
import type { OrchestrationStore } from './orchestration-store'
import type { AgentCollaborationStore } from './agent-collaboration-store'
import type { ProjectBacklogs } from './project-backlog'
import { workspacePath } from './agent-artifacts'
import { readEditorFile, writeEditorFile } from './editor-files'
import { invalidateProjectFiles, searchProjectFiles } from './project-file-search'

type Args = Record<string, unknown>
const restricted = (settings?: SessionSettings): boolean => settings?.permission === 'read-only' || settings?.sandbox === 'read-only' || settings?.plan === true
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
  'app.state': '() — current project, workspace, tabs and relationships',
  'models.list': '() — available providers and model-specific effort choices; discovered runtime models take precedence',
  'tabs.list': '() — open tabs in this workspace, including detached windows',
  'tabs.open': '({kind?,provider?,model?,effort?,title?}) — visible tab; agent default kind, provider/model must be available',
  'tabs.focus': '({tabId})',
  'tabs.rename': '({tabId,title})',
  'tabs.split': '({tabId,direction:"horizontal"|"vertical"})',
  'tabs.detach': '({tabId})',
  'tabs.close': '({tabId}) — asks the owner to confirm; never closes the caller or its ancestors',
  'agents.list': '() — visible native sessions',
  'agents.snapshot': '({agentSessionId}) — recent native turn output and state',
  'agents.history': '({agentSessionId,afterSequence?}) — incremental native events',
  'agents.submit': '({agentSessionId,prompt}) — dispatch to a visible native tab with its existing permission settings',
  'agents.steer': '({agentSessionId,prompt}) — same steering/queue behavior as the user composer',
  'agents.interrupt': '({agentSessionId})',
  'agents.resume': '({agentSessionId}) ? reconnect an idle/disconnected native conversation with its existing settings',
  'agents.fork': '({agentSessionId,title?}) ? fork supported idle native history into a visible linked tab',
  'agents.release': '({agentSessionId}) — release this controller relationship',
  'files.list': '({query?}) — indexed project search, at most 100 matches with stable URIs',
  'files.read': '({path}) — UTF-8 text up to 1 MiB',
  'files.write': '({path,content,expectedContent}) — atomic compare-and-save; expectedContent:null creates a file; live views refresh',
  'files.open': '({path}) — open the file in a visible editor',
  'tasks.list': '() — feature-list.md tasks and revision',
  'tasks.update': '({revision,id,status?:"todo"|"doing"|"done",title?}) — optimistic update preserving markers and other agents’ claims',
  'memory.recall': '({query?})',
  'memory.remember': '({gist,kind?:"episodic"|"semantic"|"procedural",cues?:string[]}) — writes agent-owned memory',
  'memory.forget': '({id}) — agent-owned memory only; asks the owner to confirm',
  'orchestration.snapshot': '()',
  'orchestration.tasks.create': '({title,description?,priority?,status?,assignedAgentId?})',
  'orchestration.tasks.update': '({id,title?,description?,priority?,status?,assignedAgentId?})',
  'orchestration.routines.save': '({id?,name,description?,steps:[{title,instructions?,assignedAgentId?}]})',
  'workspace.rename': '({title})',
  'router.start': '({prompt,provider?,model?}) — create/reuse the project router definition, open its tab, dispatch the requested task',
  'router.dispatch': '({tasks:[{title,prompt,provider?,model?,effort?}]}) — one to four explicit assignments; choose actual catalog models per task; visible tabs and persisted orchestration tasks'
} as const

export interface AgentControlDependencies {
  database: ConductorDatabase
  sessions: StructuredSessions
  orchestration: OrchestrationStore
  collaboration: AgentCollaborationStore
  backlogs: ProjectBacklogs
  providers(): AgentProviderInfo[]
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

  private target(scope: AgentControlScope, id: string, mutate = false): AgentControlTab {
    const spec = this.deps.database.structured.spec<AgentSpec>(id)
    const tab = this.tabs(scope).find(tab => tab.kind === 'agent' && tab.resourceId === id)
    if (!tab || !spec || spec.projectId !== scope.projectId || spec.sessionId !== scope.sessionId) throw new Error('Agent is outside this workspace or has no visible tab')
    if (mutate) {
      const links = this.links(scope)
      const ancestors = new Set([scope.agentSessionId])
      for (let cursor = scope.agentSessionId; links.has(cursor);) {
        cursor = links.get(cursor)!
        if (ancestors.has(cursor)) break
        ancestors.add(cursor)
      }
      if (ancestors.has(id)) throw new Error('An agent cannot control itself or an ancestor')
      const owner = links.get(id)
      if (owner && owner !== scope.agentSessionId) throw new Error('Another agent already controls this tab; its controller must release it first')
    }
    return tab
  }

  private links(scope: AgentControlScope): Map<string, string> {
    return new Map(this.listLinks(scope.projectId, scope.sessionId).map(link => [link.targetAgentSessionId, link.controllerAgentSessionId]))
  }

  listLinks(projectId: string, sessionId: string): AgentControlLink[] {
    const tabs = this.tabs({ projectId, sessionId, agentSessionId: '' }), ids = new Set(tabs.map(tab => tab.resourceId))
    return tabs.flatMap(tab => {
      const stored = tab.resourceId && this.deps.database.getSetting('agentControlParent:' + tab.resourceId)
      if (!stored) return []
      try {
        const link = JSON.parse(stored) as AgentControlLink
        return link.projectId === projectId && link.sessionId === sessionId && ids.has(link.controllerAgentSessionId) && link.targetAgentSessionId === tab.resourceId ? [{ ...link, controllerTitle: tabs.find(tab => tab.resourceId === link.controllerAgentSessionId)?.title, controlledTitle: tab.title }] : []
      } catch { return [] }
    })
  }

  releaseByOwner(targetAgentSessionId: string): void {
    const spec = this.deps.database.structured.spec<AgentSpec>(targetAgentSessionId)
    if (!spec) throw new Error('Agent not found')
    const stored = this.deps.database.getSetting('agentControlParent:' + targetAgentSessionId)
    this.deps.database.removeSetting('agentControlParent:' + targetAgentSessionId)
    if (stored) {
      const link = JSON.parse(stored) as AgentControlLink
      this.deps.collaboration.postMessage({ projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: link.controllerAgentSessionId, toAgentSessionId: targetAgentSessionId, kind: 'handoff', body: 'The owner released this control relationship.', metadata: { control: 'detached', controllerTabId: link.controllerTabId, controlledTabId: link.controlledTabId } })
    }
    this.deps.linksChanged?.({ projectId: spec.projectId, sessionId: spec.sessionId })
  }

  private relationship(scope: AgentControlScope, tab: AgentControlTab, state: 'attached' | 'detached'): void {
    const source = this.tabs(scope).find(tab => tab.resourceId === scope.agentSessionId)
    if (state === 'attached') {
      const link: AgentControlLink = { projectId: scope.projectId, sessionId: scope.sessionId, controllerAgentSessionId: scope.agentSessionId, targetAgentSessionId: tab.resourceId!, controllerTabId: source!.id, controlledTabId: tab.id }
      this.deps.database.setSetting('agentControlParent:' + tab.resourceId, JSON.stringify(link))
    } else this.deps.database.removeSetting('agentControlParent:' + tab.resourceId)
    this.deps.linksChanged?.(scope)
    this.deps.collaboration.postMessage({ ...scope, toAgentSessionId: tab.resourceId, kind: 'handoff', body: state === 'attached' ? `Controlling ${tab.title}` : `Released ${tab.title}`, metadata: { control: state, controllerTabId: source?.id, controlledTabId: tab.id } })
  }

  private ui(scope: AgentControlScope, action: AgentControlUiRequest['action'], params: Args): Promise<unknown> {
    return this.deps.ui({ ...scope, id: randomUUID(), action, params })
  }

  private catalog(scope: AgentControlScope): Array<{ provider: StructuredProvider; available: boolean; source: 'runtime' | 'configured'; models: Array<{ id: string; label: string; effort?: string[]; defaultEffort?: string; isDefault?: boolean }> }> {
    return this.deps.providers().filter(provider => provider.id === 'codex' || provider.id === 'claude').map(provider => {
      const runtime = this.tabs(scope).filter(tab => tab.kind === 'agent' && tab.state?.provider === provider.id).map(tab => this.deps.database.structured.snapshot(tab.resourceId!)?.capabilities).find(capabilities => capabilities?.models.length)
      return { provider: provider.id as StructuredProvider, available: provider.available, source: runtime ? 'runtime' : 'configured', models: runtime?.models ?? provider.models.filter(model => !['default', 'auto'].includes(model.id)).map(model => ({ ...model, effort: provider.efforts.map(effort => effort.id).filter(id => id !== 'auto') })) }
    })
  }

  private async open(scope: AgentControlScope, args: Args): Promise<AgentControlTab> {
    const kind = (args.kind ?? 'agent') as PaneKind
    const allowed: PaneKind[] = ['agent', 'terminal', 'file-tree', 'browser', 'tasks', 'memory', 'routine', 'logs']
    if (!allowed.includes(kind)) throw new Error('Unsupported tab kind; use files.open for editors')
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
      tab.resourceId = makeId('agent')
      tab.title = args.title === undefined ? model.label : title
      tab.state = { provider, model: model.id, effort: effort ?? 'auto', viewMode: 'visual' }
      const spec: AgentSpec = { id: tab.resourceId, projectId: scope.projectId, sessionId: scope.sessionId, provider, model: model.id, title: tab.title, cwd: source.cwd }
      const result = this.deps.sessions.ensure(spec)
      if (!result.available) throw new Error(result.message || 'Provider unavailable')
      const sourceSettings = this.deps.database.structured.snapshot(scope.agentSessionId)!.settings
      const settings: SessionSettings = { ...this.deps.database.structured.snapshot(spec.id)!.settings, model: model.id, effort, permission: restricted(sourceSettings) && provider === 'codex' ? 'read-only' : 'default', ...(restricted(sourceSettings) && provider === 'codex' ? { sandbox: 'read-only' as const } : {}), plan: restricted(sourceSettings) && provider === 'claude' }
      this.deps.database.structured.update(spec.id, { settings })
    } else if (kind === 'terminal') tab.resourceId = makeId('terminal')
    await this.ui(scope, 'tabs.open', { tab })
    const opened = this.tab(scope, tab.id)
    if (kind === 'agent') this.relationship(scope, opened, 'attached')
    return opened
  }

  async call(scope: AgentControlScope, method: string, rawArgs: unknown = {}): Promise<unknown> {
    const source = this.authorize(scope), args = object(rawArgs), { database, sessions, backlogs, orchestration } = this.deps
    if (process.env.CONDUCTOR_LIVE_TESTS === '1') throw new Error('App control is disabled during isolated live acceptance tests')
    if (args.projectId !== undefined && args.projectId !== scope.projectId || args.sessionId !== undefined && args.sessionId !== scope.sessionId) throw new Error('Requested scope differs from the authorized session')
    if (method === 'tools.list') return toolSignatures
    if (method === 'app.state') return { project: database.getProject(scope.projectId), workspace: database.getSession(scope.sessionId), tabs: this.tabs(scope), relationships: [...this.links(scope)].map(([agentSessionId, controllerAgentSessionId]) => ({ agentSessionId, controllerAgentSessionId })) }
    if (method === 'models.list') return this.catalog(scope)
    if (method === 'tabs.list') return this.tabs(scope)
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
      if (method === 'tabs.close' && tab.kind === 'agent') this.relationship(scope, tab, 'detached')
      return result
    }
    if (method === 'agents.list') return this.tabs(scope).filter(tab => tab.kind === 'agent').map(tab => ({ tabId: tab.id, agentSessionId: tab.resourceId, title: tab.title, provider: tab.state?.provider, phase: database.structured.snapshot(tab.resourceId!)?.phase, uri: tab.uri }))
    if (method.startsWith('agents.')) {
      const id = text(args, 'agentSessionId', 160), mutate = !['agents.snapshot', 'agents.history'].includes(method)
      const tab = this.target(scope, id, mutate), state = database.structured.snapshot(id)!
      if (method === 'agents.snapshot') return { ...state, items: state.items.slice(-60) }
      if (method === 'agents.history') return database.structured.events(id, typeof args.afterSequence === 'number' && Number.isSafeInteger(args.afterSequence) && args.afterSequence >= 0 ? args.afterSequence : 0).slice(0, 100)
      if (method === 'agents.resume' || method === 'agents.fork') {
        if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings) && !restricted(state.settings)) throw new Error('A read-only controller cannot resume or fork a writable conversation')
        if (method === 'agents.resume') { await sessions.resume(id, state.settings); return { agentSessionId: id, phase: database.structured.snapshot(id)?.phase } }
        const forkId = await sessions.fork(id)
        const forkTab: PaneTab = { id: makeId('tab'), kind: 'agent', resourceId: forkId, title: args.title === undefined ? tab.title + ' (fork)' : text(args, 'title', 120), state: { ...tab.state, viewMode: 'visual' } }
        await this.ui(scope, 'tabs.open', { tab: forkTab })
        const opened = this.tab(scope, forkTab.id)
        this.relationship(scope, opened, 'attached')
        return opened
      }
      if (method === 'agents.release') { this.relationship(scope, tab, 'detached'); return { released: true } }
      if (method === 'agents.interrupt') { await sessions.interrupt(id); return { interrupted: true } }
      if (method === 'agents.submit' || method === 'agents.steer') {
        const prompt = text(args, 'prompt')
        if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings) && !restricted(state.settings)) throw new Error('A read-only controller cannot dispatch to a writable conversation')
        this.relationship(scope, tab, 'attached')
        try {
          if (method === 'agents.submit') await sessions.submit(id, prompt, state.settings)
          else await sessions.steer(id, prompt, state.settings)
        } catch (error) { this.relationship(scope, tab, 'detached'); throw error }
        return { agentSessionId: id, tabId: tab.id, uri: tab.uri, phase: database.structured.snapshot(id)?.phase }
      }
    }
    if (method === 'files.list') return (await searchProjectFiles([database.getProject(scope.projectId)!], typeof args.query === 'string' ? args.query.slice(0, 300) : '')).map(file => ({ ...file, uri: conductorUri(scope.projectId, 'file', file.path) }))
    if (['files.read', 'files.write', 'files.open'].includes(method)) {
      const path = await workspacePath(source.cwd, text(args, 'path', 4000), method === 'files.write')
      if (method !== 'files.write' && (!statSync(path).isFile() || statSync(path).size > 1024 * 1024)) throw new Error('Only text files up to 1 MiB are supported')
      // Match workspacePath's native resolver, including Windows 8.3 folder aliases.
      const relativePath = relative(await realpath(source.cwd), path).replaceAll('\\', '/')
      this.authorize(scope)
      if (method === 'files.open') return this.ui(scope, 'files.open', { path: relativePath })
      if (method === 'files.read') return { path: relativePath, content: readEditorFile(path), uri: conductorUri(scope.projectId, 'file', relativePath) }
      if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 1024 * 1024 || !(args.expectedContent === null || typeof args.expectedContent === 'string' && Buffer.byteLength(args.expectedContent) <= 1024 * 1024)) throw new Error('Provide content and the exact expectedContent (null for a new file), up to 1 MiB')
      const lease = this.deps.collaboration.announcePresence({ ...scope, path: relativePath, intent: args.expectedContent === null ? 'create' : 'edit', ttlSeconds: 90 })
      if (!lease.granted) throw new Error('Another agent holds an active edit lease for this file')
      const saved = writeEditorFile(path, args.content, args.expectedContent)
      if (saved.status === 'saved') { invalidateProjectFiles(source.cwd); this.deps.fileChanged({ ...scope, path: relativePath }) }
      return saved
    }
    if (method === 'tasks.list') return backlogs.get(scope.projectId)
    if (method === 'tasks.update') {
      if (restricted(database.structured.snapshot(scope.agentSessionId)?.settings)) throw new Error('This conversation is read-only or planning')
      const board = await backlogs.get(scope.projectId), id = text(args, 'id', 160), task = board.tasks.find(task => task.id === id)
      if (!task) throw new Error('Task not found')
      if (task.agentId && task.agentId !== scope.agentSessionId && task.status === 'doing') throw new Error('Another agent owns this task')
      const status = args.status === undefined ? task.status : args.status
      if (!['todo', 'doing', 'done'].includes(String(status))) throw new Error('Invalid task status')
      const updated = await backlogs.edit(scope.projectId, text(args, 'revision', 100), { type: 'update', id, status: status as 'todo' | 'doing' | 'done', ...(args.title === undefined ? {} : { title: text(args, 'title', 8000) }), agentId: scope.agentSessionId })
      this.deps.fileChanged({ ...scope, path: 'feature-list.md' })
      return updated
    }
    if (method === 'memory.recall') return database.recall(scope.projectId, typeof args.query === 'string' ? args.query.slice(0, 4000) : '', undefined, 12)
    if (method === 'memory.remember') {
      const kind = args.kind ?? 'semantic'
      if (!['episodic', 'semantic', 'procedural'].includes(String(kind))) throw new Error('Invalid memory kind')
      if (args.cues !== undefined && (!Array.isArray(args.cues) || args.cues.length > 20 || args.cues.some(cue => typeof cue !== 'string' || cue.length > 160))) throw new Error('Invalid memory cues')
      return database.remember({ projectId: scope.projectId, kind: kind as 'semantic', source: 'agent', gist: text(args, 'gist', 4000), cues: args.cues as string[] | undefined })
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
    const requests = args.tasks.map(value => { const task = object(value); text(task, 'title', 120); text(task, 'prompt'); return task })
    const results: unknown[] = []
    for (const request of requests) {
      const tab = await this.open(scope, { ...request, kind: 'agent' })
      const assigned = this.deps.orchestration.saveAgent({ projectId: scope.projectId, name: tab.title, provider: tab.state!.provider as StructuredProvider, model: String(tab.state!.model), role: 'Routed coworker', instructions: String(request.prompt) })
      const task = this.deps.orchestration.createTask({ projectId: scope.projectId, title: String(request.title), description: String(request.prompt), status: 'in_progress', assignedAgentId: assigned.id })
      try {
        await this.call(scope, 'agents.submit', { agentSessionId: tab.resourceId, prompt: String(request.prompt) + '\n\nConductor orchestration task: ' + task.id + '. Mark it done with orchestration.tasks.update only after finishing. Your controller is ' + scope.agentSessionId + '; coordinate through the provided app protocol.' })
        results.push({ tabId: tab.id, agentSessionId: tab.resourceId, taskId: task.id, provider: tab.state!.provider, model: tab.state!.model, uri: tab.uri })
      } catch (error) {
        this.deps.orchestration.updateTask(task.id, { status: 'blocked' })
        results.push({ tabId: tab.id, taskId: task.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }
}
