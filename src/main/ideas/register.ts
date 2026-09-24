import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { globalShortcut, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { DurableJobsService } from '../../shared/durable-jobs'
import { IDEA_CAPTURE_ACCELERATOR, IDEAS_IPC, type IdeaLink } from '../../shared/ideas'
import { DEFAULT_LOCAL_MODEL } from '../../shared/local-models'
import { makeId, type AgentSpec, type PaneTab, type ProjectRecord } from '../../shared/models'
import type { AgentControlUiRequest } from '../../shared/agent-control'
import type { AgentControl } from '../agent-control'
import type { ConductorDatabase } from '../database'
import { observeProjection } from '../durable-jobs/structured-runtime'
import { loadConfig } from '../local-models/config'
import { registerPhoneApiRoute } from '../phone-access-server'
import type { ProjectBacklogs } from '../project-backlog'
import { IDEA_INCUBATOR_BUILTIN, createIdeaIncubatorExecutor } from '../schedule-builtins/idea-incubator'
import type { ScheduleStore } from '../schedule-store'
import { registerScheduleKindExecutor } from '../schedule-wiring'
import { localServerTargets } from '../system-metrics'
import { ideaMethods, ideaSignatures, ideasCall, type IdeasControlCaller } from './control'
import { IdeaExplorer } from './explore'
import { ideasPhoneRoute } from './phone'
import { IdeasService } from './service'
import { IdeaStore } from './store'

export interface IdeasRegistrationDeps {
  databasePath: string
  database: ConductorDatabase
  control: AgentControl
  ui(request: AgentControlUiRequest): Promise<unknown>
  jobs(): DurableJobsService | undefined
  backlogs: ProjectBacklogs
  schedules: ScheduleStore
  /** Broadcast to every window (index.ts `publish`). */
  publish(channel: string, payload: unknown): void
  /** The window the capture shortcut raises. */
  window(): BrowserWindow | null
  /** A parked test launch (CONDUCTOR_TEST_USER_DATA): no global shortcut, never take focus. */
  background: boolean
  /** This machine's name as the Machines list shows it; default: the host name. */
  machine?(): string
}

/** What agent-control needs to serve ideas.* (see the report in docs/ideas.md). */
export interface IdeasControl {
  signatures: Record<string, string>
  methods: ReadonlySet<string>
  call(caller: IdeasControlCaller, method: string, args: unknown): Promise<unknown>
}

export interface IdeasRegistration {
  service: IdeasService
  control: IdeasControl
  /** The renderer IPC, registered where index.ts's trusted-sender check (`trustedStructured`) lives. */
  registerIpc(authorize: (event: IpcMainInvokeEvent) => void): () => void
  dispose(): void
}

const localProject = (project: ProjectRecord | null | undefined): project is ProjectRecord => Boolean(project && !project.remote)

/** The project an exploration or the incubator lives in when an idea links none. */
export function homeProjectId(database: ConductorDatabase): string | null {
  const projects = database.listProjects().filter(localProject)
  const conductor = projects.find(project => {
    try { return (JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8')) as { name?: string }).name === 'conductor-desktop' } catch { return false }
  })
  return conductor?.id ?? database.listDeskProjects().find(localProject)?.id ?? projects[0]?.id ?? null
}

function localModels(): { configured: string[]; loaded: string | null } {
  let configured: string[] = []
  try {
    const models = loadConfig().models
    configured = [...new Set([DEFAULT_LOCAL_MODEL, ...Object.keys(models)])].filter(id => models[id])
  } catch { configured = [] }
  let loaded: string | null = null
  try { loaded = localServerTargets().find(server => server.running)?.model ?? null } catch { loaded = null }
  return { configured, loaded }
}

/**
 * Builds Ideas and plugs it into the app: the store beside the other tables in conductor.db, the
 * renderer IPC, the global capture shortcut, the phone's /api/ideas, the Idea Incubator's
 * executor and seed, and the job listener that turns finished explorations into briefs.
 */
export function registerIdeas(deps: IdeasRegistrationDeps): IdeasRegistration {
  const { database, control } = deps
  const store = new IdeaStore(deps.databasePath)
  const machine = (): string => { try { return deps.machine?.() || hostname() } catch { return hostname() } }
  const explorer = new IdeaExplorer({
    store, jobs: deps.jobs, localModels,
    homeProjectId: () => homeProjectId(database),
    projectExists: projectId => localProject(database.getProject(projectId)),
    relatedMemories: text => service.relatedMemories(text),
    lastAnswer: agentSessionId => observeProjection(database.structured.snapshot(agentSessionId), undefined).lastAnswer,
    get machine() { return machine() }
  })

  const openConversation = async (projectId: string, agentSessionId: string, title: string): Promise<void> => {
    const spec = database.structured.spec<AgentSpec>(agentSessionId)
    if (!spec || spec.projectId !== projectId) throw new Error('That conversation is no longer available')
    const workspaceId = database.listSessions(projectId).find(workspace => workspace.id === spec.sessionId)?.id ?? database.listSessions(projectId)[0]?.id
    if (!workspaceId) throw new Error('Open a workspace in that project first')
    const scope = { projectId, sessionId: workspaceId, agentSessionId: '' }
    const existing = control.tabs(scope).find(tab => tab.resourceId === agentSessionId)
    if (existing) { await deps.ui({ ...scope, id: randomUUID(), action: 'tabs.focus', params: { tabId: existing.id } }); return }
    const tab: PaneTab = { id: makeId('tab'), kind: 'agent', resourceId: agentSessionId, title: title.slice(0, 120), state: { provider: spec.provider, model: database.structured.snapshot(agentSessionId)?.settings.model ?? spec.model, viewMode: 'visual' } }
    await deps.ui({ ...scope, id: randomUUID(), action: 'tabs.open', params: { tab } })
  }

  const open = async (link: IdeaLink): Promise<void> => {
    if (link.kind === 'agent-session' && link.projectId) return openConversation(link.projectId, link.targetId, link.label)
    if (link.kind === 'job') { await control.call(control.ownerScope(link.projectId ? { projectId: link.projectId } : {}), 'tabs.open', { kind: 'job', jobId: link.targetId }); return }
    if (link.kind === 'artifact') {
      if (/^https?:\/\//i.test(link.targetId)) { await shell.openExternal(link.targetId); return }
      const project = link.projectId ? database.getProject(link.projectId) : null
      const path = isAbsolute(link.targetId) ? link.targetId : localProject(project) ? join(project.path, link.targetId) : null
      if (!path || !existsSync(path)) throw new Error('That file is no longer there')
      const failure = await shell.openPath(path)
      if (failure) throw new Error(failure)
      return
    }
    throw new Error(link.kind === 'task' ? 'Open Project tasks in that project to see the task' : 'There is nothing to open for this link')
  }

  const service: IdeasService = new IdeasService({
    store, explorer,
    memories: () => database.listProjects().flatMap(project => database.listMemories(project.id)),
    projectTitle: projectId => { const project = database.getProject(projectId); return project ? project.name : null },
    async openAgent(request) {
      const owner = control.ownerScope({ projectId: request.projectId })
      const opened = await control.call(owner, 'tabs.open', { provider: request.provider, ...(request.model ? { model: request.model } : {}), title: request.title }) as { id: string; resourceId?: string }
      if (!opened.resourceId) throw new Error('The agent tab did not open')
      await control.call(owner, 'agents.submit', { agentSessionId: opened.resourceId, prompt: request.prompt })
      return { agentSessionId: opened.resourceId, tabId: opened.id }
    },
    async addTask(projectId, title) {
      const query = { query: title, includeDone: true, includeArchived: true, limit: 200 }
      const before = await deps.backlogs.get(projectId, query)
      const known = new Set(before.tasks.map(task => task.id))
      const after = await deps.backlogs.edit(projectId, before.revision, { type: 'add', title, kind: 'idea' }, { actor: 'you' }, query)
      const added = after.tasks.find(task => !known.has(task.id))
      if (!added) throw new Error('The task was added but could not be found again; refresh Project tasks')
      return { taskId: added.id, title: added.title }
    },
    open
  })

  const disposers: Array<() => void> = []
  disposers.push(store.onChange(change => deps.publish(IDEAS_IPC.changed, change)))

  const registerIpc = (authorize: (event: IpcMainInvokeEvent) => void): (() => void) => {
    const channels: string[] = []
    const handle = (channel: string, listener: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args) => { authorize(event); return listener(...args) })
      channels.push(channel)
    }
    handle(IDEAS_IPC.list, query => service.list(query ?? {}))
    handle(IDEAS_IPC.get, ideaId => service.get(ideaId))
    handle(IDEAS_IPC.capture, input => service.capture({ text: input?.text, source: 'desktop' }))
    handle(IDEAS_IPC.update, (ideaId, input) => service.update(ideaId, input ?? {}))
    handle(IDEAS_IPC.work, input => service.work(input ?? {}))
    handle(IDEAS_IPC.explore, input => service.explore(input ?? {}, 'owner'))
    handle(IDEAS_IPC.createTask, input => service.createTask(input ?? {}))
    handle(IDEAS_IPC.unlink, (ideaId, linkId) => service.unlink(ideaId, linkId))
    handle(IDEAS_IPC.incubator, () => service.incubator())
    handle(IDEAS_IPC.setIncubator, settings => service.setIncubator(settings ?? {}))
    handle(IDEAS_IPC.openLink, (ideaId, linkId) => service.openLink(ideaId, linkId))
    return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
  }

  // The capture shortcut works from anywhere, like a notes app's quick note. A parked test launch
  // must not take the owner's keys or raise a window.
  if (!deps.background) {
    const capture = (): void => {
      const window = deps.window()
      if (!window || window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      window.webContents.send(IDEAS_IPC.captureRequested)
    }
    try {
      if (globalShortcut.register(IDEA_CAPTURE_ACCELERATOR, capture)) disposers.push(() => globalShortcut.unregister(IDEA_CAPTURE_ACCELERATOR))
      else console.warn(`Ideas: ${IDEA_CAPTURE_ACCELERATOR} is taken by another application; use the title-bar lightbulb or the palette`)
    } catch (error) { console.warn('Ideas: capture shortcut unavailable', error) }
  }

  disposers.push(registerPhoneApiRoute('/api/ideas', (method, path, body, query, device) => ideasPhoneRoute(service, method, path, body, query, device)))
  disposers.push(registerScheduleKindExecutor('idea-incubator', createIdeaIncubatorExecutor({ store, explore: (ideaId, intensity) => service.explore({ ideaId, intensity }, 'incubator') })))
  const home = homeProjectId(database)
  if (home) {
    try { deps.schedules.ensureBuiltin(home, IDEA_INCUBATOR_BUILTIN) } catch (error) { console.warn('Ideas: the Idea Incubator task could not be seeded', error) }
  }
  disposers.push(explorer.attach())

  return {
    service,
    control: { signatures: ideaSignatures, methods: ideaMethods, call: (caller, method, args) => ideasCall(service, caller, method, args) },
    registerIpc,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) { try { dispose() } catch { /* shutting down */ } }
      store.close()
    }
  }
}
