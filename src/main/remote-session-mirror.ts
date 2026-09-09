import type { AgentEvent, SessionProjection, StructuredProvider } from '../shared/structured-agent'
import type { AgentSpec } from '../shared/models'
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
  /** The highest sequence already copied from that machine, so polling stays incremental. */
  remoteSequence: number
}

const BINDINGS_SETTING = 'remote-control.sessionMirrors'

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
  private timer: { cancel(): void } | null = null
  private polling = false

  constructor(private readonly deps: RemoteSessionMirrorDependencies) {
    for (const binding of readBindings(this.deps.database.getSetting(BINDINGS_SETTING) || undefined)) {
      this.bindings.set(binding.localSessionId, binding)
    }
  }

  list(): RemoteSessionBinding[] { return [...this.bindings.values()].map(binding => ({ ...binding })) }

  get(localSessionId: string): RemoteSessionBinding | undefined {
    const binding = this.bindings.get(localSessionId)
    return binding ? { ...binding } : undefined
  }

  /** True when this session is somewhere else, which is what routing a write has to check. */
  isRemote(localSessionId: string): boolean { return this.bindings.has(localSessionId) }

  private save(): void {
    this.deps.database.setSetting(BINDINGS_SETTING, JSON.stringify([...this.bindings.values()]))
  }

  /**
   * Registers the local half of a mirrored tab. The local session is registered before any event
   * arrives so the pane has something to open immediately, rather than showing an empty tab until
   * the first poll returns.
   */
  bind(binding: RemoteSessionBinding): RemoteSessionBinding {
    const stored = { ...binding, remoteSequence: binding.remoteSequence ?? 0 }
    this.bindings.set(stored.localSessionId, stored)
    this.save()
    const store = this.deps.database.structured
    if (!store.snapshot(stored.localSessionId)) {
      const spec = {
        id: stored.localSessionId, projectId: stored.projectId, sessionId: stored.workspaceId,
        provider: stored.provider, title: 'Remote conversation', cwd: stored.cwd, machineId: stored.machineId
      }
      // The agent row owns the structured session; registering without it would leave a
      // conversation the rest of the app cannot look up by tab.
      this.deps.database.upsertAgent(spec as unknown as AgentSpec, 'running', 'idle')
      store.register(stored.localSessionId, stored.projectId, stored.provider, spec)
    }
    return { ...stored }
  }

  release(localSessionId: string): void {
    if (this.bindings.delete(localSessionId)) this.save()
  }

  /** Drops every binding to a machine the owner just forgot or revoked. */
  releaseMachine(machineId: string): void {
    let changed = false
    for (const [id, binding] of this.bindings) if (binding.machineId === machineId) { this.bindings.delete(id); changed = true }
    if (changed) this.save()
  }

  /**
   * Copies whatever that machine has produced since the last poll. A failure is left to the next
   * poll rather than unbinding the tab: a laptop closing its lid should not destroy the owner's
   * view of a render that is still running on the other computer.
   */
  async pull(localSessionId: string): Promise<AgentEvent[]> {
    const binding = this.bindings.get(localSessionId)
    if (!binding) return []
    const raw = await this.deps.call(binding.machineId, 'agents.history', {
      projectId: binding.remoteProjectId,
      sessionId: binding.remoteSessionId,
      agentSessionId: binding.remoteAgentSessionId,
      afterSequence: binding.remoteSequence
    })
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
      this.bindings.set(binding.localSessionId, { ...binding, remoteSequence })
      this.save()
      store.checkpoint(binding.localSessionId)
      this.deps.publish('structured:events', appended)
    }
    return appended
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
  async submit(localSessionId: string, prompt: string, method: 'agents.submit' | 'agents.steer' = 'agents.submit'): Promise<void> {
    const binding = this.bindings.get(localSessionId)
    if (!binding) throw new Error('This conversation is not running on another machine.')
    await this.deps.call(binding.machineId, method, {
      projectId: binding.remoteProjectId, sessionId: binding.remoteSessionId,
      agentSessionId: binding.remoteAgentSessionId, prompt
    })
    await this.pull(localSessionId)
  }

  async interrupt(localSessionId: string): Promise<void> {
    const binding = this.bindings.get(localSessionId)
    if (!binding) throw new Error('This conversation is not running on another machine.')
    await this.deps.call(binding.machineId, 'agents.interrupt', {
      projectId: binding.remoteProjectId, sessionId: binding.remoteSessionId,
      agentSessionId: binding.remoteAgentSessionId
    })
    await this.pull(localSessionId)
  }
}
