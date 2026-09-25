import { RESTART_REQUEST_MAX_AGE_MS, type RestartInitiator, type RestartRequest } from './restart-initiator'
import { app, BrowserWindow } from 'electron'
import { NsisUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import type { UpdateDownloadedEvent } from 'electron-updater'
import { gt, valid } from 'semver'
import type { AppUpdateState } from '../shared/models'
import { DEFAULT_GITHUB_UPDATE_URL, normalizeUpdateFeedUrl, resolveUpdateProvider, type ConductorUpdateProvider } from './update-config'
import { LocalUpdateFeed } from './local-update-feed'
import { RestorePointStore } from './restore-points'
import type { CliPinState, RestorePlan, RestorePoint, RestoreScope } from '../shared/models'
import { CliVersionStore, PINNABLE_CLIS, plainCliVersion, restorePlan, setActiveCliVersions } from './cli-versions'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createUpdateInstallSeam, type InstallRequest, type UpdateInstallSeam } from './update-install-seam'

interface UpdateManagerOptions {
  currentVersion: string
  isPackaged: boolean
  allowDevelopmentUpdates?: boolean
  localBuildDirectory?: string
  /** `force` is the owner's own credential asking: no running-work dialog, drafts kept for recovery. */
  beforeInstall(force: boolean, initiator?: Omit<RestartInitiator, 'at'>): void | Promise<void>
  /** Defaults to the real one: quitAndInstall, or the installer stub in a test profile. */
  installSeam?: UpdateInstallSeam
  /** The model catalogs Conductor offers now, compared with a restore point's in its plan. */
  currentModels?(): RestorePoint['models']
  /** Saved CLI copies and pins (src/main/cli-versions.ts); defaults to one beside the restore points. */
  cliVersions?: CliVersionStore
  /** When the installed CLIs are first saved after launch; null never (unit tests). */
  cliSnapshotDelayMs?: number | null
}
interface PendingPrepare {
  requestId: string
  webContentsIds: Set<number>
  finish(): void
}
const CHECK_INTERVAL_MS = 2 * 60 * 1000
const CLI_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60_000
const PREPARE_TIMEOUT_MS = 2_000
/** A test profile (CONDUCTOR_TEST_USER_DATA) looks for older CLI versions under a fake home, never the owner's. */
const testCliHome = (): string | undefined => process.env.CONDUCTOR_TEST_USER_DATA ? process.env.CONDUCTOR_TEST_CLI_HOME?.trim() || join(process.env.CONDUCTOR_TEST_USER_DATA, 'cli-home') : undefined
const busy = (phase: AppUpdateState['phase']): boolean => ['downloading', 'ready', 'installing'].includes(phase)
const errorMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error:\s*/i, '').slice(0, 280)

export class UpdateManager {
  private state: AppUpdateState
  private updater: NsisUpdater | null = null
  private remoteUpdater: NsisUpdater | null = null
  private localUpdater: NsisUpdater | null = null
  private localFeed?: LocalUpdateFeed
  private restorePoints?: RestorePointStore
  private cliVersions?: CliVersionStore
  private cliSnapshotTimer: NodeJS.Timeout | null = null
  private localUrl?: string
  private includeLocal = true
  private epoch = 0
  private checking = false
  private checkTimer: NodeJS.Timeout | null = null
  private pendingPrepare: PendingPrepare | null = null
  private restartRequest: RestartRequest | null = null
  private readonly seam: UpdateInstallSeam
  /** The running version; in a test profile, the one the installer stub last "installed". */
  private readonly currentVersion: string
  private downloaded: Omit<InstallRequest, 'reason'> | null = null
  private installReason: InstallRequest['reason'] = 'update'

