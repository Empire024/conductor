import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  ContextAttachment,
  InteractionResponse,
  Json,
  QueuedPrompt,
  SessionPhase,
  SessionProjection,
  SessionSettings,
  StructuredProvider
} from '../shared/structured-agent'
import type { AgentSpec, RuntimeEnsureResult } from '../shared/models'
import type { RemotePromptFileAttachment } from '../shared/remote-files'
import type { ConductorDatabase } from './database'

/**
 * What a local tab needs in order to show a conversation that is really running on another
 * machine. The remote ids are that machine's private ids and are never shown to the owner; the
 * local ids are what every existing pane, store and IPC handler already keys on, which is why a
 * mirrored tab needs no special case anywhere in the renderer.
 */
export interface RemoteSessionBinding {
  localSessionId: string
  machineId: string
  projectId: string
  workspaceId: string
  provider: StructuredProvider
  cwd: string
  remoteProjectId: string
  remoteSessionId: string
  remoteAgentSessionId: string
  /**
   * The tab that machine opened for this conversation, so closing the mirrored tab here can close
   * the real one there. Bindings made before this was recorded resolve it from `agents.list`.
   */
  remoteTabId?: string
  /** The highest sequence already copied from that machine, so polling stays incremental. */
  remoteSequence: number
}

const BINDINGS_SETTING = 'remote-control.sessionMirrors'
const OWNERS_SETTING = 'remote-control.sessionMirrorOwners'

function readOwners(raw: string | undefined): Map<string, string> {
  if (!raw) return new Map()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    return new Map(Object.entries(parsed).flatMap(([sessionId, machineId]) =>
      sessionId && typeof machineId === 'string' && machineId ? [[sessionId, machineId]] : []))
  } catch { return new Map() }
}

export function readBindings(raw: string | undefined): RemoteSessionBinding[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Partial<RemoteSessionBinding>
    const strings = [value.localSessionId, value.machineId, value.projectId, value.workspaceId, value.cwd,
      value.remoteProjectId, value.remoteSessionId, value.remoteAgentSessionId]
    if (strings.some(field => typeof field !== 'string' || !field)) return []
    if (typeof value.provider !== 'string') return []
    if (value.remoteTabId !== undefined && (typeof value.remoteTabId !== 'string' || !value.remoteTabId)) return []
    return [{
      ...(value as RemoteSessionBinding),
      remoteSequence: Number.isSafeInteger(value.remoteSequence) && value.remoteSequence! >= 0 ? value.remoteSequence! : 0
    }]
  })
}

/**
 * Rewrites one machine's events so they belong to the local session that displays them. The
 * sequence is renumbered from the local projection rather than carried across, because the two
 * journals advance independently and the local store rejects a gap; the remote sequence is kept
 * separately so a reconnect resumes where the copy stopped rather than replaying the whole
 * conversation. Events at or below what was already copied are dropped, which makes an overlapping
 * re-poll after a dropped connection idempotent instead of duplicating the transcript.
 */
export function rekeyRemoteEvents(
  events: AgentEvent[],
  binding: RemoteSessionBinding,
  localSequence: number
): { events: AgentEvent[]; remoteSequence: number } {
  let sequence = localSequence
  let remoteSequence = binding.remoteSequence
  const fresh = events
    .filter(event => Number.isSafeInteger(event?.sequence) && event.sequence > binding.remoteSequence)
    .sort((left, right) => left.sequence - right.sequence)
  const rekeyed = fresh.map(event => {
    remoteSequence = Math.max(remoteSequence, event.sequence)
    sequence += 1
    return {
      ...event,
      sequence,
      sessionId: binding.localSessionId,
      projectId: binding.projectId,
      workspaceId: binding.workspaceId,
      cwd: binding.cwd
    }
  })
  return { events: rekeyed, remoteSequence }
}

function retainedRuntimeStatus(phase: SessionPhase): RuntimeEnsureResult['status'] {
  if (phase === 'starting') return 'starting'
  if (phase === 'running' || phase === 'interrupting') return 'running'
  if (phase === 'waiting_approval' || phase === 'waiting_input') return 'waiting_input'
  if (phase === 'completed') return 'complete'
  if (phase === 'failed') return 'error'
  return 'exited'
}

