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
const markdownSource = readFileSync(new URL('./markdown.js', import.meta.url), 'utf8')

const ORIGIN = 'https://phone.test:51841'
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1'

type Listener = (event: any) => void

/* The one element that has focus in whichever app page a test booted; boot.js never focuses. */
let focusedNode: FakeNode | null = null

class FakeNode {
  tagName: string
  className = ''
  hidden = false
  type = ''
  src = ''
  value = ''
  dataset: Record<string, string> = {}
  style: Record<string, unknown> = { setProperty: () => undefined }
  children: FakeNode[] = []
  parentNode: FakeNode | null = null
  attributes: Record<string, string> = {}
  listeners: Record<string, Listener[]> = {}
  private text = ''

  constructor(tag: string) { this.tagName = tag.toUpperCase() }

  get firstChild(): FakeNode | null { return this.children[0] ?? null }
  get childNodes(): FakeNode[] { return this.children }
  get classList() {
    const names = () => this.className.split(' ').filter(Boolean)
    const add = (name: string) => { if (!names().includes(name)) this.className = names().concat([name]).join(' ') }
    const remove = (name: string) => { this.className = names().filter(entry => entry !== name).join(' ') }
    return {
      add,
      remove,
      contains: (name: string) => names().includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !names().includes(name) : force
        if (on) add(name); else remove(name)
        return on
      }
    }
  }
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
  removeEventListener(type: string, fn: Listener): void { this.listeners[type] = (this.listeners[type] ?? []).filter(entry => entry !== fn) }
  dispatch(type: string, event: Record<string, unknown> = {}): void { for (const fn of this.listeners[type] ?? []) fn({ target: this, preventDefault: () => undefined, ...event }) }

  all(): FakeNode[] { return this.children.flatMap(child => [child, ...child.all()]) }
  querySelectorAll(selector: string): FakeNode[] {
    const wanted = selector.replace(/^\./, '')
    return this.all().filter(node => node.className.split(' ').includes(wanted))
  }
  querySelector(selector: string): FakeNode | null { return this.querySelectorAll(selector)[0] ?? null }
  find(predicate: (node: FakeNode) => boolean): FakeNode | undefined { return this.all().find(predicate) }
  click(): void { for (const fn of this.listeners.click ?? []) fn({ target: this }) }
  focus(): void { focusedNode = this; this.dispatch('focus') }
  blur(): void { if (focusedNode === this) focusedNode = null; this.dispatch('blur') }
  /* What typing does to a field: the value changes, then 'input' fires. */
  typeText(value: string): void { this.value = value; this.dispatch('input') }
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
    /* Deferred scripts run in document order, so the renderer is loaded before app.js draws. */
    const markdown = indexSource.indexOf('<script src="/markdown.js" defer></script>')
    expect(markdown).toBeGreaterThan(boot)
    expect(app).toBeGreaterThan(markdown)
    expect(indexSource).not.toMatch(/<script>(?!<\/script>)/)
  })
})

describe('phone task section', () => {
  it('has a dedicated Tasks route and keeps project-task creation out of New', () => {
    expect(appSource).toContain("hash.indexOf('#/tasks')")
    expect(appSource).toContain("'Project tasks'")
    expect(appSource).toContain("api('/api/projects/' + encodeURIComponent(form.projectId) + '/tasks?offset='")
    expect(appSource).not.toContain("{ id: 'project', label: 'Project task' }")
  })
})

describe('phone keyboard viewport', () => {
  it('pulls the fixed shell back by the visual viewport offset, not only its height, and settles the caret', () => {
    expect(appSource).toContain("root.style.setProperty('--app-height'")
    expect(appSource).toContain("root.style.setProperty('--app-offset'")
    expect(appSource).toContain('scrollCaretIntoView')
    expect(appSource).toContain("window.visualViewport.addEventListener('resize', applyViewport)")
    expect(appSource).toContain("window.visualViewport.addEventListener('scroll', applyViewport)")
  })
  it('sizes and translates the app shell from those custom properties in CSS', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
    expect(css).toContain('height: var(--app-height, 100dvh)')
    expect(css).toContain('transform: translateY(var(--app-offset, 0px))')
  })
  it('sizes the shell from the visual viewport only while it is well short of the layout one', () => {
    /* Otherwise CSS fills the screen: an iOS Home Screen app reporting a short visual viewport
       left a bare band under the tab bar (owner iPhone, 2026-10-03). */
    expect(appSource).toContain('layout - viewport.height > KEYBOARD_MIN_HEIGHT')
    expect(appSource).toContain("root.style.removeProperty('--app-height')")
    expect(appSource).toContain("root.classList.toggle('keyboard-open', shrunk && typing)")
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
    expect(css).toContain('@media (display-mode: standalone) { .app { height: var(--app-height, max(100vh, 100dvh)); } }')
    expect(css).toContain('.keyboard-open .tabbar { display: none; }')
  })
})

describe('new conversation defaults', () => {
  it('shows the prompt first with settings folded behind a toggle', () => {
    expect(appSource).toContain('settingsToggle')
    expect(appSource).toContain('form.settingsOpen')
    expect(appSource).toContain('settings.hidden = !form.settingsOpen')
  })
  it('uses a remembered successful choice or Claude Opus rather than quota ranking', () => {
    expect(appSource).not.toContain('usageRemainingByProvider')
    expect(appSource).toContain('LAST_AGENT_KEY')
    expect(appSource).toContain('preferredModel')
  })
})

