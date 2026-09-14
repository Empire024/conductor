import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import type {
  GpuMetric,
  LocalServerMetric,
  ProcessMetric,
  SystemMetricsSnapshot
} from '../shared/system-metrics.ts'
import { loadConfig } from './local-models/config.ts'
import { processAlive, readRunRecord } from './local-models/llama.ts'

/** Conductor's own processes, as Electron already measures them. Taking these from the runtime
 *  rather than the process table means the browser/GPU/utility children are attributed to
 *  Conductor even though Windows only knows them as more copies of the same executable. */
export interface AppProcessMetric { pid: number; type: string; cpuPercent: number; memoryBytes: number }

export interface CpuSample { idle: number; total: number }

export const cpuSample = (): CpuSample => {
  let idle = 0, total = 0
  for (const core of cpus()) {
    idle += core.times.idle
    for (const value of Object.values(core.times)) total += value
  }
  return { idle, total }
}

/** Busy share of the whole machine between two samples. A repeated sample (no elapsed ticks)
 *  reports 0 rather than dividing by zero. */
export function cpuPercentBetween(previous: CpuSample, next: CpuSample): number {
  const total = next.total - previous.total
  if (total <= 0) return 0
  const busy = total - (next.idle - previous.idle)
  return Math.max(0, Math.min(100, (busy / total) * 100))
}

export interface RawProcess { pid: number; name: string; memoryBytes: number; cpuSeconds: number }

/** `Get-Process | ConvertTo-Json` gives an object for a single match and an array otherwise, and
 *  omits CPU for processes this session may not query. Both shapes are normal, neither is an
 *  error worth surfacing. */
export function parseProcessList(json: string): RawProcess[] {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return [] }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const processes: RawProcess[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const pid = Number(record.Id)
    if (!Number.isInteger(pid) || pid <= 0) continue
    processes.push({
      pid,
      name: typeof record.ProcessName === 'string' ? record.ProcessName : String(pid),
      memoryBytes: Number(record.WorkingSet64) || 0,
      cpuSeconds: Number(record.CPU) || 0
    })
  }
  return processes
}

/** `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu
 *  --format=csv,noheader,nounits`. Memory is reported in MiB. */
export function parseGpuQuery(stdout: string): GpuMetric[] {
  const gpus: GpuMetric[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = line.split(',').map(field => field.trim())
    if (fields.length < 5) continue
    const index = Number(fields[0])
    if (!Number.isInteger(index)) continue
    gpus.push({
      index,
      name: fields[1] || `GPU ${index}`,
      utilizationPercent: Number(fields[2]) || 0,
      memoryUsedBytes: (Number(fields[3]) || 0) * 1024 ** 2,
      memoryTotalBytes: (Number(fields[4]) || 0) * 1024 ** 2,
      ...(Number.isFinite(Number(fields[5])) ? { temperatureC: Number(fields[5]) } : {})
    })
  }
  return gpus
}

/** `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits`: which
 *  processes actually hold VRAM, which is the only way to attribute a resident model to the
 *  llama.cpp server that loaded it. */
export function parseComputeApps(stdout: string): Map<number, number> {
  const byPid = new Map<number, number>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [rawPid, rawMemory] = line.split(',').map(field => field.trim())
    const pid = Number(rawPid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    // Windows drivers running in WDDM mode report every row as [N/A]: per-process VRAM is simply
    // not available there. An unknown figure is left out, never recorded as zero, so the panel
    // says nothing about it rather than claiming the model holds no memory on the card.
    const used = Number(rawMemory)
    if (!Number.isFinite(used) || used <= 0) continue
    // One process can hold memory on several GPUs; the rows sum rather than overwrite.
    byPid.set(pid, (byPid.get(pid) ?? 0) + used * 1024 ** 2)
  }
  return byPid
}

/** The rows the panel shows. Every local model server and Conductor itself are always listed —
 *  the owner asked about those explicitly — and the rest of the table contributes only its most
 *  expensive few, which is how an unrelated render or build becomes visible without Conductor
 *  keeping a list of other people's programs. */
