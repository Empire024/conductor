import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/* boot.js and sw.js are served verbatim to the phone with no build step, so they are run here as
   they are, in a bare context with just enough of a window, document or worker to drive them. No
   jsdom: the stub DOM below implements only what the two files touch. */

const bootSource = readFileSync(new URL('./boot.js', import.meta.url), 'utf8')
const swSource = readFileSync(new URL('./sw.js', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('./app.js', import.meta.url), 'utf8')

const ORIGIN = 'https://phone.test:51841'
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1'

type Listener = (event: any) => void

class FakeNode {
  tagName: string
  className = ''
  hidden = false
  type = ''
  src = ''
  children: FakeNode[] = []
  parentNode: FakeNode | null = null
  attributes: Record<string, string> = {}
  listeners: Record<string, Listener[]> = {}
  private text = ''

  constructor(tag: string) { this.tagName = tag.toUpperCase() }

  get firstChild(): FakeNode | null { return this.children[0] ?? null }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' ') }
  set textContent(value: string) { this.text = String(value); this.children = [] }

  appendChild(child: FakeNode): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (!before) return this.appendChild(child)
    child.parentNode = this
    this.children.splice(this.children.indexOf(before), 0, child)
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    this.children = this.children.filter(entry => entry !== child)
    child.parentNode = null
    return child
  }

  setAttribute(name: string, value: string): void { this.attributes[name] = String(value) }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn) }

  all(): FakeNode[] { return this.children.flatMap(child => [child, ...child.all()]) }
  querySelectorAll(selector: string): FakeNode[] {
    const wanted = selector.replace(/^\./, '')
    return this.all().filter(node => node.className.split(' ').includes(wanted))
  }
  find(predicate: (node: FakeNode) => boolean): FakeNode | undefined { return this.all().find(predicate) }
  click(): void { for (const fn of this.listeners.click ?? []) fn({ target: this }) }
}

interface BootOptions {
  userAgent?: string
  standalone?: boolean
  online?: boolean
  controlled?: boolean
  fetch?: (path: string) => Promise<unknown>
}

