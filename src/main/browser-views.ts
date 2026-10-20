import { BrowserWindow, nativeImage, net, WebContentsView, type NativeImage, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AgentControlTab } from '../shared/agent-control'
import { browserUrl, DOWNLOADS, VIDEO_FRAMES, type BrowserMcpHost, type BrowserMcpScope, type BrowserView, type DownloadRequest, type DownloadResult, type VideoFramesRequest, type VideoFramesResult } from '../shared/browser-mcp'
import { CAPTURE_FOLDER, captureStamp, contentDispositionName, cropRect, planFrameTimes, projectTarget, safeFileName, uniquePath } from './browser-media'
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
const failure = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** An image with pixels. capturePage resolves an empty 0x0 image, not an error, for a view that has
 *  no compositor surface, which is what a guest hidden in its workspace window is. */
const usable = (image: NativeImage | undefined): image is NativeImage => Boolean(image && !image.isEmpty() && image.getSize().width > 0 && image.getSize().height > 0)
const CAPTURE_ADVICE = 'The page is still loaded: read it with browser_snapshot, re-open it with browser_navigate to the same URL (that reloads it and gives it a fresh surface), or call browser_present({mode:"detached"}) to show it in its own window (it does not take focus) and capture again.'
/** A download still running this long is answered "continuing in the background": the MCP client
 *  gives a tool call 60 s and would otherwise drop a call whose file is still arriving. */
const DOWNLOAD_ANSWER_MS = 45_000
const DOWNLOAD_IDLE_MS = 60_000
const DOWNLOAD_CEILING_MS = 30 * 60_000
/** Base64 characters of a recorded WAV pulled out of the page per call. */
const AUDIO_CHUNK = 2_000_000
const MEDIA_TARGET = 'globalThis[Symbol.for("conductor.mediaTarget")]'
const MEDIA_AUDIO = 'globalThis[Symbol.for("conductor.mediaAudio")]'
interface MediaFrame { time: number | null; ended?: boolean; rect?: { x: number; y: number; width: number; height: number } | null; viewport: { width: number; height: number } }
interface MediaTarget { kind: 'video' | 'element' | 'viewport'; duration?: number | null; seekable?: boolean; currentTime?: number; paused?: boolean; source?: string; readyState?: number }

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
  /** The project's folder on this machine, where captures and downloads are written; undefined for
   *  a project that has none here (a remote project). */
  projectRoot?(projectId: string): string | undefined
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
  /** Captures in progress; the guest returns from a borrowed parking host when the last one ends. */
  captures?: number
  /** The emulated page viewport the surface last asked for (Phone, Desktop, …). */
  viewport?: { width: number; height: number }
  /** The guest moved to another host window since its last capture; its next capture asks for a
   *  fresh frame first. */
  rehosted?: boolean
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

/** A DevTools Page.captureScreenshot of the guest, bounded. It attaches the debugger only when no
 *  Electron debugger client is attached already, and detaches only what it attached. */
const devtoolsScreenshot = async (contents: WebContents): Promise<{ image?: NativeImage; error?: string }> => {
  let attached = false
  try {
    if (!contents.debugger.isAttached()) { contents.debugger.attach('1.3'); attached = true }
    const reply = await Promise.race([contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }) as Promise<{ data?: string }>, settle(3000).then(() => undefined)])
    if (!reply?.data) return { error: 'no image within 3 s' }
    return { image: nativeImage.createFromBuffer(Buffer.from(reply.data, 'base64')) }
  } catch (error) { return { error: failure(error) } }
  finally { if (attached) { try { contents.debugger.detach() } catch { /* already detached */ } } }
}

/** Runs code in the guest page and returns its JSON value; an in-page throw becomes a readable error. */
const runInPage = async (guest: WebContents, code: string, gesture = false): Promise<unknown> => {
  if (guest.isDestroyed()) throw new Error('The browser view was closed')
  const raw = await guest.executeJavaScript(evaluation(code), gesture) as string
  const value = JSON.parse(typeof raw === 'string' ? raw : 'null') as unknown
  const wrapper = value && typeof value === 'object' ? value as { __conductorError?: string; __conductorTruncated?: number; value?: string } : undefined
  if (wrapper?.__conductorError) throw new Error(wrapper.__conductorError)
  if (wrapper?.__conductorTruncated) throw new Error(`The page returned ${wrapper.__conductorTruncated} characters, over the ${MAX_VALUE_CHARS} character limit. Return less: slice the value, or count it in the page instead of returning it.`)
  return value
}