  constructor(private readonly options: UpdateManagerOptions) {
    this.seam = options.installSeam ?? createUpdateInstallSeam({ isPackaged: options.isPackaged, relaunch: () => { app.relaunch(); app.quit() } })
    this.currentVersion = this.seam.reportedVersion(options.currentVersion)
    this.state = { phase: 'disabled', currentVersion: this.currentVersion, configured: false, message: 'Connecting to update sources.' }
    if (options.localBuildDirectory) {
      this.localFeed = new LocalUpdateFeed(options.localBuildDirectory)
      this.restorePoints = new RestorePointStore(options.localBuildDirectory)
      this.restorePoints.beginRun(this.currentVersion)
      this.cliVersions = options.cliVersions ?? new CliVersionStore({ directory: join(options.localBuildDirectory, 'cli-cache'), ...(testCliHome() ? { home: testCliHome() } : {}) })
      setActiveCliVersions(this.cliVersions)
      // A test profile saves CLIs only when a smoke asks (CONDUCTOR_TEST_CLI_SNAPSHOT_MS), so no
      // other smoke copies the owner's real CLIs into its profile.
      const testDelay = process.env.CONDUCTOR_TEST_USER_DATA ? (process.env.CONDUCTOR_TEST_CLI_SNAPSHOT_MS ? Number(process.env.CONDUCTOR_TEST_CLI_SNAPSHOT_MS) : null) : 20_000
      const delay = options.cliSnapshotDelayMs === undefined ? testDelay : options.cliSnapshotDelayMs
      if (delay !== null) {
        this.cliSnapshotTimer = setTimeout(() => {
          void this.saveClis()
          this.cliSnapshotTimer = setInterval(() => void this.saveClis(), CLI_SNAPSHOT_INTERVAL_MS)
          this.cliSnapshotTimer.unref()
        }, delay)
        this.cliSnapshotTimer.unref()
      }
    }
  }
  getState(): AppUpdateState {
    const request = this.restartRequest
    const current = request && Date.now() - Date.parse(request.at) <= RESTART_REQUEST_MAX_AGE_MS
    return { ...this.state, ...(current ? { restartRequest: { title: request.title, reason: request.reason, at: request.at } } : {}) }
  }
  /** A wizard's app.restart.request, shown on the owner's update control until the next launch. */
  setRestartRequest(request: RestartRequest | null): void { this.restartRequest = request; this.setState(this.state) }
  versions(): RestorePoint[] { return this.restorePoints?.list() ?? [] }
  pinVersion(version: string, pinned: boolean): RestorePoint {
    if (!this.restorePoints) throw new Error('Local restore points are unavailable')
    return this.restorePoints.pin(version, pinned)
  }
  /** What rolling back to a restore point changes: the app (scope all) and the CLIs. */
  async restorePlan(version: string, scope: RestoreScope = 'all'): Promise<RestorePlan> {
    if (!this.restorePoints || !this.cliVersions) throw new Error('Local restore points are unavailable')
    const store = this.cliVersions
    const point = this.restorePoints.list().find(entry => entry.version === version)
    if (!point) throw new Error(`No restore point ${version}`)
    const pins = store.pins()
    const clis = Object.fromEntries(await Promise.all(PINNABLE_CLIS.map(async provider => {
      const installed = (await store.installed(provider).catch(() => null))?.version ?? null
      const recorded = plainCliVersion(point.cliVersions[provider])
      return [provider, { installed, pinned: pins[provider]?.version ?? null, availability: recorded ? store.availability(provider, recorded, installed) : 'missing' }] as const
    }))) as Parameters<typeof restorePlan>[0]['clis']
    return restorePlan({ point, scope, currentAppVersion: this.currentVersion, clis, currentModels: this.options.currentModels?.() ?? [],
      appRestorable: existsSync(join(this.restorePoints.directory, `restore-point-${version}.json`)) })
  }
  cliPins(): Promise<CliPinState[]> { return this.cliVersions?.pinStates() ?? Promise.resolve([]) }
  /** Every tab launches the installed Claude Code and Codex again. */
  useInstalledClis(): Promise<CliPinState[]> {
    this.cliVersions?.clearPins()
    return this.cliPins()
  }
  /** Keeps the installed CLIs and the versions the restore points name, so rolling back needs no network. */
  async saveClis(): Promise<void> {
    if (!this.cliVersions || !this.restorePoints) return
    try {
      const recorded = Object.fromEntries(PINNABLE_CLIS.map(provider => [provider, this.restorePoints!.list().map(point => plainCliVersion(point.cliVersions?.[provider])).filter((value): value is string => Boolean(value))]))
      await this.cliVersions.snapshot(recorded)
      await this.cliVersions.prune(recorded)
    } catch (error) { console.warn('Could not save the installed CLI versions', error) }
  }
  recordFailedShip(): void { this.restorePoints?.recordFailedShip(this.currentVersion) }