export interface RemoteSessionMirrorDependencies {
  database: ConductorDatabase
  /** Calls one method on a paired machine; the client already enforces pairing and identity. */
  call(machineId: string, method: string, args?: Record<string, unknown>): Promise<unknown>
  publish(channel: string, payload: unknown): void
  /** Injected so tests drive the poll loop instead of waiting on a timer. */
  schedule?(run: () => void, ms: number): { cancel(): void }
}

/**
 * Copies a conversation running on a paired machine into the local structured store, so the tab
 * the owner is looking at is an ordinary local session that happens to be fed from elsewhere.
 * Everything the owner types is forwarded the other way. Nothing here decides *whether* a machine
 * may be used: that is settled by the pairing and the project mapping before a binding exists.
 */
export class RemoteSessionMirror {
  private bindings = new Map<string, RemoteSessionBinding>()
  /** Durable execution ownership outlives the live route; `local` is an explicit relocation. */
  private owners: Map<string, string>
  /** Invalidates every continuation that captured an older binding, including same-id rebinds. */
  private revisions = new Map<string, number>()
  /** Latest metadata request wins when the same mounted pane asks twice. */
  private metadataRequests = new Map<string, number>()
  /** Settings are ordered so an older network reply can never overwrite a newer owner choice. */
  private settingMutations = new Map<string, Promise<void>>()
  private timer: { cancel(): void } | null = null
  private polling = false

  constructor(private readonly deps: RemoteSessionMirrorDependencies) {
    this.owners = readOwners(this.deps.database.getSetting(OWNERS_SETTING) || undefined)
    let recoveredOwner = false
    for (const binding of readBindings(this.deps.database.getSetting(BINDINGS_SETTING) || undefined)) {
      this.bindings.set(binding.localSessionId, binding)
      if (!this.owners.has(binding.localSessionId)) { this.owners.set(binding.localSessionId, binding.machineId); recoveredOwner = true }
    }
    if (recoveredOwner) this.saveOwners()
  }

  list(): RemoteSessionBinding[] { return [...this.bindings.values()].map(binding => ({ ...binding })) }

  get(localSessionId: string): RemoteSessionBinding | undefined {
    const binding = this.bindings.get(localSessionId)
    return binding ? { ...binding } : undefined
  }

  private owner(localSessionId: string): string | null {
    if (this.owners.has(localSessionId)) return this.owners.get(localSessionId) ?? null
    const machineId = this.deps.database.structured.spec<AgentSpec>(localSessionId)?.machineId
    return typeof machineId === 'string' && machineId ? machineId : null
  }

  /**
   * True means the session must never enter local execution. This deliberately survives removal
   * of its live route: retained history still belongs to the machine recorded in its spec/tombstone.
   */
  isRemote(localSessionId: string): boolean {
    const owner = this.owner(localSessionId)
    return Boolean(owner && owner !== 'local')
  }

  /**
   * Mounts the retained local view of a remotely-owned conversation. The renderer's legacy
   * `agent:ensure` request necessarily contains the controller project's cwd, so cwd is not an
   * authority input here. Durable structured metadata supplies the real host cwd and machine.
   * This method only validates identity and reports saved state: it performs no network call,
   * constructs no adapter and remains usable after the live pairing has been released.
   */
  mount(spec: AgentSpec): RuntimeEnsureResult {
    const stored = this.deps.database.structured.spec<AgentSpec>(spec?.id)
    const projection = this.deps.database.structured.snapshot(spec?.id)
    const owner = this.owner(spec?.id)
    if (!stored || !projection || !owner || owner === 'local') {
      throw new Error('This conversation has no retained remote execution owner.')
    }
    if (stored.id !== spec.id || stored.projectId !== spec.projectId || stored.sessionId !== spec.sessionId
      || stored.provider !== spec.provider || projection.sessionId !== spec.id) {
      throw new Error('The requested tab does not match the retained remote conversation identity.')
    }
    if (spec.machineId && spec.machineId !== owner) {
      throw new Error('The requested machine does not own this remote conversation.')
    }
    const binding = this.bindings.get(spec.id)
    if (binding && (binding.machineId !== owner || binding.projectId !== stored.projectId
      || binding.workspaceId !== stored.sessionId || binding.provider !== stored.provider)) {
      throw new Error('The active remote route does not match the retained conversation identity.')
    }
    return {
      id: spec.id,
      available: true,
      status: retainedRuntimeStatus(projection.phase),
      transcript: '',
      model: projection.settings.model ?? stored.model ?? 'default',
      ...(!binding ? { message: 'Remote pairing is unavailable; saved history remains read-only.' } : {})
    }
  }

