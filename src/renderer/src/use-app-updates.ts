import { useCallback, useSyncExternalStore } from 'react'
import type { AgentActivityPhase, AppUpdateState } from '../../shared/models'

const initialState: AppUpdateState = {
  phase: 'disabled',
  currentVersion: '',
  configured: false
}

type UpdateAction = 'check' | 'download' | 'install'
export interface UpdateBusyTab { id: string; title: string }
type UpdatesBridge = typeof window.conductor.updates

/** A tab whose turn is still in flight, or paused only because it is waiting on the person
 *  at the keyboard: quitting now would abandon that work, so it counts as "still running"
 *  for the one-click restart gate below. A tab the user already stopped, or one that never
 *  started, does not. */
const STILL_RUNNING_PHASES: ReadonlySet<AgentActivityPhase> = new Set(['working', 'limited', 'waiting_input'])

const defaultLookupTitle = async (id: string): Promise<string | undefined> => {
  const projection = await window.conductor.structured.snapshot(id).catch(() => null)
  return projection?.title
}

const defaultActivityEvents = (listener: (id: string, phase: AgentActivityPhase) => void): (() => void) => {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<{ id: string; phase: AgentActivityPhase }>).detail
    listener(detail.id, detail.phase)
  }
  window.addEventListener('conductor:agent-activity', handler)
  return () => window.removeEventListener('conductor:agent-activity', handler)
}

interface UpdateStoreSnapshot {
  state: AppUpdateState
  autoDownload: boolean
  pendingQuitConfirm: UpdateBusyTab[] | null
}

/** One store per window, not per mounted component: the status-bar button, the update-ready
 *  prompt and the settings panel all need the same in-flight action and the same pending
 *  quit confirmation, and a click that starts a cascade (download then install) must be
 *  visible to whichever of them re-renders next, not just the instance that issued it. */
export class UpdateStore {
  private state: AppUpdateState = initialState
  private autoDownload = false
  private pendingQuitConfirm: UpdateBusyTab[] | null = null
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private inFlight: { id: number; action: UpdateAction } | null = null
  private nextRequestId = 0
  private autoDownloadAttempt: string | null = null
  private readonly activity = new Map<string, AgentActivityPhase>()
  private resolvingQuitConfirm = false
  private started = false
  private snapshotValue: UpdateStoreSnapshot = this.buildSnapshot()

  // Every dependency is resolved lazily (see the resolve* methods below) rather than defaulted
  // here, so constructing a store never touches `window` or `localStorage`. Bare construction
  // happens on every render that calls useAppUpdates, including a server-side render of a
  // presentational component like AppUpdateButton in a test with no browser globals at all;
  // only ensureStarted, reached solely through a real subscription, needs them to exist.
  constructor(
    private readonly bridgeOverride?: UpdatesBridge,
    private readonly lookupTitleOverride?: (id: string) => Promise<string | undefined>,
    private readonly storageOverride?: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly activityEventsOverride?: (listener: (id: string, phase: AgentActivityPhase) => void) => () => void
  ) {}

