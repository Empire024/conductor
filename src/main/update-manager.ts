import { BrowserWindow } from 'electron'
import { NsisUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import { gt, valid } from 'semver'
import type { AppUpdateState } from '../shared/models'
import { DEFAULT_GITHUB_UPDATE_URL, normalizeUpdateFeedUrl, resolveUpdateProvider, type ConductorUpdateProvider } from './update-config'
import { LocalUpdateFeed } from './local-update-feed'

interface UpdateManagerOptions {
  currentVersion: string
  isPackaged: boolean
  allowDevelopmentUpdates?: boolean
  localBuildDirectory?: string
  beforeInstall(): void | Promise<void>
}
interface PendingPrepare {
  requestId: string
  webContentsIds: Set<number>
  finish(): void
}
const CHECK_INTERVAL_MS = 2 * 60 * 1000
const PREPARE_TIMEOUT_MS = 2_000
const busy = (phase: AppUpdateState['phase']): boolean => ['downloading', 'ready', 'installing'].includes(phase)
const errorMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error:\s*/i, '').slice(0, 280)

export class UpdateManager {
  private state: AppUpdateState
  private updater: NsisUpdater | null = null
  private remoteUpdater: NsisUpdater | null = null
  private localUpdater: NsisUpdater | null = null
  private localFeed?: LocalUpdateFeed
  private localUrl?: string
  private includeLocal = true
  private epoch = 0
  private checking = false
  private checkTimer: NodeJS.Timeout | null = null
  private pendingPrepare: PendingPrepare | null = null

  constructor(private readonly options: UpdateManagerOptions) {
    this.state = { phase: 'disabled', currentVersion: options.currentVersion, configured: false, message: 'Connecting to update sources.' }
    if (options.localBuildDirectory) this.localFeed = new LocalUpdateFeed(options.localBuildDirectory)
  }
  getState(): AppUpdateState { return { ...this.state } }

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
      this.setState({ phase: 'disabled', currentVersion: this.options.currentVersion, configured: true, message: 'Installed builds update from GitHub and enabled local test builds.' })
      return feedUrl
    }
    this.remoteUpdater = this.createUpdater(resolveUpdateProvider(feedUrl))
    this.setState({ phase: 'idle', currentVersion: this.options.currentVersion, configured: true, message: 'Checking ' + (feedUrl || DEFAULT_GITHUB_UPDATE_URL) + (includeLocal ? ' and local test builds' : '') + ' automatically.' })
    this.scheduleChecks()
    return feedUrl
  }
  private createUpdater(provider: ConductorUpdateProvider): NsisUpdater {
    const updater = new NsisUpdater(provider)
    const epoch = this.epoch
    const current = (): boolean => epoch === this.epoch && this.updater === updater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.autoRunAppAfterInstall = true
    updater.disableWebInstaller = true
    updater.allowDowngrade = false
    updater.allowPrerelease = false // Local generic feeds still accept their explicitly versioned build.
    updater.forceDevUpdateConfig = Boolean(this.options.allowDevelopmentUpdates)
    updater.logger = console
    updater.on('download-progress', (info: ProgressInfo) => {
      if (current()) this.setState({ ...this.state, phase: 'downloading', progress: Math.max(0, Math.min(100, info.percent)), message: 'Downloading Conductor ' + this.state.availableVersion + '…' })
    })
    updater.on('update-downloaded', (info: UpdateInfo) => {
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
      if (epoch !== this.epoch || busy(this.state.phase) || !info || !valid(info.version) || !gt(info.version, this.options.currentVersion)) return
      if (selected && this.state.availableVersion && !gt(info.version, this.state.availableVersion)) return
      selected = true
      this.updater = updater
      this.setState({ phase: 'available', currentVersion: this.options.currentVersion, availableVersion: info.version, source, configured: true, message: 'Update pending: Conductor ' + info.version + (source === 'local' ? ' (local test build).' : '.'), lastCheckedAt: new Date().toISOString(), localBuildWarning: this.state.localBuildWarning })
    }
    // Start remote I/O concurrently, but offer a valid local build without waiting
    // for the network. A selected download cannot be replaced by a late response.
    const remoteResult = remote.checkForUpdates().then(result => ({ result })).catch(error => ({ error }))
    try {
      if (this.includeLocal && this.localFeed) {
        try {
          const local = await this.localFeed.refresh()
          if (epoch !== this.epoch) return this.getState()
          if (local && gt(local.version, this.options.currentVersion)) {
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
        this.setState({ phase: problems.length ? 'error' : 'idle', currentVersion: this.options.currentVersion, configured: true, message: problems[0] ?? 'Conductor is up to date.', lastCheckedAt: new Date().toISOString(), localBuildWarning: this.state.localBuildWarning })
      }
    } finally { if (epoch === this.epoch) this.checking = false }
    return this.getState()
  }
  async download(): Promise<AppUpdateState> {
    const updater = this.updater
    if (!updater || !(this.state.phase === 'available' || this.state.phase === 'error' && this.state.availableVersion)) return this.getState()
    this.setState({ ...this.state, phase: 'downloading', progress: 0, message: 'Downloading Conductor ' + this.state.availableVersion + '…' })
    try { await updater.downloadUpdate() }
    catch (reason) { if (this.updater === updater) this.setState({ ...this.state, phase: 'error', message: errorMessage(reason) }) }
    return this.getState()
  }
  async install(): Promise<void> {
    if (!this.updater || this.state.phase !== 'ready') return
    this.setState({ ...this.state, phase: 'installing', message: 'Saving windows and stopping processes…' })
    try {
      await this.prepareRenderers()
      await this.options.beforeInstall()
      this.updater.quitAndInstall(true, true)
    } catch (reason) {
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
    this.epoch++
    this.remoteUpdater?.removeAllListeners()
    this.localUpdater?.removeAllListeners()
    this.remoteUpdater?.on('error', () => {})
    this.localUpdater?.on('error', () => {})
    this.updater = this.remoteUpdater = this.localUpdater = null
    this.localFeed?.dispose()
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
