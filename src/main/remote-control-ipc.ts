import { ipcMain } from 'electron'
import { hostname } from 'node:os'
import type { AgentControlUiRequest, AgentFileChange } from '../shared/agent-control'
import type { AgentProviderInfo, AgentSpec } from '../shared/models'
import { makeId } from '../shared/models'
import type {
  GitHubAuthState,
  MachineDescriptor,
  RemoteControlSettings,
  RemoteControlState,
  RemotePairingTicket,
  RemoteProjectSummary
} from '../shared/remote-control'
import { encodeTicket, LOCAL_MACHINE_ID, readRemoteProjectSummaries } from '../shared/remote-control'
import { checkRemoteProjectPlacement } from '../shared/project-identity'
import type { ConductorDatabase } from './database'
import { GitHubAuth } from './github-auth'
import { describeMachines, machineBriefing, tabMachineId } from './machines'
import { projectSummary } from './project-identity'
import type { ProjectBacklogs } from './project-backlog'
import { RemoteControlClient } from './remote-control-client'
import { RemoteControlHost } from './remote-control-host'
import { RemoteControlServer } from './remote-control-server'
import { RemoteAccessError, RemotePeers } from './remote-peers'
import { RemoteSessionMirror } from './remote-session-mirror'
import { StoredSecretVault, type SecretCipher } from './secret-store'
import type { StructuredSessions } from './structured-sessions'

export interface RemoteControlServiceDependencies {
  database: ConductorDatabase
  sessions: StructuredSessions
  backlogs: ProjectBacklogs
  providers(): AgentProviderInfo[]
  ui(request: AgentControlUiRequest): Promise<unknown>
  fileChanged(change: AgentFileChange): void
  cipher: SecretCipher
  publish(channel: string, payload: unknown): void
  /** GitHub OAuth app client ID; the device flow cannot start without one. */
  clientId?: string
}

const MACHINE_NAME_SETTING = 'remote-control.machineName'

/**
 * Assembles GitHub identity, the peer registry, the listening server and this machine's outbound
 * connections, and exposes them to the renderer. Nothing here ever sends a token, a private key
 * or a pairing code to the renderer.
 */
export class RemoteControlService {
  readonly auth: GitHubAuth
  readonly peers: RemotePeers
  readonly host: RemoteControlHost
  readonly server: RemoteControlServer
  readonly client: RemoteControlClient
  readonly mirror: RemoteSessionMirror
  private registered = false

  constructor(private readonly deps: RemoteControlServiceDependencies) {
    const store = deps.database
    const vault = new StoredSecretVault(store, deps.cipher)
    this.auth = new GitHubAuth({
      store, vault,
      fetch: globalThis.fetch,
      clientId: deps.clientId ?? process.env.CONDUCTOR_GITHUB_CLIENT_ID ?? '',
      machineName: this.machineName(),
      changed: state => deps.publish('remote:github-changed', state),
      // Identity is the root of every peer relationship, so losing it takes them all with it.
      // Tearing the listener down must never be able to reject into nothing: an unhandled
      // rejection here would take the main process down during a sign-out.
      signedOut: () => {
        this.peers.revokeAll('Signed out of GitHub')
        this.client.clear()
        void this.server.apply().catch(error => console.warn('Remote control did not stop cleanly', error))
      }
    })
    this.peers = new RemotePeers({
      store,
      accountId: () => this.auth.identity()?.id ?? null,
      accountLogin: () => this.auth.identity()?.login ?? null,
      accountKeys: force => this.auth.accountKeys(force),
      projects: () => deps.database.listProjects().map(projectSummary),
      changed: () => this.publishState(),
      activity: entry => deps.publish('remote:activity', entry)
    })
    this.host = new RemoteControlHost({
      database: deps.database, sessions: deps.sessions, backlogs: deps.backlogs, peers: this.peers,
      providers: () => deps.providers().map(provider => ({ id: provider.id, available: provider.available, models: provider.models })),
      ui: deps.ui, fileChanged: deps.fileChanged, machineName: () => this.machineName()
    })
    this.server = new RemoteControlServer({
      peers: this.peers, host: this.host, store, vault,
      machineName: () => this.machineName(),
      accountLogin: () => this.auth.identity()?.login ?? null,
      changed: () => this.publishState()
    })
    this.client = new RemoteControlClient({
      store,
      machineId: () => this.peers.machineId,
      machineName: () => this.machineName(),
      deviceKey: () => this.auth.deviceKey(),
      changed: () => this.publishState()
    })
    this.mirror = new RemoteSessionMirror({
      database: store,
      call: (machineId, method, args) => this.client.call(machineId, method, args),
      publish: deps.publish
    })
  }

