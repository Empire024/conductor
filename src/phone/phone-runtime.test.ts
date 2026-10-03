import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Run the actual unbundled runtime; avoid boot/navigation so failures here isolate the phone
// connection/composer contract. No provider, microphone, desktop window or mutation is used.
class Node {
  className = ''; value = ''; text = ''; hidden = false; disabled = false
  selectionStart = 0; selectionEnd = 0; scrollHeight = 20; scrollTop = 0; clientHeight = 20
  rows = 1; children: Node[] = []; parentNode: Node | null = null
  style: Record<string, unknown> = {}; dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}; listeners: Record<string, Array<() => void>> = {}
  constructor(public tagName = 'DIV') {}
  get firstChild(): Node | null { return this.children[0] ?? null }
  get childNodes() { return this.children }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(' ') }
  set textContent(value: string) { this.text = String(value); this.children = [] }
  get classList() {
    const toggle = (name: string, enabled = !this.className.split(' ').includes(name)) => {
      this.className = this.className.split(' ').filter(word => word !== name).concat(enabled ? [name] : []).join(' ')
    }
    return { toggle, add: (name: string) => toggle(name, true), remove: (name: string) => toggle(name, false), contains: (name: string) => this.className.split(' ').includes(name) }
  }
  appendChild(node: Node) { node.parentNode = this; this.children.push(node); return node }
  insertBefore(node: Node, before: Node | null) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; const index = before ? this.children.indexOf(before) : -1; if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); return node }
  removeChild(node: Node) { this.children = this.children.filter(child => child !== node); node.parentNode = null }
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  getAttribute(name: string) { return this.attributes[name] }
  addEventListener(name: string, fn: () => void) { (this.listeners[name] ??= []).push(fn) }
  removeEventListener() {}
  click() { for (const fn of this.listeners.click ?? []) fn() }
  focus() {}
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end }
  all(): Node[] { return [this, ...this.children.flatMap(node => node.all())] }
  querySelectorAll(selector: string) { return this.all().filter(node => node.className.split(' ').includes(selector.replace(/^\./, ''))) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
}

const settle = async () => { for (let n = 0; n < 16; n++) await Promise.resolve() }
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const summary = { id: 's1', title: 'Work', phase: 'running', state: 'working', provider: 'claude', projectName: 'Project', machineName: 'MAIN' }
const conversation = (extra = {}) => ({ summary, items: [], pending: [], queued: [], sequence: 1, canSteer: true, canAttachImages: false, ...extra })

const runtime = (options: { recognition?: unknown; secure?: boolean; fetch?: typeof fetch } = {}) => {
  const storage = new Map<string, string>(); const timers = new Map<number, () => void>(); let nextTimer = 0
  const setTimer = (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id }
  const document = { createElement: (tag: string) => new Node(tag.toUpperCase()), createElementNS: (_: string, tag: string) => new Node(tag), createTextNode: (text: string) => { const node = new Node(); node.textContent = text; return node }, visibilityState: 'visible' }
  const window: any = { __runtimeOnly: true, document, location: { origin: 'https://phone.test', hash: '#/session/s1' }, navigator: { language: 'en-US', onLine: true }, isSecureContext: options.secure ?? true,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, SpeechRecognition: options.recognition }
  const exposed = `window.runtime = { state, api, dictationButton, stopDictation, markLocked, handleUnauthorized, checkLock, onStreamEvent, applyLockStatus, cachePhoneState, restorePhoneState, refreshPhoneState, refreshRuntime, loadConversation, reconcileMessages, applyTheme,
    startConversation: id => { screen = conversationScreen(id); return screen; },
    setToasts: host => { toastHost = host; },
  };`
  let source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
  source = source.replace('const render = () => {', 'const render = () => { if (window.__runtimeOnly) { if (screen && screen.update) screen.update(); return }')
  source = source.replace(/  if \(document.readyState === 'loading'\)[\s\S]*?\n\}\)\(\)\s*$/, exposed + '\n})()')
  const network = options.fetch ?? (async () => new Response(JSON.stringify(conversation()))) as typeof fetch
  runInNewContext(source, { window, document, navigator: window.navigator, fetch: network, setTimeout: setTimer, clearTimeout: (id: number) => timers.delete(id), setInterval: () => 0, clearInterval: () => {}, AbortController, TextDecoder, Response, URL, Blob, Date })
  const toast = new Node(); window.runtime.setToasts(toast)
  window.runtime.state.token = 'paired'
  window.runtime.state.authReady = true
  return { ...window.runtime, window, toast, storage, timers }
}

