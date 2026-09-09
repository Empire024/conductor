import { ipcMain } from 'electron'
import { hostname } from 'node:os'
import type { AgentControlUiRequest, AgentFileChange } from '../shared/agent-control'
import type { AgentProviderInfo, AgentSpec } from '../shared/models'
import type {
  GitHubAuthState,
  MachineDescriptor,
  RemoteControlSettings,
  RemoteControlState,
  RemotePairingTicket
} from '../shared/remote-control'
import { encodeTicket, LOCAL_MACHINE_ID } from '../shared/remote-control'
import type { ConductorDatabase } from './database'
import { GitHubAuth } from './github-auth'
import { describeMachines, machineBriefing, tabMachineId } from './machines'
import type { ProjectBacklogs } from './project-backlog'
import { RemoteControlClient } from './remote-control-client'
import { RemoteControlHost } from './remote-control-host'
import { RemoteControlServer } from './remote-control-server'
import { RemoteAccessError, RemotePeers } from './remote-peers'
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
      projects: () => deps.database.listProjects().map(project => ({ id: project.id, name: project.name, path: project.path })),
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

  /**
   * Places a tab on a paired machine. The project has to exist on both sides; matching by name
   * keeps the mapping something the owner can see and reason about rather than a hidden table.
   */
  async openRemote(machineId: string, request: { projectId: string; sessionId: string; provider?: string; model?: string; effort?: string; title?: string }): Promise<{ tabId: string; agentSessionId?: string; machineName: string }> {
    const connection = this.client.get(machineId)
    if (!connection) throw new RemoteAccessError('This machine is not paired with that one.', 404)
    const localProject = this.deps.database.getProject(request.projectId)
    if (!localProject) throw new RemoteAccessError('This project is not registered on this machine.', 404)
    const projects = await this.client.call(machineId, 'projects.list') as Array<{ id: string; name: string }>
    const matches = projects.filter(project => project.name === localProject.name)
    if (matches.length !== 1) {
      throw new RemoteAccessError(`${connection.machineName} does not share exactly one project named “${localProject.name}”. Share the matching project on that machine first.`, 409)
    }
    const remoteProjectId = matches[0]!.id
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
    return { tabId: tab.id, agentSessionId: tab.resourceId, machineName: connection.machineName }
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
      projects: this.deps.database.listProjects().map(project => ({ id: project.id, name: project.name, path: project.path })),
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
    handle<RemoteControlState>('remote:deny', (pendingId: string) => { this.peers.deny(String(pendingId)); return this.state() })
    handle<RemoteControlState>('remote:revoke', (peerId: string) => { this.peers.revoke(String(peerId)); return this.state() })
    handle<RemoteControlState>('remote:connect', async (ticket: string) => { await this.client.connect(String(ticket)); return this.state() })
    handle<RemoteControlState>('remote:forget', (machineId: string) => {
      this.client.forget(String(machineId) || LOCAL_MACHINE_ID)
      return this.state()
    })
    handle<MachineDescriptor[]>('remote:machines', () => this.machines())
  }

  async dispose(): Promise<void> {
    if (this.registered) {
      for (const channel of ['remote:github-state', 'remote:github-sign-in', 'remote:github-cancel', 'remote:github-sign-out',
        'remote:state', 'remote:set-settings', 'remote:ticket', 'remote:approve', 'remote:deny', 'remote:revoke',
        'remote:connect', 'remote:forget', 'remote:machines']) ipcMain.removeHandler(channel)
      this.registered = false
    }
    await this.server.close()
  }
}
