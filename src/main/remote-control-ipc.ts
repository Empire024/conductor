import { ipcMain } from 'electron'
import { hostname } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import type { AgentControlUiRequest, AgentFileChange } from '../shared/agent-control'
import type { AgentProviderInfo, AgentSpec } from '../shared/models'
import { makeId } from '../shared/models'
import { CONDUCTOR_GITHUB_OAUTH_CLIENT_ID } from '../shared/github-oauth'
import type {
  GitHubAuthState,
  MachineDescriptor,
  RemoteControlSettings,
  RemoteControlState,
  RemotePairingTicket,
  RemoteProjectSummary
} from '../shared/remote-control'
import type { RemoteFileDescription, RemoteFileIdentity, RemoteFileWriteRequest } from '../shared/remote-files'
import { decodeTicket, encodeTicket, LOCAL_MACHINE_ID, readRemoteProjectSummaries } from '../shared/remote-control'
import { checkRemoteProjectPlacement } from '../shared/project-identity'
import type { ConductorDatabase } from './database'
import { GitHubAuth, GITHUB_SCOPES } from './github-auth'
import { MachineProbeSchedule, describeMachines, machineBriefing, tabMachineId } from './machines'
import { projectSummary } from './project-identity'
import type { ProjectBacklogs } from './project-backlog'
import { DIRECT_PROBE_TIMEOUT_MS, RemoteControlClient, type RemoteCallOptions } from './remote-control-client'
import { RemoteControlHost } from './remote-control-host'
import { RemoteFileResourceServer } from './remote-file-resources'
import { RemoteFiles } from './remote-files'
import { RemoteControlServer } from './remote-control-server'
import { GitHubRelayMailbox } from './github-relay'
import { ConductorRelay, relayEndpointUrl } from './conductor-relay'
import { RelayHost } from './relay-host'
import { generateRoomSecret } from './relay-room'
import { RelayRoute } from './relay-route'
import { RemoteRelay } from './remote-relay'
import { RELAY_BACKGROUND_CALL_TIMEOUT_MS } from '../shared/remote-relay'
import { generateSealKey, type RelaySealKeyPair } from './relay-crypto'
import { RemoteAccessError, RemotePeers } from './remote-peers'
import { RemoteSessionMirror } from './remote-session-mirror'
import { StoredSecretVault, type SecretCipher } from './secret-store'
import type { StructuredSessions } from './structured-sessions'
import type { PromptDispatchAuthority } from '../shared/structured-agent'

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
  /** Main-owned native save dialog; renderer input can never choose an arbitrary destination. */
  chooseRemoteDownloadPath?(description: RemoteFileDescription): Promise<string | null>
}

const MACHINE_NAME_SETTING = 'remote-control.machineName'
/**
 * How often a paired machine is re-probed so the launcher reflects what is reachable now.
 *
 * Derived rather than chosen, because the two numbers are not independent: a probe that starts
 * before the previous one can possibly have ended leaves a call pending at every instant, and the
 * relay reads "a call is pending" as "someone is waiting", which is what pinned it to its 1.5 s
 * cadence and spent the account's whole hourly GitHub budget on one machine being switched off.
 * A probe is bounded by the direct attempt plus the relay's background deadline, so the interval is
 * that sum and some slack - it cannot be tuned back into overlapping. The per-machine in-flight
 * claim in `MachineProbeSchedule` enforces the same rule at runtime, for a direct socket that hangs
 * past its own timeout.
 */
const MACHINE_PROBE_MS = DIRECT_PROBE_TIMEOUT_MS + RELAY_BACKGROUND_CALL_TIMEOUT_MS + 7_000
/** The X25519 key relayed messages to this machine are sealed to; never leaves the credential store. */
const RELAY_KEY_SECRET = 'remote-control.relay.sealKey'
/**
 * The room secret for the owner's own relay. It is the one value that decides whether a machine may
 * connect to that relay at all, so it lives where the device key lives - the OS credential store -
 * and never in ordinary settings, a log, or anything the renderer can read.
 */
const RELAY_ROOM_SECRET = 'remote-control.relay.roomSecret'

interface FixtureGist { id: string; description: string; files: Record<string, string> }
interface FixtureState { keys: Array<{ id: number; key: string; title: string }>; gists: FixtureGist[] }