class Recognizer {
  static last: Recognizer
  start = vi.fn(); stop = vi.fn(); abort = vi.fn()
  onresult?: (event: unknown) => void; onerror?: (event: unknown) => void; onend?: () => void; onstart?: () => void
  constructor() { Recognizer.last = this }
  hear(words: Array<[string, boolean]>) { this.onresult?.({ results: words.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) }) }
}

describe('phone dictation failure and lifecycle contract', () => {
  it('catches constructor failures and keeps keyboard entry available', () => {
    const app = runtime({ recognition: class { constructor() { throw new Error('service unavailable') } } })
    const input = new Node('TEXTAREA'); input.value = 'Keep draft'
    const mic = app.dictationButton(input, () => {})
    expect(() => mic.node.click()).not.toThrow()
    expect(input.value).toBe('Keep draft')
    expect(app.toast.textContent).toMatch(/keyboard/i)
  })
  it('does not start recognition from an insecure page', () => {
    const app = runtime({ recognition: Recognizer, secure: false }); const mic = app.dictationButton(new Node(), () => {})
    mic.node.click()
    expect(app.toast.textContent).toMatch(/secure|https/i)
    expect(app.toast.textContent).toMatch(/keyboard/i)
  })
  it('catches a start permission exception and resets the listening state', () => {
    class Denied extends Recognizer { start = vi.fn(() => { const error = new Error('permission denied'); error.name = 'NotAllowedError'; throw error }) }
    const app = runtime({ recognition: Denied }); const mic = app.dictationButton(new Node(), () => {})
    expect(() => mic.node.click()).not.toThrow()
    expect(mic.node.getAttribute('aria-pressed')).toBe('false')
    expect(app.toast.textContent).toContain('Microphone is off')
  })
  it('starts within the mic tap and preserves interim/final text without duplication', () => {
    const app = runtime({ recognition: Recognizer }); const input = new Node(); input.value = 'Before after'; input.selectionStart = 6
    const mic = app.dictationButton(input, () => {})
    mic.node.click(); expect(Recognizer.last.start).toHaveBeenCalledTimes(1)
    Recognizer.last.hear([['hello', false]]); Recognizer.last.hear([['hello', true], [' world', false]])
    expect(input.value).toBe('Before hello world after')
    mic.stop(); Recognizer.last.hear([['late words', true]])
    expect(input.value).toBe('Before hello world after')
    expect(Recognizer.last.abort).toHaveBeenCalledTimes(1)
  })
  it.each(['not-allowed', 'audio-capture', 'network', 'service-not-allowed'])('explains %s and releases the mic immediately', code => {
    const app = runtime({ recognition: Recognizer }); const mic = app.dictationButton(new Node(), () => {})
    mic.node.click(); Recognizer.last.onerror?.({ error: code })
    expect(mic.node.getAttribute('aria-pressed')).toBe('false')
    expect(app.toast.textContent).toMatch(/keyboard/i)
    if (code === 'network') expect(app.toast.textContent).toMatch(/network|connection/i)
    if (code === 'service-not-allowed') expect(app.toast.textContent).toMatch(/service/i)
  })
})

