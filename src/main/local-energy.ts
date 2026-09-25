import { spawn } from 'node:child_process'
import { SYSTEM_SHARE_WATTS, type LocalEnergyReading } from '../shared/local-energy'

/**
 * Samples GPU board power while local model turns run and turns it into Wh per turn
 * (shared/local-energy.ts). One `nvidia-smi --query-gpu=index,power.draw -lms 500` process runs
 * only while at least one turn is metered and stops with the last one, so an idle Conductor never
 * polls the GPU. Readings of several GPUs are summed. Turns running at the same time split the
 * draw equally, so two conversations on one server never both claim the whole card.
 */

export interface PowerStream { stop(): void }
export interface EnergySamplerDeps {
  /** Starts the power stream: each stdout line is handed to onLine; onEnd reports why it ended
   *  (a spawn failure such as ENOENT, or an exit) so the meters can say "not measured". */
  start(onLine: (line: string) => void, onEnd: (reason: string) => void): PowerStream
  now(): number
  systemWatts?: number
}

export interface EnergyMeter { stop(): LocalEnergyReading }

interface MeterState { started: number; firstAt: number | null; energyJ: number; samples: number; peak: number; shared: boolean; failure?: string }

export class GpuEnergySampler {
  private stream: PowerStream | null = null
  private readonly meters = new Set<MeterState>()
  private readonly watts = new Map<string, number>()
  private lastAt: number | null = null
  /** Why power cannot be read on this machine; once known, later turns do not spawn again. */
  private unavailable: string | null = null

  constructor(private readonly deps: EnergySamplerDeps) {}

  begin(): EnergyMeter {
    const started = this.deps.now()
    const state: MeterState = { started, firstAt: this.lastAt !== null && this.watts.size ? started : null, energyJ: 0, samples: 0, peak: 0, shared: this.meters.size > 0 }
    if (this.meters.size) for (const other of this.meters) other.shared = true
    this.accrue(started)
    this.meters.add(state)
    if (!this.unavailable && !this.stream) this.open()
    let reading: LocalEnergyReading | null = null
    return { stop: () => reading ??= this.finish(state) }
  }

  private open(): void {
    this.watts.clear()
    this.lastAt = null
    try {
      this.stream = this.deps.start(line => this.onLine(line), reason => this.onEnd(reason))
    } catch (error) {
      this.onEnd(error instanceof Error ? error.message : String(error))
    }
  }

  private onLine(line: string): void {
    const match = /^\s*(\d+)\s*,\s*(.+?)\s*$/.exec(line)
    if (!match) return
    const now = this.deps.now()
    const value = Number(match[2])
    if (!Number.isFinite(value)) {
      // "[N/A]": the driver does not report power for this board.
      if (!this.watts.size) this.fail(`the GPU driver does not report power draw (nvidia-smi said "${match[2]}")`)
      return
    }
    this.accrue(now)
    this.watts.set(match[1]!, value)
    const total = this.total()
    for (const meter of this.meters) { meter.samples++; meter.peak = Math.max(meter.peak, total); meter.firstAt ??= now }
    this.lastAt = now
  }

  private onEnd(reason: string): void {
    this.stream = null
    const now = this.deps.now()
    this.accrue(now)
    if (!this.watts.size) this.fail(reason)
    // A stream that ended after it had worked loses only the time until the next turn reopens it.
    this.lastAt = null
    this.watts.clear()
  }

  private fail(reason: string): void {
    this.unavailable = reason
    for (const meter of this.meters) meter.failure = reason
    this.stream?.stop()
    this.stream = null
  }

  private total(): number {
    let sum = 0
    for (const value of this.watts.values()) sum += value
    return sum
  }

  /** Adds the draw since the last reading to every running meter, split between them. The span
   *  before a meter's first sample is filled with the first reading it sees, in finish(). */
  private accrue(now: number): void {
    if (this.lastAt === null || !this.watts.size || !this.meters.size) return
    const seconds = Math.max(0, now - this.lastAt) / 1000
    const share = this.total() * seconds / this.meters.size
    for (const meter of this.meters) meter.energyJ += share
    this.lastAt = now
  }

  private finish(state: MeterState): LocalEnergyReading {
    const now = this.deps.now()
    this.accrue(now)
    this.meters.delete(state)
    if (!this.meters.size && this.stream) { this.stream.stop(); this.stream = null; this.lastAt = null; this.watts.clear() }
    const durationMs = Math.max(0, now - state.started)
    const failure = state.failure ?? (state.samples ? null : this.unavailable)
    if (failure) return { measured: false, durationMs, reason: failure }
    if (!state.samples) return { measured: false, durationMs, reason: 'the turn ended before nvidia-smi reported a power reading' }
    // Power accrues between readings; the stretch before the meter's first reading (nvidia-smi
    // starting up) is charged at the average it then saw, which is closer than zero or the peak.
    const firstAt = state.firstAt ?? now
    const sampledMs = Math.max(0, now - firstAt)
    const sampledWatts = sampledMs > 0 ? state.energyJ / (sampledMs / 1000) : state.peak
    const joules = state.energyJ + sampledWatts * Math.max(0, firstAt - state.started) / 1000
    const averageGpuWatts = durationMs > 0 ? joules / (durationMs / 1000) : sampledWatts
    const systemWatts = this.deps.systemWatts ?? SYSTEM_SHARE_WATTS
    const gpuWh = joules / 3600
    const systemWh = systemWatts * durationMs / 3_600_000
    return { measured: true, source: 'nvidia-smi', durationMs, gpuWh, systemWh, totalWh: gpuWh + systemWh, averageGpuWatts, peakGpuWatts: state.peak, systemWatts, samples: state.samples, shared: state.shared }
  }
}

function nvidiaSmiStream(onLine: (line: string) => void, onEnd: (reason: string) => void): PowerStream {
  const child = spawn('nvidia-smi', ['--query-gpu=index,power.draw', '--format=csv,noheader,nounits', '-lms', '500'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let buffer = ''
  let stopped = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
  child.on('error', error => {
    if (stopped) return
    stopped = true
    onEnd((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'nvidia-smi is not available on this machine (no NVIDIA GPU tools), so GPU power cannot be read' : `nvidia-smi could not start: ${error.message}`)
  })
  child.on('exit', code => {
    if (stopped) return
    stopped = true
    onEnd(`nvidia-smi stopped (exit ${code ?? 'signal'}) before it reported power`)
  })
  return { stop: () => { if (stopped) return; stopped = true; child.kill() } }
}

let shared: GpuEnergySampler | null = null

/** Starts metering one local turn. Never throws: a machine without nvidia-smi gets a reading
 *  that says "not measured". */
export function startLocalEnergyMeter(): EnergyMeter {
  shared ??= new GpuEnergySampler({ start: nvidiaSmiStream, now: () => Date.now() })
  try { return shared.begin() } catch (error) {
    const started = Date.now()
    const reason = error instanceof Error ? error.message : String(error)
    return { stop: () => ({ measured: false, durationMs: Date.now() - started, reason }) }
  }
}