export function selectNotableProcesses(processes: readonly ProcessMetric[], limit = 5): ProcessMetric[] {
  const named = processes.filter(process => process.kind !== 'other')
  const others = processes
    .filter(process => process.kind === 'other' && (process.cpuPercent >= 3 || process.memoryBytes >= 1024 ** 3))
    .sort((left, right) => right.cpuPercent - left.cpuPercent || right.memoryBytes - left.memoryBytes)
    .slice(0, limit)
  return [...named.sort((left, right) => right.cpuPercent - left.cpuPercent), ...others]
}

const run = (file: string, args: string[], timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })

export interface LocalServerTarget { model: string; label: string; port: number; pid: number | null; running: boolean }

/** Which local model servers exist and which are alive, read from the run records the launcher
 *  writes. An unconfigured local root is not an error here: it only means there is nothing local
 *  to measure. */
export function localServerTargets(): LocalServerTarget[] {
  try {
    const config = loadConfig()
    return Object.values(config.models).map(model => {
      const record = readRunRecord(model)
      const running = Boolean(record && processAlive(record.pid))
      return { model: model.id, label: model.label, port: model.port, pid: running ? record!.pid : null, running }
    })
  } catch { return [] }
}

export interface SamplerOptions {
  /** Electron's own per-process measurements; omitted in tests and on a headless run. */
  appMetrics?: () => AppProcessMetric[]
  localServers?: () => LocalServerTarget[]
  /** A sample costs two short child processes, so repeated reads inside this window are served
   *  from the last one. */
  minIntervalMs?: number
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<string>
  platform?: NodeJS.Platform
}

/** Samples the host on demand. Nothing is polled in the background: the renderer asks while the
 *  chip or its panel is on screen, and an idle Conductor measures nothing at all. */
export class SystemMetricsSampler {
  private previousCpu = cpuSample()
  private previousAt = Date.now()
  private previousProcessCpu = new Map<number, number>()
  private cached: SystemMetricsSnapshot | null = null
  private cachedAt = 0
  private inFlight: Promise<SystemMetricsSnapshot> | null = null
  private gpuMissing = false
  private processListMissing = false
  private readonly options: Required<Pick<SamplerOptions, 'minIntervalMs' | 'exec' | 'platform'>> & SamplerOptions

  constructor(options: SamplerOptions = {}) {
    this.options = { minIntervalMs: 1500, exec: run, platform: process.platform, ...options }
  }