  machineName(): string {
    return this.deps.database.getSetting(MACHINE_NAME_SETTING) || this.peers?.getSettings().machineName || hostname() || 'This machine'
  }

  machines(): MachineDescriptor[] {
    return describeMachines(this.machineName(), this.client.list())
  }

  /** The sentence appended to an agent's briefing so it knows where it is running. */
  machineNote(spec: Pick<AgentSpec, 'projectId' | 'sessionId' | 'id'>): string {
    const workspace = this.deps.database.getSession(spec.sessionId)
    if (workspace?.projectId !== spec.projectId) return ''
    const tabs: Array<{ resourceId?: string; state?: Record<string, unknown> }> = []
    const visit = (node: { type: string } & Record<string, unknown>): void => {
      if (node.type === 'split') { (node.children as Array<Parameters<typeof visit>[0]>).forEach(visit); return }
      tabs.push(...(node.tabs as typeof tabs))
    }
    visit(workspace.layout.root as unknown as Parameters<typeof visit>[0])
    const tab = tabs.find(candidate => candidate.resourceId === spec.id)
    return machineBriefing(this.machines(), tabMachineId(tab))
  }

  /** Asks a paired machine what it shares now and remembers the answer against the mapping. */
  async refreshRemoteProjects(machineId: string): Promise<RemoteProjectSummary[]> {
    return this.client.recordRemoteProjects(machineId, readRemoteProjectSummaries(await this.client.call(machineId, 'projects.list')))
  }

  /**
   * The owner confirming that this project here is that project there. Both identities are read
   * fresh — the local one off disk, the remote one from that machine right now — so what is stored
   * is what the owner was actually looking at when they said yes.
   */
  async confirmProject(machineId: string, localProjectId: string, remoteProjectId: string): Promise<RemoteControlState> {
    const connection = this.client.get(machineId)
    if (!connection) throw new RemoteAccessError('This machine is not paired with that one.', 404)
    const project = this.deps.database.getProject(localProjectId)
    if (!project) throw new RemoteAccessError('This project is not registered on this machine.', 404)
    const local = projectSummary(project)
    if (!local.identity) throw new RemoteAccessError(local.identityError || 'Conductor cannot read this project identity, so it will not pair it.', 409)
    const remote = (await this.refreshRemoteProjects(machineId)).find(entry => entry.id === remoteProjectId)
    if (!remote) throw new RemoteAccessError(`${connection.machineName} is not sharing that project.`, 409)
    if (!remote.identity) throw new RemoteAccessError(remote.identityError || `${connection.machineName} cannot read that project identity, so it cannot be paired.`, 409)
    this.client.confirmProject(machineId, {
      localProjectId,
      local: local.identity,
      remoteProjectId,
      remote: remote.identity,
      confirmedAt: new Date().toISOString()
    })
    return this.state()
  }

