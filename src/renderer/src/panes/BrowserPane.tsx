import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, LockKeyhole, RefreshCw, RotateCw, SearchCode } from 'lucide-react'
import type { BrowserPresentation, BrowserSurfaceCommand, BrowserSurfaceRequest, BrowserSurfaceState } from '../../../shared/browser-surface'
import type { ProjectRecord } from '../../../shared/models'
import type { RemoteServiceRecord } from '../../../shared/remote-services'
import { ExecutionTargetChip } from '../components/ExecutionTargetChip'
import { browserPartition } from './browser-partition'
import { PreviewServices } from './PreviewServices'
import { RemotePreviewPicker } from './RemotePreviewPicker'
import { previewHostLost, previewOriginNote, previewTarget, viewingService as isViewingService } from './preview-services'

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
  /**
   * The project record, when the caller has it. A project that lives on a host previews that
   * host's registered services rather than this computer's localhost - and must say so, because
   * the tunnel's own address is a loopback port here.
   */
  project?: Pick<ProjectRecord, 'id' | 'remote'>
  /** The machine this tab is placed on, for a paired project whose work runs elsewhere. */
  machineId?: string
  /** That machine's name, for the copy; the chip reads the rest from remote state itself. */
  machineName?: string
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
  projectId = '', project, machineId, machineName, initialUrl = 'http://localhost:3000', compact = false,
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
  const target = useMemo(() => previewTarget(project ?? (projectId ? { id: projectId } : null), machineId, machineName), [project, projectId, machineId, machineName])
  /** The host service this pane is currently tunnelled to, so it can be closed again exactly once. */
  const [service, setService] = useState<RemoteServiceRecord | null>(null)
  /**
   * The origin of that tunnel's local end. Held separately from `service` because the address bar
   * still works: the owner can type their own localhost while a tunnel is open, and from that
   * moment the pane is no longer showing the host. Labelling by *mode* would then say "Remote:
   * MAIN" over the laptop's own dev server - the very confusion this label exists to prevent, just
   * pointing the other way. So everything that names the host is tied to what is actually loaded.
   */
  const [serviceOrigin, setServiceOrigin] = useState('')
  const [serviceError, setServiceError] = useState('')
  const openedRef = useRef<{ machineId: string; projectId: string; serviceId: string } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  // React clears refs to unmounting DOM nodes before running this effect's cleanup (refs are
  // detached synchronously during commit; passive-effect cleanups run later). Reading frameRef
  // inside the unmount cleanup below would therefore see `null` and skip hiding the native view,
  // leaving it attached with its last real bounds and no owner to paint over the UI. Caching the
  // most recent request here means the cleanup can still tell the main process to hide it.
  const lastPayload = useRef<BrowserSurfaceRequest | null>(null)
  // Distinguishes leaving for good from the ordinary effect re-run that a resize or a visibility
  // change causes. Declared before the surface effect so React runs this cleanup first.
  const unmounting = useRef(false)
  useEffect(() => () => { unmounting.current = true }, [])

  const request = useCallback((): BrowserSurfaceRequest | null => {
    const frame = frameRef.current
    if (!frame || !browserViewId) return null
    const rect = frame.getBoundingClientRect()
    const payload: BrowserSurfaceRequest = { projectId, surfaceId: browserViewId, initialUrl: startingUrl, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: viewport.width, height: viewport.height }, visible: visible && !occluded && rect.width > 0 && rect.height > 0 }
    lastPayload.current = payload
    return payload
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
        mounted.current = true
        if (stopped) {
          // The pane unmounted before the mount/update round-tripped: the main process now believes
          // this surface is visible with the bounds we sent, and nobody else will tell it otherwise.
          // Hide it instead of leaving a stray native view painted over the UI at its last bounds.
          // Only on a real unmount - after a mere re-run a newer update is already in flight, and
          // hiding here would land after it and blank a browser the owner is still looking at.
          const stale = unmounting.current ? lastPayload.current : null
          if (stale) void window.conductor.browser.update({ ...stale, visible: false }).catch(() => {})
          return
        }
        setState(next)
        if (next.url) { setInput(next.url); onUrlChange?.(next.url) }
        if (next.presentation !== presentation) void window.conductor.browser.present(projectId, presentation).catch(() => {})
      }).catch(error => { if (!stopped) setFailure(error instanceof Error ? error.message : String(error)) })
    }
    const observer = new ResizeObserver(sync)
    observer.observe(frame); window.addEventListener('resize', sync); sync()
    return () => {
      stopped = true; observer.disconnect(); window.removeEventListener('resize', sync)
      // frameRef.current is already null here whenever this cleanup runs because the pane is
      // unmounting (see the comment on lastPayload above), so request() would return null and the
      // hide would silently never be sent. Fall back to the last payload we actually delivered.
      const payload = request() ?? lastPayload.current
      if (payload && mounted.current) void window.conductor.browser.update({ ...payload, visible: false }).catch(() => {})
    }
  }, [browserViewId, onUrlChange, presentation, projectId, request])

  /**
   * A tunnel is a real loopback listener on this computer, so leaving one open behind a closed tab
   * would be a port nobody is watching pointing at a machine nobody is attached to. Closing is
   * best-effort by design: after a detach the main process has already torn every tunnel down, and
   * the only thing left to get right here is not to leave a pane pretending it still has one.
   */
  const releaseService = useCallback((): void => {
    const opened = openedRef.current
    openedRef.current = null
    if (opened) void window.conductor.remote.services.close(opened).catch(() => {})
  }, [])

  useEffect(() => releaseService, [releaseService])

  // Changing which machine or project this pane previews invalidates the tunnel it holds.
  useEffect(() => {
    releaseService()
    setService(null)
    setServiceOrigin('')
    setServiceError('')
  }, [releaseService, target.mode === 'controller' ? target.machineId : '', target.mode === 'controller' ? target.projectId : ''])

  // A host that goes away - detached, revoked or simply gone - has already had its tunnels closed
  // in the main process. Drop the pane's claim to one rather than leaving a dead preview labelled
  // as live; the picker beneath it then says what to do next.
  useEffect(() => window.conductor.remote.onState(() => {
    if (target.mode !== 'controller' || !openedRef.current) return
    void window.conductor.remote.machines().then(machines => {
      if (!previewHostLost(machines, target.machineId)) return
      openedRef.current = null
      setService(null)
      setServiceOrigin('')
      setServiceError(`This preview came from ${target.machineName}, which is no longer available. Nothing is being loaded from it now.`)
    }).catch(() => {})
  }), [target])

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

  /**
   * Whether the page on screen really is the host's service. The tunnel may be open while the
   * owner has navigated somewhere else entirely; only this decides whether the host is named.
   */
  const viewingService = isViewingService(state?.url ?? input, serviceOrigin)

  const command = (action: BrowserSurfaceCommand): void => {
    setFailure('')
    void window.conductor.browser.command(projectId, action).then(setState).catch(error => setFailure(error instanceof Error ? error.message : String(error)))
  }
  const visit = (requested: string): void => {
    const url = normalizeUrl(requested)
    if (!url) { setInvalid(true); return }
    setInvalid(false); setInput(url); command({ type: 'navigate', url })
  }

  /**
   * Opens the tunnel for one of the host's registered services and points the pane at its local
   * end. `localUrl` is the only address this pane ever gets for a host service: there is no URL to
   * construct, and the page it loads holds no credential - the device key that opened the tunnel
   * stays in the main process and the guest can reach nothing but this one service.
   */
  const openService = (next: RemoteServiceRecord): void => {
    if (target.mode !== 'controller') return
    setServiceError('')
    const scope = { machineId: target.machineId, projectId: target.projectId, serviceId: next.id }
    const previous = openedRef.current
    void window.conductor.remote.services.open(scope).then(({ localUrl }) => {
      // Only once the new one is really open, so a failure leaves the owner on what they had.
      if (previous && previous.serviceId !== next.id) void window.conductor.remote.services.close(previous).catch(() => {})
      openedRef.current = scope
      setService(next)
      const url = normalizeUrl(localUrl)
      if (!url) { setServiceError('That machine returned an address this pane cannot load.'); return }
      setServiceOrigin(new URL(url).origin)
      setInput(url)
      command({ type: 'navigate', url })
    }).catch(reason => setServiceError(reason instanceof Error ? reason.message : String(reason)))
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
        {/* The host half sits next to the address bar because that is where the owner already is
            when they are thinking about a dev server. It is only ever offered for a project whose
            ports are actually on this computer. */}
        {target.mode === 'host' && projectId && <PreviewServices projectId={projectId} />}
        {/* Whose localhost this is. A laptop looking at MAIN's dev server on a loopback address of
            its own, next to its own dev server on a similar port, is the confusion this prevents. */}
        {viewingService && target.mode == 'controller' && <ExecutionTargetChip machineId={target.machineId} />}
      </div>
      {target.mode === 'controller' && (
        <div className="browser-remote-bar">
          <RemotePreviewPicker
            machineId={target.machineId}
            machineName={target.machineName}
            projectId={target.projectId}
            activeServiceId={service?.id ?? null}
            onOpen={openService}
          />
          {viewingService && service && <p className="browser-remote-origin">{previewOriginNote(service, target.machineName)}</p>}
          {serviceError && <p className="browser-remote-error" role="alert">{serviceError}</p>}
        </div>
      )}
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
