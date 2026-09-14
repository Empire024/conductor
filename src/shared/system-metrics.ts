/** Host resource telemetry. Conductor can saturate this machine on its own — a local Qwen
 *  server holds a model resident on the GPU while its sandbox burns cores, and the owner has no
 *  way to tell "the model is thinking" from "the machine is out of room" without leaving the
 *  app. These are the numbers that distinction needs, sampled in the main process and rendered
 *  as one small chip. */

export type ProcessKind = 'local-model' | 'conductor' | 'other'

export interface ProcessMetric {
  pid: number
  name: string
  kind: ProcessKind
  /** What the owner should recognise it as: a model id for a local server, otherwise the image
   *  name. */
  label: string
  /** Share of the whole machine, not of one core, so two rows can be compared and summed. */
  cpuPercent: number
  memoryBytes: number
  gpuMemoryBytes?: number
}

export interface GpuMetric {
  index: number
  name: string
  utilizationPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  temperatureC?: number
}

export interface LocalServerMetric {
  model: string
  label: string
  port: number
  pid: number | null
  running: boolean
  cpuPercent: number
  memoryBytes: number
  gpuMemoryBytes?: number
}

export interface SystemMetricsSnapshot {
  sampledAt: string
  /** Whole machine, averaged across cores between the previous sample and this one. */
  cpuPercent: number
  cpuCores: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  gpus: GpuMetric[]
  /** The rows worth showing: every running local model server, Conductor itself, and whatever
   *  else on this machine is currently expensive. Never the full process table. */
  processes: ProcessMetric[]
  localServers: LocalServerMetric[]
  /** Why a part of the picture is missing (no NVIDIA GPU, per-process listing refused), so the
   *  panel can say so instead of showing a confident zero. */
  unavailable: string[]
}

export type PerformanceLevel = 'calm' | 'busy' | 'hot'

export const BUSY_CPU_PERCENT = 60
export const HOT_CPU_PERCENT = 85
const HOT_MEMORY_SHARE = 0.9
const BUSY_MEMORY_SHARE = 0.75
const CONDUCTOR_BUSY_CPU_PERCENT = 25

export const share = (used: number, total: number): number => (total > 0 ? used / total : 0)

/** The chip earns its place on screen only when something is actually happening: a local model
 *  is resident, Conductor itself is expensive, or the machine as a whole is under load (which is
 *  how another program — a Blender render, a build — shows up here without being named). */
export function performanceChipVisible(snapshot: SystemMetricsSnapshot | null | undefined): boolean {
  if (!snapshot) return false
  if (snapshot.localServers.some(server => server.running)) return true
  if (snapshot.cpuPercent >= BUSY_CPU_PERCENT) return true
  if (share(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes) >= BUSY_MEMORY_SHARE) return true
  if (snapshot.gpus.some(gpu => gpu.utilizationPercent >= 50 || share(gpu.memoryUsedBytes, gpu.memoryTotalBytes) >= 0.8)) return true
  return snapshot.processes.some(process => process.kind === 'conductor' && process.cpuPercent >= CONDUCTOR_BUSY_CPU_PERCENT)
}

/** Hot is the level that means "starting more work here will thrash", so it is driven by the
 *  resources that cannot be oversubscribed gracefully: memory and VRAM. */
export function performanceLevel(snapshot: SystemMetricsSnapshot | null | undefined): PerformanceLevel {
  if (!snapshot) return 'calm'
  const memory = share(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes)
  const vram = Math.max(0, ...snapshot.gpus.map(gpu => share(gpu.memoryUsedBytes, gpu.memoryTotalBytes)))
  if (snapshot.cpuPercent >= HOT_CPU_PERCENT || memory >= HOT_MEMORY_SHARE || vram >= 0.95) return 'hot'
  if (snapshot.cpuPercent >= BUSY_CPU_PERCENT || memory >= BUSY_MEMORY_SHARE || vram >= 0.8) return 'busy'
  return 'calm'
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export const formatPercent = (value: number): string => `${Math.round(Math.max(0, Math.min(100, value)))}%`