describe('phone notification preferences', () => {
  it('offers per-category toggles and saves them to the device', () => {
    expect(appSource).toContain("api('/api/notifications', { method: 'POST'")
    expect(appSource).toContain("prefRow('A controller or main task is done', 'taskDone')")
    expect(appSource).toContain("prefRow('Something needs you (approval, question, error)', 'needsYou')")
    expect(appSource).toContain("prefRow('A coworker finishes', 'coworkerDone')")
  })
})

/* app.js itself, booted on a paired phone at a given hash, with the same stub DOM. The server is a
   function from each request to its JSON answer; throwing from it is a network failure. */
interface AppCall { path: string; method: string; body: any; keepalive: boolean; raw?: unknown; contentType?: string }

/* Just enough canvas for the image tray: a thumbnail data URL and a re-encoded JPEG blob. */
const fakeCanvas = () => Object.assign(new FakeNode('canvas'), {
  width: 0,
  height: 0,
  getContext: () => ({ fillStyle: '', fillRect: () => undefined, drawImage: () => undefined }),
  toDataURL: () => 'data:image/jpeg;base64,dGh1bWI=',
  toBlob: (done: (blob: Blob) => void, type: string) => done(new Blob(['scaled'], { type }))
})

/* A test that is not about the lock never sees its boot-time read: the computer has no code set. */
const bootApp = (hash: string, respond: (call: AppCall) => unknown, options: { lock?: boolean; markdown?: boolean; globals?: Record<string, unknown>; phoneState?: unknown } = {}) => {
  focusedNode = null
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let now = 0
  let nextId = 1
  const windowListeners: Record<string, Listener[]> = {}
  const documentListeners: Record<string, Listener[]> = {}
  const calls: AppCall[] = []
  const streams: Array<{ headers: Record<string, string> }> = []
  const headersSent: Array<{ path: string; headers: Record<string, string> }> = []
  const app = new FakeNode('div')
  const pill = new FakeNode('div')
  const toasts = new FakeNode('div')
  const setTimer = (fn: () => void, ms: number) => { const id = nextId++; timers.push({ at: now + (ms || 0), fn, id }); return id }
  const clearTimer = (id: number) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1) }
  const fire = (host: Record<string, Listener[]>, type: string, event: any = {}) => { for (const fn of host[type] ?? []) fn(event) }

  let currentHash = hash
  const location = {
    origin: ORIGIN,
    pathname: '/',
    search: '',
    get hash() { return currentHash },
    set hash(value: string) {
      currentHash = value
      setTimer(() => fire(windowListeners, 'hashchange'), 0)
    },
    reload: () => undefined,
    assign: () => undefined
  }
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    body: new FakeNode('body'),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined }, classList: { toggle: () => false, add: () => undefined, remove: () => undefined, contains: () => false } },
    get activeElement() { return focusedNode },
    createElement: (tag: string) => (tag === 'canvas' ? fakeCanvas() : new FakeNode(tag)),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => { const node = new FakeNode('#text'); node.textContent = text; return node },
    getElementById: (id: string) => ({ app, pill, toasts } as Record<string, FakeNode>)[id] ?? null,
    addEventListener: (type: string, fn: Listener) => { (documentListeners[type] ??= []).push(fn) },
    removeEventListener: () => undefined
  }
  const fetch = async (path: string, init: any = {}) => {
    if (path === '/api/stream') {
      streams.push({ headers: { ...(init.headers || {}) } })
      /* One `state` event, then the stream ends; a reconnect only waits on a timer. */
      if (options.phoneState) return new Response('event: state\ndata: ' + JSON.stringify(options.phoneState) + '\n\n', { status: 200 })
      return new Promise(() => undefined)
    }
    if (path === '/api/lock/state' && !options.lock) return { status: 200, ok: true, text: async () => JSON.stringify({ configured: false, unlocked: false }) }
    if (path === '/api/state') return { status: 200, ok: true, text: async () => JSON.stringify(options.phoneState || { projects: [], sessions: [], providers: [], machines: [], counts: {} }) }
    const text = typeof init.body === 'string'
    const call: AppCall = { path, method: init.method || 'GET', body: text ? JSON.parse(init.body) : undefined, keepalive: Boolean(init.keepalive), ...(init.body && !text ? { raw: init.body, contentType: (init.headers || {})['Content-Type'] } : {}) }
    calls.push(call)
    headersSent.push({ path, headers: { ...(init.headers || {}) } })
    const answer = await respond(call) as any
    /* An answer shaped { __status, body } is an HTTP failure; anything else is a 200. */
    if (answer && typeof answer.__status === 'number') return { status: answer.__status, ok: answer.__status < 400, text: async () => JSON.stringify(answer.body ?? null) }
    return { status: 200, ok: true, text: async () => JSON.stringify(answer ?? null) }
  }
  const window: Record<string, any> = {
    document,
    location,
    navigator: { userAgent: IPHONE_SAFARI, maxTouchPoints: 5, onLine: true, standalone: true },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { currentHash = url.slice(url.indexOf('#')) } },
    localStorage: { getItem: (key: string) => (key === 'conductor.phone.token' ? 'phone-token' : null), setItem: () => undefined, removeItem: () => undefined },
    innerHeight: 800,
    isSecureContext: true,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    setInterval: () => 0,
    clearInterval: () => undefined,
    addEventListener: (type: string, fn: Listener) => { (windowListeners[type] ??= []).push(fn) },
    fetch,
    AbortController,
    ...options.globals
  }
  /* index.html loads markdown.js before app.js; without it app.js falls back to plain text. */
  if (options.markdown) runInNewContext(markdownSource, { window })
  runInNewContext(appSource, {
    window, document, navigator: window.navigator, fetch, setTimeout: setTimer, clearTimeout: clearTimer,
    setInterval: () => 0, clearInterval: () => undefined, AbortController, TextDecoder, Response, URL, Blob, File
  })

  const advance = (ms: number) => {
    now += ms
    for (;;) {
      const due = timers.filter(timer => timer.at <= now).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      due.fn()
    }
  }
  const setVisibility = (value: 'visible' | 'hidden') => {
    document.visibilityState = value
    fire(documentListeners, 'visibilitychange')
  }
  const editor = () => app.find(node => node.tagName === 'TEXTAREA')
  const posts = () => calls.filter(call => call.method === 'POST')
  return { window, document, app, toasts, calls, posts, streams, headersSent, advance, setVisibility, editor, fireWindow: (type: string) => fire(windowListeners, type), fireDocument: (type: string, event: any = {}) => fire(documentListeners, type, event) }
}