  async sample(): Promise<SystemMetricsSnapshot> {
    if (this.cached && Date.now() - this.cachedAt < this.options.minIntervalMs) return this.cached
    if (this.inFlight) return this.inFlight
    this.inFlight = this.measure().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async gpus(unavailable: string[]): Promise<{ gpus: GpuMetric[]; vramByPid: Map<number, number> }> {
    if (this.gpuMissing) return { gpus: [], vramByPid: new Map() }
    try {
      const [query, apps] = await Promise.all([
        this.options.exec('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], 6000),
        this.options.exec('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], 6000).catch(() => '')
      ])
      return { gpus: parseGpuQuery(query), vramByPid: parseComputeApps(apps) }
    } catch {
      // A machine with no NVIDIA tooling will never grow one mid-run, so stop paying for the
      // spawn after the first refusal.
      this.gpuMissing = true
      unavailable.push('No NVIDIA GPU telemetry on this machine (nvidia-smi did not answer).')
      return { gpus: [], vramByPid: new Map() }
    }
  }

  private async processTable(unavailable: string[]): Promise<RawProcess[]> {
    if (this.processListMissing || this.options.platform !== 'win32') {
      if (this.options.platform !== 'win32') unavailable.push('Per-process detail is measured on Windows only.')
      return []
    }
    try {
      const stdout = await this.options.exec('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-Process | Select-Object -Property Id,ProcessName,WorkingSet64,CPU | ConvertTo-Json -Compress'
      ], 10_000)
      return parseProcessList(stdout)
    } catch {
      this.processListMissing = true
      unavailable.push('The process table could not be read, so only machine totals are shown.')
      return []
    }
  }

  private async measure(): Promise<SystemMetricsSnapshot> {
    const unavailable: string[] = []
    const servers = (this.options.localServers ?? localServerTargets)()
    const [{ gpus, vramByPid }, table] = await Promise.all([this.gpus(unavailable), this.processTable(unavailable)])

    const now = Date.now()
    const elapsedSeconds = Math.max(0.001, (now - this.previousAt) / 1000)
    const nextCpu = cpuSample()
    const cpuPercent = cpuPercentBetween(this.previousCpu, nextCpu)
    this.previousCpu = nextCpu
    this.previousAt = now

    const cores = Math.max(1, cpus().length)
    const localPids = new Map<number, string>()
    for (const server of servers) if (server.pid) localPids.set(server.pid, server.label)
    const appProcesses = this.options.appMetrics?.() ?? []
    const conductorPids = new Set(appProcesses.map(metric => metric.pid))

    const processCpu = new Map<number, number>()
    const measured: ProcessMetric[] = []
    for (const row of table) {
      processCpu.set(row.pid, row.cpuSeconds)
      const previous = this.previousProcessCpu.get(row.pid)
      // A process first seen in this sample has no delta to compare against; reporting 0 for one
      // interval is honest, where dividing its lifetime CPU by the interval would not be.
      const percent = previous === undefined ? 0 : Math.max(0, Math.min(100, ((row.cpuSeconds - previous) / elapsedSeconds / cores) * 100))
      const label = localPids.get(row.pid)
      if (conductorPids.has(row.pid)) continue
      measured.push({
        pid: row.pid,
        name: row.name,
        kind: label ? 'local-model' : 'other',
        label: label ?? row.name,
        cpuPercent: percent,
        memoryBytes: row.memoryBytes,
        ...(vramByPid.has(row.pid) ? { gpuMemoryBytes: vramByPid.get(row.pid) } : {})
      })
    }
    this.previousProcessCpu = processCpu

    // Conductor is reported as one row: its windows, GPU process and utility children are all
    // the same program to the owner, and Electron already attributes them.
    if (appProcesses.length) {
      measured.push({
        pid: appProcesses.find(metric => metric.type === 'Browser')?.pid ?? appProcesses[0]!.pid,
        name: 'Conductor',
        kind: 'conductor',
        label: `Conductor (${appProcesses.length} processes)`,
        cpuPercent: Math.min(100, appProcesses.reduce((total, metric) => total + metric.cpuPercent, 0) / cores),
        memoryBytes: appProcesses.reduce((total, metric) => total + metric.memoryBytes, 0),
        ...(appProcesses.some(metric => vramByPid.has(metric.pid))
          ? { gpuMemoryBytes: appProcesses.reduce((total, metric) => total + (vramByPid.get(metric.pid) ?? 0), 0) }
          : {})
      })
    }

    const byPid = new Map(measured.map(process => [process.pid, process]))
    const localServers: LocalServerMetric[] = servers.map(server => {
      const process = server.pid ? byPid.get(server.pid) : undefined
      return {
        model: server.model,
        label: server.label,
        port: server.port,
        pid: server.pid,
        running: server.running,
        cpuPercent: process?.cpuPercent ?? 0,
        memoryBytes: process?.memoryBytes ?? 0,
        ...(process?.gpuMemoryBytes ? { gpuMemoryBytes: process.gpuMemoryBytes } : {})
      }
    })

    const snapshot: SystemMetricsSnapshot = {
      sampledAt: new Date(now).toISOString(),
      cpuPercent,
      cpuCores: cores,
      memoryUsedBytes: totalmem() - freemem(),
      memoryTotalBytes: totalmem(),
      gpus,
      processes: selectNotableProcesses(measured),
      localServers,
      unavailable
    }
    this.cached = snapshot
    this.cachedAt = Date.now()
    return snapshot
  }
}
