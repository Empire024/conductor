import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, LockKeyhole, RefreshCw, RotateCw, SearchCode } from 'lucide-react'

type ChromiumWebview = HTMLElement & {
  loadURL(url: string): Promise<void>
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  openDevTools(): void
}

type NavigationEvent = Event & { url?: string; errorDescription?: string; isMainFrame?: boolean }

const normalizeUrl = (requested: string): string | null => {
  const candidate = requested.trim()
  if (!candidate) return null
  try {
    const url = new URL(candidate.includes('://') ? candidate : `http://${candidate}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

interface BrowserPaneProps {
  initialUrl?: string
  compact?: boolean
  viewportStorageKey?: string
  performanceTabId?: string
  onUrlChange?(url: string): void
}

type DeviceId = 'phone' | 'tablet' | 'laptop' | 'desktop'
interface DeviceViewport { id: DeviceId; width: number; height: number }
const devices: Array<DeviceViewport & { label: string }> = [
  { id: 'phone', label: 'Phone', width: 390, height: 844 },
  { id: 'tablet', label: 'Tablet', width: 820, height: 1180 },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900 }
]

export function BrowserPane({
  initialUrl = 'http://localhost:3000',
  compact = false,
  viewportStorageKey = 'conductor.browserViewport',
  performanceTabId,
  onUrlChange
}: BrowserPaneProps): React.JSX.Element {
  const startingUrl = useMemo(() => normalizeUrl(initialUrl) ?? 'http://localhost:3000/', [initialUrl])
  const [webview, setWebview] = useState<ChromiumWebview | null>(null)
  const [input, setInput] = useState(startingUrl)
  const [url, setUrl] = useState(startingUrl)
  const [loading, setLoading] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [failure, setFailure] = useState('')
  const [viewport, setViewport] = useState<DeviceViewport>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(viewportStorageKey) ?? '') as DeviceViewport
      if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) return saved
    } catch { /* Start with the primary QA target: a modern phone. */ }
    return { id: 'phone', width: 390, height: 844 }
  })
  const [scale, setScale] = useState(1)
  const stageRef = useRef<HTMLDivElement>(null)

  const webviewRef = useCallback((node: Element | null): void => {
    setWebview(node as ChromiumWebview | null)
  }, [])

  useEffect(() => {
    if (!webview) return
    const syncNavigation = (event?: Event): void => {
      const eventUrl = (event as NavigationEvent | undefined)?.url
      const next = eventUrl || webview.getURL?.() || startingUrl
      setUrl(next)
      setInput(next)
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
      onUrlChange?.(next)
    }
    const start = (): void => { setLoading(true); setFailure('') }
    const stop = (): void => { setLoading(false); syncNavigation() }
    const fail = (event: Event): void => {
      const detail = event as NavigationEvent
      if (detail.isMainFrame === false) return
      setLoading(false)
      setFailure(detail.errorDescription ?? 'The page could not be loaded')
    }
    webview.addEventListener('did-start-loading', start)
    webview.addEventListener('did-stop-loading', stop)
    webview.addEventListener('dom-ready', stop)
    webview.addEventListener('did-navigate', syncNavigation)
    webview.addEventListener('did-navigate-in-page', syncNavigation)
    webview.addEventListener('did-fail-load', fail)
    return () => {
      webview.removeEventListener('did-start-loading', start)
      webview.removeEventListener('did-stop-loading', stop)
      webview.removeEventListener('dom-ready', stop)
      webview.removeEventListener('did-navigate', syncNavigation)
      webview.removeEventListener('did-navigate-in-page', syncNavigation)
      webview.removeEventListener('did-fail-load', fail)
    }
  }, [onUrlChange, startingUrl, webview])

  useEffect(() => {
    if (!loading) return
    const timeout = window.setTimeout(() => setLoading(false), 12_000)
    return () => window.clearTimeout(timeout)
  }, [loading])

  useEffect(() => {
    localStorage.setItem(viewportStorageKey, JSON.stringify(viewport))
  }, [viewport, viewportStorageKey])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const fitViewport = (): void => {
      const rect = stage.getBoundingClientRect()
      setScale(Math.max(0.2, Math.min(1, (rect.width - 20) / viewport.width, (rect.height - 20) / viewport.height)))
    }
    const observer = new ResizeObserver(fitViewport)
    observer.observe(stage)
    fitViewport()
    return () => observer.disconnect()
  }, [viewport.height, viewport.width])

  const selectDevice = (id: DeviceId): void => {
    const preset = devices.find((device) => device.id === id)!
    setViewport({ id, width: preset.width, height: preset.height })
  }

  const visit = (requested: string): void => {
    const next = normalizeUrl(requested)
    if (!next) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setFailure('')
    setInput(next)
    setUrl(next)
    setLoading(Boolean(webview))
    onUrlChange?.(next)
    void webview?.loadURL(next)
  }

  const chromium = createElement('webview', {
    ref: webviewRef,
    className: 'chromium-webview',
    src: startingUrl,
    partition: 'persist:conductor-browser',
    webpreferences: 'contextIsolation=yes, nodeIntegration=no, sandbox=yes',
    allowpopups: 'false',
    'data-performance-browser-tab-id': performanceTabId
  })

  return (
    <div className={`browser-pane chromium-shell ${compact ? 'browser-pane-compact' : ''}`}>
      <div className="browser-toolbar">
        <button disabled={!canGoBack} title="Back" onClick={() => webview?.goBack()}><ArrowLeft size={13} /></button>
        <button disabled={!canGoForward} title="Forward" onClick={() => webview?.goForward()}><ArrowRight size={13} /></button>
        <button title="Reload" onClick={() => { if (!webview) return; setLoading(true); webview.reload() }}><RefreshCw className={loading ? 'spin' : ''} size={13} /></button>
        <form className={invalid ? 'invalid' : ''} onSubmit={(event) => { event.preventDefault(); visit(input) }}>
          <LockKeyhole size={10} />
          <input aria-label="Address" value={input} onChange={(event) => { setInvalid(false); setInput(event.target.value) }} />
        </form>
        {!compact && <button title="Open Chromium DevTools" onClick={() => webview?.openDevTools()}><SearchCode size={14} /></button>}
        <button title="Open in default browser" onClick={() => void window.conductor.system.openExternal(url)}><ExternalLink size={13} /></button>
      </div>
      <div className="browser-device-toolbar" aria-label="Responsive viewport">
        <div className="browser-device-presets">
          {devices.map((device) => <button key={device.id} className={viewport.id === device.id ? 'active' : ''} onClick={() => selectDevice(device.id)}>{device.label}</button>)}
        </div>
        <label><input aria-label="Viewport width" type="number" min="240" max="3840" value={viewport.width} onChange={(event) => setViewport({ ...viewport, width: Math.max(240, Number(event.target.value) || 240) })} /> <span>×</span> <input aria-label="Viewport height" type="number" min="320" max="2160" value={viewport.height} onChange={(event) => setViewport({ ...viewport, height: Math.max(320, Number(event.target.value) || 320) })} /></label>
        <button className="browser-rotate" title="Rotate viewport" onClick={() => setViewport({ ...viewport, width: viewport.height, height: viewport.width })}><RotateCw size={13} /></button>
        <small>{Math.round(scale * 100)}%</small>
      </div>
      <div className="browser-device-stage" ref={stageRef}>
        <div className="browser-device-frame" style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }}>
          {chromium}
        </div>
      </div>
      {failure && <div className="browser-failure"><strong>Could not load this page</strong><span>{failure}</span><button onClick={() => visit(url)}>Try again</button></div>}
    </div>
  )
}