const ideaDetail = (id: string, text: string) => ({
  id, title: text.split('\n')[0] || 'New idea', preview: '', status: 'inbox', workedOn: false, capturedFrom: 'phone',
  createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z', exploring: false, linkCounts: {}, tags: [],
  text, originalText: text, links: [], events: [], sections: [], explorations: []
})

const settleAll = async () => { for (let index = 0; index < 6; index += 1) await settle() }

describe('phone Ideas screen', () => {
  it('#/ideas opens a new note with the cursor already in it and Home always reachable', async () => {
    const page = bootApp('#/ideas', () => ({}))
    await settleAll()
    const editor = page.editor()
    expect(editor).toBeDefined()
    expect(page.document.activeElement).toBe(editor)
    expect(editor!.value).toBe('')
    expect(page.app.querySelector('.tabbar')!.hidden).toBe(false)
    const labels = page.app.querySelectorAll('.idea-bar-button').map(node => node.getAttribute('aria-label'))
    expect(labels).toEqual(['Ideas', 'New idea', 'Search ideas', 'More'])
  })

  it('creates the idea once on the first words, then autosaves the rest to that idea', async () => {
    let created = 0
    const page = bootApp('#/ideas', call => {
      if (call.path === '/api/ideas' && call.method === 'POST') { created += 1; return ideaDetail('idea-1', call.body.text) }
      if (call.path === '/api/ideas/idea-1' && call.method === 'POST') return ideaDetail('idea-1', call.body.text)
      return {}
    })
    await settleAll()
    const editor = page.editor()!
    editor.typeText('Solar')
    editor.typeText('Solar kettle')
    page.advance(699)
    expect(page.posts()).toHaveLength(0)
    page.advance(1)
    await settleAll()
    expect(page.posts()).toEqual([{ path: '/api/ideas', method: 'POST', body: { text: 'Solar kettle' }, keepalive: false }])
    expect(page.app.textContent).toContain('Saved')
    // The note now has an address of its own, without rebuilding the editor under the keyboard.
    expect(page.window.location.hash).toBe('#/ideas/idea-1')
    expect(page.editor()).toBe(editor)

    editor.typeText('Solar kettle\nthat boils with a lens')
    page.advance(700)
    await settleAll()
    expect(created).toBe(1)
    expect(page.posts().slice(1)).toEqual([{ path: '/api/ideas/idea-1', method: 'POST', body: { text: 'Solar kettle\nthat boils with a lens' }, keepalive: false }])
    page.fireWindow('hashchange')
    expect(page.editor()).toBe(editor)
  })

  it('never creates an empty idea, even when the app goes to the background', async () => {
    const page = bootApp('#/ideas', () => ideaDetail('idea-1', ''))
    await settleAll()
    const editor = page.editor()!
    editor.typeText('   ')
    editor.typeText('  \n ')
    page.advance(5000)
    page.setVisibility('hidden')
    page.fireWindow('pagehide')
    await settleAll()
    expect(page.posts()).toHaveLength(0)
  })

  it('keeps every keystroke typed while a save is in flight and sends one request at a time', async () => {
    const answers: Array<() => void> = []
    const page = bootApp('#/ideas', call => new Promise(resolve => {
      answers.push(() => resolve(ideaDetail('idea-7', call.body ? call.body.text : '')))
    }))
    await settleAll()
    const editor = page.editor()!
    editor.typeText('a')
    page.advance(700)
    await settleAll()
    expect(page.posts()).toHaveLength(1)
    editor.typeText('ab')
    page.advance(700)
    editor.typeText('abc')
    page.advance(700)
    await settleAll()
    expect(page.posts()).toHaveLength(1)
    answers.shift()!()
    await settleAll()
    expect(page.posts().map(call => [call.path, call.body.text])).toEqual([['/api/ideas', 'a'], ['/api/ideas/idea-7', 'abc']])
    answers.shift()!()
    await settleAll()
    expect(page.posts()).toHaveLength(2)
    expect(page.app.textContent).toContain('Saved')
  })

  it('flushes at once when the phone leaves the app, and retries when offline', async () => {
    let online = false
    const page = bootApp('#/ideas', call => {
      if (!online) throw new TypeError('Failed to fetch')
      return ideaDetail('idea-3', call.body.text)
    })
    await settleAll()
    page.editor()!.typeText('Call the plumber')
    page.setVisibility('hidden')
    await settleAll()
    expect(page.posts()).toEqual([{ path: '/api/ideas', method: 'POST', body: { text: 'Call the plumber' }, keepalive: true }])
    expect(page.app.textContent).toContain('Offline — will retry')
    online = true
    page.advance(2000)
    await settleAll()
    expect(page.posts()).toHaveLength(2)
    expect(page.app.textContent).toContain('Saved')
  })

  it('loads an existing idea into the same editor and saves edits to it', async () => {
    const page = bootApp('#/ideas/idea-9', call => {
      if (call.path === '/api/ideas/idea-9') return ideaDetail('idea-9', call.method === 'POST' ? call.body.text : 'Old thought')
      return {}
    })
    await settleAll()
    const editor = page.editor()!
    expect(editor.value).toBe('Old thought')
    editor.typeText('Old thought, sharpened')
    page.advance(700)
    await settleAll()
    expect(page.posts()).toEqual([{ path: '/api/ideas/idea-9', method: 'POST', body: { text: 'Old thought, sharpened' }, keepalive: false }])
  })

  it('lists ideas with what has happened to each under More', async () => {
    const page = bootApp('#/ideas/list', call => {
      if (call.path.indexOf('/api/ideas?') === 0) {
        return {
          ideas: [
            { ...ideaDetail('a', 'Worked one'), workedOn: true },
            { ...ideaDetail('b', 'Explored one'), lastExploredAt: '2026-09-24T11:00:00.000Z' },
            ideaDetail('c', 'Fresh one')
          ]
        }
      }
      return {}
    })
    await settleAll()
    expect(page.calls[0]!.path).toBe('/api/ideas?search=')
    const text = page.app.textContent
    expect(text).toContain('Worked one')
    expect(text).toContain('Worked on')
    expect(text).toContain('Explored')
    expect(text).toContain('Never touched')
    expect(page.app.querySelector('.tabbar')!.hidden).toBe(false)
    const tab = page.app.querySelectorAll('.tab').find(node => node.dataset.tab === 'more')!
    expect(tab.classList.contains('active')).toBe(true)
    page.app.querySelectorAll('.idea-row')[2]!.click()
    page.advance(0)
    expect(page.window.location.hash).toBe('#/ideas/c')
  })
})

