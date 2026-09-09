import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { AgentControlUiRequest, AgentFileChange } from '../shared/agent-control'
import { conductorUri } from '../shared/agent-control'
import { makeId, type AgentSpec, type LayoutNode, type PaneTab } from '../shared/models'
import type { PromptOrigin, SessionSettings, StructuredProvider } from '../shared/structured-agent'
import { LOCAL_MACHINE_ID, type RemotePeerRecord } from '../shared/remote-control'
import { projectTaskPriorities, type ProjectTaskPriority } from '../shared/project-backlog'
import { workspacePath } from './agent-artifacts'
import type { ConductorDatabase } from './database'
import { writeEditorFile } from './editor-files'
import type { ProjectBacklogs } from './project-backlog'
import { invalidateProjectFiles, searchProjectFiles } from './project-file-search'
import { RemoteAccessError, type RemotePeers } from './remote-peers'
import type { StructuredSessions } from './structured-sessions'
import { readTextFile } from './text-files'

type Args = Record<string, unknown>

const text = (args: Args, key: string, maximum = 20000): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new RemoteAccessError(`Invalid ${key}`, 400)
  return value
}

/**
 * Deliberately narrower than the local agent surface. A paired machine can work inside the
 * projects it was granted and drive agent tabs there; it has no shell, no arbitrary path access,
 * and no way to reach a project the owner did not share.
 */
export const remoteToolSignatures = {
  'machine.describe': '() — this machine, the projects it shares with you and the tabs it is running',
  'projects.list': '() — only the projects this machine shared with you',
  'workspaces.list': '({projectId})',
  'tabs.list': '({projectId,sessionId})',
  'tabs.open': '({projectId,sessionId,kind?,provider?,model?,effort?,title?,permission?}) — opens a visible tab on this machine',
  'tabs.focus': '({projectId,sessionId,tabId})',
  'tabs.close': '({projectId,sessionId,tabId})',
  'agents.list': '({projectId,sessionId})',
  'agents.snapshot': '({projectId,sessionId,agentSessionId})',
  'agents.history': '({projectId,sessionId,agentSessionId,afterSequence?}) — incremental events, for mirroring the tab remotely',
  'agents.submit': '({projectId,sessionId,agentSessionId,prompt})',
  'agents.steer': '({projectId,sessionId,agentSessionId,prompt})',
  'agents.interrupt': '({projectId,sessionId,agentSessionId})',
  'files.list': '({projectId,query?}) — indexed search inside the shared project only',
  'files.read': '({projectId,path})',
  'files.write': '({projectId,path,content,expectedContent})',
  'files.open': '({projectId,sessionId,path})',
  'tasks.list': '({projectId})',
  'tasks.update': '({projectId,revision,id,status?,title?,priority?})'
} as const

export interface RemoteControlHostDependencies {
  database: ConductorDatabase
  sessions: StructuredSessions
  backlogs: ProjectBacklogs
  peers: RemotePeers
  providers(): Array<{ id: string; available: boolean; models: Array<{ id: string; label: string; isDefault?: boolean }> }>
  ui(request: AgentControlUiRequest): Promise<unknown>
  fileChanged(change: AgentFileChange): void
  machineName(): string
}

/** Serves one authenticated peer's calls against this machine's own projects. */
export class RemoteControlHost {
  constructor(private readonly deps: RemoteControlHostDependencies) {}

  private workspace(peer: RemotePeerRecord, args: Args): { projectId: string; sessionId: string } {
    const project = this.deps.peers.requireProject(peer, args.projectId)
    const sessionId = text(args, 'sessionId', 160)
    const workspace = this.deps.database.getSession(sessionId)
    if (workspace?.projectId !== project.id) throw new RemoteAccessError('That workspace is not in the shared project.', 403)
    return { projectId: project.id, sessionId }
  }