/** Offline GitHub boundary for the full Electron remote-integration smoke; never enabled alone. */
function githubFetch(): typeof globalThis.fetch {
  if (process.env.CONDUCTOR_OFFLINE_TESTS !== '1' || process.env.CONDUCTOR_TEST_REMOTE_GITHUB !== '1') return globalThis.fetch
  const sharedState = process.env.CONDUCTOR_TEST_REMOTE_GITHUB_STATE
  let local: FixtureState = { keys: [], gists: [] }
  let rotation = 0
  const readState = (): FixtureState => {
    if (!sharedState) return local
    try {
      const value = JSON.parse(readFileSync(sharedState, 'utf8')) as Partial<FixtureState>
      return {
        keys: Array.isArray(value.keys) ? value.keys.flatMap(entry => {
          if (!entry || typeof entry !== 'object') return []
          const key = entry as Record<string, unknown>
          return typeof key.id === 'number' && typeof key.key === 'string' && typeof key.title === 'string'
            ? [{ id: key.id, key: key.key, title: key.title }] : []
        }) : [],
        gists: Array.isArray(value.gists) ? value.gists.flatMap(entry => {
          if (!entry || typeof entry !== 'object') return []
          const gist = entry as { id?: unknown; description?: unknown; files?: unknown }
          return typeof gist.id === 'string' && gist.files && typeof gist.files === 'object'
            ? [{ id: gist.id, description: String(gist.description ?? ''), files: gist.files as Record<string, string> }] : []
        }) : []
      }
    } catch { return { keys: [], gists: [] } }
  }
  // Both smoke instances share one file, and each only ever mutates the gist it owns, so the state
  // is re-read immediately before every write rather than held across one.
  const writeState = (mutate: (state: FixtureState) => void): FixtureState => {
    const state = readState()
    mutate(state)
    if (sharedState) writeFileSync(sharedState, JSON.stringify(state))
    else local = state
    return state
  }
  const readKeys = (): FixtureState['keys'] => readState().keys
  const writeKeys = (keys: FixtureState['keys']): void => { writeState(state => { state.keys = keys }) }
  const describeGist = (gist: FixtureGist): unknown => ({
    id: gist.id,
    description: gist.description,
    updated_at: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(gist.files).map(([name, content]) => [name, { filename: name, size: content.length, truncated: false, content }]))
  })
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const request = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    if (url === 'https://github.com/login/device/code') {
      return Response.json({ device_code: 'offline-device-fixture', user_code: 'TEST-ONLY', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 })
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      rotation++
      return Response.json({
        access_token: `offline-access-${rotation}`,
        refresh_token: `offline-refresh-${rotation}`,
        expires_in: 3600,
        refresh_token_expires_in: 180 * 24 * 3600,
        token_type: 'bearer'
      })
    }
    if (url === 'https://api.github.com/user') {
      return Response.json({ id: 4242, login: 'offline-remote-fixture', name: 'Offline remote fixture', avatar_url: null })
    }
    if (url.endsWith('/user/keys?per_page=100')) return Response.json(readKeys())
    if (url.endsWith('/user/keys') && init?.method === 'POST') {
      const keys = readKeys()
      const entry = { id: Math.max(0, ...keys.map(key => key.id)) + 1, key: String(request.key ?? ''), title: String(request.title ?? '') }
      keys.push(entry)
      writeKeys(keys)
      return Response.json(entry, { status: 201 })
    }
    if (/\/user\/keys\/\d+$/.test(url) && init?.method === 'DELETE') {
      const keys = readKeys()
      const id = Number(url.split('/').pop())
      const index = keys.findIndex(key => key.id === id)
      if (index >= 0) keys.splice(index, 1)
      writeKeys(keys)
      return new Response(null, { status: 204 })
    }
    // The relay's mailbox. Both smoke instances share one account, so each sees the other's gist
    // exactly as it would on github.com, which is the whole point of relaying through one.
    if (url.startsWith('https://api.github.com/gists?')) {
      return Response.json(readState().gists.map(describeGist), { headers: { 'x-oauth-scopes': GITHUB_SCOPES.replace(/ /g, ', ') } })
    }
    if (url === 'https://api.github.com/gists' && init?.method === 'POST') {
      const files = (request.files ?? {}) as Record<string, { content?: string }>
      const created: FixtureGist = {
        id: `fixture-gist-${Math.random().toString(36).slice(2, 10)}`,
        description: String(request.description ?? ''),
        files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, String(file?.content ?? '')]))
      }
      writeState(state => { state.gists.push(created) })
      return Response.json(describeGist(created), { status: 201 })
    }
    const gistMatch = /^https:\/\/api\.github\.com\/gists\/([^/?]+)$/.exec(url)
    if (gistMatch) {
      const id = decodeURIComponent(gistMatch[1]!)
      if (init?.method === 'PATCH') {
        const patch = (request.files ?? {}) as Record<string, { content?: string } | null>
        let found: FixtureGist | undefined
        writeState(state => {
          found = state.gists.find(gist => gist.id === id)
          if (!found) return
          for (const [name, file] of Object.entries(patch)) {
            if (file === null) delete found.files[name]
            else found.files[name] = String(file?.content ?? '')
          }
        })
        return found ? Response.json(describeGist(found)) : Response.json({ message: 'Not Found' }, { status: 404 })
      }
      const gist = readState().gists.find(entry => entry.id === id)
      return gist ? Response.json(describeGist(gist)) : Response.json({ message: 'Not Found' }, { status: 404 })
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  }) as typeof globalThis.fetch
}

