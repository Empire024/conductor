import { BrowserWindow, WebContentsView, type WebContents } from 'electron'
import type { AgentControlTab } from '../shared/agent-control'
import { browserUrl, type BrowserMcpHost, type BrowserMcpScope, type BrowserView } from '../shared/browser-mcp'
import { projectBrowserViewId } from '../shared/browser-view-identity'
import type { BrowserPresentation, BrowserSurfaceCommand, BrowserSurfaceRequest, BrowserSurfaceState } from '../shared/browser-surface'

/** Attribute a Conductor browser pane puts on its <webview> so the main process can tell which
 *  workspace tab a guest belongs to. `data-performance-browser-tab-id` is the one the panes have
 *  carried since the tab performance popover shipped; `data-conductor-tab-id` is the name the
 *  renderer should move to, and both are read so neither half has to land first. */
const CONSOLE_LIMIT = 500
const LOAD_TIMEOUT = 10_000
/** Background guests need a real viewport before the owner ever opens the Browser rail. Without
 * one, Chromium lays pages out at 0x0 and MCP screenshots/DOM measurements are misleading. */
const BACKGROUND_VIEWPORT: Electron.Rectangle = { x: 0, y: 0, width: 1440, height: 900 }
/** A page value is JSON-encoded in the guest, sent whole across IPC, parsed in the main process and
 *  then re-encoded into the HTTP reply. Uncapped, a page returning a few hundred megabytes takes
 *  the main process — and with it every conversation, terminal and unsaved editor — down with an
 *  out-of-memory abort, which is why the cap is applied in the page, before any of that. */
const MAX_VALUE_CHARS = 200_000
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface ConsoleEntry { level: string; message: string; source?: string; line?: number; at: string }
interface Deps {
  /** Every tab in the caller's own workspace, from the database. */
  tabs(scope: BrowserMcpScope): AgentControlTab[]
  /** Legacy constructor dependency. Browser tools never call it: enabling tools must not alter
   * the owner's visible layout. */
  openBrowserTab(scope: BrowserMcpScope): Promise<void>
  rendererPath: string
  createDetachedWindow?(projectId: string, onClosed: () => void): BrowserWindow
  publishState?(state: BrowserSurfaceState): void
}

interface OwnedBrowser {
  projectId: string
  view: WebContentsView
  surface?: { id: string; window: BrowserWindow; bounds: Electron.Rectangle; visible: boolean }
  parent?: BrowserWindow
  parking?: BrowserWindow
  detached?: BrowserWindow
  presentation: BrowserPresentation
  failure?: string
}

export function browserViewCandidates(scope: BrowserMcpScope, tabs: AgentControlTab[]): Set<string> {
  const projectView = projectBrowserViewId(scope.projectId)
  return new Set([
    ...(projectView ? [projectView] : []),
    ...tabs.filter(tab => tab.kind === 'browser').map(tab => tab.id)
  ])
}

/** Normalizes both shapes of Electron's console-message event: the modern single details object
 *  and the older positional (event, level, message, line, source). */
const consoleEntry = (args: unknown[]): ConsoleEntry => {
  const detail = args[0] as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown } | undefined
  const levels = ['verbose', 'info', 'warning', 'error']
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') {
    return { level: typeof detail.level === 'string' ? detail.level : levels[Number(detail.level) || 0] ?? 'info', message: detail.message.slice(0, 4000), source: typeof detail.sourceId === 'string' ? detail.sourceId : undefined, line: typeof detail.lineNumber === 'number' ? detail.lineNumber : undefined, at: new Date().toISOString() }
  }
  return { level: levels[Number(args[1]) || 0] ?? 'info', message: String(args[2] ?? '').slice(0, 4000), source: typeof args[4] === 'string' ? args[4] : undefined, line: typeof args[3] === 'number' ? args[3] : undefined, at: new Date().toISOString() }
}

/** Wraps agent-supplied code so the page returns a JSON string: executeJavaScript's structured
 *  clone silently drops functions and throws on DOM nodes, and an in-page exception would come
 *  back as an opaque rejection rather than something the agent can read. */
