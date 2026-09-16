import { Menu, Tray, nativeImage } from 'electron'

/**
 * Closing the window is not stopping the host.
 *
 * A machine that other computers are attached to is running their agents, their terminals and
 * their builds. On Windows and Linux, Conductor quits when the last window closes, which for a
 * host would mean the owner tidying up their desktop kills work someone is watching from the other
 * room. While hosting is on and the listener is up, the last window closing leaves the process
 * running behind a tray icon instead, and quitting says who is attached before it disconnects them.
 *
 * When hosting is off, none of this applies and today's behaviour is kept exactly: the window was
 * the whole application, so closing it ends the application.
 *
 * Everything Electron owns - the tray, the app events, the dialog - is behind an interface here so
 * the rule itself can be tested without a desktop.
 */

export interface HostLifecycleState {
  enabled: boolean
  listening: boolean
  /** Names of the machines currently attached, for the question asked before disconnecting them. */
  attachedPeers: string[]
}

export interface HostTrayItem {
  label: string
  click(): void
}

export interface HostTray {
  update(tooltip: string, items: HostTrayItem[]): void
  destroy(): void
}

export interface LifecycleEvent {
  preventDefault(): void
}

/** Electron's `app`, narrowed to what this module actually uses. */
export interface HostLifecycleApp {
  on(event: string, listener: (event: LifecycleEvent) => void): unknown
}

export interface HostLifecycleDependencies {
  hosting(): HostLifecycleState
  showWindow(): void
  confirm(message: string): Promise<boolean>
  quit(): void
  /** Omitted in tests and wherever no tray is wanted; the keep-alive rule does not depend on it. */
  createTray?(): HostTray
  platform?: NodeJS.Platform
  /**
   * Registers a `before-quit` listener that asks the hosting question on its own. Left off when
   * the application already owns that event and only wants `confirmStopHosting` inside it, which
   * is the case here: index.ts has its own running-work confirmation to ask first.
   */
  installBeforeQuit?: boolean
}

export interface HostLifecycleController {
  /** True when the quit was suppressed and this process should stay alive. */
  windowAllClosed(): boolean
  /** A window exists again, so the tray is no longer the only way back in. */
  windowOpened(): void
  /** Hosting started, stopped, or a machine attached or left. */
  refresh(): void
  /** The question `before-quit` must ask while machines are attached. True means go ahead. */
  confirmStopHosting(): Promise<boolean>
  /** True while hosting is what is keeping this process alive. */
  keepAlive(): boolean
  dispose(): void
}

/** "A", "A and B", "A, B and C" - a sentence about machines, not a debug list. */
export function nameList(names: string[]): string {
  const cleaned = names.map(name => name.trim()).filter(Boolean)
  const last = cleaned[cleaned.length - 1]
  if (!last) return ''
  if (cleaned.length === 1) return last
  return `${cleaned.slice(0, -1).join(', ')} and ${last}`
}

export function installHostLifecycle(app: HostLifecycleApp, deps: HostLifecycleDependencies): HostLifecycleController {
  const platform = deps.platform ?? process.platform
  let tray: HostTray | null = null
  let windowsOpen = true
  let disposed = false

  const state = (): HostLifecycleState => {
    const current = deps.hosting()
    return {
      enabled: Boolean(current?.enabled),
      listening: Boolean(current?.listening),
      attachedPeers: Array.isArray(current?.attachedPeers) ? current.attachedPeers.filter(name => typeof name === 'string') : []
    }
  }

  // Enabled but not listening is a host that is switched on and cannot be reached - Tailscale
  // signed out, the listener refused to bind. Nobody can be attached to it, so it keeps nothing
  // alive; the panel is where that is explained.
  const keepAlive = (): boolean => { const current = state(); return current.enabled && current.listening }

  const confirmStopHosting = async (): Promise<boolean> => {
    const current = state()
    if (!current.enabled || !current.listening || !current.attachedPeers.length) return true
    return deps.confirm(`Stop hosting for ${nameList(current.attachedPeers)}? Their attached tabs will disconnect; work already running here continues until you close it.`)
  }

  const syncTray = (): void => {
    if (disposed) return
    const wanted = keepAlive() && !windowsOpen
    if (!wanted) {
      tray?.destroy()
      tray = null
      return
    }
    if (!deps.createTray) return
    tray = tray ?? deps.createTray()
    const attached = state().attachedPeers
    tray.update(attached.length ? `Conductor is hosting for ${nameList(attached)}` : 'Conductor is hosting', [
      { label: 'Open Conductor', click: () => { deps.showWindow(); controller.windowOpened() } },
      { label: 'Stop hosting and quit', click: () => { void confirmStopHosting().then(ok => { if (ok) deps.quit() }) } }
    ])
  }

  const controller: HostLifecycleController = {
    windowAllClosed(): boolean {
      windowsOpen = false
      // macOS keeps an application running without windows whatever Conductor is doing; that is
      // the platform's rule and hosting does not change it.
      if (platform === 'darwin') return true
      if (!keepAlive()) return false
      syncTray()
      return true
    },
    windowOpened(): void {
      windowsOpen = true
      syncTray()
    },
    refresh(): void { syncTray() },
    confirmStopHosting,
    keepAlive,
    dispose(): void {
      disposed = true
      tray?.destroy()
      tray = null
    }
  }

  app.on('window-all-closed', () => {
    if (!controller.windowAllClosed()) deps.quit()
  })

  if (deps.installBeforeQuit) {
    app.on('before-quit', event => {
      const current = state()
      if (!current.enabled || !current.listening || !current.attachedPeers.length) return
      event.preventDefault()
      void confirmStopHosting().then(ok => { if (ok) deps.quit() })
    })
  }

  return controller
}

/**
 * The real tray. Kept here so wiring it is one call, and kept out of the rule above so the rule
 * can be tested without a desktop session.
 */
export function electronTray(iconPath: string): HostTray {
  const tray = new Tray(nativeImage.createFromPath(iconPath))
  return {
    update(tooltip: string, items: HostTrayItem[]): void {
      tray.setToolTip(tooltip)
      tray.setContextMenu(Menu.buildFromTemplate(items.map(item => ({ label: item.label, click: item.click }))))
    },
    destroy(): void { tray.destroy() }
  }
}