  /**
   * Places a tab on a paired machine, in the project the owner mapped to this one. The mapping is
   * checked against what that machine advertises at this moment, not against what it advertised
   * when the mapping was made, so a project that was swapped, copied or moved in between stops the
   * placement instead of quietly receiving the work.
   */
  async openRemote(machineId: string, request: { projectId: string; sessionId: string; provider?: string; model?: string; effort?: string; title?: string }): Promise<{ tabId: string; agentSessionId?: string; machineName: string; remoteProjectId: string; remoteSessionId: string }> {
    const connection = this.client.get(machineId)
    if (!connection) throw new RemoteAccessError('This machine is not paired with that one.', 404)
    const localProject = this.deps.database.getProject(request.projectId)
    if (!localProject) throw new RemoteAccessError('This project is not registered on this machine.', 404)
    const local = projectSummary(localProject)
    if (!local.identity) throw new RemoteAccessError(local.identityError || 'Conductor cannot read this project identity, so it will not place work elsewhere.', 409)
    const advertised = await this.refreshRemoteProjects(machineId)
    const grant = this.client.get(machineId)?.projectGrants.find(entry => entry.localProjectId === request.projectId)
    const placement = checkRemoteProjectPlacement({
      grant,
      advertised: advertised.find(entry => entry.id === grant?.remoteProjectId)?.identity,
      local: local.identity,
      machineName: connection.machineName
    })
    if (!placement.ok) throw new RemoteAccessError(placement.message, 409)
    const remoteProjectId = placement.grant!.remoteProjectId
    const workspaces = await this.client.call(machineId, 'workspaces.list', { projectId: remoteProjectId }) as Array<{ id: string }>
    const remoteSessionId = workspaces[0]?.id
    if (!remoteSessionId) throw new RemoteAccessError(`${connection.machineName} has no open workspace for that project.`, 409)
    const tab = await this.client.call(machineId, 'tabs.open', {
      projectId: remoteProjectId, sessionId: remoteSessionId, kind: 'agent',
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.title ? { title: request.title } : {})
    }) as { id: string; resourceId?: string }
    return { tabId: tab.id, agentSessionId: tab.resourceId, machineName: connection.machineName, remoteProjectId, remoteSessionId }
  }

  /**
   * The owner placing a tab on another machine from the launcher. The remote tab is opened first
   * and only then mirrored, so a placement that machine refuses leaves nothing bound here. The
   * local session id is minted here rather than reusing the remote one: ids are private to each
   * machine, and two machines that had both ever opened the same conversation would otherwise
   * collide in this store.
   */
  async openRemoteTab(request: { machineId: string; projectId: string; sessionId: string; provider?: string; model?: string; effort?: string; title?: string }): Promise<{ localSessionId: string; machineId: string; machineName: string }> {
    const project = this.deps.database.getProject(request.projectId)
    if (!project) throw new RemoteAccessError('This project is not registered on this machine.', 404)
    // Only a provider this store can journal may be mirrored; anything else would bind a tab to a
    // conversation the local projection cannot represent.
    const provider = request.provider ?? 'claude'
    if (provider !== 'claude' && provider !== 'codex') throw new RemoteAccessError(`${provider} cannot run on another machine yet.`, 400)
    const opened = await this.openRemote(request.machineId, request)
    if (!opened.agentSessionId) throw new RemoteAccessError(`${opened.machineName} opened a tab that runs no conversation.`, 409)
    const localSessionId = makeId('agent')
    this.mirror.bind({
      localSessionId,
      machineId: request.machineId,
      projectId: request.projectId,
      workspaceId: request.sessionId,
      provider,
      cwd: project.path,
      remoteProjectId: opened.remoteProjectId,
      remoteSessionId: opened.remoteSessionId,
      remoteAgentSessionId: opened.agentSessionId,
      remoteSequence: 0
    })
    this.mirror.start()
    void this.mirror.pull(localSessionId).catch(error => console.warn('Remote session did not load', error))
    return { localSessionId, machineId: request.machineId, machineName: opened.machineName }
  }

  state(): RemoteControlState {
    const status = this.server.getStatus()
    return {
      machineId: this.peers.machineId,
      settings: { ...this.peers.getSettings(), machineName: this.machineName() },
      listening: status.listening,
      endpoint: status.endpoint,
      fingerprint: status.fingerprint,
      message: status.message,
      projects: this.deps.database.listProjects().map(projectSummary),
      peers: this.peers.listPeers(),
      pending: this.peers.listPending(),
      activity: this.peers.listActivity().slice(0, 50),
      connections: this.client.list()
    }
  }

  private publishState(): void {
    try { this.deps.publish('remote:changed', this.state()) } catch { /* the window may be closing */ }
  }

  async start(): Promise<void> {
    await this.server.apply()
    // Tabs placed elsewhere in an earlier run keep catching up without the owner reopening them.
    if (this.mirror.list().length) this.mirror.start()
  }

  private async setSettings(patch: Partial<RemoteControlSettings>): Promise<RemoteControlState> {
    if (typeof patch.machineName === 'string' && patch.machineName.trim()) {
      this.deps.database.setSetting(MACHINE_NAME_SETTING, patch.machineName.trim().slice(0, 60))
    }
    const before = this.peers.getSettings()
    const after = this.peers.updateSettings(patch)
    if (before.enabled !== after.enabled || before.exposure !== after.exposure || before.port !== after.port) await this.server.apply()
    return this.state()
  }

  registerIpc(): void {
    if (this.registered) return
    this.registered = true
    const handle = <T>(channel: string, run: (...args: never[]) => Promise<T> | T): void => { ipcMain.handle(channel, (_event, ...args) => run(...args as never[])) }
    handle<GitHubAuthState>('remote:github-state', () => this.auth.state())
    handle<GitHubAuthState>('remote:github-sign-in', () => this.auth.signIn())
    handle<GitHubAuthState>('remote:github-cancel', () => this.auth.cancelSignIn())
    handle<GitHubAuthState>('remote:github-sign-out', () => this.auth.signOut())
    handle<RemoteControlState>('remote:state', () => this.state())
    handle<RemoteControlState>('remote:set-settings', (patch: Partial<RemoteControlSettings>) => this.setSettings(patch ?? {}))
    handle<{ ticket: RemotePairingTicket; encoded: string }>('remote:ticket', () => { const ticket = this.server.ticket(); return { ticket, encoded: encodeTicket(ticket) } })
    handle<RemoteControlState>('remote:approve', (pendingId: string, projectIds: string[]) => {
      this.peers.approve(String(pendingId), Array.isArray(projectIds) ? projectIds.map(String) : [])
      return this.state()
    })
    handle<RemoteControlState>('remote:reshare-project', (peerId: string, projectId: string) => {
      this.peers.reshareProject(String(peerId), String(projectId))
      return this.state()
    })
    handle<RemoteControlState>('remote:deny', (pendingId: string) => { this.peers.deny(String(pendingId)); return this.state() })
    handle<RemoteControlState>('remote:revoke', (peerId: string) => { this.peers.revoke(String(peerId)); return this.state() })
    handle<RemoteControlState>('remote:connect', async (ticket: string) => { await this.client.connect(String(ticket)); return this.state() })
    handle<RemoteControlState>('remote:forget', (machineId: string) => {
      const id = String(machineId) || LOCAL_MACHINE_ID
      this.client.forget(id)
      // A tab cannot keep mirroring a machine the owner just cut loose.
      this.mirror.releaseMachine(id)
      return this.state()
    })
    handle<RemoteProjectSummary[]>('remote:remote-projects', (machineId: string) => this.refreshRemoteProjects(String(machineId)))
    handle<RemoteControlState>('remote:confirm-project', (machineId: string, localProjectId: string, remoteProjectId: string) =>
      this.confirmProject(String(machineId), String(localProjectId), String(remoteProjectId)))
    handle<RemoteControlState>('remote:release-project', (machineId: string, localProjectId: string) => {
      this.client.releaseProject(String(machineId), String(localProjectId))
      return this.state()
    })
    handle<MachineDescriptor[]>('remote:machines', () => this.machines())
    handle<{ localSessionId: string; machineId: string; machineName: string }>('remote:open-tab', (request: unknown) => {
      const args = (request ?? {}) as Record<string, unknown>
      const required = ['machineId', 'projectId', 'sessionId'] as const
      if (required.some(field => typeof args[field] !== 'string' || !args[field])) throw new RemoteAccessError('A remote tab needs a machine, a project and a workspace.', 400)
      return this.openRemoteTab({
        machineId: String(args.machineId), projectId: String(args.projectId), sessionId: String(args.sessionId),
        ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.effort === 'string' ? { effort: args.effort } : {}),
        ...(typeof args.title === 'string' ? { title: args.title } : {})
      })
    })
    handle<boolean>('remote:release-tab', (localSessionId: string) => { this.mirror.release(String(localSessionId)); return true })
  }

  async dispose(): Promise<void> {
    if (this.registered) {
      for (const channel of ['remote:github-state', 'remote:github-sign-in', 'remote:github-cancel', 'remote:github-sign-out',
        'remote:state', 'remote:set-settings', 'remote:ticket', 'remote:approve', 'remote:reshare-project', 'remote:deny', 'remote:revoke',
        'remote:connect', 'remote:forget', 'remote:remote-projects', 'remote:confirm-project', 'remote:release-project',
        'remote:machines', 'remote:open-tab', 'remote:release-tab']) ipcMain.removeHandler(channel)
      this.registered = false
    }
    this.mirror.stop()
    await this.server.close()
  }
}