  /** Durable execution owner used by renderer file links after a live route is released. */
  machineId(localSessionId: string): string {
    return this.owner(localSessionId) ?? 'local'
  }

  fileContext(localSessionId: string): { machineId: string; cwd: string | null } {
    const binding = this.bindings.get(localSessionId)
    const spec = this.deps.database.structured.spec<AgentSpec>(localSessionId)
    return { machineId: this.machineId(localSessionId), cwd: binding?.cwd ?? spec?.cwd ?? null }
  }

  private binding(localSessionId: string): RemoteSessionBinding {
    const binding = this.bindings.get(localSessionId)
    if (!binding) {
      const owner = this.owner(localSessionId)
      if (owner && owner !== 'local') throw new Error(`This conversation belongs to remote machine ${owner}, but its pairing is no longer active. Its saved history remains read-only.`)
      throw new Error('This conversation is not running on another machine.')
    }
    return binding
  }

  private capture(localSessionId: string): { binding: RemoteSessionBinding; revision: number } {
    return { binding: this.binding(localSessionId), revision: this.revisions.get(localSessionId) ?? 0 }
  }

  private current(captured: { binding: RemoteSessionBinding; revision: number }): boolean {
    return this.bindings.get(captured.binding.localSessionId) === captured.binding
      && (this.revisions.get(captured.binding.localSessionId) ?? 0) === captured.revision
  }

  private assertCurrent(captured: { binding: RemoteSessionBinding; revision: number }): void {
    if (!this.current(captured)) throw new Error('The remote conversation binding changed while the request was in flight. No result was applied.')
  }

  private assertRouteCurrent(captured: { binding: RemoteSessionBinding; revision: number }): void {
    if (!this.routeCurrent(captured)) {
      throw new Error('The remote conversation binding changed while the request was in flight. No result was applied.')
    }
  }

  private routeCurrent(captured: { binding: RemoteSessionBinding; revision: number }): boolean {
    return (this.revisions.get(captured.binding.localSessionId) ?? 0) === captured.revision
      && this.bindings.has(captured.binding.localSessionId)
  }

  private invalidate(localSessionId: string): void {
    this.revisions.set(localSessionId, (this.revisions.get(localSessionId) ?? 0) + 1)
  }

  private args(binding: RemoteSessionBinding): Record<string, unknown> {
    return {
      projectId: binding.remoteProjectId,
      sessionId: binding.remoteSessionId,
      agentSessionId: binding.remoteAgentSessionId
    }
  }

  private remoteAttachments(binding: RemoteSessionBinding, attachments: ContextAttachment[] | undefined): RemotePromptFileAttachment[] {
    if (!attachments?.length) return []
    if (!Array.isArray(attachments) || attachments.length > 20) throw new Error('A remote prompt can attach at most 20 host files.')
    return attachments.map(item => {
      const attachment = item as ContextAttachment & Partial<RemotePromptFileAttachment>
      const file = attachment.remoteFile
      const path = typeof file?.path === 'string' ? file.path.replaceAll('\\', '/') : ''
      if (attachment.kind !== 'file' || typeof attachment.id !== 'string' || !attachment.id || attachment.id.length > 160
        || typeof attachment.name !== 'string' || !attachment.name || attachment.name.length > 512
        || Object.hasOwn(attachment, 'content') || Object.hasOwn(attachment, 'path') || !file
        || file.machineId !== binding.machineId || file.projectId !== binding.projectId
        || !path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..')) {
        throw new Error('Remote attachments must identify a file in this conversation\'s confirmed host project; controller paths and content are refused.')
      }
      return {
        id: attachment.id, kind: 'file', name: attachment.name,
        remoteFile: {
          machineId: binding.machineId, projectId: binding.remoteProjectId,
          path: path.split('/').filter(part => part && part !== '.').join('/')
        }
      }
    })
  }

  private save(): void {
    this.deps.database.setSetting(BINDINGS_SETTING, JSON.stringify([...this.bindings.values()]))
  }

  private saveOwners(): void {
    this.deps.database.setSetting(OWNERS_SETTING, JSON.stringify(Object.fromEntries(this.owners)))
  }

