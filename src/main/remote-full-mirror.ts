import type { PaneTab, SessionRecord, WorkspaceLayout } from '../shared/models'
import type { RemoteSessionBinding } from './remote-session-mirror'

/**
 * A host workspace shown as a workspace here. `remoteName` is the host's name for it when it was
 * last seen, so a rename there is followed here only while the owner has not renamed it here.
 * `dismissed` is the owner closing that workspace here: it is never created again by itself.
 */
export interface WorkspaceMirrorEntry {
  machineId: string
  remoteProjectId: string
  remoteSessionId: string
  localSessionId: string
  remoteName: string
  dismissed?: true
}

const WORKSPACES_SETTING = 'remote-control.workspaceMirrors'
const DISMISSED_SETTING = 'remote-control.mirrorDismissed'
const DISMISSED_LIMIT = 1000
const WORKSPACE_LIMIT = 50
const SYNC_DEBOUNCE_MS = 500

type Provider = RemoteSessionBinding['provider']
const mirroredProviders = new Set<string>(['claude', 'codex', 'local'])

export function readWorkspaceMirrors(raw: string | null | undefined): WorkspaceMirrorEntry[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Partial<WorkspaceMirrorEntry>
    if ([value.machineId, value.remoteProjectId, value.remoteSessionId, value.localSessionId].some(field => typeof field !== 'string' || !field)) return []
    return [{
      machineId: value.machineId!, remoteProjectId: value.remoteProjectId!, remoteSessionId: value.remoteSessionId!, localSessionId: value.localSessionId!,
      remoteName: typeof value.remoteName === 'string' ? value.remoteName : '',
      ...(value.dismissed === true ? { dismissed: true as const } : {})
    }]
  })
}

/** A host conversation as `agents.list` names it there. */
interface HostTab { tabId: string; agentSessionId: string; title: string; provider: Provider }

/** A workspace whose layout this sync writes itself, because the window has not seen it yet. */
interface FreshWorkspace { session: SessionRecord; tabs: PaneTab[] }

/**
 * Puts tabs into a layout the window has not loaded yet: a layout that is only the launcher gives
 * the launcher's place to them, anything else gets them added to its first group. The last one is
 * selected, as opening them one by one would have left it.
 */
export function seedLayout(layout: WorkspaceLayout, tabs: readonly PaneTab[]): WorkspaceLayout {
  if (!tabs.length) return layout
  const first = (node: WorkspaceLayout['root']): Extract<WorkspaceLayout['root'], { type: 'group' }> =>
    node.type === 'group' ? node : first(node.children[0]!)
  const target = first(layout.root)
  const launcherOnly = target.tabs.every(tab => tab.kind === 'launcher')
  const replaced = { ...target, tabs: launcherOnly ? [...tabs] : [...target.tabs, ...tabs], activeTabId: tabs[tabs.length - 1]!.id }
  const swap = (node: WorkspaceLayout['root']): WorkspaceLayout['root'] =>
    node === target ? replaced : node.type === 'group' ? node : { ...node, children: [swap(node.children[0]), swap(node.children[1])] }
  return { ...layout, root: swap(layout.root) }
}

export interface RemoteFullMirrorDependencies {
  database: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string): void
    listSessions(projectId: string): SessionRecord[]
    createSession(projectId: string, name?: string): SessionRecord
    renameSession(sessionId: string, name: string): void
    saveSession(sessionId: string, layout: WorkspaceLayout, maximizedGroupId: string | null, closedTabs: PaneTab[]): void
  }
  /** Calls one method on a host; the client enforces pairing and identity. */
  call(machineId: string, method: string, args: Record<string, unknown>): Promise<unknown>
  /**
   * The hosts that mirror everything to this machine and are reachable now, with the projects of
   * theirs adopted here. A host that does not mirror, is detached or revoked is not listed, and is
   * left exactly as the owner arranged it.
   */
  hosts(): Array<{ machineId: string; machineName: string; projects: Array<{ localProjectId: string; remoteProjectId: string }> }>
  mirror: {
    list(): RemoteSessionBinding[]
    bind(binding: RemoteSessionBinding): RemoteSessionBinding
    release(localSessionId: string): void
    start(): void
  }
  /** The host's folder for a project, as it advertises it; a conversation is journaled under it. */
  cwdFor(machineId: string, remoteProjectId: string): Promise<string | null>
  /** Opens a prepared tab in a workspace the window already knows, in the background. */
  openTab(scope: { projectId: string; sessionId: string }, tab: PaneTab): Promise<void>
  /** Closes the tab showing a conversation in a workspace, if one does. */
  closeTab(scope: { projectId: string; sessionId: string }, localSessionId: string): Promise<void>
  /** A project's workspace list changed behind the window's back. */
  workspacesChanged(projectId: string): void
  /** The host workspaces worth hearing about changed. */
  subscriptionsChanged(machineId: string): void
  makeId(prefix: string): string
  /**
   * Asks the host again whether it still mirrors everything. A sync started by a tab change runs on
   * what the last probe heard, and the owner may have switched mirroring off since; this is checked
   * first so a stale "yes" never shows a conversation the owner just stopped sharing that way.
   */
  confirm?(machineId: string): Promise<boolean>
  schedule?(run: () => void, ms: number): { cancel(): void }
}