describe('sw.js', () => {
  const worker =(cached: Record<string, string>, network: (url: string) => Promise<Response>) => {
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
    runInNewContext(swSource, { self, caches, fetch: network, Response, URL, AbortController, setTimeout, clearTimeout })
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
    expect(swSource).toContain("const CACHE = 'conductor-phone-v4'")
    let done: Promise<unknown> = Promise.resolve()
    sw.listeners.install!({ waitUntil: (value: Promise<unknown>) => { done = value } })
    await done
    expect(sw.added).toContain('/boot.js')
    expect(sw.added).toContain('/app.js')
    expect(sw.added).toContain('/markdown.js')
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

  it('keeps a share-sheet POST on the phone: images and text into the share cache, then #/share', async () => {
    const listeners: Record<string, Listener> = {}
    const stored = new Map<string, Response>()
    const opened: string[] = []
    const caches = {
      open: async (name: string) => { opened.push(name); return { put: async (key: string, response: Response) => { stored.set(key, response) }, add: async () => undefined } },
      delete: async () => true, keys: async () => [], match: async () => undefined
    }
    const self = { location: new URL(ORIGIN + '/sw.js'), addEventListener: (type: string, fn: Listener) => { listeners[type] = fn }, skipWaiting: () => undefined, clients: { claim: async () => undefined, matchAll: async () => [] }, registration: {} }
    runInNewContext(swSource, { self, caches, fetch: () => Promise.reject(new Error('the share must not reach the network')), Response, URL })
    const form = new FormData()
    form.append('images', new File(['png'], 'Screenshot.png', { type: 'image/png' }))
    form.append('images', new File(['text'], 'notes.txt', { type: 'text/plain' }))
    form.append('text', 'Look at this')
    let answer: Promise<Response> | null = null
    listeners.fetch!({ request: { method: 'POST', url: ORIGIN + '/share', formData: async () => form }, respondWith: (value: Promise<Response>) => { answer = value } })
    const response = await answer!
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe(ORIGIN + '/#/share')
    expect(opened).toEqual(['conductor-phone-share'])
    expect([...stored.keys()]).toEqual(['/__share/0', '/__share/text'])
    expect(stored.get('/__share/0')!.headers.get('X-Name')).toBe('Screenshot.png')
    expect(await stored.get('/__share/0')!.text()).toBe('png')
    expect(await stored.get('/__share/text')!.text()).toBe('Look at this')
  })

  it('declares the share target the worker answers', () => {
    const manifest = JSON.parse(readFileSync(new URL('./manifest.webmanifest', import.meta.url), 'utf8'))
    expect(manifest.share_target).toMatchObject({ action: '/share', method: 'POST', enctype: 'multipart/form-data', params: { files: [{ name: 'images' }] } })
    expect(manifest.share_target.params.files[0].accept).toContain('image/*')
  })

  it('never touches /api, so the health check always asks the computer', async () => {
    const sw = worker({}, unreachable)
    expect(await sw.request('/api/health', 'cors')).toBeNull()
  })
})

describe('phone viewing state', () => {
  const extract = (name: string) => {
    const source = new RegExp(`function ${name}\\(([a-z]+)\\) \\{([\\s\\S]*?)\\r?\\n  \\}`).exec(appSource)
    if (!source) throw new Error('missing ' + name)
    return new Function(source[1]!, source[2]!) as (value: unknown) => unknown
  }
  it('says Waiting for a settled turn whose background tasks still run, and drops the turn timer', () => {
    const viewing = extract('sessionViewing')
    expect(viewing({ state: 'working', activity: 'waiting_background', phase: 'completed', backgroundTasks: 1 })).toBe(true)
    expect(viewing({ state: 'working', activity: 'complete', phase: 'idle', backgroundTasks: 2 })).toBe(true)
    expect(viewing({ state: 'working', activity: 'working', phase: 'running', backgroundTasks: 1 })).toBe(false)
    expect(viewing({ state: 'done', activity: 'complete', phase: 'completed', backgroundTasks: 0 })).toBe(false)
    expect(extract('viewingDescription')(1)).toBe('Turn ended; 1 background task still running; the agent continues when they finish')
    expect(appSource).toContain("label: 'Waiting'")
    expect(appSource).toContain("session.state === 'working' && !viewing && session.turnStartedAt")
  })
})

describe('phone lock pad', () => {
  const lockedState = { configured: true, unlocked: false, lockedOut: false, failures: 0, remaining: 5, retryAt: null, idleMs: 300000, backgroundMs: 60000 }
  const key = (page: ReturnType<typeof bootApp>, label: string) => page.app.find(node => node.tagName === 'BUTTON' && node.className.includes('lock-key') && node.textContent === label)!
  const typeCode = (page: ReturnType<typeof bootApp>, code: string) => { for (const digit of code) key(page, digit).click() }

  it('shows only the code pad while locked, opens no stream, and unlocks with the code', async () => {
    const page = bootApp('#/', call => {
      if (call.path === '/api/lock/state') return lockedState
      if (call.path === '/api/lock/unlock') return { unlockToken: 'unlock-1', idleMs: 300000, backgroundMs: 60000 }
      return {}
    }, { lock: true })
    await settleAll()
    expect(page.app.textContent).toContain('Conductor is locked')
    expect(page.app.querySelector('.tabbar')!.hidden).toBe(true)
    expect(page.streams).toHaveLength(0)
    typeCode(page, '482915')
    await settleAll()
    expect(page.posts()).toEqual([{ path: '/api/lock/unlock', method: 'POST', body: { code: '482915' }, keepalive: false }])
    expect(page.app.textContent).not.toContain('Conductor is locked')
    // The stream, and every call after it, carries the unlock token.
    expect(page.streams.at(-1)!.headers['X-Conductor-Unlock']).toBe('unlock-1')
  })

  it('says how many tries are left after a wrong code and clears the dots', async () => {
    const page = bootApp('#/', call => {
      if (call.path === '/api/lock/state') return lockedState
      if (call.path === '/api/lock/unlock') return { __status: 403, body: { error: 'That code is wrong.', remaining: 4, retryAt: null } }
      return {}
    }, { lock: true })
    await settleAll()
    typeCode(page, '000000')
    await settleAll()
    expect(page.app.textContent).toContain('That code is wrong. 4 tries left')
    expect(page.app.querySelectorAll('filled')).toHaveLength(0)
    expect(page.app.textContent).toContain('Conductor is locked')
  })

  it('goes back to the pad when the computer answers any call with 423', async () => {
    let locked = false
    const page = bootApp('#/system', call => {
      if (call.path === '/api/metrics' && locked) return { __status: 423, body: { error: 'Unlock Conductor on this phone first.', locked: true } }
      return {}
    })
    await settleAll()
    expect(page.app.textContent).not.toContain('Conductor is locked')
    locked = true
    page.fireWindow('hashchange')
    page.window.location.hash = '#/phone'
    page.advance(1)
    page.window.location.hash = '#/system'
    page.advance(1)
    await settleAll()
    expect(page.app.textContent).toContain('Conductor is locked')
  })

  it('offers the terminal from the System screen', () => {
    expect(appSource).toContain("button('ghost terminal-open', 'Terminal', () => visit('#/terminal'))")
    expect(appSource).toContain("if (hash.indexOf('#/terminal') === 0) return { name: 'terminal', key: 'terminal' }")
  })
})

/* One conversation at #/session/s1 whose timeline is the given items. */
const conversationAnswer = (items: Array<{ role: string; text: string }>) => (call: AppCall) => {
  if (call.path === '/api/sessions/s1') {
    return {
      summary: { id: 's1', title: 'Chat', phase: 'idle', state: 'idle', provider: 'claude', model: 'opus' },
      items: items.map((item, index) => ({ id: 'i' + index, sequence: index, timestamp: '2026-09-30T10:00:00.000Z', data: { type: 'text', role: item.role, text: item.text } })),
      pending: [],
      queued: []
    }
  }
  if (call.path === '/api/sessions/s1/message') return { ok: true }
  return {}
}

describe('phone conversation markdown', () => {
  it('renders agent replies as markdown and keeps what the owner typed as plain text', async () => {
    const page = bootApp('#/session/s1', conversationAnswer([
      { role: 'user', text: 'make it **bold**' },
      { role: 'assistant', text: '# Done\n\n- one **two**\n- [site](https://example.com) and [bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>' }
    ]), { markdown: true })
    await settleAll()
    const assistant = page.app.querySelector('assistant')!
    expect(assistant.find(node => node.tagName === 'P' && node.className.includes('md-h1'))!.textContent).toBe('Done')
    expect(assistant.find(node => node.tagName === 'STRONG')!.textContent).toBe('two')
    const links = assistant.all().filter(node => node.tagName === 'A')
    expect(links.map(node => node.getAttribute('href'))).toEqual(['https://example.com'])
    /* Raw HTML is text, never an element. */
    expect(assistant.find(node => node.tagName === 'IMG')).toBeUndefined()
    expect(assistant.textContent).toContain('<img src=x onerror=alert(1)>')
    const user = page.app.querySelector('user')!
    expect(user.find(node => node.tagName === 'STRONG')).toBeUndefined()
    expect(user.textContent).toContain('make it **bold**')
  })

  it('falls back to plain text blocks when markdown.js did not load', async () => {
    const page = bootApp('#/session/s1', conversationAnswer([{ role: 'assistant', text: 'plain **text**' }]))
    await settleAll()
    const assistant = page.app.querySelector('assistant')!
    expect(assistant.find(node => node.tagName === 'STRONG')).toBeUndefined()
    expect(assistant.textContent).toContain('plain **text**')
  })
})

describe('phone images', () => {
  /* createImageBitmap is how the app reads a picked file; the size decides whether it is scaled. */
  const bitmaps = (width: number, height: number) => ({ createImageBitmap: async () => ({ width, height, close: () => undefined }) })
  const imageConversation = (canAttachImages: boolean) => (call: AppCall) => {
    if (call.path === '/api/sessions/s1') {
      return { summary: { id: 's1', title: 'Chat', phase: 'idle', state: 'idle', provider: 'claude', model: 'opus' }, items: [], pending: [], queued: [], canAttachImages }
    }
    if (call.path.startsWith('/api/sessions/s1/images?name=')) {
      const name = decodeURIComponent(call.path.slice(call.path.indexOf('=') + 1))
      return { id: 'img-' + name, kind: 'image', name, path: '.conductor/prompt-images/' + name.length.toString().padStart(8, '0') + '-0000-4000-8000-000000000000.png' }
    }
    return {}
  }
  const pick = async (page: ReturnType<typeof bootApp>, files: unknown[]) => {
    const input = page.app.find(node => node.tagName === 'INPUT' && node.className.includes('image-file'))!
    expect(input.getAttribute('capture')).toBeNull()
    expect((input as any).multiple).toBe(true)
    expect((input as any).accept).toBe('image/*')
    ;(input as any).files = files
    input.dispatch('change')
    await settleAll()
  }
  const thumbs = (page: ReturnType<typeof bootApp>) => page.app.querySelectorAll('image-thumb')

  it('attaches gallery images to a message: thumbnails first, one removable, then uploads and sends them as attachments', async () => {
    const page = bootApp('#/session/s1', imageConversation(true), { globals: bitmaps(1080, 2400) })
    await settleAll()
    const attach = page.app.querySelector('composer-attach')!
    expect(attach.hidden).toBe(false)
    attach.click()
    const screenshot = new File(['png-bytes'], 'Screenshot_1.png', { type: 'image/png' })
    const second = new File(['other'], 'second.png', { type: 'image/png' })
    await pick(page, [screenshot, second])
    expect(thumbs(page)).toHaveLength(2)
    expect(thumbs(page)[0]!.find(node => node.tagName === 'IMG')!.src).toBe('data:image/jpeg;base64,dGh1bWI=')
    /* Images alone can be sent. */
    expect((page.app.querySelector('composer-send') as any).disabled).toBe(false)
    thumbs(page)[1]!.find(node => node.className.includes('image-remove'))!.click()
    expect(thumbs(page)).toHaveLength(1)
    page.app.find(node => node.tagName === 'TEXTAREA' && node.className.includes('composer-input'))!.typeText('This is the bug')
    page.app.querySelector('composer-send')!.click()
    await settleAll()
    const posts = page.posts()
    const upload = posts.find(call => call.path.startsWith('/api/sessions/s1/images'))!
    expect(upload.path).toBe('/api/sessions/s1/images?name=Screenshot_1.png')
    /* A small screenshot inside the size limit goes up untouched, as its own type. */
    expect(upload.raw).toBe(screenshot)
    expect(upload.contentType).toBe('image/png')
    expect(posts.filter(call => call.path.startsWith('/api/sessions/s1/images'))).toHaveLength(1)
    const message = posts.find(call => call.path === '/api/sessions/s1/message')!
    expect(message.body).toEqual({ text: 'This is the bug', mode: 'auto', attachments: [{ id: 'img-Screenshot_1.png', kind: 'image', name: 'Screenshot_1.png', path: '.conductor/prompt-images/00000016-0000-4000-8000-000000000000.png' }] })
    expect(posts.indexOf(upload)).toBeLessThan(posts.indexOf(message))
    expect(thumbs(page)).toHaveLength(0)
  })

  it('downscales a large photo to a JPEG before it leaves the phone', async () => {
    const page = bootApp('#/session/s1', imageConversation(true), { globals: bitmaps(4032, 3024) })
    await settleAll()
    page.app.querySelector('composer-attach')!.click()
    await pick(page, [new File(['x'.repeat(10)], 'IMG_0001.HEIC.jpeg', { type: 'image/jpeg' })])
    page.app.querySelector('composer-send')!.click()
    await settleAll()
    const upload = page.posts().find(call => call.path.startsWith('/api/sessions/s1/images'))!
    expect(upload.path).toBe('/api/sessions/s1/images?name=IMG_0001.HEIC.jpg')
    expect(upload.contentType).toBe('image/jpeg')
    expect(await (upload.raw as Blob).text()).toBe('scaled')
    expect(page.posts().find(call => call.path === '/api/sessions/s1/message')!.body.text).toBe('')
  })

  it('offers no attach button to a conversation that cannot take images', async () => {
    const page = bootApp('#/session/s1', imageConversation(false), { globals: bitmaps(10, 10) })
    await settleAll()
    expect(page.app.querySelector('composer-attach')!.hidden).toBe(true)
  })

  const phoneState = {
    projects: [{ id: 'p1', name: 'Conductor', machineId: 'local', workspaces: [{ id: 'w1', name: 'Main' }] }],
    sessions: [{ id: 's1', title: 'Fix the login bug', provider: 'claude', projectName: 'Conductor', machineId: 'local', tabId: 't1', state: 'idle', archived: false, updatedAt: '2026-10-02T10:00:00.000Z' }],
    machines: [{ id: 'local', name: 'MAIN', status: 'online' }], providers: [], counts: { attention: 0 }
  }

  it('adds a task with a photo: uploads it to the project, names it on the task, and lists the task without the image line', async () => {
    let tasks: unknown[] = []
    const page = bootApp('#/tasks', call => {
      if (call.path.startsWith('/api/projects/p1/tasks?')) return { projectId: 'p1', tasks, page: { offset: 0, limit: 20, total: tasks.length, hasMore: false } }
      if (call.path.startsWith('/api/projects/p1/images?name=')) return { id: 'img-1', kind: 'image', name: 'photo.jpg', path: '.conductor/prompt-images/00000001-0000-4000-8000-000000000000.jpg' }
      if (call.path === '/api/projects/p1/tasks') {
        tasks = [{ id: 'task-1', title: call.body.title + '\n\n![photo.jpg](.conductor/prompt-images/00000001-0000-4000-8000-000000000000.jpg)', kind: 'bug', status: 'todo', priority: 'normal', weight: 'medium' }]
        return { id: 'task-1', projectId: 'p1', title: call.body.title, kind: 'bug', priority: 'normal', weight: 'medium' }
      }
      return {}
    }, { globals: bitmaps(1200, 900), phoneState })
    await settleAll()
    const camera = page.app.find(node => node.tagName === 'BUTTON' && node.textContent.includes('Take photo'))!
    camera.click()
    const input = page.app.find(node => node.tagName === 'INPUT' && node.className.includes('image-file'))!
    expect(input.getAttribute('capture')).toBe('environment')
    ;(input as any).files = [new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' })]
    input.dispatch('change')
    await settleAll()
    expect(thumbs(page)).toHaveLength(1)
    const add = page.app.find(node => node.tagName === 'BUTTON' && node.className.includes('primary wide') && node.textContent.startsWith('Add task'))!
    expect(add.textContent).toBe('Add task with 1 image')
    page.app.find(node => node.tagName === 'TEXTAREA' && node.getAttribute('aria-label') === 'New project task')!.typeText('Settings page overflows')
    add.click()
    await settleAll()
    const posted = page.posts().find(call => call.path === '/api/projects/p1/tasks')!
    expect(posted.body).toMatchObject({ title: 'Settings page overflows', images: [{ id: 'img-1', kind: 'image', path: '.conductor/prompt-images/00000001-0000-4000-8000-000000000000.jpg' }] })
    expect(page.posts().find(call => call.path.startsWith('/api/projects/p1/images'))!.contentType).toBe('image/jpeg')
    const card = page.app.querySelector('phone-task')!
    expect(card.textContent).toContain('Settings page overflows')
    expect(card.textContent).not.toContain('prompt-images')
    expect(card.textContent).toContain('1 image')
  })

  it('lands a share-sheet image on #/share and hands it to the chosen conversation', async () => {
    const shared = new Map<string, Response>([
      [ORIGIN + '/__share/0', new Response(new Blob(['png'], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png', 'X-Name': encodeURIComponent('Screenshot 2026.png') } })],
      [ORIGIN + '/__share/text', new Response('Look at this')]
    ])
    let deleted = ''
    const caches = {
      open: async () => ({ keys: async () => [...shared.keys()].map(url => ({ url })), match: async (request: { url: string }) => shared.get(request.url) }),
      delete: async (name: string) => { deleted = name; return true }
    }
    const page = bootApp('#/share', imageConversation(true), { globals: { ...bitmaps(1080, 2400), caches }, phoneState })
    await settleAll()
    expect(deleted).toBe('conductor-phone-share')
    expect(page.app.textContent).toContain('Share to Conductor')
    expect(thumbs(page)).toHaveLength(1)
    page.app.find(node => node.tagName === 'BUTTON' && node.className.includes('share-session'))!.click()
    page.advance(0)
    await settleAll()
    expect(page.window.location.hash).toBe('#/session/s1')
    expect(thumbs(page)).toHaveLength(1)
    const composer = page.app.find(node => node.tagName === 'TEXTAREA' && node.className.includes('composer-input'))!
    expect(composer.value).toBe('Look at this')
    page.app.querySelector('composer-send')!.click()
    await settleAll()
    const message = page.posts().find(call => call.path === '/api/sessions/s1/message')!
    expect(message.body.attachments).toHaveLength(1)
    expect(message.body.attachments[0].name).toBe('Screenshot 2026.png')
  })
})

/* A scripted SpeechRecognition: the test says what was heard and when the browser ends. */
class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ''
  continuous = false
  interimResults = false
  started = false
  aborted = false
  stopped = false
  onresult: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  onend: (() => void) | null = null
  constructor() { FakeRecognition.last = this }
  start() { this.started = true }
  stop() { this.stopped = true }
  abort() { this.aborted = true }
  hear(parts: Array<[string, boolean]>) {
    const results = parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }))
    this.onresult?.({ resultIndex: 0, results })
  }
}

describe('phone composer dictation', () => {
  const composer = (page: ReturnType<typeof bootApp>) => page.app.find(node => node.tagName === 'TEXTAREA' && node.className.includes('composer-input'))!
  const mic = (page: ReturnType<typeof bootApp>) => page.app.querySelector('composer-mic')!

  it('writes what is heard into the composer after the typed text, then sends it', async () => {
    FakeRecognition.last = null
    const page = bootApp('#/session/s1', conversationAnswer([]), { globals: { webkitSpeechRecognition: FakeRecognition } })
    await settleAll()
    composer(page).typeText('Please')
    expect(mic(page).getAttribute('aria-label')).toBe('Dictate')
    mic(page).click()
    const recognition = FakeRecognition.last!
    expect(recognition.started).toBe(true)
    expect(recognition.continuous).toBe(true)
    expect(recognition.interimResults).toBe(true)
    expect(mic(page).classList.contains('listening')).toBe(true)
    expect(mic(page).getAttribute('aria-pressed')).toBe('true')
    recognition.hear([['fix the', false]])
    expect(composer(page).value).toBe('Please fix the')
    /* Each event carries the whole utterance; nothing is appended twice. */
    recognition.hear([['fix the', true], [' build', false]])
    expect(composer(page).value).toBe('Please fix the build')
    expect((page.app.querySelector('composer-send') as any).disabled).toBe(false)

    page.app.querySelector('composer-send')!.click()
    expect(recognition.aborted).toBe(true)
    expect(mic(page).classList.contains('listening')).toBe(false)
    /* A result that was already in flight does not refill the sent composer. */
    recognition.hear([['fix the build please', true]])
    await settleAll()
    expect(page.posts().find(call => call.path === '/api/sessions/s1/message')!.body.text).toBe('Please fix the build')
    expect(composer(page).value).toBe('')
  })

  it('stops on a second tap and keeps the last words', async () => {
    const page = bootApp('#/session/s1', conversationAnswer([]), { globals: { SpeechRecognition: FakeRecognition } })
    await settleAll()
    mic(page).click()
    const recognition = FakeRecognition.last!
    mic(page).click()
    expect(recognition.stopped).toBe(true)
    recognition.hear([['last words', true]])
    recognition.onend!()
    expect(composer(page).value).toBe('last words')
    expect(mic(page).getAttribute('aria-pressed')).toBe('false')
  })

  it('says the microphone is blocked instead of failing silently', async () => {
    const page = bootApp('#/session/s1', conversationAnswer([]), { globals: { webkitSpeechRecognition: FakeRecognition } })
    await settleAll()
    mic(page).click()
    FakeRecognition.last!.onerror!({ error: 'not-allowed' })
    FakeRecognition.last!.onend!()
    expect(page.toasts.textContent).toContain('Microphone is off for this page')
  })

  it('keeps one composer row and shows the keyboard fallback only after an attempt fails', async () => {
    const page = bootApp('#/session/s1', conversationAnswer([]), { globals: { webkitSpeechRecognition: FakeRecognition } })
    await settleAll()
    const row = page.app.querySelector('composer')!
    expect(row.children.map(node => node.className.split(' ')[0])).toEqual(['composer-attach', 'composer-input', 'composer-mic', 'composer-stop', 'composer-send'])
    const status = page.app.querySelector('dictation-status')!
    /* Nothing under the composer until the mic is used. */
    expect(status.hidden).toBe(true)
    mic(page).click()
    expect(status.hidden).toBe(false)
    expect(status.textContent).toContain('Starting dictation')
    expect(page.app.querySelector('dictation-keyboard')!.hidden).toBe(true)
    FakeRecognition.last!.hear([['done', true]])
    mic(page).click()
    FakeRecognition.last!.onend!()
    /* A dictation that simply finished leaves its words and no note. */
    expect(composer(page).value).toBe('done')
    expect(status.hidden).toBe(true)
    mic(page).click()
    FakeRecognition.last!.onerror!({ error: 'network' })
    expect(status.hidden).toBe(false)
    expect(status.classList.contains('error')).toBe(true)
    expect(status.textContent).toContain('Speech service connection failed')
    expect(page.app.querySelector('dictation-keyboard')!.hidden).toBe(false)
    page.app.querySelector('dictation-dismiss')!.click()
    expect(status.hidden).toBe(true)
    expect(composer(page).value).toBe('done')
  })

  it('without speech recognition the button is dimmed and points at the keyboard microphone', async () => {
    const page = bootApp('#/session/s1', conversationAnswer([]))
    await settleAll()
    expect(mic(page).classList.contains('unsupported')).toBe(true)
    expect(mic(page).getAttribute('aria-label')).toBe('Dictation is not available in this browser')
    mic(page).click()
    expect(page.toasts.textContent).toContain('Dictation is not available here')
    expect(page.toasts.textContent).toContain('microphone key')
    /* The note is about this screen: tapping it does not navigate away. */
    page.toasts.children[0]!.click()
    expect(page.window.location.hash).toBe('#/session/s1')
  })
})