  /**
   * Registers the local half of a mirrored tab. The local session is registered before any event
   * arrives so the pane has something to open immediately, rather than showing an empty tab until
   * the first poll returns.
   */
  bind(binding: RemoteSessionBinding): RemoteSessionBinding {
    const stored = { ...binding, remoteSequence: binding.remoteSequence ?? 0 }
    const owner = this.owner(stored.localSessionId)
    if (owner && owner !== 'local' && owner !== stored.machineId) {
      throw new Error(`This conversation belongs to remote machine ${owner}; it cannot be rebound to ${stored.machineId}.`)
    }
    this.invalidate(stored.localSessionId)
    this.bindings.set(stored.localSessionId, stored)
    this.owners.set(stored.localSessionId, stored.machineId)
    this.save()
    this.saveOwners()
    const store = this.deps.database.structured
    if (!store.snapshot(stored.localSessionId)) {
      const spec: AgentSpec = {
        id: stored.localSessionId, projectId: stored.projectId, sessionId: stored.workspaceId,
        provider: stored.provider, title: 'Remote conversation', cwd: stored.cwd, machineId: stored.machineId
      }
      // The agent row owns the structured session; registering without it would leave a
      // conversation the rest of the app cannot look up by tab.
      this.deps.database.upsertAgent(spec, 'running', 'idle')
      store.register(stored.localSessionId, stored.projectId, stored.provider, spec)
    }
    return { ...stored }
  }

  release(localSessionId: string): void {
    if (this.bindings.delete(localSessionId)) { this.invalidate(localSessionId); this.save() }
  }