const bootPage = (options: BootOptions = {}) => {
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let now = 0
  let nextId = 1
  const windowListeners: Record<string, Listener[]> = {}
  const documentListeners: Record<string, Array<{ fn: Listener; capture: boolean }>> = {}
  const app = new FakeNode('div')
  const overlay = new FakeNode('div')
  const body = new FakeNode('body')
  body.appendChild(app)
  body.appendChild(overlay)
  const appScript = new FakeNode('script')
  appScript.src = ORIGIN + '/app.js'
  const reloads: number[] = []

  const document = {
    readyState: 'interactive',
    body,
    createElement: (tag: string) => new FakeNode(tag),
    getElementById: (id: string) => (id === 'app' ? app : id === 'overlay' ? overlay : null),
    getElementsByTagName: () => [appScript],
    addEventListener: (type: string, fn: Listener, capture?: boolean) => { (documentListeners[type] ??= []).push({ fn, capture: Boolean(capture) }) }
  }
  const window: Record<string, any> = {
    document,
    location: { origin: ORIGIN, hash: '', reload: () => reloads.push(now) },
    navigator: {
      userAgent: options.userAgent ?? IPHONE_SAFARI,
      maxTouchPoints: 5,
      onLine: options.online ?? true,
      standalone: options.standalone ?? false,
      serviceWorker: { controller: options.controlled ? {} : null }
    },
    isSecureContext: true,
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimeout: (id: number) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1) },
    addEventListener: (type: string, fn: Listener) => { (windowListeners[type] ??= []).push(fn) },
    fetch: options.fetch,
    AbortController
  }
  runInNewContext(bootSource, { window })

  const advance = (ms: number) => {
    now += ms
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > now) continue
      timers.splice(timers.indexOf(timer), 1)
      timer.fn()
    }
  }
  const fireWindow = (type: string, event: any) => { for (const fn of windowListeners[type] ?? []) fn(event) }
  const fireDocumentCapture = (type: string, event: any) => { for (const entry of documentListeners[type] ?? []) if (entry.capture) entry.fn(event) }
  const button = (label: string) => app.find(node => node.tagName === 'BUTTON' && node.textContent === label)
  return { window, app, overlay, appScript, advance, fireWindow, fireDocumentCapture, button, reloads, boot: window.ConductorBoot }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('boot.js: browser facts', () => {
  const { boot } = bootPage()

  it('tells Safari, Chrome, Firefox, Edge and in-app browsers apart on iOS', () => {
    expect(boot.platform(IPHONE_SAFARI, 5)).toMatchObject({ ios: true, browser: 'safari', name: 'Safari' })
    expect(boot.platform(IPHONE_CHROME, 5)).toMatchObject({ ios: true, browser: 'chrome', name: 'Chrome' })
    expect(boot.platform(IPHONE_SAFARI.replace('Version/18.5', 'FxiOS/140.0'), 5)).toMatchObject({ ios: true, browser: 'firefox' })
    expect(boot.platform(IPHONE_SAFARI.replace('Version/18.5', 'EdgiOS/140.0'), 5)).toMatchObject({ ios: true, browser: 'edge' })
    expect(boot.platform(IPHONE_SAFARI.replace('Version/18.5 ', 'GSA/380.0 '), 5)).toMatchObject({ ios: true, browser: 'other' })
    // iPadOS asks for desktop sites by default and names itself a Mac; touch is what gives it away.
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'
    expect(boot.platform(ipad, 5)).toMatchObject({ ios: true, browser: 'safari' })
    expect(boot.platform(ipad, 0)).toMatchObject({ ios: false })
  })

  it('knows Chrome on Android and treats every desktop as a plain browser', () => {
    expect(boot.platform('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 5)).toMatchObject({ android: true, browser: 'chrome' })
    expect(boot.platform('Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36', 5)).toMatchObject({ android: true, browser: 'other' })
    expect(boot.platform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 0)).toMatchObject({ ios: false, android: false, browser: 'other' })
  })

  it('hands an https address to Safari through x-safari-https and keeps the fragment', () => {
    expect(boot.safariUrl(ORIGIN + '/#pair=ABCD-EFGH')).toBe('x-safari-https://phone.test:51841/#pair=ABCD-EFGH')
    expect(boot.safariUrl(ORIGIN + '/#trust')).toBe('x-safari-https://phone.test:51841/#trust')
  })

  it('accepts a scanned pairing QR only for this very origin', () => {
    expect(boot.pairCodeFromUrl(ORIGIN + '/#pair=ABCD-EFGH', ORIGIN)).toBe('ABCDEFGH')
    expect(boot.pairCodeFromUrl('HTTPS://PHONE.TEST:51841/?from=qr#pair=abcd%2Defgh', ORIGIN)).toBe('ABCDEFGH')
    expect(boot.pairCodeFromUrl('https://other.test:51841/#pair=ABCD-EFGH', ORIGIN)).toBe('')
    expect(boot.pairCodeFromUrl('http://phone.test:51841/#pair=ABCD-EFGH', ORIGIN)).toBe('')
    expect(boot.pairCodeFromUrl(ORIGIN + '/#trust', ORIGIN)).toBe('')
    expect(boot.pairCodeFromUrl('ABCD-EFGH', ORIGIN)).toBe('')
  })

  it('describes the page: origin, Home Screen or tab, network and service worker', () => {
    const home = bootPage({ standalone: true, online: false, controlled: true }).boot.describe('watchdog', {})
    const rows = Object.fromEntries(home.rows)
    expect(home.title).toBe('Conductor\'s app did not start')
    expect(rows).toMatchObject({ Address: ORIGIN, 'Opened from': 'The Home Screen app', Network: 'This phone says it is offline', 'Service worker': 'Controls this page' })
    const tab = Object.fromEntries(boot.describe('error', { message: 'boom' }).rows)
    expect(tab).toMatchObject({ 'What happened': 'boom', 'Opened from': 'A browser tab', 'Service worker': 'Not in control of this page' })
  })
})

describe('boot.js: the guard', () => {
  it('shows a placeholder at once, so the screen is never blank while app.js loads', () => {
    const page = bootPage()
    expect(page.app.textContent).toContain('Starting Conductor')
  })

  it('says the app did not start when app.js never marks itself booted within 5 seconds', () => {
    const page = bootPage()
    page.advance(4999)
    expect(page.app.textContent).not.toContain('did not start')
    page.advance(1)
    expect(page.app.textContent).toContain('Conductor\'s app did not start')
    expect(page.app.textContent).toContain('still loading')
    expect(page.app.textContent).toContain(ORIGIN)
    expect(page.button('Try again')).toBeDefined()
    expect(page.button('Connection check')).toBeDefined()
  })

  it('tells a loaded but stuck app.js from one still loading', () => {
    const page = bootPage()
    page.fireDocumentCapture('load', { target: page.appScript })
    page.advance(5000)
    expect(page.app.textContent).toContain('did not finish starting')
  })

  it('stays out of the way once app.js has booted', () => {
    const page = bootPage()
    page.boot.booted()
    expect(page.window.__conductorBooted).toBe(true)
    expect(page.app.textContent).not.toContain('Starting Conductor')
    page.advance(10000)
    expect(page.app.textContent).toBe('')
  })

  it('renders a card when app.js fails to load, which a CSP-blocked inline onerror could not', () => {
    const page = bootPage()
    page.fireWindow('error', { target: page.appScript })
    expect(page.app.textContent).toContain('The file /app.js could not be loaded from this computer.')
    page.advance(5000)
    expect(page.app.textContent).toContain('could not be loaded')
  })

  it('renders a runtime error before boot with its message and place', () => {
    const page = bootPage()
    page.fireWindow('error', { target: page.window, message: 'TypeError: x is not a function', filename: ORIGIN + '/app.js', lineno: 10, colno: 5 })
    expect(page.app.textContent).toContain('Conductor\'s app hit an error')
    expect(page.app.textContent).toContain('TypeError: x is not a function')
    expect(page.app.textContent).toContain('/app.js:10:5')
  })

  it('turns an error after boot into a line at the top instead of taking over the screen', () => {
    const page = bootPage()
    page.boot.booted()
    page.app.appendChild(new FakeNode('div')).textContent = 'the session list'
    page.fireWindow('unhandledrejection', { reason: new Error('late failure') })
    expect(page.app.textContent).toBe('the session list')
    expect(page.overlay.textContent).toContain('late failure')
    page.fireWindow('unhandledrejection', { reason: Object.assign(new Error('aborted'), { name: 'AbortError' }) })
    expect(page.overlay.querySelectorAll('.boot-strip')).toHaveLength(1)
  })

  it('reloads on Try again, and runs its own health check when app.js is not there to', async () => {
    const page = bootPage({ fetch: () => Promise.reject(new TypeError('Load failed')) })
    page.advance(5000)
    page.button('Try again')!.click()
    expect(page.reloads).toHaveLength(1)
    page.button('Connection check')!.click()
    await settle()
    await settle()
    expect(page.app.textContent).toContain('This computer is not answering at ' + ORIGIN + '.')
    expect(page.app.textContent).toContain('open Tailscale on this phone')
  })

  it('says the computer answered when only the app files are the problem', async () => {
    const page = bootPage({ fetch: async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, version: '9.9.9', exposure: 'tailscale', at: '', viaTailscale: true }) }) })
    page.advance(5000)
    page.button('Connection check')!.click()
    for (let index = 0; index < 5; index += 1) await settle()
    expect(page.app.textContent).toContain('Conductor 9.9.9 answered at ' + ORIGIN)
  })
})

