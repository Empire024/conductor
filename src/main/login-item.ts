import type { LoginItemState } from '../shared/always-on'

/**
 * "Start Conductor when I log in" (feature always-on-machines). Off until the owner turns it on.
 * The OS login item is the truth, so turning it off in Task Manager > Startup apps or in macOS
 * Login Items shows here too.
 *
 * A development or test build never touches the OS login items: registering electron.exe from a
 * checkout, or letting a parked smoke write the owner's Run key, would change the owner's login
 * without asking. Those builds keep the choice in the settings table instead ('simulated').
 */

/** Passed by the Windows login item, so the run knows nobody asked for a window. */
export const LOGIN_START_ARG = '--conductor-login-start'
const SIMULATED_SETTING = 'startAtLoginSimulated'

export interface LoginItemApp {
  getLoginItemSettings(options?: { path?: string; args?: string[] }): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean; wasOpenedAtLogin?: boolean }
  setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[] }): void
}

export interface LoginItemDeps {
  app: LoginItemApp
  platform: NodeJS.Platform
  execPath: string
  argv: string[]
  /** true for packaged builds without a test profile. */
  system: boolean
  store: { getSetting(key: string): string | null | undefined; setSetting(key: string, value: string): void }
}

export class LoginItem {
  readonly startedAtLogin: boolean

  constructor(private readonly deps: LoginItemDeps) {
    this.startedAtLogin = deps.argv.includes(LOGIN_START_ARG)
      // macOS starts login items without arguments; older macOS says so here, newer says nothing.
      || (deps.system && deps.platform === 'darwin' && this.safeRead()?.wasOpenedAtLogin === true)
  }

  enabled(): boolean | null {
    if (!this.deps.system) return this.deps.store.getSetting(SIMULATED_SETTING) === 'true'
    const settings = this.safeRead()
    if (!settings) return null
    // Windows: executableWillLaunchAtLogin is false when the entry was disabled in Task Manager.
    return this.deps.platform === 'win32' ? settings.openAtLogin && settings.executableWillLaunchAtLogin !== false : settings.openAtLogin
  }

  set(enabled: boolean): LoginItemState {
    if (!this.deps.system) this.deps.store.setSetting(SIMULATED_SETTING, String(enabled))
    else if (this.deps.platform === 'win32') this.deps.app.setLoginItemSettings({ openAtLogin: enabled, path: this.deps.execPath, args: [LOGIN_START_ARG] })
    else this.deps.app.setLoginItemSettings({ openAtLogin: enabled })
    return this.state()
  }

  state(): LoginItemState {
    return { enabled: this.enabled() === true, backend: this.deps.system ? 'system' : 'simulated', startedAtLogin: this.startedAtLogin }
  }

  private safeRead(): ReturnType<LoginItemApp['getLoginItemSettings']> | null {
    try {
      return this.deps.platform === 'win32'
        ? this.deps.app.getLoginItemSettings({ path: this.deps.execPath, args: [LOGIN_START_ARG] })
        : this.deps.app.getLoginItemSettings()
    } catch { return null }
  }
}