  /**
   * Closes the tab on the machine that actually runs this conversation, then stops mirroring it
   * here. Closing a placed tab is the owner closing that work, so it must not keep a pane open on
   * the other computer that nobody is looking at any more. The local binding is released either
   * way: the owner already closed the tab here, and a machine that was unreachable must not leave
   * a mirrored session bound to a tab that no longer exists.
   */
  async closeRemote(localSessionId: string): Promise<{ closed: boolean; message?: string }> {
    const binding = this.bindings.get(localSessionId)
    if (!binding) return { closed: false }
    try {
      const tabId = binding.remoteTabId ?? await this.remoteTabId(binding)
      await this.deps.call(binding.machineId, 'tabs.close', {
        projectId: binding.remoteProjectId, sessionId: binding.remoteSessionId, tabId
      })
      return { closed: true }
    } catch (error) {
      return { closed: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.release(localSessionId)
    }
  }

  /** Bindings written before the remote tab id was recorded ask that machine which tab it is. */
  private async remoteTabId(binding: RemoteSessionBinding): Promise<string> {
    const raw = await this.deps.call(binding.machineId, 'agents.list', {
      projectId: binding.remoteProjectId, sessionId: binding.remoteSessionId
    })
    const entry = (Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [])
      .find(candidate => candidate?.agentSessionId === binding.remoteAgentSessionId)
    if (typeof entry?.tabId !== 'string' || !entry.tabId) throw new Error('That machine no longer has a tab open for this conversation.')
    return entry.tabId
  }

  /** Drops every binding to a machine the owner just forgot or revoked. */
  releaseMachine(machineId: string): void {
    let changed = false
    for (const [id, binding] of this.bindings) if (binding.machineId === machineId) {
      this.bindings.delete(id)
      this.invalidate(id)
      changed = true
    }
    if (changed) this.save()
  }

  /**
   * Copies whatever that machine has produced since the last poll. A failure is left to the next
   * poll rather than unbinding the tab: a laptop closing its lid should not destroy the owner's
   * view of a render that is still running on the other computer.
   */
  async pull(localSessionId: string): Promise<AgentEvent[]> {
    const active = this.bindings.get(localSessionId)
    if (!active) return []
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    const raw = await this.deps.call(binding.machineId, 'agents.history', {
      projectId: binding.remoteProjectId,
      sessionId: binding.remoteSessionId,
      agentSessionId: binding.remoteAgentSessionId,
      afterSequence: binding.remoteSequence
    })
    if (!this.current(captured)) return []
    if (!Array.isArray(raw) || !raw.length) return []
    const store = this.deps.database.structured
    const projection: SessionProjection | null = store.snapshot(binding.localSessionId)
    if (!projection) return []
    const { events, remoteSequence } = rekeyRemoteEvents(raw as AgentEvent[], binding, projection.sequence)
    const appended: AgentEvent[] = []
    for (const event of events) {
      try { appended.push(store.append(event)) }
      // One malformed event from the other side must not strand the rest of the transcript.
      catch (error) { console.warn('Remote event rejected', error); break }
    }
    if (appended.length) {
      if (!this.current(captured)) return []
      this.bindings.set(binding.localSessionId, { ...binding, remoteSequence })
      this.save()
      store.checkpoint(binding.localSessionId)
      this.deps.publish('structured:events', appended)
    }
    return appended
  }

  /**
   * Mounting a mirrored pane synchronizes provider metadata from the actual host. It never creates
   * a controller-side provider. A local session event records that metadata after older remote
   * history is copied, so capabilities and phase describe the host's latest snapshot.
   */
  async connect(localSessionId: string): Promise<void> {
    const route = this.capture(localSessionId)
    await this.pull(localSessionId)
    this.assertRouteCurrent(route)
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    const request = (this.metadataRequests.get(localSessionId) ?? 0) + 1
    this.metadataRequests.set(localSessionId, request)
    const raw = await this.deps.call(binding.machineId, 'agents.snapshot', this.args(binding))
    if (!this.routeCurrent(captured) || this.metadataRequests.get(localSessionId) !== request) return
    if (!raw || typeof raw !== 'object') throw new Error('The remote machine returned an invalid conversation snapshot.')
    const snapshot = raw as Partial<SessionProjection>
    const phases: SessionPhase[] = ['idle', 'starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting', 'completed', 'failed', 'disconnected', 'interrupted']
    if (snapshot.sessionId !== binding.remoteAgentSessionId || !phases.includes(snapshot.phase as SessionPhase)
      || !snapshot.capabilities || snapshot.capabilities.provider !== binding.provider
      || !snapshot.settings || typeof snapshot.settings.plan !== 'boolean') {
      throw new Error('The remote machine returned conversation metadata for a different session or provider.')
    }
    const store = this.deps.database.structured
    const local = store.snapshot(localSessionId)
    if (!local) throw new Error('The mirrored conversation is no longer available.')
    const event: AgentEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      sequence: local.sequence + 1,
      sessionId: localSessionId,
      runtimeId: typeof snapshot.runtimeId === 'string' ? snapshot.runtimeId : local.runtimeId,
      provider: binding.provider,
      projectId: binding.projectId,
      workspaceId: binding.workspaceId,
      cwd: binding.cwd,
      timestamp: new Date().toISOString(),
      data: {
        type: 'session',
        phase: snapshot.phase as SessionPhase,
        ...(typeof snapshot.nativeSessionId === 'string' ? { nativeSessionId: snapshot.nativeSessionId } : {}),
        capabilities: snapshot.capabilities,
        settings: snapshot.settings,
        ...(typeof snapshot.title === 'string' ? { title: snapshot.title } : {}),
        ...(typeof snapshot.archived === 'boolean' ? { archived: snapshot.archived } : {})
      }
    }
    store.append(event)
    store.checkpoint(localSessionId)
    this.deps.publish('structured:events', [event])
  }