/** Picks the media target (the selector's element, its <video>, or the page's largest video,
 *  playing ones first), keeps it on the page for the following steps and scrolls it into view. */
const locateMedia = (selector: string | undefined): string => `
  const selector = ${JSON.stringify(selector ?? '')}
  let element = selector ? document.querySelector(selector) : null
  if (selector && !element) throw new Error('No element matches ' + selector)
  const area = node => { const box = node.getBoundingClientRect(); return box.width * box.height }
  if (!selector) element = Array.from(document.querySelectorAll('video')).sort((a, b) => (Number(!b.paused) - Number(!a.paused)) || area(b) - area(a))[0] || null
  const video = element && (element.tagName === 'VIDEO' ? element : element.querySelector('video'))
  const target = video || element
  ${MEDIA_TARGET} = target || null
  if (target) target.scrollIntoView({ block: 'center', inline: 'center' })
  if (video && video.readyState < 1) {
    if (video.preload === 'none') video.preload = 'metadata'
    await new Promise(resolve => { const done = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', done); resolve() }; const timer = setTimeout(done, 8000); video.addEventListener('loadedmetadata', done) })
  }
  if (!video) return { kind: element ? 'element' : 'viewport' }
  return { kind: 'video', duration: Number.isFinite(video.duration) ? video.duration : null, seekable: video.seekable.length > 0 && Number.isFinite(video.duration), currentTime: video.currentTime, paused: video.paused, source: String(video.currentSrc || video.src || '').slice(0, 2000), readyState: video.readyState }`

/** Where the target is now, in CSS pixels, with its media time when it is a video. A wait that
 *  depends on a painted frame is bounded: a page without frames must not hang the capture. */
const MEDIA_FRAME = `
  const target = ${MEDIA_TARGET}
  if (target && !target.isConnected) throw new Error('The captured element left the page')
  await Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 250))])
  const box = target ? target.getBoundingClientRect() : null
  return { time: target && target.tagName === 'VIDEO' ? target.currentTime : null, ended: Boolean(target && target.ended), rect: box && { x: box.x, y: box.y, width: box.width, height: box.height }, viewport: { width: innerWidth, height: innerHeight } }`

const seekMedia = (time: number): string => `
  const video = ${MEDIA_TARGET}
  if (!video || !video.isConnected) throw new Error('The video left the page while it was being captured')
  video.pause()
  const time = ${JSON.stringify(time)}
  if (Math.abs(video.currentTime - time) > 0.0005) {
    const painted = new Promise(resolve => { if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => resolve(true)); setTimeout(() => resolve(false), 1500) })
    await new Promise(resolve => { const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve() }; const timer = setTimeout(done, 8000); video.addEventListener('seeked', done); video.currentTime = time })
    await painted
  }
  ${MEDIA_FRAME}`

/** Starts real-time playback from start (when given) and, with audio, records the element's sound
 *  through captureStream into PCM kept on the page. Cross-origin media the page may not read comes
 *  back refused or silent; either is reported, never padded into a WAV. */
const playMedia = (start: number | undefined, audio: boolean): string => `
  const video = ${MEDIA_TARGET}
  if (!video || !video.isConnected) throw new Error('The video left the page before it could play')
  const state = { left: [], right: [], frames: 0, done: false, muted: video.muted, volume: video.volume }
  ${MEDIA_AUDIO} = state
  const start = ${JSON.stringify(start ?? null)}
  if (start !== null && Math.abs(video.currentTime - start) > 0.0005) await new Promise(resolve => { const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve() }; const timer = setTimeout(done, 8000); video.addEventListener('seeked', done); video.currentTime = start })
  let stream = null
  if (${audio ? 'true' : 'false'}) {
    try { stream = video.captureStream ? video.captureStream() : null; if (!stream) state.error = 'this browser cannot capture a video element' }
    catch (error) { state.error = 'the page does not allow its video sound to be captured (' + ((error && error.message) || error) + ')' }
    video.muted = false
    if (video.volume === 0) video.volume = 1
  }
  try { await video.play() } catch (error) { throw new Error('The video would not play: ' + ((error && error.message) || error)) }
  if (stream && !state.error) {
    const until = Date.now() + 2000
    while (!stream.getAudioTracks().length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
    if (!stream.getAudioTracks().length) state.error = 'the video has no audio track'
    else {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
      const processor = context.createScriptProcessor(4096, 2, 2)
      processor.onaudioprocess = event => {
        if (state.done) return
        const input = event.inputBuffer
        state.left.push(new Float32Array(input.getChannelData(0)))
        state.right.push(new Float32Array(input.numberOfChannels > 1 ? input.getChannelData(1) : input.getChannelData(0)))
        state.frames += input.length
      }
      source.connect(processor); processor.connect(context.destination)
      Object.assign(state, { context, nodes: [source, processor], sampleRate: context.sampleRate })
      if (context.state !== 'running') await context.resume().catch(() => {})
    }
  }
  return { time: video.currentTime }`

