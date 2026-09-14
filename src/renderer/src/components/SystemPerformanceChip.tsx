import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronUp, Cpu, Gauge, MemoryStick, MonitorCog } from 'lucide-react'
import {
  formatBytes,
  formatPercent,
  performanceChipVisible,
  performanceLevel,
  share,
  type SystemMetricsSnapshot
} from '../../../shared/system-metrics'
import './SystemPerformanceChip.css'

/** Closed, the chip samples slowly: it only has to notice that a local model came up or that the
 *  machine got busy. Open, it is a live read-out and samples as fast as the main process will
 *  answer. */
const IDLE_INTERVAL_MS = 5000
const OPEN_INTERVAL_MS = 1500

/** Host CPU, memory and GPU next to the version button. It appears only while there is something
 *  to say — a local Qwen server resident, Conductor itself expensive, or the machine under load
 *  from anything else — so an idle workspace keeps its status bar quiet. */
export function SystemPerformanceChip(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<SystemMetricsSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [problem, setProblem] = useState('')
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 })

  useEffect(() => {
    let mounted = true, sampling = false
    const measure = async (): Promise<void> => {
      if (sampling) return
      sampling = true
      try {
        const next = await window.conductor.system.metrics()
        if (!mounted) return
        setSnapshot(next)
        setProblem('')
      } catch (reason) {
        if (mounted) setProblem(reason instanceof Error ? reason.message : 'Host metrics are unavailable')
      } finally { sampling = false }
    }
    void measure()
    const timer = window.setInterval(() => { void measure() }, open ? OPEN_INTERVAL_MS : IDLE_INTERVAL_MS)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      if (!anchor) return
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 340)), bottom: window.innerHeight - anchor.top + 6 })
    }
    place()
    const dismiss = (event: MouseEvent): void => {
      if (popoverRef.current?.contains(event.target as Node) || anchorRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('resize', place)
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

  if (!snapshot || (!open && !performanceChipVisible(snapshot))) return null
  const level = performanceLevel(snapshot)
  const gpu = snapshot.gpus[0]
  const localRunning = snapshot.localServers.filter(server => server.running)

  return (
    <div className="system-performance-anchor">
      <button
        ref={anchorRef}
        className={`system-performance-chip ${level}${open ? ' active' : ''}`}
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Host load${localRunning.length ? ` · ${localRunning.length} local model server${localRunning.length > 1 ? 's' : ''} running` : ''}`}
      >
        <Gauge size={12} />
        <span>{formatPercent(snapshot.cpuPercent)}</span>
        <i />
        <span>{formatPercent(share(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes) * 100)}</span>
        {gpu && <><i /><span>{formatPercent(gpu.utilizationPercent)} GPU</span></>}
        <ChevronUp size={10} />
      </button>
      {open && createPortal(
        <section ref={popoverRef} className="system-performance-popover" style={position} role="dialog" aria-label="Host performance">
          <header>
            <span><MonitorCog size={15} /><strong>This machine</strong></span>
            <small className={level}><i /> {level}</small>
          </header>
          <div className="system-performance-summary">
            <article><Cpu size={13} /><span><strong>{formatPercent(snapshot.cpuPercent)}</strong><small>{snapshot.cpuCores} cores</small></span></article>
            <article><MemoryStick size={13} /><span><strong>{formatBytes(snapshot.memoryUsedBytes)}</strong><small>of {formatBytes(snapshot.memoryTotalBytes)}</small></span></article>
            {gpu
              ? <article><Gauge size={13} /><span><strong>{formatPercent(gpu.utilizationPercent)}</strong><small>{formatBytes(gpu.memoryUsedBytes)} of {formatBytes(gpu.memoryTotalBytes)} VRAM</small></span></article>
              : <article><Gauge size={13} /><span><strong>—</strong><small>no GPU telemetry</small></span></article>}
          </div>
          {snapshot.localServers.length > 0 && (
            <div className="system-performance-list">
              <h4>Local model servers</h4>
              {snapshot.localServers.map(server => (
                <article key={server.model}>
                  <span><strong>{server.label}</strong><small>{server.running ? `pid ${server.pid} · port ${server.port}` : 'not running'}</small></span>
                  <span className="system-performance-numbers">
                    {server.running
                      ? <>{formatPercent(server.cpuPercent)} CPU · {formatBytes(server.memoryBytes)}{server.gpuMemoryBytes ? ` · ${formatBytes(server.gpuMemoryBytes)} VRAM` : ''}</>
                      : 'idle'}
                  </span>
                </article>
              ))}
            </div>
          )}
          {snapshot.processes.length > 0 && (
            <div className="system-performance-list">
              <h4>Heaviest processes</h4>
              {snapshot.processes.map(process => (
                <article key={process.pid} className={process.kind}>
                  <span><strong title={process.label}>{process.label}</strong><small>{process.kind === 'other' ? `pid ${process.pid}` : process.kind === 'conductor' ? 'this app' : 'local model'}</small></span>
                  <span className="system-performance-numbers">{formatPercent(process.cpuPercent)} CPU · {formatBytes(process.memoryBytes)}{process.gpuMemoryBytes ? ` · ${formatBytes(process.gpuMemoryBytes)} VRAM` : ''}</span>
                </article>
              ))}
            </div>
          )}
          {(problem || snapshot.unavailable.length > 0) && (
            <footer>{problem || snapshot.unavailable.join(' ')}</footer>
          )}
        </section>,
        document.body
      )}
    </div>
  )
}