/**
 * The laptop as a full mirror of MAIN. For every host that mirrors everything (the host's own
 * switch, `mirror.state`), each of its workspaces in an adopted project gets a workspace here and
 * each conversation it is running gets a tab in it, without the owner opening anything. They are
 * attached mirrors - the same binding `attachRemoteTab` makes, with the same authority: every read,
 * prompt and answer is an ordinary host `agents.*` call reauthorised there - and marked `auto`, so a
 * conversation that ends on the host closes here and one the owner closes here is not reopened.
 *
 * Nothing here decides what this machine may reach: the host lists only granted projects, and the
 * tabs of this machine's own projects, and its own tabs anywhere, are never touched.
 */
export class RemoteFullMirror {
  private running = new Map<string, Promise<void>>()
  private again = new Set<string>()
  private timers = new Map<string, { cancel(): void }>()

  constructor(private readonly deps: RemoteFullMirrorDependencies) {}

  private workspaces(): WorkspaceMirrorEntry[] { return readWorkspaceMirrors(this.deps.database.getSetting(WORKSPACES_SETTING)) }
  private saveWorkspaces(entries: WorkspaceMirrorEntry[]): void { this.deps.database.setSetting(WORKSPACES_SETTING, JSON.stringify(entries)) }

  private dismissed(): string[] {
    try {
      const parsed = JSON.parse(this.deps.database.getSetting(DISMISSED_SETTING) ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
    } catch { return [] }
  }

  /** The owner closed a mirrored conversation here: it stays closed here until they open it again. */
  dismiss(binding: Pick<RemoteSessionBinding, 'machineId' | 'remoteAgentSessionId'>): void {
    const key = `${binding.machineId}\n${binding.remoteAgentSessionId}`
    const current = this.dismissed().filter(entry => entry !== key)
    this.deps.database.setSetting(DISMISSED_SETTING, JSON.stringify([...current, key].slice(-DISMISSED_LIMIT)))
  }

  /** The owner opened it again (the launcher's list): mirroring may show it from now on. */
  undismiss(machineId: string, remoteAgentSessionId: string): void {
    const key = `${machineId}\n${remoteAgentSessionId}`
    const current = this.dismissed()
    if (current.includes(key)) this.deps.database.setSetting(DISMISSED_SETTING, JSON.stringify(current.filter(entry => entry !== key)))
  }

  /** Every host workspace mirrored here, for the host's push channel subscriptions. */
  wanted(machineId: string): Array<{ projectId: string; sessionId: string }> {
    return this.workspaces().filter(entry => entry.machineId === machineId && !entry.dismissed)
      .map(entry => ({ projectId: entry.remoteProjectId, sessionId: entry.remoteSessionId }))
  }

  /** A burst of host tab changes (a swarm opening four coworkers) settles into one sync. */
  schedule(machineId: string, ms = SYNC_DEBOUNCE_MS): void {
    this.timers.get(machineId)?.cancel()
    const schedule = this.deps.schedule ?? ((run, delay) => { const handle = setTimeout(run, delay); handle.unref?.(); return { cancel: () => clearTimeout(handle) } })
    this.timers.set(machineId, schedule(() => { this.timers.delete(machineId); void this.sync(machineId).catch(error => console.warn('Mirroring the other machine failed', error)) }, ms))
  }

  /** One sync per host at a time; a request during one runs once more after it. */
  async sync(machineId: string, options: { confirmed?: boolean } = {}): Promise<void> {
    const running = this.running.get(machineId)
    if (running) { this.again.add(machineId); return running }
    const run = (async () => {
      let confirmed = options.confirmed === true
      try {
        do {
          this.again.delete(machineId)
          if (confirmed || !this.deps.confirm || await this.deps.confirm(machineId).catch(() => false)) await this.syncOnce(machineId)
          confirmed = false
        } while (this.again.has(machineId))
      } finally { this.running.delete(machineId) }
    })()
    this.running.set(machineId, run)
    return run
  }

  dispose(): void {
    for (const timer of this.timers.values()) timer.cancel()
    this.timers.clear()
  }

  private async syncOnce(machineId: string): Promise<void> {
    const host = this.deps.hosts().find(entry => entry.machineId === machineId)
    if (!host) return
    let entries = this.workspaces()
    const dismissed = new Set(this.dismissed())
    let subscriptions = false
    let bound = false
    for (const project of host.projects) {
      let listed: Array<{ id: string; name: string }>
      try {
        const raw = await this.deps.call(machineId, 'workspaces.list', { projectId: project.remoteProjectId })
        listed = (Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [])
          .filter(workspace => typeof workspace?.id === 'string' && workspace.id)
          .slice(0, WORKSPACE_LIMIT)
          .map(workspace => ({ id: workspace.id as string, name: typeof workspace.name === 'string' && workspace.name ? workspace.name.slice(0, 160) : 'Workspace' }))
      } catch { continue /* refused or unreachable: the next sync asks again, and nothing here is torn down */ }
      const fresh = new Map<string, FreshWorkspace>()
      const seen = new Set<string>()
      const read = new Set<string>()
      let cwd: string | null | undefined
      for (const workspace of listed) {
        let tabs: HostTab[]
        try {
          const raw = await this.deps.call(machineId, 'agents.list', { projectId: project.remoteProjectId, sessionId: workspace.id })
          tabs = (Array.isArray(raw) ? raw as Array<Record<string, unknown>> : []).flatMap((agent): HostTab[] =>
            typeof agent?.tabId === 'string' && typeof agent.agentSessionId === 'string' && agent.agentSessionId && mirroredProviders.has(String(agent.provider))
              ? [{ tabId: agent.tabId, agentSessionId: agent.agentSessionId, provider: agent.provider as Provider, title: typeof agent.title === 'string' && agent.title ? agent.title.slice(0, 160) : 'Conversation' }]
              : [])
        } catch { continue }
        read.add(workspace.id)
        for (const tab of tabs) seen.add(tab.agentSessionId)
        let entry = entries.find(candidate => candidate.machineId === machineId && candidate.remoteProjectId === project.remoteProjectId && candidate.remoteSessionId === workspace.id)
        if (entry?.dismissed) continue
        let session = entry ? this.deps.database.listSessions(project.localProjectId).find(candidate => candidate.id === entry!.localSessionId) ?? null : null
        if (entry && !session) {
          // The owner closed the workspace here; that is a decision, not something to undo by itself.
          entries = entries.map(candidate => candidate === entry ? { ...candidate, dismissed: true as const } : candidate)
          subscriptions = true
          continue
        }
        if (!entry) {
          if (!tabs.length) continue
          const adopted = this.adoptableWorkspace(project.localProjectId, entries)
          if (adopted) {
            // The window may already hold this workspace's layout, so its tabs go in through the
            // window (openTab) rather than under it; only the name changes here.
            if (adopted.name !== workspace.name) { this.deps.database.renameSession(adopted.id, workspace.name); this.deps.workspacesChanged(project.localProjectId) }
            session = { ...adopted, name: workspace.name }
          } else {
            // A workspace the window has never seen gets its tabs in its saved layout before it is announced.
            session = this.deps.database.createSession(project.localProjectId, workspace.name)
            fresh.set(session.id, { session, tabs: [] })
          }
          entry = { machineId, remoteProjectId: project.remoteProjectId, remoteSessionId: workspace.id, localSessionId: session.id, remoteName: workspace.name }
          entries = [...entries, entry]
          subscriptions = true
        } else if (entry.remoteName !== workspace.name) {
          // A rename on the host is followed while the name here is still the host's old one.
          if (session && session.name === entry.remoteName) this.deps.database.renameSession(session.id, workspace.name)
          const updated = { ...entry, remoteName: workspace.name }
          entries = entries.map(candidate => candidate === entry ? updated : candidate)
          entry = updated
          this.deps.workspacesChanged(project.localProjectId)
        }
        const existing = this.deps.mirror.list().filter(binding => binding.machineId === machineId)
        for (const tab of tabs) {
          if (existing.some(binding => binding.remoteAgentSessionId === tab.agentSessionId)) continue
          if (dismissed.has(`${machineId}\n${tab.agentSessionId}`)) continue
          if (cwd === undefined) cwd = await this.deps.cwdFor(machineId, project.remoteProjectId).catch(() => null)
          if (!cwd) break
          const localSessionId = this.deps.makeId('agent')
          this.deps.mirror.bind({
            localSessionId, machineId, projectId: project.localProjectId, workspaceId: entry.localSessionId, provider: tab.provider, cwd,
            remoteProjectId: project.remoteProjectId, remoteSessionId: workspace.id, remoteAgentSessionId: tab.agentSessionId, remoteTabId: tab.tabId,
            remoteSequence: 0, attached: true, auto: true
          })
          bound = true
          const paneTab: PaneTab = {
            id: this.deps.makeId('pane'), kind: 'agent', title: tab.title, resourceId: localSessionId,
            state: { provider: tab.provider, resume: false, model: 'default', effort: 'auto', machineId, machineName: host.machineName }
          }
          const pending = fresh.get(entry.localSessionId)
          if (pending) { pending.tabs.push(paneTab); continue }
          try { await this.deps.openTab({ projectId: project.localProjectId, sessionId: entry.localSessionId }, paneTab) }
          catch (error) {
            // The window could not take it now; unbinding lets the next sync try again cleanly.
            this.deps.mirror.release(localSessionId)
            console.warn('A mirrored conversation could not be shown', error)
          }
        }
      }
      for (const { session, tabs } of fresh.values()) {
        this.deps.database.saveSession(session.id, seedLayout(session.layout, tabs), session.maximizedGroupId ?? null, session.closedTabs ?? [])
      }
      if (fresh.size) this.deps.workspacesChanged(project.localProjectId)
      // A conversation the host no longer lists in a workspace that answered ended there: its
      // mirror closes here. Only auto mirrors; a tab the owner opened or placed is theirs.
      // A workspace the host still lists but whose tabs could not be read this time says nothing.
      const listedIds = new Set(listed.map(workspace => workspace.id))
      for (const binding of this.deps.mirror.list()) {
        if (!binding.auto || binding.machineId !== machineId || binding.remoteProjectId !== project.remoteProjectId) continue
        if (seen.has(binding.remoteAgentSessionId)) continue
        if (listedIds.has(binding.remoteSessionId) && !read.has(binding.remoteSessionId)) continue
        this.deps.mirror.release(binding.localSessionId)
        await this.deps.closeTab({ projectId: binding.projectId, sessionId: binding.workspaceId }, binding.localSessionId).catch(() => undefined)
      }
    }
    this.saveWorkspaces(entries)
    if (bound) this.deps.mirror.start()
    if (subscriptions || bound) this.deps.subscriptionsChanged(machineId)
  }

  /**
   * The empty workspace an adopted project starts with ("Workspace", only a launcher) takes the
   * first host workspace instead of sitting beside it unused. One with anything else in it, or one
   * already mirroring something, is left alone.
   */
  private adoptableWorkspace(localProjectId: string, entries: WorkspaceMirrorEntry[]): SessionRecord | null {
    const taken = new Set(entries.map(entry => entry.localSessionId))
    const collect = (node: WorkspaceLayout['root']): PaneTab[] => node.type === 'group' ? node.tabs : node.children.flatMap(collect)
    return this.deps.database.listSessions(localProjectId)
      .find(session => !taken.has(session.id) && collect(session.layout.root).every(tab => tab.kind === 'launcher')) ?? null
  }
}