  private resolveBridge(): UpdatesBridge { return this.bridgeOverride ?? window.conductor.updates }
  private resolveLookupTitle(): (id: string) => Promise<string | undefined> { return this.lookupTitleOverride ?? defaultLookupTitle }
  private resolveStorage(): Pick<Storage, 'getItem' | 'setItem'> { return this.storageOverride ?? localStorage }
  private resolveActivityEvents(): (listener: (id: string, phase: AgentActivityPhase) => void) => () => void { return this.activityEventsOverride ?? defaultActivityEvents }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.ensureStarted()
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): UpdateStoreSnapshot => this.snapshotValue

  private buildSnapshot(): UpdateStoreSnapshot {
    return { state: this.state, autoDownload: this.autoDownload, pendingQuitConfirm: this.pendingQuitConfirm }
  }

  private publish(): void {
    this.revision++
    this.snapshotValue = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    this.autoDownload = this.resolveStorage().getItem('conductor.autoDownloadUpdates') === 'true'
    this.publish()
    const bridge = this.resolveBridge()
    bridge.onState((state) => this.acceptState(state))
    const initialRevision = this.revision
    void bridge.getState().then((state) => {
      if (this.revision === initialRevision) this.acceptState(state)
    }).catch((error: unknown) => {
      if (this.revision === initialRevision) this.acceptState({ ...this.state, phase: 'error', message: String(error).slice(0, 280) })
    })
    this.resolveActivityEvents()((id, phase) => this.activity.set(id, phase))
  }

  private acceptState(state: AppUpdateState): void {
    const pending = this.inFlight
    // A check already in progress can broadcast its old candidate after a click.
    if (pending?.action === 'download' && ['available', 'checking'].includes(state.phase)) return
    if (pending?.action === 'install' && state.phase === 'ready') return
    if (pending && (
      pending.action === 'download' && ['ready', 'error'].includes(state.phase) ||
      pending.action === 'install' && state.phase === 'error' ||
      pending.action === 'check' && state.phase !== 'checking'
    )) this.inFlight = null
    this.state = state
    this.publish()
    this.maybeAutoDownload()
  }

  setAutoDownload(enabled: boolean): void {
    this.resolveStorage().setItem('conductor.autoDownloadUpdates', String(enabled))
    this.autoDownload = enabled
    this.publish()
    this.maybeAutoDownload()
  }

  private maybeAutoDownload(): void {
    if (!this.autoDownload || this.state.phase !== 'available') return
    const key = `${this.state.source ?? 'release'}:${this.state.availableVersion ?? ''}`
    if (this.autoDownloadAttempt === key) return
    this.autoDownloadAttempt = key
    // Automatic downloads only ever prepare the update; restarting still needs an explicit
    // click so active work is never interrupted without the owner asking for it.
    void this.perform('download')
  }

  private async perform(action: UpdateAction): Promise<void> {
    // This guard also blocks two clicks in the same tick.
    if (this.inFlight || ['checking', 'downloading', 'installing'].includes(this.state.phase)) return
    const requestId = ++this.nextRequestId
    this.inFlight = { id: requestId, action }
    this.acceptState({
      ...this.state,
      phase: action === 'check' ? 'checking' : action === 'download' ? 'downloading' : 'installing',
      progress: undefined,
      message: action === 'check' ? 'Checking for updates…' : action === 'download' ? 'Preparing download…' : 'Preparing restart…'
    })
    const requestRevision = this.revision
    const bridge = this.resolveBridge()
    try {
      let response: AppUpdateState
      if (action === 'install') {
        await bridge.install()
        response = await bridge.getState()
      } else {
        response = await bridge[action]()
      }
      // Progress/completion broadcasts are newer than an IPC response snapshot.
      if (this.revision === requestRevision) this.acceptState(response)
    } catch (error: unknown) {
      if (this.inFlight?.id === requestId && this.state.phase !== 'error') {
        this.state = { ...this.state, phase: 'error', progress: undefined, message: String(error).slice(0, 280) }
        this.publish()
      }
    } finally {
      if (this.inFlight?.id === requestId) this.inFlight = null
    }
  }

  private runningTabIds(): string[] {
    return [...this.activity.entries()].filter(([, phase]) => STILL_RUNNING_PHASES.has(phase)).map(([id]) => id)
  }

  private async proceedToInstall(): Promise<void> {
    if (this.resolvingQuitConfirm) return
    const running = this.runningTabIds()
    if (running.length === 0) { await this.perform('install'); return }
    this.resolvingQuitConfirm = true
    try {
      const lookupTitle = this.resolveLookupTitle()
      this.pendingQuitConfirm = await Promise.all(running.map(async (id) => ({ id, title: (await lookupTitle(id).catch(() => undefined)) || 'Untitled conversation' })))
      this.publish()
    } finally {
      this.resolvingQuitConfirm = false
    }
  }

  /** The one click this button promises: download if needed, then install and restart
   *  immediately, unless something is still running and confirmQuitAndInstall must be
   *  called first. */
  async runUpdateAction(): Promise<void> {
    if (this.pendingQuitConfirm) return
    const state = this.state
    if (state.phase === 'ready') { await this.proceedToInstall(); return }
    if (state.phase === 'available' || state.phase === 'error' && state.availableVersion) {
      await this.perform('download')
      if (this.state.phase === 'ready') await this.proceedToInstall()
      return
    }
    if (state.phase === 'error' || state.phase === 'idle') await this.perform('check')
  }

  async checkForUpdates(): Promise<void> {
    if (this.state.phase !== 'ready') await this.perform('check')
  }

  async confirmQuitAndInstall(): Promise<void> {
    if (!this.pendingQuitConfirm) return
    this.pendingQuitConfirm = null
    this.publish()
    await this.perform('install')
  }

  cancelQuitConfirm(): void {
    if (!this.pendingQuitConfirm) return
    this.pendingQuitConfirm = null
    this.publish()
  }
}

// Constructed lazily, on first use inside a mounted component: this module is also imported
// by plain unit tests running with no `window`, and those tests build their own UpdateStore
// with fakes instead of ever calling useAppUpdates.
let singleton: UpdateStore | null = null
const sharedStore = (): UpdateStore => singleton ?? (singleton = new UpdateStore())

export const useAppUpdates = (): {
  updateState: AppUpdateState
  autoDownload: boolean
  setAutoDownload(enabled: boolean): void
  runUpdateAction(): Promise<void>
  checkForUpdates(): Promise<void>
  pendingQuitConfirm: UpdateBusyTab[] | null
  confirmQuitAndInstall(): Promise<void>
  cancelQuitConfirm(): void
} => {
  const store = sharedStore()
  // A static/server render (see AppUpdateButton's own render-only tests) never subscribes,
  // so it must be content with whatever snapshot already exists instead of erroring.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const setAutoDownload = useCallback((enabled: boolean): void => store.setAutoDownload(enabled), [store])
  const runUpdateAction = useCallback((): Promise<void> => store.runUpdateAction(), [store])
  const checkForUpdates = useCallback((): Promise<void> => store.checkForUpdates(), [store])
  const confirmQuitAndInstall = useCallback((): Promise<void> => store.confirmQuitAndInstall(), [store])
  const cancelQuitConfirm = useCallback((): void => store.cancelQuitConfirm(), [store])
  return {
    updateState: snapshot.state,
    autoDownload: snapshot.autoDownload,
    setAutoDownload,
    runUpdateAction,
    checkForUpdates,
    pendingQuitConfirm: snapshot.pendingQuitConfirm,
    confirmQuitAndInstall,
    cancelQuitConfirm
  }
}