/** Stops playback and recording and encodes the recording as 16-bit PCM WAV, base64, kept on the
 *  page for chunked reads (one evaluation result is capped well below a WAV's size). */
const STOP_MEDIA = `
  const video = ${MEDIA_TARGET}, state = ${MEDIA_AUDIO}
  if (video) video.pause()
  if (!state) return { error: 'the recording was lost: the page navigated while it played' }
  state.done = true
  try { for (const node of state.nodes || []) node.disconnect() } catch {}
  try { if (state.context) await state.context.close() } catch {}
  if (video) { video.muted = state.muted; video.volume = state.volume }
  if (state.error) return { error: state.error }
  if (!state.sampleRate) return { none: true }
  if (!state.frames) return { error: 'no audio arrived while the video played' }
  const rate = state.sampleRate, frames = state.frames, pcm = new Int16Array(frames * 2)
  let peak = 0, offset = 0
  for (let chunk = 0; chunk < state.left.length; chunk++) {
    const left = state.left[chunk], right = state.right[chunk]
    for (let index = 0; index < left.length; index++) {
      const a = Math.max(-1, Math.min(1, left[index])), b = Math.max(-1, Math.min(1, right[index]))
      peak = Math.max(peak, Math.abs(a), Math.abs(b))
      pcm[offset++] = a < 0 ? a * 0x8000 : a * 0x7fff
      pcm[offset++] = b < 0 ? b * 0x8000 : b * 0x7fff
    }
  }
  state.left = state.right = null
  if (peak === 0) return { error: 'the recorded audio is pure silence: either the clip is silent there, or it is cross-origin media the page may not read (no CORS), which the browser mutes for page scripts' }
  const bytes = new Uint8Array(44 + pcm.byteLength), view = new DataView(bytes.buffer)
  const ascii = (at, text) => { for (let index = 0; index < text.length; index++) bytes[at + index] = text.charCodeAt(index) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, rate, true)
  view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, pcm.byteLength, true)
  bytes.set(new Uint8Array(pcm.buffer), 44)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000))
  state.base64 = btoa(binary)
  return { length: state.base64.length, seconds: frames / rate, sampleRate: rate }`

