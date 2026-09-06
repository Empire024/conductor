import { BrowserWindow } from 'electron'
import { NsisUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import type { AppUpdateState } from '../shared/models'
import { DEFAULT_GITHUB_UPDATE_URL, normalizeUpdateFeedUrl, resolveUpdateProvider } from './update-config'

interface UpdateManagerOptions {
  currentVersion: string
  isPackaged: boolean
  allowDevelopmentUpdates?: boolean
  beforeInstall(): void | Promise<void>
}

interface PendingPrepare {
  requestId: string
  webContentsIds: Set<number>
  finish(): void
}

const CHECK_INTERVAL_MS = 30 * 60 * 1000
const PREPARE_TIMEOUT_MS = 2_000

const errorMessage = (reason: unknown): string => {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error:\s*/i, '').slice(0, 280)
}

export class UpdateManager {
  private state: AppUpdateState
  private updater: NsisUpdater | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private pendingPrepare: PendingPrepare | null = null

  constructor(private readonly options: UpdateManagerOptions) {
    this.state = {
      phase: 'disabled',
      currentVersion: options.currentVersion,
      configured: false,
      message: 'Connecting to GitHub Releases.'
    }
  }

  getState(): AppUpdateState {
    return { ...this.state }
  }

  configure(requestedUrl: string): string {
    const feedUrl = normalizeUpdateFeedUrl(requestedUrl)
    this.clearTimer()
    this.updater?.removeAllListeners()
    this.updater = null

    if (!this.options.isPackaged && !this.options.allowDevelopmentUpdates) {
      this.setState({
        phase: 'disabled',
        currentVersion: this.options.currentVersion,
        configured: true,
        message: `Installed builds update from ${feedUrl || DEFAULT_GITHUB_UPDATE_URL}.`
      })
      return feedUrl
    }

    const updater = new NsisUpdater(resolveUpdateProvider(feedUrl))
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.autoRunAppAfterInstall = true
    updater.disableWebInstaller = true
    updater.logger = console
    updater.on('checking-for-update', () => {
      this.setState({ ...this.state, phase: 'checking', message: 'Checking for updates…' })
    })
    updater.on('update-not-available', () => {
      this.setState({
        phase: 'idle',
        currentVersion: this.options.currentVersion,
        configured: true,
        message: 'Conductor is up to date.',
        lastCheckedAt: new Date().toISOString()
      })
    })
    updater.on('update-available', (info: UpdateInfo) => {
      this.setState({
        phase: 'available',
        currentVersion: this.options.currentVersion,
        availableVersion: info.version,
        configured: true,
        message: `Conductor ${info.version} is available.`,
        lastCheckedAt: new Date().toISOString()
      })
    })
    updater.on('download-progress', (info: ProgressInfo) => {
      this.setState({
        ...this.state,
        phase: 'downloading',
        progress: Math.max(0, Math.min(100, info.percent)),
        message: `Downloading Conductor ${this.state.availableVersion ?? 'update'}…`
      })
    })
    updater.on('update-downloaded', (info) => {
      this.setState({
        phase: 'ready',
        currentVersion: this.options.currentVersion,
        availableVersion: info.version,
        progress: 100,
        configured: true,
        message: 'Update downloaded. Restart Conductor to install it.',
        lastCheckedAt: this.state.lastCheckedAt
      })
    })
    updater.on('error', (reason) => {
      this.setState({
        ...this.state,
        phase: 'error',
        configured: true,
        message: errorMessage(reason)
      })
    })
    this.updater = updater
    this.setState({
      phase: 'idle',
      currentVersion: this.options.currentVersion,
      configured: true,
      message: `Checking ${feedUrl || DEFAULT_GITHUB_UPDATE_URL} automatically.`
    })
    this.scheduleChecks()
    return feedUrl
  }

  async check(): Promise<AppUpdateState> {
    if (!this.updater) return this.getState()
    if (['checking', 'downloading', 'ready', 'installing'].includes(this.state.phase)) return this.getState()
    try {
      await this.updater.checkForUpdates()
    } catch (reason) {
      this.setState({ ...this.state, phase: 'error', configured: true, message: errorMessage(reason) })
    }
    return this.getState()
  }

  async download(): Promise<AppUpdateState> {
    if (!this.updater || (
      this.state.phase !== 'available' &&
      !(this.state.phase === 'error' && Boolean(this.state.availableVersion))
    )) return this.getState()
    try {
      await this.updater.downloadUpdate()
    } catch (reason) {
      this.setState({ ...this.state, phase: 'error', configured: true, message: errorMessage(reason) })
    }
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
      this.setState({
        ...this.state,
        phase: 'error',
        message: `Could not prepare the update: ${errorMessage(reason)}`
      })
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
    this.updater?.removeAllListeners()
    this.updater = null
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
