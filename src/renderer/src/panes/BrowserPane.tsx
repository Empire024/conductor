import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, LockKeyhole, RefreshCw, RotateCw, SearchCode } from 'lucide-react'
import type { BrowserPresentation, BrowserSurfaceCommand, BrowserSurfaceRequest, BrowserSurfaceState } from '../../../shared/browser-surface'
import { browserPartition } from './browser-partition'

const normalizeUrl = (requested: string): string | null => {
  const candidate = requested.trim()
  if (!candidate) return null
  try {
    const url = new URL(candidate.includes('://') ? candidate : `http://${candidate}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

interface BrowserPaneProps {
  projectId: string | undefined
  initialUrl?: string
  compact?: boolean
  viewportStorageKey?: string
  performanceTabId?: string
  /** Stable identity for the one main-owned project guest. Legacy workspace browser tabs omit it
   * and are intentionally not allowed to construct a competing guest. */
  browserViewId?: string
  visible?: boolean
  presentation?: BrowserPresentation
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

// WebContentsView is a native surface painted above the renderer. Hide it whenever a renderer
// overlay needs pointer/visual priority; otherwise dialogs and menus can appear underneath it.
const browserOccluders = [
  'dialog[open]', '[aria-modal="true"]', '[role="menu"]',
  '.dialog-backdrop', '.settings-scrim', '.palette-backdrop',
  '.update-prompt-backdrop', '.update-quit-confirm-backdrop'
].join(', ')

export function BrowserPane(props: BrowserPaneProps): React.JSX.Element {
  const partition = browserPartition(props.projectId)
  if (!partition) return <p className="editor-loading">Select a project to open the browser.</p>
  return <ProjectBrowserPane key={partition} {...props} />
}

function ProjectBrowserPane({
  projectId = '', initialUrl = 'http://localhost:3000', compact = false,
  viewportStorageKey = 'conductor.browserViewport', browserViewId, visible = true, presentation = 'pane', onUrlChange
}: BrowserPaneProps): React.JSX.Element {
  const startingUrl = useMemo(() => normalizeUrl(initialUrl) ?? 'http://localhost:3000/', [initialUrl])
  const [input, setInput] = useState(startingUrl)
  const [invalid, setInvalid] = useState(false)
  const [state, setState] = useState<BrowserSurfaceState | null>(null)
  const [failure, setFailure] = useState('')
  const [occluded, setOccluded] = useState(false)
  const [viewport, setViewport] = useState<DeviceViewport>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(viewportStorageKey) ?? '') as DeviceViewport
      if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) return saved
    } catch { /* Use the primary responsive QA target. */ }
    return { id: 'phone', width: 390, height: 844 }
  })
  const [scale, setScale] = useState(1)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)

  const request = useCallback((): BrowserSurfaceRequest | null => {
    const frame = frameRef.current
    if (!frame || !browserViewId) return null
    const rect = frame.getBoundingClientRect()
    return { projectId, surfaceId: browserViewId, initialUrl: startingUrl, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: viewport.width, height: viewport.height }, visible: visible && !occluded && rect.width > 0 && rect.height > 0 }
  }, [browserViewId, occluded, projectId, startingUrl, viewport.height, viewport.width, visible])

  useEffect(() => {
    const detect = (): void => setOccluded(Boolean(document.querySelector(browserOccluders)))
    const observer = new MutationObserver(detect)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-modal', 'class'] })
    detect()
    return () => observer.disconnect()
  }, [])

  useEffect(() => window.conductor.browser.onState(next => {
    if (next.projectId !== projectId) return
    setState(next); setFailure(next.failure ?? '')
    if (next.url) { setInput(next.url); onUrlChange?.(next.url) }
  }), [onUrlChange, projectId])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !browserViewId) return
    let stopped = false
    const sync = (): void => {
      const payload = request()
      if (!payload || stopped) return
      const operation = mounted.current ? window.conductor.browser.update(payload) : window.conductor.browser.mount(payload)
      void operation.then(next => {
        if (stopped) return
        mounted.current = true; setState(next)
        if (next.url) { setInput(next.url); onUrlChange?.(next.url) }
        if (next.presentation !== presentation) void window.conductor.browser.present(projectId, presentation).catch(() => {})
      }).catch(error => { if (!stopped) setFailure(error instanceof Error ? error.message : String(error)) })
    }
    const observer = new ResizeObserver(sync)
    observer.observe(frame); window.addEventListener('resize', sync); sync()
    return () => {
      stopped = true; observer.disconnect(); window.removeEventListener('resize', sync)
      const payload = request()
      if (payload && mounted.current) void window.conductor.browser.update({ ...payload, visible: false }).catch(() => {})
    }
  }, [browserViewId, onUrlChange, presentation, projectId, request])

  useEffect(() => { localStorage.setItem(viewportStorageKey, JSON.stringify(viewport)) }, [viewport, viewportStorageKey])
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const fit = (): void => {
      const rect = stage.getBoundingClientRect()
      setScale(Math.max(0.2, Math.min(1, (rect.width - 20) / viewport.width, (rect.height - 20) / viewport.height)))
    }
    const observer = new ResizeObserver(fit)
    observer.observe(stage); fit()
    return () => observer.disconnect()
  }, [viewport.height, viewport.width])

  if (!browserViewId) return <div className="browser-pane browser-moved"><strong>Browser moved to the activity rail</strong><span>Use Browser on the left for the project’s persistent preview.</span></div>

  const command = (action: BrowserSurfaceCommand): void => {
    setFailure('')
    void window.conductor.browser.command(projectId, action).then(setState).catch(error => setFailure(error instanceof Error ? error.message : String(error)))
  }
  const visit = (requested: string): void => {
    const url = normalizeUrl(requested)
    if (!url) { setInvalid(true); return }
    setInvalid(false); setInput(url); command({ type: 'navigate', url })
  }
  const selectDevice = (id: DeviceId): void => {
    const preset = devices.find(device => device.id === id)!
    setViewport({ id, width: preset.width, height: preset.height })
  }

  return (
    <div className={`browser-pane chromium-shell ${compact ? 'browser-pane-compact' : ''}`} data-browser-web-contents-id={state?.webContentsId}>
      <div className="browser-toolbar">
        <button disabled={!state?.canGoBack} title="Back" onClick={() => command({ type: 'back' })}><ArrowLeft size={13} /></button>
        <button disabled={!state?.canGoForward} title="Forward" onClick={() => command({ type: 'forward' })}><ArrowRight size={13} /></button>
        <button title="Reload" onClick={() => command({ type: 'reload' })}><RefreshCw className={state?.loading ? 'spin' : ''} size={13} /></button>
        <form className={invalid ? 'invalid' : ''} onSubmit={event => { event.preventDefault(); visit(input) }}><LockKeyhole size={10} /><input aria-label="Address" value={input} onChange={event => { setInvalid(false); setInput(event.target.value) }} /></form>
        {!compact && <button title="Open Chromium DevTools" onClick={() => command({ type: 'devtools' })}><SearchCode size={14} /></button>}
        <button title="Open in default browser" onClick={() => void window.conductor.system.openExternal(state?.url || input)}><ExternalLink size={13} /></button>
      </div>
      <div className="browser-device-toolbar" aria-label="Responsive viewport">
        <div className="browser-device-presets">{devices.map(device => <button key={device.id} className={viewport.id === device.id ? 'active' : ''} onClick={() => selectDevice(device.id)}>{device.label}</button>)}</div>
        <label><input aria-label="Viewport width" type="number" min="240" max="3840" value={viewport.width} onChange={event => setViewport({ ...viewport, width: Math.max(240, Number(event.target.value) || 240) })} /> <span>×</span> <input aria-label="Viewport height" type="number" min="320" max="2160" value={viewport.height} onChange={event => setViewport({ ...viewport, height: Math.max(320, Number(event.target.value) || 320) })} /></label>
        <button className="browser-rotate" title="Rotate viewport" onClick={() => setViewport({ ...viewport, width: viewport.height, height: viewport.width })}><RotateCw size={13} /></button><small>{Math.round(scale * 100)}%</small>
      </div>
      <div className="browser-device-stage" ref={stageRef}><div ref={frameRef} className="browser-device-frame browser-owned-surface" data-conductor-browser-view-id={browserViewId} style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }} /></div>
      {failure && <div className="browser-failure browser-failure-inline"><strong>Could not load this page</strong><span>{failure}</span></div>}
    </div>
  )
}
