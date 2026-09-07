import { useEffect, useRef, useState } from 'react'
import { Bug, Camera, Copy, Maximize2, Minimize2, Minus, PictureInPicture2, Send, Trash2, X } from 'lucide-react'
import type { DebugScreenshot, IssueReportContext } from '../../../shared/models'
import {
  buildIssueReport,
  buildIssueDraftUrl,
  clearDebugEntries,
  getDebugEntries,
  subscribeToDebugEntries,
  type DebugLogEntry
} from '../debug-log'
import { useWindowMaximized } from '../use-window-maximized'

export function DebugConsole({
  context,
  entries: suppliedEntries,
  detached = false,
  onClose,
  onCopied,
  onClear,
  onDetach
}: {
  context: IssueReportContext
  entries?: DebugLogEntry[]
  detached?: boolean
  onClose(): void
  onCopied(): void
  onClear?(): void
  onDetach?(): void
}): React.JSX.Element {
  const [localEntries, setLocalEntries] = useState<DebugLogEntry[]>(getDebugEntries)
  const [minimized, setMinimized] = useState(false)
  const [screenshot, setScreenshot] = useState<DebugScreenshot | null>(null)
  const [screenshotDescription, setScreenshotDescription] = useState('')
  const [captureStatus, setCaptureStatus] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const entries = suppliedEntries ?? localEntries
  const windowMaximized = useWindowMaximized()

  useEffect(() => {
    if (suppliedEntries) return
    return subscribeToDebugEntries(setLocalEntries)
  }, [suppliedEntries])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [entries])

  const copyReport = async (): Promise<void> => {
    const diagnostics = await window.conductor.system.getDiagnostics()
    await navigator.clipboard.writeText(buildIssueReport(
      diagnostics,
      context,
      entries,
      screenshot ? { ...screenshot, description: screenshotDescription } : undefined
    ))
    onCopied()
  }

  const openIssue = async (): Promise<void> => {
    if (!screenshot) return
    const description = screenshotDescription.trim()
    if (!description) {
      setCaptureStatus('Describe what is wrong first')
      descriptionRef.current?.focus()
      return
    }
    setCaptureStatus('Opening issue...')
    try {
      const diagnostics = await window.conductor.system.getDiagnostics()
      const report = buildIssueReport(
        diagnostics,
        context,
        entries,
        { ...screenshot, description }
      )
      const { screenshotCopied } = await window.conductor.debug.openIssue(buildIssueDraftUrl(report, description))
      setCaptureStatus(screenshotCopied
        ? 'Issue draft opened - paste the copied screenshot'
        : 'Issue draft opened')
    } catch (reason) {
      setCaptureStatus(reason instanceof Error ? reason.message : 'Could not open the issue')
    }
  }

  const takeScreenshot = async (): Promise<void> => {
    setCaptureStatus('Capturing…')
    document.documentElement.dataset.debugCapturing = 'true'
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    try {
      const captured = await window.conductor.debug.captureScreenshot()
      setScreenshot(captured)
      setScreenshotDescription('')
      setMinimized(false)
      setCaptureStatus('Describe it, then press Enter')
      requestAnimationFrame(() => requestAnimationFrame(() => descriptionRef.current?.focus()))
    } catch (reason) {
      setCaptureStatus(reason instanceof Error ? reason.message : 'Capture failed')
    } finally {
      delete document.documentElement.dataset.debugCapturing
    }
  }

  const clear = (): void => {
    if (onClear) onClear()
    else clearDebugEntries()
  }

  const beginDetachDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (detached || !onDetach || (event.target as HTMLElement).closest('button')) return
    const startX = event.clientX
    const startY = event.clientY
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    const move = (next: PointerEvent): void => {
      if (Math.hypot(next.clientX - startX, next.clientY - startY) < 8) return
      stop()
      onDetach()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  return (
    <aside className={`debug-console ${minimized ? 'minimized' : ''} ${detached ? 'detached' : ''}`} aria-label="Debug console">
      <header className={!detached && onDetach ? 'detach-drag-enabled' : undefined} onPointerDown={beginDetachDrag}>
        <div><span className="debug-bug"><Bug size={13} /></span><strong>Debug console</strong><span>{entries.length} events</span>{captureStatus && <small title={captureStatus}>{captureStatus}</small>}</div>
        <div className="debug-console-actions">
          <button onClick={() => void takeScreenshot()} title="Capture the unobstructed Conductor window" aria-label="Take screenshot"><Camera size={13} /> Capture</button>
          <button onClick={() => void copyReport()} title="Copy issue report" aria-label="Copy issue report"><Copy size={13} /> Report</button>
          {!detached && onDetach && <button onClick={onDetach} title="Detach debug console" aria-label="Detach debug console"><PictureInPicture2 size={13} /></button>}
          {detached ? (
            <>
              <button onClick={() => window.conductor.window.minimize()} title="Minimize debug window" aria-label="Minimize debug window"><Minus size={14} /></button>
              <button onClick={() => window.conductor.window.toggleMaximize()} title={windowMaximized ? 'Restore debug window' : 'Maximize debug window'} aria-label={windowMaximized ? 'Restore debug window' : 'Maximize debug window'}>
                {windowMaximized ? <Minimize2 size={14} /> : <Maximize2 size={13} />}
              </button>
            </>
          ) : (
            <button
              onClick={() => setMinimized((value) => !value)}
              title={minimized ? 'Expand debug console' : 'Minimize debug console'}
              aria-label={minimized ? 'Expand debug console' : 'Minimize debug console'}
            >{minimized ? <Maximize2 size={13} /> : <Minimize2 size={14} />}</button>
          )}
          <button onClick={clear} title="Clear debug log" aria-label="Clear debug log"><Trash2 size={13} /></button>
          <button onClick={onClose} title="Close debug console" aria-label="Close debug console"><X size={14} /></button>
        </div>
      </header>
      {!minimized && screenshot && (
        <div className="debug-screenshot">
          <img src={screenshot.dataUrl} alt="Captured Conductor window" />
          <label>
            <span><strong>What is wrong here?</strong><small>{screenshot.width} × {screenshot.height} · Enter to report</small></span>
            <textarea
              ref={descriptionRef}
              rows={2}
              value={screenshotDescription}
              onChange={(event) => setScreenshotDescription(event.target.value)}
              placeholder="Briefly describe what should have happened…"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void openIssue()
                }
              }}
            />
          </label>
          <button onClick={() => void openIssue()} title="Open GitHub issue draft (Enter)" aria-label="Open GitHub issue draft"><Send size={14} /></button>
          <button onClick={() => { setScreenshot(null); setCaptureStatus('') }} title="Remove screenshot" aria-label="Remove screenshot"><X size={14} /></button>
        </div>
      )}
      {!minimized && (
        <>
          <div className="debug-console-log" ref={listRef}>
            {entries.length === 0 && <div className="debug-console-empty">Actions, warnings, and errors will appear here.</div>}
            {entries.map((entry) => (
              <div className={`debug-entry ${entry.level}`} key={entry.id}>
                <time>{new Date(entry.createdAt).toLocaleTimeString([], { hour12: false })}</time>
                <b>{entry.level}</b>
                <span>[{entry.scope}] {entry.message}</span>
                {entry.detail && <code>{entry.detail}</code>}
              </div>
            ))}
          </div>
          <footer>Capture, describe, press Enter. The issue draft opens with diagnostics and the screenshot ready to paste as a GitHub link.</footer>
        </>
      )}
    </aside>
  )
}
