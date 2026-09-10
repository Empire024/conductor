import { BrowserWindow, webContents as allWebContents, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import type { AgentControlTab } from '../shared/agent-control'
import type { BrowserMcpHost, BrowserMcpScope, BrowserView } from '../shared/browser-mcp'
import { isStructuredRendererUrl } from './structured-ipc-policy'

/** Attribute a Conductor browser pane puts on its <webview> so the main process can tell which
 *  workspace tab a guest belongs to. `data-performance-browser-tab-id` is the one the panes have
 *  carried since the tab performance popover shipped; `data-conductor-tab-id` is the name the
 *  renderer should move to, and both are read so neither half has to land first. */
const TAB_ATTRIBUTES = ['data-conductor-tab-id', 'data-performance-browser-tab-id']
/** Read in the workspace window's own page, which is the only place a <webview> element and its
 *  getWebContentsId() exist. Identity still comes from the database: a tab id that is not in the
 *  caller's own workspace is discarded below, so this only ever narrows the candidate set. */
const PROBE = `(() => Array.from(document.querySelectorAll('webview')).map(element => {
  try { return { id: element.getWebContentsId(), tabId: ${JSON.stringify(TAB_ATTRIBUTES)}.map(name => element.getAttribute(name)).find(Boolean) || '' } }
  catch { return null }
}).filter(entry => entry && entry.tabId))()`
const CONSOLE_LIMIT = 500
/** How long a pane this bridge just asked for is given to mount. */
const ATTACH_TIMEOUT = 12_000
/** How long a workspace whose browser tabs already exist is given, when none of them is on screen.
 *  Waiting the full attach timeout for a workspace that is simply not mounted resolves nothing and
 *  runs the probe script inside the owner's live window dozens of times to find that out. */
const MOUNT_TIMEOUT = 2_000
const LOAD_TIMEOUT = 10_000
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
  /** Opens a visible browser tab in the caller's own workspace. */
  openBrowserTab(scope: BrowserMcpScope): Promise<void>
  rendererPath: string
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
  constructor(private readonly deps: Deps) {}

  /** Called from every workspace window's did-attach-webview. */
  attach(window: BrowserWindow, guest: WebContents): void {
    const id = guest.id
    // did-attach-webview can fire again for a guest this already watches. Without dropping the
    // previous listeners each re-attach would add another recorder and every page message would
    // arrive in the agent's console output as many times as the pane has attached.
    this.detach.get(id)?.()
    this.hosts.set(id, window.webContents.id)
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
    // The candidate set is the caller's own workspace, read from the database. Nothing the agent
    // sends takes part in choosing it, so no session can address another project's view.
    let located = await this.probe(this.browserTabs(scope))
    let opened = false
    // A workspace with no browser view yet gets one, in the owner's own window, where they can
    // watch every page the agent opens.
    if (!located && !this.browserTabs(scope).size) { opened = true; await this.deps.openBrowserTab(scope) }
    // Only a pane that is actually on its way is worth waiting out. A workspace that is not on
    // screen never resolves, and polling it for the full attach timeout runs the probe script
    // inside the owner's live renderer dozens of times to arrive at the same refusal.
    const deadline = Date.now() + (opened ? ATTACH_TIMEOUT : MOUNT_TIMEOUT)
    for (let pause = 100; !located && Date.now() < deadline; pause = Math.min(pause + 100, 600)) {
      await settle(pause)
      // The tab list is re-read each pass because the renderer persists the new layout a moment
      // after it acknowledges the open.
      located = await this.probe(this.browserTabs(scope))
    }
    if (!located) throw new Error('The Conductor browser view for this workspace is not open yet. Ask the owner to open a Browser tab, or try again in a moment.')
    return this.page(located.guest, located.tabId)
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

  private browserTabs(scope: BrowserMcpScope): Set<string> {
    return new Set(this.deps.tabs(scope).filter(tab => tab.kind === 'browser').map(tab => tab.id))
  }

  private async probe(wanted: Set<string>): Promise<{ guest: WebContents; tabId: string } | undefined> {
    if (!wanted.size) return undefined
    const trusted = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(this.deps.rendererPath).href
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      if (!isStructuredRendererUrl(window.webContents.getURL(), trusted)) continue
      let found: Array<{ id: number; tabId: string }>
      try { found = await window.webContents.executeJavaScript(PROBE) as Array<{ id: number; tabId: string }> }
      catch { continue }
      for (const entry of found ?? []) {
        if (!wanted.has(entry.tabId)) continue
        // The pane element claims a tab id; the main process independently confirms that this
        // guest attached to this very window, so a stale or mismatched id resolves to nothing.
        if (this.hosts.get(entry.id) !== window.webContents.id) continue
        const guest = allWebContents.fromId(entry.id)
        if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') continue
        return { guest, tabId: entry.tabId }
      }
    }
    return undefined
  }

  private page(guest: WebContents, tabId: string): BrowserView {
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
      }
    }
  }
}