/** The source of the page's <video>: currentSrc, else src, else its first <source>. */
const videoSource = (selector: string | undefined): string => `
  const selector = ${JSON.stringify(selector ?? '')}
  let element = selector ? document.querySelector(selector) : null
  if (selector && !element) throw new Error('No element matches ' + selector)
  const area = node => { const box = node.getBoundingClientRect(); return box.width * box.height }
  if (!selector) element = Array.from(document.querySelectorAll('video')).sort((a, b) => (Number(!b.paused) - Number(!a.paused)) || area(b) - area(a))[0] || null
  const video = element && (element.tagName === 'VIDEO' ? element : element.querySelector('video'))
  if (!video) throw new Error(selector ? selector + ' is not a <video> and contains none' : 'The page has no <video> element')
  const source = video.querySelector('source[src]')
  return { source: String(video.currentSrc || video.src || (source && source.src) || '') }`

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
      owned.rehosted = true
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
    this.attachTo(owned, this.parkingWindow(owned), true)
    owned.view.setBounds(BACKGROUND_VIEWPORT)
    owned.view.setVisible(true)
  }

  private parkingWindow(owned: OwnedBrowser): BrowserWindow {
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
    return parking
  }

  /** Whether the guest is on screen in a real presentation, so capturePage reads what the owner sees. */
  private shownInPlace(owned: OwnedBrowser): boolean {
    const host = owned.parent
    if (!host || host.isDestroyed() || host === owned.parking || !host.isVisible() || host.isMinimized()) return false
    if (owned.presentation === 'detached') return host === owned.detached
    return owned.presentation !== 'background' && host === owned.surface?.window && Boolean(owned.surface?.visible)
  }

  /** The size the page is laid out at in its current presentation, so a capture never reflows it. */
  private layoutSize(owned: OwnedBrowser): { width: number; height: number } {
    const detached = owned.presentation === 'detached' && owned.detached && !owned.detached.isDestroyed() ? owned.detached.getContentBounds() : undefined
    const bounds = detached ?? owned.surface?.bounds
    return bounds && bounds.width > 0 && bounds.height > 0 ? { width: bounds.width, height: bounds.height } : { width: BACKGROUND_VIEWPORT.width, height: BACKGROUND_VIEWPORT.height }
  }

  /** A guest hidden in its workspace window (background presentation, or a pane the owner is not
   *  looking at) has no compositor surface: capturePage hands back an empty 0x0 image for it. For
   *  the capture it borrows its hidden, non-focusable, off-desktop parking host, at the size it is
   *  laid out at, so nothing is ever shown over the owner's screen. */
  private borrowParking(owned: OwnedBrowser): void {
    // An emulated viewport (a pane shows Desktop 1440x900 scaled into its width) is captured at its
    // own size and scale 1: the page keeps its layout and the agent gets legible pixels.
    const size = owned.viewport ?? this.layoutSize(owned)
    const parking = this.parkingWindow(owned)
    parking.setContentSize(size.width, size.height)
    this.attachTo(owned, parking, true)
    owned.view.setBounds({ x: 0, y: 0, ...size })
    owned.view.setVisible(true)
    if (owned.viewport) owned.view.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: size, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, viewSize: size, scale: 1 })
  }

  /** Puts a borrowed guest back where its presentation keeps it, unless something (the owner
   *  opening the pane, a presentation change) has already moved it. */
  private returnFromParking(owned: OwnedBrowser): void {
    if (owned.view.webContents.isDestroyed() || !owned.parking || owned.parent !== owned.parking) return
    if (owned.presentation === 'detached' && owned.detached && !owned.detached.isDestroyed()) this.attachTo(owned, owned.detached, true)
    else if (owned.surface && !owned.surface.window.isDestroyed()) this.attachTo(owned, owned.surface.window, owned.presentation !== 'background' && owned.surface.visible)
    else {
      // A browser that lives parked stays parked, at the background viewport.
      owned.parking.setContentSize(BACKGROUND_VIEWPORT.width, BACKGROUND_VIEWPORT.height)
      owned.view.setBounds(BACKGROUND_VIEWPORT)
      this.emulateViewport(owned, owned.viewport, BACKGROUND_VIEWPORT)
      return
    }
    this.layout(owned)
    this.emulateViewport(owned, owned.viewport, owned.view.getBounds())
  }

  /** Runs work with a grab() that always returns pixels or throws saying why. A visible guest is
   *  captured where it is; any other is captured from its parking host for the whole of the work. */
  /** Resolves after the guest has had the chance to paint twice, or after 500 ms (a page that paints
   *  no frames must not hang a capture). */
  private async painted(contents: WebContents): Promise<void> {
    await Promise.race([contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))').catch(() => undefined), settle(500)])
  }

  /** Asks the compositor for a new frame of the guest without touching the page's state: a 1px
   *  resize round trip allocates a new surface, as a navigation does, and invalidate repaints it. */
  private async freshFrame(owned: OwnedBrowser): Promise<void> {
    const contents = owned.view.webContents
    if (contents.isDestroyed()) return
    const bounds = owned.view.getBounds()
    if (bounds.width > 1) {
      owned.view.setBounds({ ...bounds, width: bounds.width - 1 })
      await this.painted(contents)
      owned.view.setBounds(bounds)
    }
    contents.invalidate()
    await this.painted(contents)
  }

  /** Runs work with a grab() that always returns pixels or throws saying why. A visible guest is
   *  captured where it is; any other is captured from its parking host for the whole of the work.
   *
   *  Two states give a hidden guest no capturable surface (docs/browser-mcp.md): a guest never
   *  painted in a shown window, where capturePage refuses until a DevTools screenshot makes the
   *  renderer produce one, and the first capture after it left a shown window (detached, then
   *  background), where even the DevTools screenshot answered "Internal error" until the page was
   *  navigated. So the first capture after any move asks for a fresh frame, and a failed capture
   *  escalates: DevTools screenshot, fresh frame, a brand-new capture host, each retried, and the
   *  error names what every step returned. */
  private async withCapture<T>(owned: OwnedBrowser, work: (grab: () => Promise<NativeImage>) => Promise<T>): Promise<T> {
    const contents = owned.view.webContents
    owned.captures = (owned.captures ?? 0) + 1
    let borrowed = false
    const borrow = async (): Promise<void> => { this.borrowParking(owned); borrowed = true; await this.painted(contents) }
    const refreshIfMoved = async (): Promise<void> => { if (owned.rehosted) { owned.rehosted = false; await this.freshFrame(owned) } }
    const grab = async (): Promise<NativeImage> => {
      if (contents.isDestroyed()) throw new Error('The browser view was closed')
      const attempts: string[] = []
      const capture = async (): Promise<NativeImage | string> => {
        try { const image = await contents.capturePage(); return usable(image) ? image : 'empty image' }
        catch (error) { return failure(error) }
      }
      if (this.shownInPlace(owned)) {
        await refreshIfMoved()
        const image = await capture()
        if (typeof image !== 'string') return image
        attempts.push(`visible view: ${image}`)
      }
      if (owned.parent !== owned.parking || !owned.parking || owned.parking.isDestroyed()) await borrow()
      await refreshIfMoved()
      const first = await capture()
      if (typeof first !== 'string') return first
      attempts.push(`off-screen capture host: ${first}`)
      const steps: Array<[string, () => Promise<void>]> = [
        ['with a DevTools screenshot', async () => {}],
        ['after a fresh frame', () => this.freshFrame(owned)],
        ['in a new capture host', async () => { this.unparent(owned); this.closeParking(owned); await borrow(); await this.freshFrame(owned) }]
      ]
      for (const [label, prepare] of steps) {
        await prepare()
        if (contents.isDestroyed()) throw new Error('The browser view was closed')
        const primed = await devtoolsScreenshot(contents)
        const image = await capture()
        if (typeof image !== 'string') return image
        if (primed.image && usable(primed.image)) return primed.image
        attempts.push(`${label}: capturePage ${image}, DevTools ${primed.error ?? 'empty image'}`)
      }
      throw new Error(`Conductor could not capture the browser view (${attempts.join('; ')}). ${CAPTURE_ADVICE}`)
    }
    try {
      if (!this.shownInPlace(owned) && owned.parent !== owned.parking) await borrow()
      return await work(grab)
    } finally {
      owned.captures = Math.max(0, (owned.captures ?? 1) - 1)
      if (borrowed && !owned.captures) this.returnFromParking(owned)
    }
  }

  private projectRootOf(projectId: string): string {
    const root = this.deps.projectRoot?.(projectId)
    if (!root) throw new Error('This project has no folder on this machine, so the browser cannot write captures or downloads into it')
    return root
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
    owned.viewport = { width, height }
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
    return this.page(owned)
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

  /** browser_video_frames: seeks (or plays) the page's video, or films an element or the viewport,
   *  and writes each frame as a file under the project. Bounded by frames, bytes and a per-call time
   *  budget; the page's audio output stays muted throughout, and the video is put back as found. */
  private async videoFrames(owned: OwnedBrowser, request: VideoFramesRequest): Promise<VideoFramesResult> {
    const guest = owned.view.webContents
    const root = this.projectRootOf(owned.projectId)
    const deadline = Date.now() + VIDEO_FRAMES.budgetMs
    const target = await runInPage(guest, locateMedia(request.selector)) as MediaTarget
    const video = target.kind === 'video'
    if (video && !target.readyState) throw new Error('The video has not loaded anything yet (readyState 0). Start it with browser_click on its play control, or browser_evaluate("document.querySelector(\'video\').play()"), then call browser_video_frames again.')
    const seekable = video && target.seekable === true && typeof target.duration === 'number'
    if (request.mode === 'seek' && !seekable) throw new Error(video ? 'This video cannot be seeked (a live or unseekable stream); use mode "play" to capture it in real time.' : 'There is no <video> to seek; leave mode at auto to capture the element or viewport over time.')
    const mode: VideoFramesResult['mode'] = !video ? 'viewport' : request.audio || request.mode === 'play' || !seekable ? 'play' : 'seek'
    const directory = join(root, CAPTURE_FOLDER, captureStamp())
    await mkdir(directory, { recursive: true })
    const frames: VideoFramesResult['frames'] = []
    let bytes = 0, width = 0, height = 0, truncated: string | undefined
    let audio: VideoFramesResult['audio'] = request.audio && !video ? { unavailable: 'there is no <video> on the page to record' } : undefined
    const extension = request.format === 'jpeg' ? 'jpg' : 'png'
    const save = async (image: NativeImage, at: MediaFrame, time: number): Promise<boolean> => {
      let shot = image
      if (at.rect) {
        const crop = cropRect(at.rect, at.viewport, image.getSize())
        if (!crop) throw new Error(`The ${video ? 'video' : 'element'} is not inside the visible page (${Math.round(at.rect.x)},${Math.round(at.rect.y)} ${Math.round(at.rect.width)}×${Math.round(at.rect.height)} in a ${at.viewport.width}×${at.viewport.height} viewport); scroll it into view or pass a selector for a visible one.`)
        shot = image.crop(crop)
      }
      const natural = shot.getSize().width
      const wanted = Math.max(1, Math.min(VIDEO_FRAMES.maxWidth, Math.round(natural * request.scale)))
      if (wanted < natural) shot = shot.resize({ width: wanted, quality: 'good' })
      if (!usable(shot)) throw new Error(`Frame ${frames.length + 1} came out empty, so nothing more was written. ${CAPTURE_ADVICE}`)
      const data = request.format === 'jpeg' ? shot.toJPEG(85) : shot.toPNG()
      if (bytes + data.length > VIDEO_FRAMES.maxBytes) { truncated = `the ${VIDEO_FRAMES.maxBytes / 1024 / 1024} MB size cap was reached at ${time} s; use a smaller scale, jpeg, or a lower fps`; return false }
      const path = join(directory, `frame-${String(frames.length + 1).padStart(4, '0')}.${extension}`)
      await writeFile(path, data)
      bytes += data.length
      ;({ width, height } = shot.getSize())
      frames.push({ path, time: Math.round(time * 1000) / 1000 })
      return true
    }
    const muted = guest.isAudioMuted()
    guest.setAudioMuted(true)
    try {
      await this.withCapture(owned, async grab => {
        if (mode === 'seek') {
          const duration = target.duration as number
          const start = request.start ?? 0
          if (start > duration) throw new Error(`start ${start} s is past the end of the ${Math.round(duration * 1000) / 1000} s video`)
          const plan = planFrameTimes({ start, end: Math.min(request.end ?? duration, duration), fps: request.fps, maxFrames: request.maxFrames })
          truncated = plan.truncated
          for (const time of plan.times) {
            if (Date.now() > deadline) { truncated = `the ${Math.round(VIDEO_FRAMES.budgetMs / 1000)} s per-call budget ran out at ${time} s; continue with start=${time}`; break }
            const at = await runInPage(guest, seekMedia(time)) as MediaFrame
            if (!await save(await grab(), at, at.time ?? time)) break
          }
          return
        }
        // Real time: a video plays (and may record), an element or the viewport is filmed as it is.
        const began = video ? (await runInPage(guest, playMedia(request.start, request.audio), true) as { time: number }).time : 0
        const wall = Date.now()
        const end = request.end ?? (video && typeof target.duration === 'number' ? target.duration : began + request.maxFrames / request.fps)
        const limit = Math.min(end - began, VIDEO_FRAMES.maxRealtimeSeconds, (deadline - wall) / 1000 - 3)
        for (let index = 0; index < request.maxFrames; index++) {
          const due = wall + index * 1000 / request.fps
          if (due - wall > limit * 1000) break
          if (due > Date.now()) await settle(due - Date.now())
          const at = await runInPage(guest, MEDIA_FRAME) as MediaFrame
          const time = at.time ?? (Date.now() - wall) / 1000
          if (!await save(await grab(), at, time)) break
          if (at.ended) break
          if (index === request.maxFrames - 1 && time < end - 1 / request.fps) truncated = `maxFrames ${request.maxFrames} reached at ${Math.round(time * 1000) / 1000} s; continue with start=${Math.round((time + 1 / request.fps) * 1000) / 1000}`
        }
        if (!truncated && began + limit < end - 1e-3) truncated = `real-time capture is limited to ${Math.round(limit)} s per call; continue with start=${Math.round((began + limit) * 1000) / 1000}`
        if (video) audio = await this.finishPlayback(guest, directory) ?? audio
      })
    } finally {
      if (!guest.isDestroyed()) {
        guest.setAudioMuted(muted)
        if (video) await runInPage(guest, `
          const video = ${MEDIA_TARGET}, audio = ${MEDIA_AUDIO}
          if (audio && !audio.done) { audio.done = true; try { for (const node of audio.nodes || []) node.disconnect(); if (audio.context) audio.context.close() } catch {}; if (video) { video.muted = audio.muted; video.volume = audio.volume } }
          if (video && video.isConnected) {
            video.pause()
            ${seekable ? `video.currentTime = ${JSON.stringify(target.currentTime ?? 0)}` : ''}
            if (${target.paused === false ? 'true' : 'false'}) video.play().catch(() => {})
          }
          ${MEDIA_TARGET} = null; ${MEDIA_AUDIO} = null
          return true`).catch(() => undefined)
      }
    }
    if (!frames.length) throw new Error(truncated ? `No frame was written: ${truncated}` : 'No frame was written: the capture window was empty. Check start, end and fps.')
    return {
      directory, frames, width, height, mode, bytes,
      ...(video ? { video: { source: target.source ?? '', duration: typeof target.duration === 'number' ? target.duration : null } } : {}),
      ...(audio ? { audio } : {}),
      ...(truncated ? { truncated } : {})
    }
  }

  /** Stops a real-time pass and, when it recorded, writes the WAV next to the frames. */
  private async finishPlayback(guest: WebContents, directory: string): Promise<VideoFramesResult['audio']> {
    const stopped = await runInPage(guest, STOP_MEDIA) as { none?: true; error?: string; length?: number; seconds?: number; sampleRate?: number }
    if (stopped.none) return undefined
    if (stopped.error || !stopped.length) return { unavailable: stopped.error ?? 'no audio was recorded' }
    let base64 = ''
    for (let offset = 0; offset < stopped.length; offset += AUDIO_CHUNK) {
      const chunk = await guest.executeJavaScript(`(${MEDIA_AUDIO} && ${MEDIA_AUDIO}.base64 || '').slice(${offset}, ${offset + AUDIO_CHUNK})`) as unknown
      if (typeof chunk !== 'string' || !chunk) return { unavailable: 'the recording was lost while it was read from the page' }
      base64 += chunk
    }
    const path = join(directory, 'audio.wav')
    await writeFile(path, Buffer.from(base64, 'base64'))
    return { path, seconds: Math.round((stopped.seconds ?? 0) * 1000) / 1000, sampleRate: stopped.sampleRate ?? 0 }
  }

  /** browser_download: fetches with this browser's own session (cookies, user agent, the current page
   *  as referer) and writes a new file inside the project; redirects are followed only to http(s). */
  private async download(owned: OwnedBrowser, request: DownloadRequest): Promise<DownloadResult> {
    const guest = owned.view.webContents
    if (guest.isDestroyed()) throw new Error('The browser view was closed')
    const root = this.projectRootOf(owned.projectId)
    const page = guest.getURL()
    const referer = /^https?:/i.test(page) ? page : undefined
    let url = request.url
    if (request.fromVideo) {
      const { source } = await runInPage(guest, videoSource(request.selector)) as { source: string }
      if (!source) throw new Error('The video has no source yet; it may load one only when played. Play it (browser_click on its play control) and try again, or capture it with browser_video_frames.')
      if (/^(?:blob|mediastream|data):/i.test(source)) throw new Error(`The video plays from ${source.slice(0, 80)}${source.length > 80 ? '…' : ''}, a ${source.split(':')[0]}: source (Media Source Extensions streaming or an in-page object), which is not a file that can be saved. Use browser_video_frames to capture its frames, with audio:true for its sound.`)
      try { url = browserUrl(source) } catch { throw new Error(`The video source ${source.slice(0, 200)} is not an http(s) URL, so it cannot be downloaded`) }
    }
    if (!url) throw new Error('Provide url, or fromVideo:true')
    return this.fetchInto(guest, url, referer, root, request)
  }

  private fetchInto(guest: WebContents, url: string, referer: string | undefined, root: string, request: DownloadRequest): Promise<DownloadResult> {
    return new Promise<DownloadResult>((resolve, reject) => {
      let finalUrl = url, redirects = 0, received = 0, settled = false, answered = false
      let part: string | undefined, idle: NodeJS.Timeout | undefined
      const finish = (error?: unknown, result?: DownloadResult): void => {
        if (settled) return
        settled = true
        clearTimeout(idle); clearTimeout(ceiling); clearTimeout(answer)
        if (error) {
          try { client.abort() } catch { /* already finished */ }
          if (part) void rm(part, { force: true }).catch(() => undefined)
          if (!answered) reject(error instanceof Error ? error : new Error(String(error)))
          else console.warn('Browser download failed in the background', failure(error))
          return
        }
        if (!answered) resolve(result!)
      }
      const touch = (): void => { clearTimeout(idle); idle = setTimeout(() => finish(new Error(`${finalUrl} stopped sending data for ${DOWNLOAD_IDLE_MS / 1000} s`)), DOWNLOAD_IDLE_MS) }
      const ceiling = setTimeout(() => finish(new Error(`The download did not finish within ${DOWNLOAD_CEILING_MS / 60_000} minutes`)), DOWNLOAD_CEILING_MS)
      let answer: NodeJS.Timeout | undefined
      const client = net.request({ url, session: guest.session, useSessionCookies: true, redirect: 'manual', method: 'GET' })
      client.setHeader('User-Agent', guest.getUserAgent())
      client.setHeader('Accept', '*/*')
      if (referer) { try { client.setHeader('Referer', referer) } catch { /* the network stack keeps its own referrer */ } }
      client.on('redirect', (_status, _method, location) => {
        if (++redirects > 10) return finish(new Error(`${url} redirected more than 10 times`))
        try { finalUrl = browserUrl(location) } catch { return finish(new Error(`${finalUrl} redirected to ${location.slice(0, 200)}, which is not an http(s) URL`)) }
        client.followRedirect()
      })
      client.on('error', error => finish(error))
      client.on('response', response => {
        const header = (name: string): string | undefined => { const value = response.headers[name]; return Array.isArray(value) ? value[0] : value }
        if (response.statusCode < 200 || response.statusCode >= 300) return finish(new Error(`${finalUrl} answered HTTP ${response.statusCode}${response.statusMessage ? ` ${response.statusMessage}` : ''}; nothing was saved. If the page needs a sign-in, sign in in the project browser first.`))
        const contentType = header('content-type')
        const declared = Number(header('content-length'))
        const megabytes = (value: number): string => value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${Math.round(value / 1024 / 1024 * 10) / 10} MB`
        if (Number.isFinite(declared) && declared > request.maxBytes) return finish(new Error(`${finalUrl} is ${megabytes(declared)}, over the ${megabytes(request.maxBytes)} cap; pass maxMB to raise it (up to ${DOWNLOADS.maxBytes / 1024 / 1024})`))
        let target: { absolute: string; relative: string }
        try {
          const name = safeFileName(contentDispositionName(header('content-disposition')) ?? new URL(finalUrl).pathname, contentType, request.fromVideo ? 'video' : 'download')
          target = projectTarget(root, request.path, name, DOWNLOADS.defaultFolder)
          mkdirSync(dirname(target.absolute), { recursive: true })
        } catch (error) { return finish(error) }
        part = `${target.absolute}.part-${randomBytes(4).toString('hex')}`
        const counter = new Transform({
          transform: (chunk: Buffer, _encoding, done) => {
            received += chunk.length
            touch()
            if (received > request.maxBytes) done(new Error(`${finalUrl} sent more than the ${megabytes(request.maxBytes)} cap; pass maxMB to raise it (up to ${DOWNLOADS.maxBytes / 1024 / 1024})`))
            else done(null, chunk)
          }
        })
        touch()
        const result = (): DownloadResult => ({ path: target.absolute, relativePath: target.relative, bytes: received, ...(contentType ? { contentType } : {}), url, finalUrl, ...(referer ? { referer } : {}) })
        answer = setTimeout(() => {
          answered = true
          resolve({ ...result(), inProgress: true, partialPath: part! })
        }, DOWNLOAD_ANSWER_MS)
        pipeline(response as unknown as Readable, counter, createWriteStream(part, { flags: 'wx' }))
          .then(async () => {
            // The named file may have appeared while this one was arriving; it is never replaced.
            const final = existsSync(target.absolute) ? uniquePath(target.absolute) : target.absolute
            await rename(part!, final)
            part = undefined
            if (final !== target.absolute) target = { absolute: final, relative: join(dirname(target.relative), final.slice(dirname(final).length + 1)).replaceAll('\\', '/') }
            finish(undefined, result())
          })
          .catch(error => finish(error))
      })
      client.end()
    })
  }

  private page(owned: OwnedBrowser): BrowserView {
    const guest = owned.view.webContents
    const alive = (): WebContents => { if (guest.isDestroyed()) throw new Error('The browser view was closed'); return guest }
    const run = (code: string, gesture = false): Promise<unknown> => runInPage(alive(), code, gesture)
    return {
      tabId: projectBrowserViewId(owned.projectId)!,
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
        alive()
        const image = await this.withCapture(owned, grab => grab())
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
      present: async mode => { this.present(owned.projectId, mode) },
      videoFrames: request => this.videoFrames(owned, request),
      download: request => this.download(owned, request)
    }
  }
}