const evaluation = (code: string): string => {
  const body = /(^|[^\w.])return[\s(;]/.test(code) ? code : `return (${code})`
  return `(async () => {
    try {
      const value = await (async () => { ${body} })()
      const json = JSON.stringify(value === undefined ? null : value) ?? 'null'
      // Truncated here, in the page, so an oversized value never crosses into the main process.
      return json.length > ${MAX_VALUE_CHARS} ? JSON.stringify({ __conductorTruncated: json.length, value: json.slice(0, ${MAX_VALUE_CHARS}) }) : json
    }
    catch (error) { return JSON.stringify({ __conductorError: String((error && error.message) || error) }) }
  })()`
}

export class BrowserViews implements BrowserMcpHost {
  /** guest webContents id -> the workspace window it is attached to, recorded from that window's
   *  own did-attach-webview. A guest the main process never saw attach is never driven. */
  private hosts = new Map<number, number>()
  private consoles = new Map<number, ConsoleEntry[]>()
  /** Undoes one guest's listeners, so a second attach for the same guest replaces them. */
  private detach = new Map<number, () => void>()
  private owned = new Map<string, OwnedBrowser>()
  constructor(private readonly deps: Deps) {}

  private ensureOwned(projectId: string): OwnedBrowser {
    if (!projectBrowserViewId(projectId)) throw new Error('Invalid browser project identity')
    const existing = this.owned.get(projectId)
    if (existing && !existing.view.webContents.isDestroyed()) return existing
    const view = new WebContentsView({ webPreferences: { partition: `persist:conductor-browser-${projectId}`, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    view.setBounds(BACKGROUND_VIEWPORT)
    view.setVisible(false)
    const owned: OwnedBrowser = { projectId, view, presentation: 'background' }
    this.owned.set(projectId, owned)
    this.observe(view.webContents)
    const changed = (): void => this.publish(owned)
    view.webContents.on('did-start-loading', changed)
    view.webContents.on('did-stop-loading', changed)
    view.webContents.on('did-navigate', changed)
    view.webContents.on('did-navigate-in-page', changed)
    view.webContents.on('page-title-updated', changed)
    view.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame === false || code === -3) return
      owned.failure = description || `Navigation failed (${code})`
      this.publish(owned)
    })
    view.webContents.once('destroyed', () => { if (this.owned.get(projectId) === owned) this.owned.delete(projectId) })
    return owned
  }

  /** Renderer registration reparents an existing background guest or explicitly creates one.
   * Authorized MCP access may already have created the same guest without a visible surface. */
  async mount(window: BrowserWindow, request: BrowserSurfaceRequest): Promise<BrowserSurfaceState> {
    const projectId = request.projectId.trim()
    if (!projectBrowserViewId(projectId) || typeof request.surfaceId !== 'string' || !request.surfaceId.trim() || request.surfaceId.length > 200) throw new Error('Invalid browser surface identity')
    const requestedBounds = this.bounds(request.bounds)
    const bounds = requestedBounds.width > 0 && requestedBounds.height > 0 ? requestedBounds : BACKGROUND_VIEWPORT
    const owned = this.ensureOwned(projectId)
    if (!owned.view.webContents.getURL()) {
      void owned.view.webContents.loadURL(browserUrl(request.initialUrl)).catch(error => {
        if (owned.view.webContents.isDestroyed()) return
        owned.failure = error instanceof Error ? error.message : String(error)
        this.publish(owned)
      })
    }
    if (owned.presentation === 'background' && !owned.surface) owned.presentation = 'pane'
    owned.surface = { id: request.surfaceId, window, bounds, visible: request.visible }
    this.emulateViewport(owned, request.viewport, bounds)
    if (owned.presentation !== 'detached') this.attachTo(owned, window, request.visible && owned.presentation !== 'background')
    this.layout(owned)
    return this.state(owned)
  }

  update(window: BrowserWindow, request: BrowserSurfaceRequest): BrowserSurfaceState {
    const owned = this.owned.get(request.projectId)
    if (!owned || owned.surface?.id !== request.surfaceId) throw new Error('Browser surface is not mounted')
    const requestedBounds = this.bounds(request.bounds)
    // A retained React surface reports 0x0 while hidden. Keep the last real native viewport so
    // background screenshots and DOM layout never collapse merely because the owner switched UI.
    const bounds = requestedBounds.width > 0 && requestedBounds.height > 0 ? requestedBounds : owned.surface.bounds
    owned.surface = { id: request.surfaceId, window, bounds, visible: request.visible }
    this.emulateViewport(owned, request.viewport, bounds)
    if (owned.presentation !== 'detached') this.attachTo(owned, window, request.visible && owned.presentation !== 'background')
    this.layout(owned)
    return this.state(owned)
  }

  async command(projectId: string, command: BrowserSurfaceCommand): Promise<BrowserSurfaceState> {
    const owned = this.required(projectId), contents = owned.view.webContents
    if (command.type === 'navigate') { owned.failure = undefined; await contents.loadURL(browserUrl(command.url)) }
    else if (command.type === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    else if (command.type === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    else if (command.type === 'reload') contents.reload()
    else if (command.type === 'devtools') contents.openDevTools({ mode: 'detach', activate: false })
    return this.state(owned)
  }

  present(projectId: string, presentation: BrowserPresentation): BrowserSurfaceState {
    const owned = this.required(projectId)
    if (!['pane', 'expanded', 'background', 'detached'].includes(presentation)) throw new Error('Invalid browser presentation')
    owned.presentation = presentation
    if (presentation === 'detached') {
      if (!owned.detached || owned.detached.isDestroyed()) {
        if (!this.deps.createDetachedWindow) throw new Error('Detached browser presentation is unavailable')
        let detached!: BrowserWindow
        detached = this.deps.createDetachedWindow(projectId, () => this.detachedClosed(owned, detached))
        owned.detached = detached
        detached.on('resize', () => { if (owned.detached === detached) this.layout(owned) })
      }
      this.attachTo(owned, owned.detached, true)
      this.layout(owned)
      if (!owned.detached.isVisible()) owned.detached.showInactive()
    } else {
      this.closeDetached(owned)
      if (owned.surface && !owned.surface.window.isDestroyed()) this.attachTo(owned, owned.surface.window, presentation !== 'background' && owned.surface.visible)
      else this.park(owned)
      this.layout(owned)
    }
    const state = this.state(owned)
    this.deps.publishState?.(state)
    return state
  }

  /** Release a workspace host. During application shutdown no replacement parking window may be
   * created: Electron is already closing every host, and resurrecting one prevents `will-quit`.
   * Outside shutdown, an explicitly retained browser is parked so its project work can continue. */
  releaseWindow(window: BrowserWindow, closingApplication = false): void {
    for (const owned of this.owned.values()) {
      if (owned.surface?.window === window) owned.surface = undefined
      if (owned.parent === window) this.unparent(owned)
      if (owned.detached === window) { owned.detached = undefined; owned.presentation = 'background'; this.publish(owned) }
      if (!closingApplication && !owned.surface && !owned.detached && !owned.view.webContents.isDestroyed()) this.park(owned)
    }
  }

  releaseProject(projectId: string): void {
    const owned = this.owned.get(projectId)
    if (!owned) return
    this.closeDetached(owned)
    this.unparent(owned)
    this.closeParking(owned)
    if (!owned.view.webContents.isDestroyed()) owned.view.webContents.close()
    this.owned.delete(projectId)
  }

  dispose(): void { for (const projectId of [...this.owned.keys()]) this.releaseProject(projectId) }

  private required(projectId: string): OwnedBrowser {
    const owned = this.owned.get(projectId)
    if (!owned) throw new Error('The Conductor browser for this project has not been opened. Open Browser from the left activity rail once; model tools never activate it silently.')
    if (owned.view.webContents.isDestroyed()) { this.owned.delete(projectId); throw new Error('The browser view was closed') }
    return owned
  }

  private bounds(value: BrowserSurfaceRequest['bounds']): Electron.Rectangle {
    const numbers = [value?.x, value?.y, value?.width, value?.height]
    if (numbers.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw new Error('Invalid browser surface bounds')
    return {
      x: Math.max(0, Math.round(value.x)),
      y: Math.max(0, Math.round(value.y)),
      width: Math.max(0, Math.min(16_384, Math.round(value.width))),
      height: Math.max(0, Math.min(16_384, Math.round(value.height)))
    }
  }

  private attachTo(owned: OwnedBrowser, window: BrowserWindow, visible: boolean): void {
    if (window.isDestroyed()) throw new Error('Browser presentation window is closed')
    if (owned.parent !== window) {
      this.unparent(owned)
      window.contentView.addChildView(owned.view)
      owned.parent = window
      this.hosts.set(owned.view.webContents.id, window.webContents.id)
    }
    owned.view.setVisible(visible)
    if (owned.parking && owned.parking !== window) this.closeParking(owned)
  }

  /** An unattached WebContentsView retains nominal bounds but Chromium gives its document a 0x0
   * layout viewport. A hidden, non-focusable, off-desktop host keeps the guest useful for MCP
   * before the owner ever selects this project. The host is retired as soon as the same guest is
   * reparented into a real surface; it never becomes a workspace tab or visible desktop window. */
  private park(owned: OwnedBrowser): void {
    if (owned.parent && !owned.parent.isDestroyed()) return
    let parking = owned.parking
    if (!parking || parking.isDestroyed()) {
      parking = new BrowserWindow({
        show: false,
        focusable: false,
        skipTaskbar: true,
        frame: false,
        useContentSize: true,
        x: -32_000,
        y: -32_000,
        width: BACKGROUND_VIEWPORT.width,
        height: BACKGROUND_VIEWPORT.height,
        webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      owned.parking = parking
    }
    this.attachTo(owned, parking, true)
    owned.view.setBounds(BACKGROUND_VIEWPORT)
    owned.view.setVisible(true)
  }

  private closeParking(owned: OwnedBrowser): void {
    const parking = owned.parking
    if (!parking) return
    owned.parking = undefined
    if (!parking.isDestroyed()) parking.close()
  }

  private emulateViewport(owned: OwnedBrowser, value: BrowserSurfaceRequest['viewport'], bounds: Electron.Rectangle): void {
    if (!value) return
    const width = Math.round(value.width), height = Math.round(value.height)
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height) || width < 240 || width > 3840 || height < 320 || height > 2160) throw new Error('Invalid browser viewport')
    if (bounds.width <= 0 || bounds.height <= 0) return
    const scale = Math.max(0.1, Math.min(1, bounds.width / width, bounds.height / height))
    owned.view.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, viewSize: { width, height }, scale })
  }

  private unparent(owned: OwnedBrowser): void {
    if (owned.parent && !owned.parent.isDestroyed()) {
      try { owned.parent.contentView.removeChildView(owned.view) } catch { /* The host may already be tearing down. */ }
    }
    owned.parent = undefined
    owned.view.setVisible(false)
  }

  private layout(owned: OwnedBrowser): void {
    if (owned.presentation === 'detached' && owned.detached && !owned.detached.isDestroyed()) {
      const bounds = owned.detached.getContentBounds()
      owned.view.setBounds({ x: 0, y: 0, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) })
      owned.view.setVisible(true)
      return
    }
    if (!owned.surface) return
    owned.view.setBounds(owned.surface.bounds)
    owned.view.setVisible(owned.presentation !== 'background' && owned.surface.visible)
  }

  private closeDetached(owned: OwnedBrowser): void {
    const window = owned.detached
    if (!window || window.isDestroyed()) { owned.detached = undefined; return }
    if (owned.parent === window) this.unparent(owned)
    // Retire the identity before close(): Electron may emit `closed` synchronously or much later.
    // Its captured callback must never affect a reattached surface or a newer detached window.
    owned.detached = undefined
    window.close()
  }

  private detachedClosed(owned: OwnedBrowser, closedWindow: BrowserWindow): void {
    if (owned.detached !== closedWindow) return
    if (owned.parent === closedWindow) this.unparent(owned)
    owned.detached = undefined
    owned.presentation = 'background'
    if (owned.surface && !owned.surface.window.isDestroyed()) this.attachTo(owned, owned.surface.window, false)
    this.publish(owned)
  }

  private state(owned: OwnedBrowser): BrowserSurfaceState {
    const contents = owned.view.webContents
    return {
      projectId: owned.projectId,
      webContentsId: contents.id,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      presentation: owned.presentation,
      ...(owned.failure ? { failure: owned.failure } : {})
    }
  }

  private publish(owned: OwnedBrowser): void { if (!owned.view.webContents.isDestroyed()) this.deps.publishState?.(this.state(owned)) }

  /** Called from every workspace window's did-attach-webview. */
  attach(window: BrowserWindow, guest: WebContents): void {
    const id = guest.id
    this.hosts.set(id, window.webContents.id)
    this.observe(guest)
  }

  private observe(guest: WebContents): void {
    const id = guest.id
    // Reparenting a main-owned view and repeated did-attach-webview events update ownership but
    // retain exactly one console recorder and popup guard for the life of the guest.
    if (this.detach.has(id)) return
    const buffer: ConsoleEntry[] = []
    this.consoles.set(id, buffer)
    const record = (...args: unknown[]): void => { buffer.push(consoleEntry(args)); if (buffer.length > CONSOLE_LIMIT) buffer.splice(0, buffer.length - CONSOLE_LIMIT) }
    const stopped = (_event: unknown, details: { reason: string }): void => record({ level: 'error', message: `The page process stopped: ${details.reason}` })
    const destroyed = (): void => { this.hosts.delete(id); this.consoles.delete(id); this.detach.get(id)?.(); this.detach.delete(id) }
    // Electron changed this event from positional arguments to a details object; consoleEntry
    // reads either, and the cast is what lets one listener be typed for both shapes.
    guest.on('console-message', record as never)
    guest.on('render-process-gone', stopped as never)
    guest.once('destroyed', destroyed)
    // The pane asks for allowpopups="false", but Electron reads `allowpopups` as a presence
    // attribute: the string "false" switches popups on. A page — or a browser_evaluate calling
    // window.open — can then put a real window over the owner's screen, so the main process, which
    // owns the guest either way, refuses instead and says so where the agent can read it.
    guest.setWindowOpenHandler(({ url }) => { record({ level: 'warning', message: `Conductor blocked a popup window to ${url}` }); return { action: 'deny' } })
    this.detach.set(id, () => {
      guest.off('console-message', record as never)
      guest.off('render-process-gone', stopped as never)
      guest.off('destroyed', destroyed)
    })
  }

  async view(scope: BrowserMcpScope): Promise<BrowserView> {
    // The authenticated credential supplies this scope. A hidden parked host gives a never-opened
    // project a real viewport without selecting it or presenting anything on the owner's desktop.
    const owned = this.ensureOwned(scope.projectId)
    this.park(owned)
    return this.page(owned.view.webContents, projectBrowserViewId(scope.projectId)!, mode => { this.present(scope.projectId, mode) })
  }

  /** loadURL settles before the guest has committed the new document, so reading the URL straight
   *  afterwards can report the page the view was showing before — a success the agent would then
   *  reason about. Wait for the load to stop instead. */
  private async loaded(guest: WebContents): Promise<void> {
    if (!guest.isLoading()) { await settle(150); return }
    await new Promise<void>(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        guest.off('did-stop-loading', done); guest.off('did-fail-load', done as never); guest.off('destroyed', done)
        resolve()
      }
      const timer = setTimeout(done, LOAD_TIMEOUT)
      guest.once('did-stop-loading', done); guest.once('did-fail-load', done as never); guest.once('destroyed', done)
    })
  }

  private page(guest: WebContents, tabId: string, present: (mode: 'background' | 'detached') => void = () => {}): BrowserView {
    const alive = (): WebContents => { if (guest.isDestroyed()) throw new Error('The browser view was closed'); return guest }
    const run = async (code: string, gesture = false): Promise<unknown> => {
      const raw = await alive().executeJavaScript(evaluation(code), gesture) as string
      const value = JSON.parse(typeof raw === 'string' ? raw : 'null') as unknown
      const wrapper = value && typeof value === 'object' ? value as { __conductorError?: string; __conductorTruncated?: number; value?: string } : undefined
      if (wrapper?.__conductorError) throw new Error(wrapper.__conductorError)
      if (wrapper?.__conductorTruncated) throw new Error(`The page returned ${wrapper.__conductorTruncated} characters, over the ${MAX_VALUE_CHARS} character limit. Return less: slice the value, or count it in the page instead of returning it.`)
      return value
    }
    return {
      tabId,
      navigate: async (url) => {
        let failure: unknown
        try { await alive().loadURL(url) }
        catch (error) { failure = error }
        await this.loaded(alive())
        // loadURL rejects with whatever load was in flight, which on a pane the bridge has just
        // opened is that pane's own starting URL and not ours — the agent would be handed a
        // connection error for a page it never asked for. Only a failure naming the URL we asked
        // for is ours, and an aborted load is what a redirect or a same-document jump looks like
        // from here. Anything else is judged by where the view actually settled.
        const blamed = /loading '([^']*)'/.exec(String(failure))?.[1]
        if (failure && (blamed === undefined || blamed === url) && !/ERR_ABORTED/.test(String(failure))) throw failure
        return { url: alive().getURL(), title: alive().getTitle() }
      },
      snapshot: async ({ selector, maxChars }) => {
        const value = await run(`
          const root = ${JSON.stringify(selector ?? '')} ? document.querySelector(${JSON.stringify(selector ?? '')}) : document.body
          if (!root) throw new Error('No element matches ' + ${JSON.stringify(selector ?? '')})
          const visible = element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 }
          const label = element => (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120)
          return {
            url: location.href, title: document.title,
            text: (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${maxChars}),
            headings: Array.from(root.querySelectorAll('h1,h2,h3')).slice(0, 40).map(element => element.tagName.toLowerCase() + ': ' + label(element)),
            links: Array.from(root.querySelectorAll('a[href]')).filter(visible).slice(0, 60).map(element => ({ text: label(element), href: String(element.href).slice(0, 2000) })),
            fields: Array.from(root.querySelectorAll('input,textarea,select,button,[contenteditable=""],[contenteditable="true"]')).filter(visible).slice(0, 60).map(element => ({
              tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || undefined,
              name: element.getAttribute('name') || element.id || undefined,
              selector: element.id ? '#' + CSS.escape(element.id) : element.getAttribute('name') ? element.tagName.toLowerCase() + '[name="' + element.getAttribute('name') + '"]' : undefined,
              label: label(element) || element.getAttribute('placeholder') || element.getAttribute('aria-label') || undefined,
              value: typeof element.value === 'string' ? element.value.slice(0, 200) : undefined
            }))
          }`)
        return value as Record<string, unknown>
      },
      screenshot: async () => {
        const image = await alive().capturePage()
        const size = image.getSize()
        // A full-resolution PNG of a desktop viewport is megabytes of base64 in the agent's
        // context for no extra legibility; 900px wide is still readable text.
        const scaled = size.width > 900 ? image.resize({ width: 900 }) : image
        return { data: scaled.toPNG().toString('base64'), mimeType: 'image/png', width: size.width, height: size.height }
      },
      messages: (limit) => (this.consoles.get(guest.id) ?? []).slice(-limit),
      evaluate: (code) => run(code),
      click: async (selector) => {
        const target = await run(`
          const element = document.querySelector(${JSON.stringify(selector)})
          if (!element) throw new Error('No element matches ' + ${JSON.stringify(selector)})
          element.scrollIntoView({ block: 'center' })
          element.click()
          return { tag: element.tagName.toLowerCase(), text: (element.innerText || element.value || '').trim().slice(0, 200) }`, true) as Record<string, unknown>
        // Read the destination from the guest rather than the page: a click that navigates tears
        // down the frame the script was running in.
        await settle(400)
        return { clicked: true, selector, ...target, url: alive().getURL(), title: alive().getTitle() }
      },
      type: async ({ selector, text, submit }) => {
        const typed = await run(`
          const element = document.querySelector(${JSON.stringify(selector)})
          if (!element) throw new Error('No element matches ' + ${JSON.stringify(selector)})
          element.focus()
          const value = ${JSON.stringify(text)}
          if (element.isContentEditable) element.textContent = value
          else {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')
            if (!setter || !setter.set) throw new Error(${JSON.stringify(selector)} + ' is not a field that accepts text')
            setter.set.call(element, value)
          }
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
          if (${submit ? 'true' : 'false'}) {
            element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
            if (element.form && element.form.requestSubmit) element.form.requestSubmit()
          }
          return { tag: element.tagName.toLowerCase() }`, true) as Record<string, unknown>
        await settle(submit ? 500 : 100)
        return { typed: true, selector, submitted: submit, ...typed, url: alive().getURL(), title: alive().getTitle() }
      },
      present: async mode => { present(mode) }
    }
  }
}