/**
 * Assembles GitHub identity, the peer registry, the listening server and this machine's outbound
 * connections, and exposes them to the renderer. Tokens and private keys never cross that
 * boundary; the short-lived pairing code deliberately does, because the owner must transfer it.
 */
export class RemoteControlService {
  readonly auth: GitHubAuth
  readonly peers: RemotePeers
  readonly host: RemoteControlHost
  readonly server: RemoteControlServer
  /** Whichever off-network route is in use: the owner's own relay, or the gist mailbox. */
  readonly relay: RelayRoute
  readonly githubRelay: RemoteRelay
  readonly serverRelay: ConductorRelay
  /** The relay this machine runs for itself and its other machines, when the owner asks it to. */
  readonly relayHost: RelayHost
  readonly client: RemoteControlClient
  readonly files: RemoteFiles
  readonly resources: RemoteFileResourceServer
  readonly mirror: RemoteSessionMirror
  private registered = false
  private seal: RelaySealKeyPair | null = null
  private room: string | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  /** One scheduled sweep at a time; a relay round trip can outlast the interval that started it. */
  private probing: Promise<MachineDescriptor[]> | null = null
  /** When each machine is next worth probing, and which probes are still outstanding. */
  private readonly probes = new MachineProbeSchedule(MACHINE_PROBE_MS)