describe('phone send and Stop independence', () => {
  it('shows Sending immediately and can stop while message POST is unresolved', async () => {
    const sending = deferred<Response>(); const calls: string[] = []
    const app = runtime({ fetch: (async (path: string) => {
      calls.push(path)
      if (path.endsWith('/message')) return sending.promise
      return new Response(JSON.stringify(path.endsWith('/interrupt') ? { phase: 'interrupting', held: 0 } : conversation()))
    }) as typeof fetch })
    const view = app.startConversation('s1'); await settle()
    const input = view.root.querySelector('.composer-input')!; input.value = 'Immediate message'; input.listeners.input?.forEach((fn: () => void) => fn())
    view.root.querySelector('.composer-send')!.click(); await settle()
    expect(view.root.textContent).toContain('Sending')
    const stop = view.root.querySelector('.composer-stop')!
    expect(stop.disabled).toBe(false); stop.click(); await settle()
    expect(calls.filter(path => path.endsWith('/interrupt'))).toHaveLength(1)
    expect(calls.filter(path => path.endsWith('/message'))).toHaveLength(1)
    sending.resolve(new Response(JSON.stringify({ mode: 'steer', phase: 'running' }))); await settle()
  })
  it('keeps an ambiguous failed message draft and never automatically resends', async () => {
    const calls: string[] = []
    const app = runtime({ fetch: (async (path: string) => { calls.push(path); if (path.endsWith('/message')) throw new TypeError('network lost'); return new Response(JSON.stringify(conversation())) }) as typeof fetch })
    const view = app.startConversation('s1'); await settle()
    const input = view.root.querySelector('.composer-input')!; input.value = 'Keep this'; input.listeners.input?.forEach((fn: () => void) => fn())
    view.root.querySelector('.composer-send')!.click(); await settle()
    expect(input.value).toBe('Keep this'); expect(view.root.textContent).toContain('Check status')
    expect(calls.filter(path => path.endsWith('/message'))).toHaveLength(1)
  })
  it('Stop remains pending until a later authoritative inactive phase', async () => {
    let current = conversation(); const app = runtime({ fetch: (async (path: string) => new Response(JSON.stringify(path.endsWith('/interrupt') ? { phase: 'interrupting', held: 2 } : current))) as typeof fetch })
    const view = app.startConversation('s1'); await settle()
    view.root.querySelector('.composer-stop')!.click(); await settle()
    expect(app.state.stops.s1.status).toBe('pending')
    expect(view.root.textContent).toContain('Stopping')
    current = conversation({ sequence: 2, summary: { ...summary, phase: 'interrupted' } })
    await app.loadConversation('s1', true)
    expect(app.state.stops.s1.status).toBe('confirmed'); expect(view.root.textContent).toContain('2 submitted messages are held')
  })
  it('a read-only Check status action resolves an ambiguous send without a second POST', async () => {
    let current = conversation(); let posts = 0
    const app = runtime({ fetch: (async (path: string) => { if (path.endsWith('/message')) { posts++; throw new TypeError('lost reply') } return new Response(JSON.stringify(current)) }) as typeof fetch })
    const view = app.startConversation('s1'); await settle()
    const input = view.root.querySelector('.composer-input')!; input.value = 'Confirm me'; input.listeners.input?.forEach((fn: () => void) => fn())
    view.root.querySelector('.composer-send')!.click(); await settle()
    current = conversation({ sequence: 2, inputDeliveries: [{ id: 'receipt', text: 'Confirm me', status: 'accepted', sequence: 2 }] })
    view.root.querySelector('.composer-send')!.click(); await settle()
    expect(posts).toBe(1); expect(input.value).toBe(''); expect(view.root.textContent).toContain('Steered')
  })
})

describe('phone authoritative delivery reconciliation', () => {
  const row = (extra = {}) => ({ id: 'local-1', text: 'Same words', status: 'sent', mode: 'submit', baseline: 10, baselineIds: ['older-input'], images: [], ambiguous: false, acknowledged: false, ...extra })
  it('rejects old receipts and same-text receipts already present before sending', () => {
    const app = runtime(); const message = row({ mode: 'steer' }); app.state.messages.s1 = [message]
    app.reconcileMessages('s1', conversation({ inputDeliveries: [{ id: 'older-input', text: 'Same words', status: 'delivered', sequence: 30 }, { id: 'old', text: 'Same words', status: 'delivered', sequence: 9 }] }))
    expect(message.status).toBe('sent')
  })
  it('keeps accepted steering at Steered until a matching authoritative delivered receipt', () => {
    const app = runtime(); const message: any = row({ mode: 'steer' }); app.state.messages.s1 = [message]
    app.reconcileMessages('s1', conversation({ inputDeliveries: [{ id: 'new-input', text: 'Same words', status: 'accepted', sequence: 11 }] }))
    expect(message.status).toBe('steered'); expect(message.receiptId).toBe('new-input')
    app.reconcileMessages('s1', conversation({ inputDeliveries: [{ id: 'new-input', text: '', status: 'delivered', sequence: 12 }] }))
    expect(message.status).toBe('delivered')
  })
  it('does not associate two ambiguous same-text acknowledgements', () => {
    const app = runtime(); const message = row({ ambiguous: true, mode: 'steer', status: 'uncertain' }); app.state.messages.s1 = [message]
    app.reconcileMessages('s1', conversation({ inputDeliveries: ['one', 'two'].map(id => ({ id, text: 'Same words', status: 'accepted', sequence: 11 })) }))
    expect(message.status).toBe('uncertain'); expect(message.ambiguous).toBe(true)
  })
  it('a new submitted user item delivers once, without regressing on a held queue receipt', () => {
    const app = runtime(); const message = row({ mode: 'queue' }); app.state.messages.s1 = [message]
    const data = conversation({ items: [{ id: 'user-1', sequence: 11, data: { type: 'text', role: 'user', text: 'Same words' } }], inputDeliveries: [{ id: 'new-input', text: 'Same words', status: 'queued', sequence: 11 }] })
    app.reconcileMessages('s1', data); expect(message.status).toBe('delivered')
    app.reconcileMessages('s1', data); expect(message.status).toBe('delivered')
  })
})