  configure(requestedUrl: string, includeLocal = this.includeLocal): string {
    if (busy(this.state.phase)) throw new Error('Finish the downloaded update before changing update sources')
    const feedUrl = normalizeUpdateFeedUrl(requestedUrl)
    this.epoch++
    this.clearTimer()
    this.checking = false
    for (const updater of [this.remoteUpdater, this.localUpdater]) {
      if (updater) { updater.autoInstallOnAppQuit = false; updater.removeAllListeners(); updater.on('error', () => {}) }
    }
    this.updater = this.remoteUpdater = this.localUpdater = null
    this.localUrl = undefined
    this.includeLocal = includeLocal
    if (!this.options.isPackaged && !this.options.allowDevelopmentUpdates) {
      this.setState({ phase: 'disabled', currentVersion: this.currentVersion, configured: true, message: 'Installed builds update from GitHub and enabled local test builds.' })
      return feedUrl
    }
    this.remoteUpdater = this.createUpdater(resolveUpdateProvider(feedUrl))
    this.setState({ phase: 'idle', currentVersion: this.currentVersion, configured: true, message: 'Checking ' + (feedUrl || DEFAULT_GITHUB_UPDATE_URL) + (includeLocal ? ' and local test builds' : '') + ' automatically.' })
    this.scheduleChecks()
    return feedUrl
  }
  private createUpdater(provider: ConductorUpdateProvider, allowDowngrade = false): NsisUpdater {
    const updater = new NsisUpdater(provider)
    const epoch = this.epoch
    const current = (): boolean => epoch === this.epoch && this.updater === updater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.autoRunAppAfterInstall = true
    updater.disableWebInstaller = true
    updater.allowDowngrade = allowDowngrade
    updater.allowPrerelease = false // Local generic feeds still accept their explicitly versioned build.
    updater.forceDevUpdateConfig = Boolean(this.options.allowDevelopmentUpdates)
    updater.logger = console
    this.seam.prepare(updater)
    updater.on('download-progress', (info: ProgressInfo) => {
      if (current()) this.setState({ ...this.state, phase: 'downloading', progress: Math.max(0, Math.min(100, info.percent)), message: 'Downloading Conductor ' + this.state.availableVersion + '…' })
    })
    updater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
      if (current()) this.downloaded = { version: info.version, installerPath: info.downloadedFile ?? null, sha512: info.sha512 ?? info.files?.[0]?.sha512 ?? null }
      if (current()) this.setState({ ...this.state, phase: 'ready', availableVersion: info.version, progress: 100, message: 'Update downloaded. Restart Conductor to install it.' })
      else updater.autoInstallOnAppQuit = false
    })
    updater.on('error', (reason: unknown) => {
      if (current() && busy(this.state.phase)) this.setState({ ...this.state, phase: 'error', message: errorMessage(reason) })
    })
    return updater
  }
  async check(): Promise<AppUpdateState> {
    if (!this.remoteUpdater || this.checking || busy(this.state.phase)) return this.getState()
    const epoch = this.epoch
    const remote = this.remoteUpdater
    this.checking = true
    this.setState({ ...this.state, phase: 'checking', message: 'Checking released and local builds…', localBuildWarning: undefined })
    const problems: string[] = []
    let selected = false
    const consider = (updater: NsisUpdater, info: UpdateInfo | undefined, source: 'local' | 'release'): void => {
      if (epoch !== this.epoch || busy(this.state.phase) || !info || !valid(info.version) || !gt(info.version, this.currentVersion)) return
      if (selected && this.state.availableVersion && !gt(info.version, this.state.availableVersion)) return
      selected = true
      this.updater = updater
      this.setState({ phase: 'available', currentVersion: this.currentVersion, availableVersion: info.version, source, configured: true, message: 'Update pending: Conductor ' + info.version + (source === 'local' ? ' (local test build).' : '.'), lastCheckedAt: new Date().toISOString(), localBuildWarning: this.state.localBuildWarning })
    }
    // Start remote I/O concurrently, but offer a valid local build without waiting
    // for the network. A selected download cannot be replaced by a late response.
    const remoteResult = remote.checkForUpdates().then(result => ({ result })).catch(error => ({ error }))
    try {
      if (this.includeLocal && this.localFeed) {
        try {
          const local = await this.localFeed.refresh()
          if (epoch !== this.epoch) return this.getState()
          if (local && gt(local.version, this.currentVersion)) {
            if (!this.localUpdater || local.url !== this.localUrl) {
              this.localUpdater?.removeAllListeners()
              this.localUpdater = this.createUpdater({ provider: 'generic', url: local.url, useMultipleRangeRequest: false })
              this.localUrl = local.url
            }
            const result = await this.localUpdater.checkForUpdates()
            if (result?.isUpdateAvailable) consider(this.localUpdater, result.updateInfo, 'local')
          }
        } catch (reason) {
          if (epoch === this.epoch) this.setState({ ...this.state, localBuildWarning: 'Local build rejected: ' + errorMessage(reason) })
        }
      }
      const remoteResponse = await remoteResult
      if (epoch !== this.epoch) return this.getState()
      if ('error' in remoteResponse) problems.push(errorMessage(remoteResponse.error))
      else if (remoteResponse.result?.isUpdateAvailable) consider(remote, remoteResponse.result.updateInfo, 'release')
      if (!selected && !busy(this.state.phase)) {
        this.updater = null
        this.setState({ phase: problems.length ? 'error' : 'idle', currentVersion: this.currentVersion, configured: true, message: problems[0] ?? 'Conductor is up to date.', lastCheckedAt: new Date().toISOString(), localBuildWarning: this.state.localBuildWarning })
      }
    } finally { if (epoch === this.epoch) this.checking = false }
    return this.getState()
  }
  async download(): Promise<AppUpdateState> {
    const updater = this.updater
    if (!updater || !(this.state.phase === 'available' || this.state.phase === 'error' && this.state.availableVersion)) return this.getState()
    this.setState({ ...this.state, phase: 'downloading', progress: undefined, message: 'Downloading Conductor ' + this.state.availableVersion + '…' })
    try { await updater.downloadUpdate() }
    catch (reason) { if (this.updater === updater) this.setState({ ...this.state, phase: 'error', message: errorMessage(reason) }) }
    return this.getState()
  }
  /** Selects an immutable historical build in the same loopback feed, downloads it through the
   * normal updater, then takes the existing guarded restart path. */
  async rollback(version: string, scope: RestoreScope = 'all'): Promise<RestorePlan> {
    if (!this.restorePoints || !this.localFeed || !this.cliVersions) throw new Error('Local restore points are unavailable')
    if (scope === 'all' && busy(this.state.phase)) throw new Error('Finish the current update before rolling back')
    const plan = await this.restorePlan(version, scope)
    if (plan.blocked) throw new Error(plan.blocked)
    // The CLIs first: they take effect at once, and the app install below ends this process.
    await this.cliVersions.restore(plan)
    if (scope === 'clis') return plan
    const point = this.restorePoints.activate(version)
    const local = await this.localFeed.refresh()
    if (!local || local.version !== point.version) throw new Error(`Restore point ${version} could not be opened by the local update feed`)
    this.localUpdater?.removeAllListeners()
    const updater = this.localUpdater = this.createUpdater({ provider: 'generic', url: local.url, useMultipleRangeRequest: false }, true)
    this.localUrl = local.url
    this.updater = updater
    const result = await updater.checkForUpdates()
    if (!result?.isUpdateAvailable) throw new Error(`Restore point ${version} is not installable`)
    this.setState({ phase: 'available', currentVersion: this.currentVersion, availableVersion: version, source: 'local', configured: true, message: `Rolling back to Conductor ${version}.` })
    await this.download()
    if (this.state.phase !== 'ready') throw new Error(this.state.message ?? `Could not download restore point ${version}`)
    this.installReason = 'rollback'
    try { await this.install() } finally { this.installReason = 'update' }
    return plan
  }
  async install(options: { force?: boolean } = {}, initiator?: Omit<RestartInitiator, 'at'>): Promise<void> {
    if (!this.updater || this.state.phase !== 'ready') return
    this.setState({ ...this.state, phase: 'installing', message: 'Saving windows and stopping processes…' })
    try {
      await this.prepareRenderers()
      await (initiator ? this.options.beforeInstall(options.force === true, initiator) : this.options.beforeInstall(options.force === true))
      const version = this.state.availableVersion ?? this.downloaded?.version ?? ''
      const downloaded = this.downloaded?.version === version ? this.downloaded : null
      this.seam.install(this.updater, { version, installerPath: downloaded?.installerPath ?? null, sha512: downloaded?.sha512 ?? null, reason: this.installReason })
    } catch (reason) {
      if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'UPDATE_CANCELLED') { this.setState({ ...this.state, phase: 'ready', message: 'Update ready. Restart whenever you are ready.' }); return }
      this.setState({ ...this.state, phase: 'error', message: 'Could not prepare the update: ' + errorMessage(reason) })
      throw reason
    }
  }
  acknowledgePrepare(webContentsId: number, requestId: string): void {
    const pending = this.pendingPrepare
    if (!pending || pending.requestId !== requestId) return
    pending.webContentsIds.delete(webContentsId)
    if (pending.webContentsIds.size === 0) pending.finish()
  }

  dispose(): void {
    this.clearTimer()
    if (this.cliSnapshotTimer) clearTimeout(this.cliSnapshotTimer)
    this.cliSnapshotTimer = null
    this.epoch++
    this.remoteUpdater?.removeAllListeners()
    this.localUpdater?.removeAllListeners()
    this.remoteUpdater?.on('error', () => {})
    this.localUpdater?.on('error', () => {})
    this.updater = this.remoteUpdater = this.localUpdater = null
    this.localFeed?.dispose()
    this.restorePoints?.endRun(this.currentVersion)
    this.pendingPrepare?.finish()
  }

  private setState(state: AppUpdateState): void {
    this.state = state
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('updates:state', this.getState())
      }
    }
  }

  private scheduleChecks(): void {
    const run = (): void => { void this.check() }
    this.checkTimer = setTimeout(() => {
      run()
      this.checkTimer = setInterval(run, CHECK_INTERVAL_MS)
      this.checkTimer.unref()
    }, 2_000)
    this.checkTimer.unref()
  }

  private clearTimer(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer)
    this.checkTimer = null
  }

  private prepareRenderers(): Promise<void> {
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed()
    )
    if (windows.length === 0) return Promise.resolve()
    const requestId = `update_${Date.now().toString(36)}`
    return new Promise((resolve) => {
      let finished = false
      const timer = setTimeout(finish, PREPARE_TIMEOUT_MS)
      const pending: PendingPrepare = {
        requestId,
        webContentsIds: new Set(windows.map((window) => window.webContents.id)),
        finish
      }
      const manager = this
      function finish(): void {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (manager.pendingPrepare === pending) manager.pendingPrepare = null
        resolve()
      }
      this.pendingPrepare = pending
      for (const window of windows) window.webContents.send('updates:prepare-install', { requestId })
    })
  }
}