  constructor(private readonly deps: RemoteControlServiceDependencies) {
    const store = deps.database
    const vault = new StoredSecretVault(store, deps.cipher)
    this.auth = new GitHubAuth({
      store, vault,
      fetch: githubFetch(),
      // The bundled value is a public native-app identifier, not a secret. An explicit dependency
      // or environment value still wins for development and deterministic integration fixtures.
      clientId: deps.clientId ?? process.env.CONDUCTOR_GITHUB_CLIENT_ID ?? CONDUCTOR_GITHUB_OAUTH_CLIENT_ID,
      machineName: this.machineName(),
      changed: state => deps.publish('remote:github-changed', state),
      // Identity is the root of every peer relationship, so losing it takes them all with it.
      // Tearing the listener down must never be able to reject into nothing: an unhandled
      // rejection here would take the main process down during a sign-out.
      signedOut: () => {
        this.peers.revokeAll('Signed out of GitHub')
        this.client.clear()
        // The mailbox is reached with the account's own token, so signing out is what makes it
        // unreachable; the gist left behind holds ciphertext and a signed public key and nothing else.
        this.relay?.stop()
        this.seal = null
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
      relayKey: () => this.sealKey()?.publicKey ?? null,
      deviceKey: () => this.auth.deviceKey()?.publicKey ?? null,
      relayRoom: () => {
        // What the other machine should dial: the address this machine's own relay can be reached
        // at - the public one if the router opened it - or whichever relay this machine itself uses.
        const settings = this.peers.getSettings()
        const hosted = this.relayHost.advertisedEndpoints()
        const endpoint = hosted[0] ?? settings.relayEndpoint
        const alternates = hosted.length ? hosted.slice(1) : settings.relayEndpointAlternates
        const fingerprint = hosted.length ? this.relayHost.fingerprint() : settings.relayFingerprint
        const secret = this.roomSecret()
        return endpoint && secret
          ? { endpoint, secret, fingerprint: fingerprint || undefined, alternates: alternates.length ? alternates : undefined }
          : null
      },
      changed: () => this.publishState()
    })
    this.githubRelay = new RemoteRelay({
      mailbox: new GitHubRelayMailbox({
        api: (path, init) => this.auth.gistApi(path, init),
        fetchRaw: async url => {
          // Raw gist content is ciphertext under a URL only the account can produce, and it is
          // only ever parsed as an envelope, never executed or rendered.
          const response = await githubFetch()(url)
          return response.ok ? await response.text() : ''
        },
        getSetting: key => store.getSetting(key),
        setSetting: (key, value) => store.setSetting(key, value)
      }),
      machineId: () => this.peers.machineId,
      machineName: () => this.machineName(),
      accountLogin: () => this.auth.identity()?.login ?? null,
      deviceKey: () => this.auth.deviceKey(),
      sealKey: () => this.sealKey(),
      fingerprint: () => { try { return this.server.identity().fingerprint } catch { return null } },
      peerDeviceKey: machineId => this.peerDeviceKey(machineId),
      // The relay hands an inbound request to the very same handler the HTTPS listener uses, so a
      // peer gains nothing by arriving this way instead of over the network.
      handle: (path, body, headers) => this.server.handleRequest(path, body, headers),
      enabled: () => this.relayEnabled() && !this.serverRelay.configured(),
      changed: () => { this.publishState(); this.probeMachinesSeenOnRelay() }
    })
    this.relayHost = new RelayHost({
      store,
      vault,
      settings: () => {
        const settings = this.peers.getSettings()
        return {
          enabled: settings.enabled && settings.relay && settings.relayHosting,
          port: settings.relayHostPort,
          internet: settings.relayHostInternet
        }
      },
      machineName: () => this.machineName(),
      // Starting a relay is the moment a room secret is needed, so it is made here rather than
      // asked for: an owner should not have to produce a secret before they can press a button.
      secret: () => this.ensureRoomSecret(),
      changed: () => { this.publishState(); this.relay?.start() }
    })
    this.serverRelay = new ConductorRelay({
      // The relay this machine runs is the one it uses, over loopback, where no certificate
      // authority and no router is involved at all.
      endpoint: () => this.relayHost.localEndpoint() ?? (this.peers.getSettings().relayEndpoint || null),
      // A relay this machine runs is reached over loopback and needs no alternates; one somewhere
      // else may answer at several addresses, and which of them works depends on where this is.
      alternateEndpoints: () => this.relayHost.localEndpoint() ? [] : this.peers.getSettings().relayEndpointAlternates,
      pinnedFingerprint: () => this.relayHost.localEndpoint() ? this.relayHost.fingerprint() : (this.peers.getSettings().relayFingerprint || null),
      roomSecret: () => this.roomSecret(),
      machineId: () => this.peers.machineId,
      machineName: () => this.machineName(),
      deviceKey: () => this.auth.deviceKey(),
      sealKey: () => this.sealKey(),
      fingerprint: () => { try { return this.server.identity().fingerprint } catch { return null } },
      peerDeviceKey: machineId => this.peerDeviceKey(machineId),
      handle: (path, body, headers) => this.server.handleRequest(path, body, headers),
      enabled: () => this.relayEnabled(),
      changed: () => { this.publishState(); this.probeMachinesSeenOnRelay() }
    })
    this.relay = new RelayRoute({
      server: this.serverRelay,
      github: this.githubRelay,
      endpoint: () => this.relayHost.localEndpoint() ?? (this.peers.getSettings().relayEndpoint || null)
    })
    this.client = new RemoteControlClient({
      store,
      machineId: () => this.peers.machineId,
      machineName: () => this.machineName(),
      deviceKey: () => this.auth.deviceKey(),
      relay: {
        enabled: () => this.relayEnabled(),
        call: (machineId, peerDeviceKey, path, body, headers, peerRelayKey, options) =>
          this.relay.call(machineId, peerDeviceKey, path, body, headers, peerRelayKey, options)
      },
      changed: () => this.publishState()
    })
    this.files = new RemoteFiles({
      client: this.client,
      project: projectId => {
        const project = deps.database.getProject(projectId)
        return project ? projectSummary(project) : null
      }
    })
    this.resources = new RemoteFileResourceServer({ files: this.files, chooseDownloadPath: deps.chooseRemoteDownloadPath })
    this.mirror = new RemoteSessionMirror({
      database: store,
      call: (machineId, method, args) => this.client.call(machineId, method, args),
      publish: deps.publish
    })
  }

  machineName(): string {
    return this.deps.database.getSetting(MACHINE_NAME_SETTING) || this.peers?.getSettings().machineName || hostname() || 'This machine'
  }

  /**
   * This machine's relay key, minted once and kept in the OS credential store next to the device
   * key. Without a credential store there is no relay: a private key for an off-network channel is
   * exactly the thing that must not be written somewhere anyone can read.
   */
  private sealKey(): RelaySealKeyPair | null {
    if (this.seal) return this.seal
    const vault = new StoredSecretVault(this.deps.database, this.deps.cipher)
    if (!vault.available()) return null
    const stored = vault.read(RELAY_KEY_SECRET)
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Partial<RelaySealKeyPair>
        if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string' && parsed.publicKey && parsed.privateKey) {
          this.seal = { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
          return this.seal
        }
      } catch { /* a key that cannot be read is replaced rather than trusted */ }
    }
    const created = generateSealKey()
    vault.write(RELAY_KEY_SECRET, JSON.stringify(created))
    this.seal = created
    return this.seal
  }

  /**
   * Whether an off-network route may run at all. Being signed into GitHub still gates it, because
   * the account is what proves a peer is the owner's own machine on either route - the relay the
   * owner runs decides who may connect to it, not who anybody is.
   */
  private relayEnabled(): boolean {
    const settings = this.peers.getSettings()
    return settings.enabled && settings.relay && this.auth.identity() !== null
  }

  /**
   * The device key this machine has reason to trust for another machine, from either side of a
   * pairing: the approved peer record on the machine being controlled, or the key pinned in the
   * pairing code on the machine doing the controlling.
   *
   * Only the first existed before, which made a relay mailbox unattributable on the controlling
   * side - it holds connections, not peer records - so that machine could never count a peer as
   * checked in, and the one place that notices a machine coming back was dead there. The pinned key
   * is the same one every relayed answer from that machine is already required to carry, so trusting
   * it here widens nothing: it only lets this machine recognise a signature it already demands.
   */
  private peerDeviceKey(machineId: string): string | null {
    const approved = this.peers.listPeers().find(peer => peer.machineId === machineId && !peer.revokedAt)?.publicKey
    if (approved) return approved
    const pinned = this.client?.list().find(connection => connection.machineId === machineId && connection.status !== 'revoked')?.deviceKey
    return pinned ?? null
  }

  /**
   * A room secret for this machine, made on first use. It is the one value a relay needs, so the
   * owner never has to produce one themselves: pressing start is enough, and pairing carries it.
   */
  private ensureRoomSecret(): string | null {
    const existing = this.roomSecret()
    if (existing) return existing
    const vault = new StoredSecretVault(this.deps.database, this.deps.cipher)
    if (!vault.available()) return null
    const created = generateRoomSecret()
    vault.write(RELAY_ROOM_SECRET, created)
    this.room = created
    return created
  }

  /** The room secret for the owner's own relay, read once from the credential store. */
  private roomSecret(): string | null {
    if (this.room) return this.room
    const vault = new StoredSecretVault(this.deps.database, this.deps.cipher)
    if (!vault.available()) return null
    const stored = vault.read(RELAY_ROOM_SECRET)
    this.room = stored && stored.trim() ? stored.trim() : null
    return this.room
  }

  /**
   * Points this machine at a relay of the owner's own, or takes it off one.
   *
   * The address is an ordinary setting and the secret is not, so they are set together here and the
   * secret goes straight into the credential store. Changing either one changes which route this
   * machine is on, so the old one is stopped and the new one started rather than left to notice.
   */
  private async setRelayServer(endpoint: string, secret: string | null): Promise<RemoteControlState> {
    const vault = new StoredSecretVault(this.deps.database, this.deps.cipher)
    const trimmed = String(endpoint ?? '').trim()
    if (trimmed) relayEndpointUrl(trimmed)
    if (secret !== null) {
      if (!vault.available()) {
        throw new RemoteAccessError('This machine has no credential store, so a relay secret cannot be kept safely here.', 500)
      }
      const value = String(secret).trim()
      if (value && value.length < 16) throw new RemoteAccessError('A relay room secret is at least 16 characters. Run `npm run relay:secret` on the relay to make one.', 400)
      vault.write(RELAY_ROOM_SECRET, value)
      this.room = value || null
    }
    // An address typed by hand replaces whatever a pairing code left behind, alternates included.
    this.peers.updateSettings({ relayEndpoint: trimmed, relayEndpointAlternates: [] })
    this.relay.start()
    this.publishState()
    return this.state()
  }

  /**
   * Starts, stops or reconfigures the relay this machine runs.
   *
   * Everything a relay needs is made here rather than asked for: the room secret on first start, the
   * certificate with it, and - if the owner asked - the router mapping that makes the address work
   * from outside the house. What comes back is a status that says which of those succeeded.
   */
  private async setRelayHosting(patch: { enabled?: boolean; port?: number; internet?: boolean }): Promise<RemoteControlState> {
    const next: Partial<RemoteControlSettings> = {}
    if (typeof patch.enabled === 'boolean') next.relayHosting = patch.enabled
    if (Number.isInteger(patch.port)) next.relayHostPort = Number(patch.port)
    if (typeof patch.internet === 'boolean') next.relayHostInternet = patch.internet
    if (patch.enabled === true && !this.ensureRoomSecret()) {
      throw new RemoteAccessError('This machine has no credential store, so a relay secret cannot be kept safely here.', 500)
    }
    this.peers.updateSettings(next)
    await this.relayHost.apply()
    this.relay.start()
    this.publishState()
    return this.state()
  }

  /**
   * A pairing code from a machine that uses the owner's relay carries that relay with it, so the
   * machine being paired can reach it at all. A machine that already has one of its own keeps it:
   * silently moving a machine to another relay would cut every pairing it already has.
   */
  private adoptRelayFromTicket(encoded: string): void {
    let ticket: RemotePairingTicket
    try { ticket = decodeTicket(encoded) } catch { return }
    if (!ticket.relayEndpoint || !ticket.relaySecret) return
    if (this.peers.getSettings().relayEndpoint || this.roomSecret() || this.relayHost.localEndpoint()) return
    const vault = new StoredSecretVault(this.deps.database, this.deps.cipher)
    if (!vault.available()) return
    try { relayEndpointUrl(ticket.relayEndpoint) } catch { return }
    vault.write(RELAY_ROOM_SECRET, ticket.relaySecret)
    this.room = ticket.relaySecret
    this.peers.updateSettings({
      relayEndpoint: ticket.relayEndpoint,
      relayEndpointAlternates: ticket.relayEndpointAlternates ?? [],
      relayFingerprint: ticket.relayFingerprint ?? ''
    })
    this.relay.start()
  }

  /** Callback installed into StructuredSessions after both services exist. */
  assertPromptDispatchAuthority(authority: PromptDispatchAuthority, spec: Pick<AgentSpec, 'projectId'>): void {
    if (!authority || authority.kind !== 'remote-peer' || authority.projectId !== spec.projectId) {
      throw new RemoteAccessError('Remote prompt authority does not match this session project.', 403, 'peer-revoked')
    }
    this.peers.requirePromptAuthority(authority.peerId, authority.projectId)
  }

  machines(): MachineDescriptor[] {
    return describeMachines(this.machineName(), this.client.list())
  }

  /**
   * What is reachable now, rather than what the last call happened to find.
   *
   * A paired machine's status was only ever a side effect of real work: one call that failed left
   * it marked unreachable until some later call happened to succeed. The launcher disables an
   * offline machine, so the owner could not make that later call happen from the one place the
   * staleness showed — a machine that blinked once stayed "unavailable" indefinitely.
   *
   * `projects.list` is the right probe rather than the cheapest one: reachability and the projects
   * that machine still advertises are the two things the launcher gates on, and a stale mapping
   * reads as exactly the same word.
   */
  async probeMachines(options: { scheduled?: boolean; background?: boolean } = {}): Promise<MachineDescriptor[]> {
    // A sweep the owner asked for is never folded into a scheduled one, because a scheduled sweep
    // may deliberately be skipping the very machine they are asking about.
    if (options.scheduled && this.probing) return await this.probing
    const now = Date.now()
    const peers = this.client.list().filter(connection =>
      connection.status !== 'revoked' && connection.peerId &&
      (!options.scheduled || this.probes.due(connection.machineId, now)) &&
      this.probes.begin(connection.machineId))
    if (!peers.length) return this.machines()
    const sweep = Promise.all(peers.map(async connection => {
      // A machine that does not answer is a result here, not a failure: call() has already recorded
      // why against the connection, and that recorded reason is what the owner is shown.
      try { await this.refreshRemoteProjects(connection.machineId, options) } catch { /* recorded by call() */ }
      // Whether it answered is what the call itself recorded - a machine that refused one request is
      // reachable, a machine that timed out is not - so the backoff follows that, not the throw.
      this.probes.settle(connection.machineId, this.client.get(connection.machineId)?.status === 'connected', Date.now())
    })).then(() => this.machines())
    if (options.scheduled) {
      this.probing = sweep
      void sweep.catch(() => undefined).finally(() => { if (this.probing === sweep) this.probing = null })
    }
    return await sweep
  }

  private scheduleMachineProbe(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => { void this.probeMachines({ scheduled: true, background: true }).catch(() => undefined) }, MACHINE_PROBE_MS)
    this.heartbeat.unref?.()
  }

  /**
   * A peer republishing its relay mailbox proves it is running and signed into the same account, so
   * a machine this one believes is offline is worth re-probing the moment it reappears there —
   * without waiting out the heartbeat interval.
   */
  private probeMachinesSeenOnRelay(): void {
    const reachable = new Set(this.relay.getStatus().reachable)
    const returned = this.client.list().filter(connection =>
      connection.status !== 'connected' && connection.status !== 'revoked' && reachable.has(connection.machineId))
    if (!returned.length) return
    // Proof of life outranks the backoff: whatever a machine's silent streak had earned it, it is
    // worth one probe now. This is what makes backing a silent machine off cost no responsiveness.
    for (const connection of returned) this.probes.reappeared(connection.machineId)
    void this.probeMachines({ scheduled: true, background: true }).catch(() => undefined)
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
  async refreshRemoteProjects(machineId: string, options: RemoteCallOptions = {}): Promise<RemoteProjectSummary[]> {
    return this.client.recordRemoteProjects(machineId, readRemoteProjectSummaries(await this.client.call(machineId, 'projects.list', {}, options)))
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
  async openRemote(machineId: string, request: { projectId: string; sessionId: string; provider?: string; model?: string; effort?: string; title?: string }): Promise<{ tabId: string; agentSessionId?: string; machineName: string; remoteProjectId: string; remoteSessionId: string; remoteCwd: string }> {
    const connection = this.client.get(machineId)
    if (!connection) throw new RemoteAccessError('This machine is not paired with that one.', 404)
    const localProject = this.deps.database.getProject(request.projectId)
    if (!localProject) throw new RemoteAccessError('This project is not registered on this machine.', 404)
    const local = projectSummary(localProject)
    if (!local.identity) throw new RemoteAccessError(local.identityError || 'Conductor cannot read this project identity, so it will not place work elsewhere.', 409)
    const advertised = await this.refreshRemoteProjects(machineId)
    const grant = this.client.get(machineId)?.projectGrants.find(entry => entry.localProjectId === request.projectId)
    const observed = advertised.find(entry => entry.id === grant?.remoteProjectId)
    const placement = checkRemoteProjectPlacement({
      grant,
      advertised: observed?.identity,
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
    return { tabId: tab.id, agentSessionId: tab.resourceId, machineName: connection.machineName, remoteProjectId, remoteSessionId, remoteCwd: observed!.identity!.path }
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
    // conversation the local projection cannot represent. A local model qualifies: the weights and
    // the llama.cpp servers stay on the machine that has them, and this one only mirrors the
    // conversation, which is the whole point of reaching another device's local stack.
    const provider = request.provider ?? 'claude'
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'local') throw new RemoteAccessError(`${provider} cannot run on another machine yet.`, 400)
    const opened = await this.openRemote(request.machineId, request)
    if (!opened.agentSessionId) throw new RemoteAccessError(`${opened.machineName} opened a tab that runs no conversation.`, 409)
    const localSessionId = makeId('agent')
    this.mirror.bind({
      localSessionId,
      machineId: request.machineId,
      projectId: request.projectId,
      workspaceId: request.sessionId,
      provider,
      cwd: opened.remoteCwd,
      remoteProjectId: opened.remoteProjectId,
      remoteSessionId: opened.remoteSessionId,
      remoteAgentSessionId: opened.agentSessionId,
      remoteTabId: opened.tabId,
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
      relay: this.relay.getStatus(),
      relaySecretSet: this.roomSecret() !== null,
      relayHost: this.relayHost.getStatus(),
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
    // The relay this machine runs comes up before the client that uses it, so the first connection
    // finds something listening instead of failing and waiting out a backoff.
    await this.relayHost.apply()
    // The relay is what makes this machine answerable from another network, so it comes up with
    // the listener rather than on the first call: a machine nobody has called yet still has to be
    // found, and a peer's request has to be collected while nothing here is asking for anything.
    this.relay.start()
    // Paired machines are probed on a timer so a machine that blinked once does not stay marked
    // unavailable until the owner happens to make a call that succeeds.
    this.scheduleMachineProbe()
    void this.probeMachines({ background: true }).catch(() => undefined)
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
    if (before.enabled !== after.enabled || before.relay !== after.relay) await this.relayHost.apply()
    if (before.enabled !== after.enabled || before.relay !== after.relay || before.relayEndpoint !== after.relayEndpoint) {
      if (after.enabled && after.relay) this.relay.start()
      else this.relay.stop()
    }
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
    handle<RemoteControlState>('remote:set-relay-server', (endpoint: string, secret: string | null) =>
      this.setRelayServer(String(endpoint ?? ''), typeof secret === 'string' ? secret : null))
    handle<RemoteControlState>('remote:set-relay-hosting', (patch: { enabled?: boolean; port?: number; internet?: boolean }) =>
      this.setRelayHosting(patch ?? {}))
    handle<RemoteControlState>('remote:connect', async (ticket: string) => {
      // The relay has to be in place before the first pairing request goes out, or a machine that
      // is only reachable through it cannot be reached to be paired with.
      this.adoptRelayFromTicket(String(ticket))
      await this.client.connect(String(ticket))
      return this.state()
    })
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
    handle<MachineDescriptor[]>('remote:refresh-machines', () => this.probeMachines())
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
    handle<{ closed: boolean; message?: string }>('remote:close-tab', (localSessionId: string) => this.mirror.closeRemote(String(localSessionId)))
    handle<string>('remote:session-machine', (localSessionId: string) => this.mirror.machineId(String(localSessionId)))
    handle<{ machineId: string; cwd: string | null }>('remote:session-file-context', (localSessionId: string) => this.mirror.fileContext(String(localSessionId)))
    handle('remote:files-list', (request: RemoteFileIdentity) => this.files.list(request))
    handle('remote:files-stat', (request: RemoteFileIdentity) => this.files.stat(request))
    handle('remote:files-read', (request: RemoteFileIdentity) => this.files.read(request))
    handle('remote:files-write', (request: RemoteFileWriteRequest) => this.files.write(request))
    handle('remote:files-preview', (request: RemoteFileIdentity) => this.resources.issue(request))
    handle<boolean>('remote:files-revoke-preview', (url: string) => { this.resources.revoke(String(url)); return true })
    handle('remote:files-download', (request: RemoteFileIdentity) => this.resources.download(request))
  }

  async dispose(): Promise<void> {
    if (this.registered) {
      for (const channel of ['remote:github-state', 'remote:github-sign-in', 'remote:github-cancel', 'remote:github-sign-out',
        'remote:state', 'remote:set-settings', 'remote:set-relay-server', 'remote:set-relay-hosting', 'remote:ticket', 'remote:approve', 'remote:reshare-project', 'remote:deny', 'remote:revoke',
        'remote:connect', 'remote:forget', 'remote:remote-projects', 'remote:confirm-project', 'remote:release-project',
        'remote:machines', 'remote:refresh-machines', 'remote:open-tab', 'remote:close-tab', 'remote:session-machine', 'remote:session-file-context', 'remote:files-list', 'remote:files-stat', 'remote:files-read',
        'remote:files-write', 'remote:files-preview', 'remote:files-revoke-preview', 'remote:files-download']) ipcMain.removeHandler(channel)
      this.registered = false
    }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
    this.relay.stop()
    // The relay this machine runs goes down with it, and its router mapping is handed back rather
    // than left to expire - a forwarded port that nothing listens on is not something to leave open.
    await this.relayHost.stop()
    this.mirror.stop()
    this.resources.close()
    await this.server.close()
  }
}