  private tabs(projectId: string, sessionId: string): Array<PaneTab & { groupId: string; detachedId?: string; uri: string }> {
    const workspace = this.deps.database.getSession(sessionId)
    if (workspace?.projectId !== projectId) throw new RemoteAccessError('That workspace is not in the shared project.', 403)
    const tabs: Array<PaneTab & { groupId: string; detachedId?: string; uri: string }> = []
    const visit = (node: LayoutNode, detachedId?: string): void => {
      if (node.type === 'split') { node.children.forEach(child => visit(child, detachedId)); return }
      node.tabs.forEach(tab => tabs.push({ ...tab, groupId: node.id, ...(detachedId ? { detachedId } : {}), uri: conductorUri(projectId, 'tab', tab.id) }))
    }
    visit(workspace.layout.root)
    for (const window of this.deps.database.listDetachedWindows()) {
      if (window.projectId === projectId && window.sessionId === sessionId) visit(window.layout.root, window.id)
    }
    return tabs
  }

  private ui(projectId: string, sessionId: string, action: AgentControlUiRequest['action'], params: Args): Promise<unknown> {
    return this.deps.ui({ projectId, sessionId, agentSessionId: '', id: randomUUID(), action, params })
  }

  private agentTab(projectId: string, sessionId: string, agentSessionId: string): PaneTab & { uri: string } {
    const tab = this.tabs(projectId, sessionId).find(candidate => candidate.kind === 'agent' && candidate.resourceId === agentSessionId)
    if (!tab) throw new RemoteAccessError('That agent tab is not open in the shared workspace.', 404)
    return tab
  }

  /**
   * Runs a peer's call. Every branch records what happened so the owner sees remote work in this
   * machine's UI with the same weight as a local agent's actions.
   */
  async call(peer: RemotePeerRecord, method: string, rawArgs: unknown): Promise<unknown> {
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Args
    if (process.env.CONDUCTOR_LIVE_TESTS === '1') throw new RemoteAccessError('Remote control is disabled during isolated live acceptance tests.', 503)
    // `in` would also accept every inherited key, so `constructor` and friends would pass here.
    if (!Object.hasOwn(remoteToolSignatures, method) && method !== 'tools.list') throw new RemoteAccessError('Unknown remote method; use tools.list.', 400)
    try {
      const result = await this.dispatch(peer, method, args)
      this.deps.peers.record(peer, method, typeof args.projectId === 'string' ? args.projectId : null, this.describe(method, args), 'allowed')
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.peers.record(peer, method, typeof args.projectId === 'string' ? args.projectId : null, this.describe(method, args), 'denied', message)
      throw error
    }
  }

  private describe(method: string, args: Args): string {
    const path = typeof args.path === 'string' ? ` ${args.path}` : ''
    const title = typeof args.title === 'string' ? ` “${args.title}”` : ''
    return `${method}${path}${title}`
  }

