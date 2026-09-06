import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, ChevronUp, Cpu, LayoutPanelTop, MemoryStick } from 'lucide-react'
import type { AppPerformanceSnapshot, PaneTab, RuntimeProcessSummary } from '../../../shared/models'
import { classifyPerformance, classifyTabUiWeight, formatMemoryMb } from '../performance-metrics'

interface TabSample {
  tab: PaneTab
  active: boolean
  domNodes: number
  runtime?: RuntimeProcessSummary
  browserPerformance?: { cpuPercent: number; memoryMb: number }
}

interface PerformanceSample {
  app: AppPerformanceSnapshot
  fps: number
  longTaskMs: number
  domNodes: number
  tabs: TabSample[]
}

type MeasurableWebview = HTMLElement & { getWebContentsId?(): number }

export function TabPerformancePopover({
  tabs,
  activeTabIds,
  projectId,
  sessionId
}: {
  tabs: PaneTab[]
  activeTabIds: Set<string>
  projectId: string
  sessionId: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [sample, setSample] = useState<PerformanceSample | null>(null)
  const [problem, setProblem] = useState('')
  const [position, setPosition] = useState({ right: 8, bottom: 30 })
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const tabSignature = useMemo(
    () => tabs.map((tab) => `${tab.id}:${tab.title}:${tab.kind}`).join('|'),
    [tabs]
  )
  const activeSignature = useMemo(() => [...activeTabIds].sort().join('|'), [activeTabIds])

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const bounds = anchorRef.current?.getBoundingClientRect()
      if (!bounds) return
      setPosition({
        right: Math.max(8, window.innerWidth - bounds.right),
        bottom: Math.max(30, window.innerHeight - bounds.top + 6)
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!anchorRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let mounted = true
    let animationFrame = 0
    let frameCount = 0
    let frameWindowStarted = performance.now()
    let measuredFps = 60
    let blockingTime = 0
    let sampling = false

    const countFrame = (now: number): void => {
      frameCount += 1
      const elapsed = now - frameWindowStarted
      if (elapsed >= 750) {
        measuredFps = Math.min(60, frameCount * 1000 / elapsed)
        frameCount = 0
        frameWindowStarted = now
      }
      animationFrame = requestAnimationFrame(countFrame)
    }
    animationFrame = requestAnimationFrame(countFrame)

    const observer = typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver((entries) => {
          blockingTime += entries.getEntries().reduce((total, entry) => total + entry.duration, 0)
        })
      : null
    observer?.observe({ type: 'longtask', buffered: false })

    const measure = async (): Promise<void> => {
      if (sampling) return
      sampling = true
      try {
        const roots = new Map<string, HTMLElement>()
        for (const root of document.querySelectorAll<HTMLElement>('[data-performance-tab-id]')) {
          const id = root.dataset.performanceTabId
          if (id) roots.set(id, root)
        }
        const browserWebContents: Record<string, number> = {}
        for (const [id, root] of roots) {
          const webview = root.querySelector('webview') as MeasurableWebview | null
          try {
            const webContentsId = webview?.getWebContentsId?.()
            if (webContentsId) browserWebContents[id] = webContentsId
          } catch { /* A browser tab can be sampled after its guest attaches. */ }
        }

        const [appPerformance, processes] = await Promise.all([
          window.conductor.system.getPerformance(browserWebContents),
          window.conductor.agents.listProcesses(projectId)
        ])
        if (!mounted) return
        const currentProcesses = processes.filter((process) => process.sessionId === sessionId)
        const tabSamples = tabs.map((tab): TabSample => {
          const root = roots.get(tab.id)
          return {
            tab,
            active: activeTabIds.has(tab.id),
            domNodes: root ? root.getElementsByTagName('*').length + 1 : 0,
            runtime: tab.resourceId
              ? currentProcesses.find((process) => process.id === tab.resourceId)
              : undefined,
            browserPerformance: appPerformance.browserTabs[tab.id]
          }
        })
        setProblem('')
        setSample({
          app: appPerformance,
          fps: measuredFps,
          longTaskMs: blockingTime,
          domNodes: document.getElementsByTagName('*').length,
          tabs: tabSamples
        })
        blockingTime = 0
      } catch (reason) {
        if (mounted) setProblem(reason instanceof Error ? reason.message : 'Performance data is unavailable')
      } finally {
        sampling = false
      }
    }

    void measure()
    const timer = window.setInterval(() => { void measure() }, 1_500)
    return () => {
      mounted = false
      window.clearInterval(timer)
      cancelAnimationFrame(animationFrame)
      observer?.disconnect()
    }
  }, [activeSignature, open, projectId, sessionId, tabSignature])

  const health = sample
    ? classifyPerformance({ cpuPercent: sample.app.cpuPercent, fps: sample.fps, longTaskMs: sample.longTaskMs })
    : 'smooth'
  const liveRuntimes = sample?.tabs.filter((tab) => tab.runtime && !['exited', 'unavailable', 'error'].includes(tab.runtime.status)).length ?? 0

  return (
    <div className="tab-performance-anchor">
      <button
        ref={anchorRef}
        className={open ? 'status-tab-count active' : 'status-tab-count'}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Workspace tab performance"
      >
        <LayoutPanelTop size={12} /> {tabs.length} tabs <ChevronUp size={10} />
      </button>
      {open && createPortal(
        <section
          ref={popoverRef}
          className="tab-performance-popover"
          style={position}
          role="dialog"
          aria-label="Workspace tab performance"
        >
          <header>
            <span><Activity size={15} /><strong>Workspace performance</strong></span>
            <small className={health}><i /> {health}</small>
          </header>
          {sample ? (
            <>
              <div className="performance-summary">
                <article><Cpu size={13} /><span><strong>{sample.app.cpuPercent.toFixed(1)}%</strong><small>suite CPU</small></span></article>
                <article><MemoryStick size={13} /><span><strong>{formatMemoryMb(sample.app.memoryMb)}</strong><small>suite memory</small></span></article>
                <article><Activity size={13} /><span><strong>{Math.round(sample.fps)} fps</strong><small>{Math.round(sample.longTaskMs)} ms blocked</small></span></article>
                <article><LayoutPanelTop size={13} /><span><strong>{sample.app.processCount}</strong><small>processes · {liveRuntimes} runtimes</small></span></article>
              </div>
              <div className="performance-tab-list">
                {sample.tabs.map(({ tab, active, domNodes, runtime, browserPerformance }) => {
                  const weight = classifyTabUiWeight(domNodes)
                  const share = Math.min(100, Math.max(3, domNodes / Math.max(1, sample.tabs.reduce((total, item) => total + item.domNodes, 0)) * 100))
                  return (
                    <article key={tab.id}>
                      <div className="performance-tab-heading">
                        <span><strong title={tab.title}>{tab.title}</strong><small>{tab.kind} · {active ? 'visible' : 'background'}{runtime ? ` · ${runtime.status}` : ''}</small></span>
                        <span className={`performance-weight ${weight}`}>{weight}</span>
                      </div>
                      <div className="performance-tab-meter"><i style={{ width: `${share}%` }} /></div>
                      <footer>
                        <span>{domNodes.toLocaleString()} UI nodes</span>
                        {browserPerformance && <span>{browserPerformance.cpuPercent.toFixed(1)}% CPU · {formatMemoryMb(browserPerformance.memoryMb)}</span>}
                      </footer>
                    </article>
                  )
                })}
              </div>
              <footer className="performance-note">Live Electron totals. Per-tab bars show UI footprint; browser tabs also expose their isolated process usage.</footer>
            </>
          ) : (
            <div className="performance-loading"><i className="spin" />{problem || 'Measuring this workspace…'}</div>
          )}
        </section>,
        document.body
      )}
    </div>
  )
}