describe('phone cache and read security', () => {
  const key = 'conductor.phone.lastState'
  const phone = { projects: [{ name: 'Private project' }], sessions: [], machineName: 'MAIN' }
  it('does not restore before current auth/lock validation or persist an unlocked configured lock', () => {
    const app = runtime(); app.state.authReady = false
    app.storage.set(key, JSON.stringify({ token: 'paired', at: Date.now(), phone }))
    app.restorePhoneState(); expect(app.state.phone).toBeNull()
    app.state.authReady = true; app.state.lock = { configured: true, unlocked: true }; app.state.unlockToken = 'memory-only'; app.state.phone = phone
    app.cachePhoneState(); expect(app.storage.get(key)).not.toContain('memory-only')
    app.applyLockStatus({ configured: true, unlocked: false }); expect(app.state.phone).toBeNull(); expect(app.storage.has(key)).toBe(false)
  })
  it('restores only a matching cache after server confirms no configured lock, then clears it on 401', () => {
    const app = runtime(); app.state.authReady = false
    app.storage.set(key, JSON.stringify({ token: 'paired', at: Date.now(), phone }))
    app.applyLockStatus({ configured: false, unlocked: false })
    expect(app.state.phone.machineName).toBe('MAIN'); expect(app.state.stale).toBe(true)
    app.handleUnauthorized(); expect(app.storage.has(key)).toBe(false); expect(app.state.phone).toBeNull()
  })
  it('a late read from before lock cannot put sensitive data back after locking', async () => {
    const pending = deferred<Response>(); const app = runtime({ fetch: (() => pending.promise) as typeof fetch })
    const read = app.api('/api/state').catch((error: Error) => error)
    app.markLocked(); pending.resolve(new Response(JSON.stringify(phone)))
    expect((await read).name).toBe('AbortError'); expect(app.state.phone).toBeNull()
  })
  it('a GET started before an SSE state cannot overwrite the more recent stream state', async () => {
    const pending = deferred<Response>(); const app = runtime({ fetch: (() => pending.promise) as typeof fetch })
    const reading = app.refreshPhoneState()
    app.onStreamEvent('state', { ...phone, machineName: 'New stream state' })
    pending.resolve(new Response(JSON.stringify({ ...phone, machineName: 'Old GET' })))
    await reading; expect(app.state.phone.machineName).toBe('New stream state')
  })
})

describe('phone service worker bounded shell fallback', () => {
  it('uses cached shell when a static request stalls; API POST remains outside the worker', async () => {
    const handlers: Record<string, (event: any) => void> = {}; let timer!: () => void
    const cached = new Response('safe static shell')
    runInNewContext(readFileSync(new URL('./sw.js', import.meta.url), 'utf8'), {
      self: { location: { origin: 'https://phone.test' }, addEventListener: (name: string, fn: any) => { handlers[name] = fn } },
      caches: { match: async () => cached }, fetch: (_: unknown, init: any) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')))),
      AbortController, setTimeout: (fn: () => void) => { timer = fn }, clearTimeout: () => {}, Response, URL
    })
    let answer!: Promise<Response>
    handlers.fetch!({ request: { url: 'https://phone.test/app.js', method: 'GET' }, respondWith: (value: Promise<Response>) => { answer = value } })
    timer(); expect(await (await answer).text()).toBe('safe static shell')
    const intercepted = vi.fn()
    handlers.fetch!({ request: { url: 'https://phone.test/api/sessions/s1/message', method: 'POST' }, respondWith: intercepted })
    expect(intercepted).not.toHaveBeenCalled()
  })
})