  private async dispatch(peer: RemotePeerRecord, method: string, args: Args): Promise<unknown> {
    const { database, backlogs, sessions } = this.deps
    if (method === 'tools.list') return remoteToolSignatures
    if (method === 'machine.describe') {
      return {
        machineId: this.deps.peers.machineId,
        machineName: this.deps.machineName(),
        observedAt: new Date().toISOString(),
        projects: peer.grantedProjectIds.flatMap(id => { const project = database.getProject(id); return project ? [{ id: project.id, name: project.name, path: project.path }] : [] }),
        providers: this.deps.providers().filter(provider => provider.available).map(provider => ({ id: provider.id, models: provider.models.map(model => model.id) }))
      }
    }
    if (method === 'projects.list') {
      return peer.grantedProjectIds.flatMap(id => { const project = database.getProject(id); return project ? [{ id: project.id, name: project.name, path: project.path }] : [] })
    }
    if (method === 'workspaces.list') {
      const project = this.deps.peers.requireProject(peer, args.projectId)
      return database.listSessions(project.id).map(workspace => ({ id: workspace.id, name: workspace.name, projectId: workspace.projectId }))
    }
    if (method === 'files.list') {
      const project = this.deps.peers.requireProject(peer, args.projectId)
      const query = typeof args.query === 'string' ? args.query.slice(0, 300) : ''
      return (await searchProjectFiles([database.getProject(project.id)!], query, { showHidden: true })).map(file => ({ ...file, uri: conductorUri(project.id, 'file', file.path) }))
    }
    if (method === 'files.read' || method === 'files.write' || method === 'files.open') {
      const project = this.deps.peers.requireProject(peer, args.projectId)
      // workspacePath is the same containment check local agents get; it refuses anything that
      // resolves outside the project folder, including through symlinks and 8.3 aliases.
      const path = await workspacePath(project.path, text(args, 'path', 4000), method === 'files.write')
      if (method !== 'files.write' && (!statSync(path).isFile() || statSync(path).size > 1024 * 1024)) throw new RemoteAccessError('Only text files up to 1 MiB are supported.', 400)
      const relativePath = relative(await realpath(project.path), path).replaceAll('\\', '/')
      if (method === 'files.open') {
        const { sessionId } = this.workspace(peer, args)
        return this.ui(project.id, sessionId, 'files.open', { path: relativePath })
      }
      if (method === 'files.read') return { path: relativePath, content: readTextFile(path), uri: conductorUri(project.id, 'file', relativePath) }
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 1024 * 1024
        || !(args.expectedContent === null || typeof args.expectedContent === 'string' && Buffer.byteLength(args.expectedContent) <= 1024 * 1024)) {
        throw new RemoteAccessError('Provide content and the exact expectedContent (null for a new file), up to 1 MiB.', 400)
      }
      const saved = writeEditorFile(path, args.content, args.expectedContent)
      if (saved.status === 'saved') { invalidateProjectFiles(project.path); this.deps.fileChanged({ projectId: project.id, path: relativePath }) }
      return saved
    }
    if (method === 'tasks.list') return backlogs.get(this.deps.peers.requireProject(peer, args.projectId).id)
    if (method === 'tasks.update') {
      const project = this.deps.peers.requireProject(peer, args.projectId)
      const board = await backlogs.get(project.id), id = text(args, 'id', 160)
      const task = board.tasks.find(entry => entry.id === id)
      if (!task) throw new RemoteAccessError('Task not found.', 404)
      const status = args.status === undefined ? task.status : args.status
      if (!['todo', 'doing', 'done'].includes(String(status))) throw new RemoteAccessError('Invalid task status.', 400)
      if (args.priority !== undefined && !projectTaskPriorities.includes(args.priority as ProjectTaskPriority)) throw new RemoteAccessError('Invalid task priority.', 400)
      const updated = await backlogs.edit(project.id, text(args, 'revision', 100), {
        type: 'update', id, status: status as 'todo' | 'doing' | 'done',
        ...(args.title === undefined ? {} : { title: text(args, 'title', 8000) }),
        ...(args.priority === undefined ? {} : { priority: args.priority as ProjectTaskPriority })
      })
      this.deps.fileChanged({ projectId: project.id, path: 'feature-list.md' })
      return updated
    }
    const { projectId, sessionId } = this.workspace(peer, args)
    if (method === 'tabs.list') return this.tabs(projectId, sessionId)
    if (method === 'tabs.open') return this.open(peer, projectId, sessionId, args)
    if (method === 'tabs.focus' || method === 'tabs.close') {
      const tabId = text(args, 'tabId', 160)
      if (!this.tabs(projectId, sessionId).some(tab => tab.id === tabId)) throw new RemoteAccessError('That tab is no longer open.', 404)
      return this.ui(projectId, sessionId, method, { tabId })
    }
    if (method === 'agents.list') {
      return this.tabs(projectId, sessionId).filter(tab => tab.kind === 'agent').map(tab => {
        const snapshot = database.structured.snapshot(tab.resourceId!)
        return { tabId: tab.id, agentSessionId: tab.resourceId, title: tab.title, uri: tab.uri, machineId: LOCAL_MACHINE_ID, phase: snapshot?.phase, provider: tab.state?.provider, model: snapshot?.settings.model }
      })
    }
    if (method.startsWith('agents.')) {
      const agentSessionId = text(args, 'agentSessionId', 160)
      const tab = this.agentTab(projectId, sessionId, agentSessionId)
      const state = database.structured.snapshot(agentSessionId)
      if (!state) throw new RemoteAccessError('That agent session is not available.', 404)
      if (method === 'agents.snapshot') {
        const recent = [...state.items].sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence)).slice(0, 60)
        return { tabId: tab.id, agentSessionId, machineId: LOCAL_MACHINE_ID, ...state, items: recent.sort((a, b) => a.sequence - b.sequence), truncated: state.truncated || state.items.length > recent.length }
      }
      if (method === 'agents.history') {
        const after = typeof args.afterSequence === 'number' && Number.isSafeInteger(args.afterSequence) && args.afterSequence >= 0 ? args.afterSequence : 0
        return database.structured.events(agentSessionId, after).slice(0, 100)
      }
      if (method === 'agents.interrupt') { await sessions.interrupt(agentSessionId); return { interrupted: true } }
      if (method === 'agents.submit' || method === 'agents.steer') {
        const prompt = text(args, 'prompt')
        // Attributed to the peer machine, never to "You", so the owner can always tell remote
        // work apart in the transcript.
        const origin: PromptOrigin = { agentSessionId: `remote:${peer.id}`, label: `${peer.machineName} (remote)` }
        if (method === 'agents.submit') await sessions.submit(agentSessionId, prompt, state.settings, [], origin)
        else await sessions.steer(agentSessionId, prompt, state.settings, [], origin)
        return { agentSessionId, tabId: tab.id, uri: tab.uri, phase: database.structured.snapshot(agentSessionId)?.phase }
      }
    }
    throw new RemoteAccessError('Unknown remote method; use tools.list.', 400)
  }

  /**
   * Opens a real, visible tab on this machine. The remote caller never gets more autonomy than it
   * asks for and the peer's machine is stamped on the tab so the owner can see whose work it is.
   */
  private async open(peer: RemotePeerRecord, projectId: string, sessionId: string, args: Args): Promise<unknown> {
    const kind = args.kind === undefined ? 'agent' : String(args.kind)
    // A terminal tab is a PTY on this machine, and the approval prompt promises a peer no shell.
    // Kinds a peer may open are listed here rather than excluded, so a new tab kind is opt-in.
    if (!['agent', 'file-tree', 'tasks', 'logs'].includes(kind)) throw new RemoteAccessError('Unsupported remote tab kind.', 400)
    const project = this.deps.database.getProject(projectId)
    if (!project) throw new RemoteAccessError('That project is no longer registered on this machine.', 404)
    const tab: PaneTab = { id: makeId('tab'), kind: kind as PaneTab['kind'], title: args.title === undefined ? (kind === 'agent' ? 'Agent' : kind) : text(args, 'title', 120) }
    if (kind === 'agent') {
      const provider = String(args.provider ?? 'codex') as StructuredProvider
      const entry = this.deps.providers().find(candidate => candidate.id === provider && candidate.available)
      if (!entry) throw new RemoteAccessError('That provider is not available on this machine.', 409)
      const model = typeof args.model === 'string'
        ? entry.models.find(candidate => candidate.id === args.model)
        : entry.models.find(candidate => candidate.isDefault) ?? entry.models[0]
      if (!model) throw new RemoteAccessError('Choose a model this machine offers.', 400)
      tab.resourceId = makeId('agent')
      tab.title = args.title === undefined ? model.label : tab.title
      tab.state = { provider, model: model.id, effort: typeof args.effort === 'string' ? args.effort : 'auto', viewMode: 'visual', machineId: LOCAL_MACHINE_ID, remotePeerId: peer.id, remoteMachineName: peer.machineName }
      const spec: AgentSpec = { id: tab.resourceId, projectId, sessionId, provider, model: model.id, title: tab.title, cwd: project.path }
      const created = this.deps.sessions.ensure(spec)
      if (!created.available) throw new RemoteAccessError(created.message || 'Provider unavailable on this machine.', 409)
      const snapshot = this.deps.database.structured.snapshot(spec.id)!
      // A remote caller cannot hand itself more permission than the owner granted; anything
      // beyond the default has to be chosen on this machine.
      const settings: SessionSettings = { ...snapshot.settings, model: model.id, permission: 'default' }
      this.deps.database.structured.update(spec.id, { settings })
    }
    await this.ui(projectId, sessionId, 'tabs.open', { tab })
    const opened = this.tabs(projectId, sessionId).find(candidate => candidate.id === tab.id)
    if (!opened) throw new RemoteAccessError('The tab was not opened on this machine.', 500)
    return opened
  }
}