  /** One sweep over every mirrored tab; overlapping sweeps are skipped rather than queued. */
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      for (const id of [...this.bindings.keys()]) {
        try { await this.pull(id) }
        catch (error) { console.warn('Remote session poll failed', error) }
      }
    } finally { this.polling = false }
  }

  start(intervalMs = 1000): void {
    if (this.timer) return
    const schedule = this.deps.schedule ?? ((run, ms) => { const handle = setInterval(run, ms); return { cancel: () => clearInterval(handle) } })
    this.timer = schedule(() => void this.poll(), intervalMs)
  }

  stop(): void { this.timer?.cancel(); this.timer = null }

  /** Forwards what the owner typed to the machine that is actually running the conversation. */
  async submit(localSessionId: string, prompt: string, method: 'agents.submit' | 'agents.steer' = 'agents.submit', settings?: SessionSettings, attachments?: ContextAttachment[]): Promise<void> {
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    const remoteAttachments = this.remoteAttachments(binding, attachments)
    await this.deps.call(binding.machineId, method, { ...this.args(binding), prompt, ...(settings ? { settings } : {}), ...(remoteAttachments.length ? { attachments: remoteAttachments } : {}) })
    this.assertRouteCurrent(captured)
    await this.pull(localSessionId)
    this.assertRouteCurrent(captured)
  }

  async queue(localSessionId: string, prompt: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void> {
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    const remoteAttachments = this.remoteAttachments(binding, attachments)
    await this.deps.call(binding.machineId, 'agents.queue', { ...this.args(binding), prompt, settings, ...(remoteAttachments.length ? { attachments: remoteAttachments } : {}) })
    this.assertRouteCurrent(captured)
    await this.pull(localSessionId)
    this.assertRouteCurrent(captured)
  }

  async cancelQueued(localSessionId: string, promptId?: string): Promise<QueuedPrompt | null> {
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    const result = await this.deps.call(binding.machineId, 'agents.cancelQueued', { ...this.args(binding), ...(promptId ? { promptId } : {}) })
    this.assertRouteCurrent(captured)
    await this.pull(localSessionId)
    this.assertRouteCurrent(captured)
    return result && typeof result === 'object' ? result as QueuedPrompt : null
  }

  async interrupt(localSessionId: string, expediteSubmittedInput = false): Promise<void> {
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    await this.deps.call(binding.machineId, 'agents.interrupt', { ...this.args(binding), expediteSubmittedInput })
    this.assertRouteCurrent(captured)
    await this.pull(localSessionId)
    this.assertRouteCurrent(captured)
  }

  async resume(localSessionId: string, settings?: SessionSettings): Promise<void> {
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    await this.deps.call(binding.machineId, 'agents.resume', { ...this.args(binding), ...(settings ? { settings } : {}) })
    this.assertRouteCurrent(captured)
    await this.pull(localSessionId)
    this.assertRouteCurrent(captured)
  }

  async discover(localSessionId: string): Promise<Json> {
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    const result = await this.deps.call(binding.machineId, 'agents.discover', this.args(binding))
    this.assertRouteCurrent(captured)
    await this.pull(localSessionId)
    this.assertRouteCurrent(captured)
    return result as Json
  }

  async saveSettings(localSessionId: string, settings: SessionSettings): Promise<void> {
    const requested = this.capture(localSessionId)
    const previous = this.settingMutations.get(localSessionId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      this.assertRouteCurrent(requested)
      const binding = requested.binding
      await this.deps.call(binding.machineId, 'agents.settings', { ...this.args(binding), settings })
      this.assertRouteCurrent(requested)
      this.deps.database.structured.update(localSessionId, { settings })
    })
    this.settingMutations.set(localSessionId, operation)
    try { await operation } finally { if (this.settingMutations.get(localSessionId) === operation) this.settingMutations.delete(localSessionId) }
  }

  async respond(response: InteractionResponse): Promise<void> {
    const captured = this.capture(response.sessionId)
    const binding = captured.binding
    await this.deps.call(binding.machineId, 'agents.respond', { ...this.args(binding), response: { ...response, sessionId: binding.remoteAgentSessionId } })
    this.assertRouteCurrent(captured)
    await this.pull(response.sessionId)
    this.assertRouteCurrent(captured)
  }

  async rename(localSessionId: string, title: string): Promise<void> {
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    await this.deps.call(binding.machineId, 'agents.rename', { ...this.args(binding), title })
    this.assertRouteCurrent(captured)
    await this.pull(localSessionId)
    this.assertRouteCurrent(captured)
  }

  async archive(localSessionId: string, archived: boolean): Promise<void> {
    const captured = this.capture(localSessionId)
    const binding = captured.binding
    await this.deps.call(binding.machineId, 'agents.archive', { ...this.args(binding), archived })
    this.assertRouteCurrent(captured)
    await this.pull(localSessionId)
    this.assertRouteCurrent(captured)
  }

  /** Conversation selection rebinds idempotently; only an actual workspace move is unsupported. */
  bindWorkspace(localSessionId: string, workspaceId: string): void {
    const binding = this.bindings.get(localSessionId)
    const persistedWorkspaceId = binding?.workspaceId
      ?? this.deps.database.structured.spec<AgentSpec>(localSessionId)?.sessionId
    if (this.isRemote(localSessionId) && persistedWorkspaceId === workspaceId) return
    this.unsupported(localSessionId, 'Moving remote conversation history between local workspaces')
  }

  unsupported(localSessionId: string, feature: string): never {
    this.binding(localSessionId)
    throw new Error(`${feature} is not supported for a conversation running on another machine. Switch the tab to its host machine to use it.`)
  }
}