describe('index.html', () => {
  it('loads the boot guard as a blocking script before the deferred app', () => {
    const boot = indexSource.indexOf('<script src="/boot.js"></script>')
    const app = indexSource.indexOf('<script src="/app.js" defer></script>')
    expect(boot).toBeGreaterThan(0)
    expect(app).toBeGreaterThan(boot)
    expect(indexSource).not.toMatch(/<script>(?!<\/script>)/)
  })
})

describe('phone task section', () => {
  it('has a dedicated Tasks route and keeps project-task creation out of New', () => {
    expect(appSource).toContain("hash.indexOf('#/tasks')")
    expect(appSource).toContain("{ id: 'tasks', label: 'Tasks', hash: '#/tasks' }")
    expect(appSource).toContain("api('/api/projects/' + encodeURIComponent(form.projectId) + '/tasks?offset='")
    expect(appSource).not.toContain("{ id: 'project', label: 'Project task' }")
  })
})

describe('sw.js', () => {
  const worker = (cached: Record<string, string>, network: (url: string) => Promise<Response>) => {
    const listeners: Record<string, Listener> = {}
    const added: string[] = []
    const store = new Map(Object.entries(cached).map(([path, body]) => [path, new Response(body, { headers: { 'Content-Type': 'text/html' } })]))
    const keyOf = (request: any) => new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname
    const caches = {
      open: async () => ({ put: async () => undefined, add: async (path: string) => { added.push(path) } }),
      match: async (request: any) => store.get(keyOf(request))?.clone(),
      keys: async () => [],
      delete: async () => true
    }
    const self = {
      location: new URL(ORIGIN + '/sw.js'),
      addEventListener: (type: string, fn: Listener) => { listeners[type] = fn },
      skipWaiting: () => undefined,
      clients: { claim: async () => undefined, matchAll: async () => [] },
      registration: {}
    }
    runInNewContext(swSource, { self, caches, fetch: network, Response, URL })
    const request = async (path: string, mode = 'navigate') => {
      let answer = null as Promise<Response> | null
      listeners.fetch!({ request: { method: 'GET', url: ORIGIN + path, mode }, respondWith: (value: Promise<Response>) => { answer = value } })
      return answer ? await answer : null
    }
    return { listeners, added, request }
  }
  const unreachable = () => Promise.reject(new TypeError('Failed to fetch'))

  it('precaches the boot guard with the rest of the shell under a new cache name', async () => {
    const sw = worker({}, unreachable)
    expect(swSource).toContain("const CACHE = 'conductor-phone-v2'")
    let done: Promise<unknown> = Promise.resolve()
    sw.listeners.install!({ waitUntil: (value: Promise<unknown>) => { done = value } })
    await done
    expect(sw.added).toContain('/boot.js')
    expect(sw.added).toContain('/app.js')
  })

  it('answers a failed navigation with no cached shell with a static page that explains itself', async () => {
    const sw = worker({}, unreachable)
    const response = await sw.request('/')
    expect(response!.status).toBe(503)
    const html = await response!.text()
    expect(html).toContain('Conductor is not answering')
    expect(html).toContain(ORIGIN)
    expect(html).toContain('open Tailscale on this phone')
    expect(html).toContain('<a class="button" href="/">Try again</a>')
    expect(html).not.toMatch(/<script|src=|<link/i)
  })

  it('prefers the cached shell when there is one', async () => {
    const sw = worker({ '/': '<!doctype html><title>cached shell</title>' }, unreachable)
    expect(await (await sw.request('/'))!.text()).toContain('cached shell')
  })

  it('never touches /api, so the health check always asks the computer', async () => {
    const sw = worker({}, unreachable)
    expect(await sw.request('/api/health', 'cors')).toBeNull()
  })
})
