import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScheduleDefinition, ScheduleGateVerdict } from '../shared/schedules.ts'
import {
  formatBytes,
  formatPercent,
  HOT_CPU_PERCENT,
  type ProcessMetric,
  type SystemMetricsSnapshot
} from '../shared/system-metrics.ts'

/** When a due scheduled run may start (docs/schedules.md). Scheduled tasks are background chores,
 *  so they take the hours nobody else wants: the night, or a stretch where the owner is away and
 *  the machine is quiet. Everything that could make a run unwelcome — the owner at the keyboard,
 *  a render, a smoke or a delivery, Conductor's own agents — is measured and judged here, and the
 *  verdict names what it saw so the Schedules panel can say why a task is waiting. */

export interface ScheduleGateThresholds {
  /** Local hour the night window opens (inclusive). */
  nightStartHour: number
  /** Local hour the night window closes (exclusive). */
  nightEndHour: number
  /** The owner counts as away after this long without keyboard or mouse input; a locked screen
   *  counts as away at once. */
  ownerIdleSeconds: number
  /** Whole-machine CPU at or above this is busy. */
  machineCpuPercent: number
  /** Whole-machine CPU at or above this holds back even an urgent run. */
  hotCpuPercent: number
  /** Any GPU's utilization at or above this is busy. */
  gpuPercent: number
  /** A single unrelated process at or above this share of the whole machine is busy. */
  processCpuPercent: number
  /** A known heavy app using at least this share of the whole machine is busy. */
  heavyAppCpuPercent: number
  /** ...or holding at least this much VRAM. */
  heavyAppGpuMemoryBytes: number
  /** Lower-case image names without `.exe`. */
  heavyApps: readonly string[]
  /** A task overdue by at least this long may run outside the night window and alongside a
   *  durable job, never while the owner works or the machine is busy. */
  starvationHours: number
  /** How soon a deferral is looked at again. */
  retryMinutes: number
  /** Gap between the probe's two metric samples. */
  settleMs: number
}

/** Tuned for this machine (docs/machine-profile.md: 24 threads, one 12 GB GPU). */
export const SCHEDULE_GATE_THRESHOLDS: ScheduleGateThresholds = Object.freeze({
  nightStartHour: 1,
  nightEndHour: 6,
  ownerIdleSeconds: 600,
  // About seven of 24 threads flat out: a build, a render or an encode, not a browser and a chat.
  machineCpuPercent: 30,
  // The level the performance chip calls hot: starting anything more there thrashes.
  hotCpuPercent: HOT_CPU_PERCENT,
  gpuPercent: 40,
  // Three to four threads of one program: a compile, an encode or a simulation, not a busy tab.
  processCpuPercent: 15,
  // Half a thread. A heavy app idling in its viewport stays under it; one that renders, bakes or
  // plays back does not, and that is exactly when a scheduled run would steal from it.
  heavyAppCpuPercent: 2,
  // A scene or a project resident on the card: a local model started now would spill to RAM.
  heavyAppGpuMemoryBytes: 1024 ** 3,
  heavyApps: Object.freeze([
    'blender',
    'houdini', 'houdinifx', 'hython',
    'maya', 'mayabatch',
    '3dsmax',
    'cinema 4d', 'c4d',
    'unity',
    'unrealeditor', 'ue4editor', 'ue5editor',
    'resolve', 'davinci resolve',
    'afterfx', 'adobe premiere pro', 'adobe media encoder', 'photoshop',
    'obs64',
    'handbrake', 'handbrakecli',
    'substance painter', 'adobe substance 3d painter',
    'zbrush',
    'fusion360'
  ]),
  starvationHours: 24,
  retryMinutes: 5,
  // Longer than SystemMetricsSampler's 1.5 s cache, so the second sample is a fresh measurement.
  settleMs: 4000
})

/** How the owner knows these programs; the image names are rarely what the title bar says. */
const HEAVY_APP_LABELS = new Map<string, string>([
  ['blender', 'Blender'],
  ['houdini', 'Houdini'], ['houdinifx', 'Houdini FX'], ['hython', 'Houdini'],
  ['maya', 'Maya'], ['mayabatch', 'Maya'],
  ['3dsmax', '3ds Max'],
  ['cinema 4d', 'Cinema 4D'], ['c4d', 'Cinema 4D'],
  ['unity', 'Unity'],
  ['unrealeditor', 'Unreal Editor'], ['ue4editor', 'Unreal Editor'], ['ue5editor', 'Unreal Editor'],
  ['resolve', 'DaVinci Resolve'], ['davinci resolve', 'DaVinci Resolve'],
  ['afterfx', 'After Effects'], ['adobe premiere pro', 'Premiere Pro'], ['adobe media encoder', 'Media Encoder'],
  ['photoshop', 'Photoshop'],
  ['obs64', 'OBS Studio'],
  ['handbrake', 'HandBrake'], ['handbrakecli', 'HandBrake'],
  ['substance painter', 'Substance Painter'], ['adobe substance 3d painter', 'Substance 3D Painter'],
  ['zbrush', 'ZBrush'],
  ['fusion360', 'Fusion 360']
])

export interface ScheduleGateSignals {
  now: Date
  /** null = unknown (no powerMonitor): not treated as active, but named in the verdict. */
  ownerIdleSeconds: number | null
  screenLocked: boolean
  /** null = unavailable: not treated as busy, but named in the verdict. */
  metrics: SystemMetricsSnapshot | null
  /** Conductor conversations mid-turn right now. */
  conductorTurns: number
  smokeRunning: boolean
  /** git.ship tests/build running. */
  deliveryRunning: boolean
  /** app.update build running. */
  localUpdateBuilding: boolean
  /** Overnight local-model jobs running. */
  durableJobsRunning: number
}

const pad = (hour: number): string => String(hour).padStart(2, '0')
const windowLabel = (thresholds: ScheduleGateThresholds): string =>
  `${pad(thresholds.nightStartHour)}:00-${pad(thresholds.nightEndHour)}:00`

/** "45 s", "23 min", "3 h 12 min". */
function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return `${whole} s`
  if (whole < 3600) return `${Math.floor(whole / 60)} min`
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Local time. A window whose start is later than its end wraps past midnight (22 to 6). Equal
 *  hours would be a zero-length window that holds night tasks forever, so they mean any hour. */
export function inNightWindow(date: Date, thresholds: ScheduleGateThresholds = SCHEDULE_GATE_THRESHOLDS): boolean {
  const { nightStartHour: start, nightEndHour: end } = thresholds
  if (start === end) return true
  const hour = date.getHours()
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** `date` itself when already inside the window, else the next local nightStartHour:00. Built
 *  from calendar fields rather than by adding 24 h, so a DST change still lands on local 01:00. */
export function nextNightStart(date: Date, thresholds: ScheduleGateThresholds = SCHEDULE_GATE_THRESHOLDS): Date {
  if (inNightWindow(date, thresholds)) return new Date(date.getTime())
  const year = date.getFullYear(), month = date.getMonth(), day = date.getDate()
  const today = new Date(year, month, day, thresholds.nightStartHour)
  return today.getTime() > date.getTime() ? today : new Date(year, month, day + 1, thresholds.nightStartHour)
}

export interface HeavyApp { name: string; cpuPercent: number; gpuMemoryBytes?: number }

const imageName = (name: string): string => name.trim().toLowerCase().replace(/\.exe$/, '')

/** Only unrelated programs count: Conductor and its local model servers are judged by turns,
 *  jobs and machine load instead. An app that is merely open (idle, little VRAM) does not. */
function heavyProcesses(metrics: SystemMetricsSnapshot, thresholds: ScheduleGateThresholds): ProcessMetric[] {
  const known = new Set(thresholds.heavyApps.map(imageName))
  return metrics.processes
    .filter(entry => entry.kind === 'other' && known.has(imageName(entry.name)))
    .filter(entry => entry.cpuPercent >= thresholds.heavyAppCpuPercent || (entry.gpuMemoryBytes ?? 0) >= thresholds.heavyAppGpuMemoryBytes)
    .sort((left, right) => right.cpuPercent - left.cpuPercent)
}

const heavyApp = (entry: ProcessMetric): HeavyApp => ({
  name: HEAVY_APP_LABELS.get(imageName(entry.name)) ?? entry.label,
  cpuPercent: entry.cpuPercent,
  ...(entry.gpuMemoryBytes !== undefined ? { gpuMemoryBytes: entry.gpuMemoryBytes } : {})
})

export function heavyAppsIn(metrics: SystemMetricsSnapshot, thresholds: ScheduleGateThresholds = SCHEDULE_GATE_THRESHOLDS): HeavyApp[] {
  return heavyProcesses(metrics, thresholds).map(heavyApp)
}

/** "CPU 45%" or "CPU 0%, 2.0 GB VRAM" when the VRAM is what makes it count. */
const heavyAppLoad = (app: HeavyApp, thresholds: ScheduleGateThresholds): string =>
  (app.gpuMemoryBytes ?? 0) >= thresholds.heavyAppGpuMemoryBytes
    ? `CPU ${formatPercent(app.cpuPercent)}, ${formatBytes(app.gpuMemoryBytes ?? 0)} VRAM`
    : `CPU ${formatPercent(app.cpuPercent)}`

/** Pure: the verdict depends only on its arguments (no clock reads), so the scheduler can
 *  re-derive and test any decision it shows. The first blocking reason wins; within machine
 *  load the most specific one goes first, so the owner reads "Blender is running" rather than
 *  the machine-wide CPU figure Blender caused. */
export function decideScheduleGate(
  task: Pick<ScheduleDefinition, 'timing' | 'urgent' | 'nextDueAt'>,
  signals: ScheduleGateSignals,
  thresholds: ScheduleGateThresholds = SCHEDULE_GATE_THRESHOLDS
): ScheduleGateVerdict {
  const now = signals.now
  const nowMs = now.getTime()
  const checkedAt = now.toISOString()
  const seen: string[] = []
  const allow = (reason: string): ScheduleGateVerdict => ({ allowed: true, reason, signals: seen, checkedAt, retryAt: null })
  const defer = (reason: string, retryAt: number): ScheduleGateVerdict =>
    ({ allowed: false, reason, signals: seen, checkedAt, retryAt: new Date(retryAt).toISOString() })
  const retryMs = thresholds.retryMinutes * 60_000
  const soon = nowMs + retryMs

  const idle = signals.ownerIdleSeconds
  seen.push(idle === null ? 'owner activity unknown' : `owner idle ${formatDuration(idle)}`)
  if (signals.screenLocked) seen.push('screen locked')
  const ownerActive = idle !== null && idle < thresholds.ownerIdleSeconds && !signals.screenLocked

  const night = inNightWindow(now, thresholds)
  seen.push(night ? 'night window' : `outside the night window (${windowLabel(thresholds)})`)

  const dueMs = task.nextDueAt ? Date.parse(task.nextDueAt) : Number.NaN
  const overdueMs = Number.isFinite(dueMs) ? nowMs - dueMs : 0
  const starvationMs = thresholds.starvationHours * 3_600_000
  const starved = Number.isFinite(dueMs) && overdueMs >= starvationMs
  if (overdueMs >= 3_600_000) seen.push(`overdue ${formatDuration(overdueMs / 1000)}`)

  const turns = Math.max(0, signals.conductorTurns)
  const jobs = Math.max(0, signals.durableJobsRunning)
  if (turns) seen.push(`${turns} Conductor ${turns === 1 ? 'turn' : 'turns'} running`)
  if (signals.smokeRunning) seen.push('smoke test running')
  if (signals.deliveryRunning) seen.push('delivery running')
  if (signals.localUpdateBuilding) seen.push('local update building')
  if (jobs) seen.push(`${jobs} durable ${jobs === 1 ? 'job' : 'jobs'} running`)

  const metrics = signals.metrics
  let heavy: HeavyApp[] = []
  let busyProcesses: ProcessMetric[] = []
  let busiestGpu = 0
  if (!metrics) seen.push('machine metrics unavailable')
  else {
    seen.push(`CPU ${formatPercent(metrics.cpuPercent)}`)
    for (const gpu of metrics.gpus) {
      seen.push(metrics.gpus.length === 1 ? `GPU ${formatPercent(gpu.utilizationPercent)}` : `GPU ${gpu.index} ${formatPercent(gpu.utilizationPercent)}`)
      busiestGpu = Math.max(busiestGpu, gpu.utilizationPercent)
    }
    const heavyRows = heavyProcesses(metrics, thresholds)
    heavy = heavyRows.map(heavyApp)
    for (const app of heavy) seen.push(`${app.name} ${heavyAppLoad(app, thresholds)}`)
    const heavyPids = new Set(heavyRows.map(entry => entry.pid))
    busyProcesses = metrics.processes
      .filter(entry => entry.kind === 'other' && entry.cpuPercent >= thresholds.processCpuPercent && !heavyPids.has(entry.pid))
      .sort((left, right) => right.cpuPercent - left.cpuPercent)
    for (const entry of busyProcesses) seen.push(`${entry.label} CPU ${formatPercent(entry.cpuPercent)}`)
    // Named so a high machine figure explains itself; a local model never blocks on its own.
    for (const entry of metrics.processes) {
      if (entry.kind === 'local-model') seen.push(`local model ${entry.label} CPU ${formatPercent(entry.cpuPercent)}`)
    }
  }

  if (task.urgent) {
    if (signals.smokeRunning) return defer('A smoke test is running; urgent work waits for it to finish.', soon)
    if (metrics && metrics.cpuPercent >= thresholds.hotCpuPercent) {
      return defer(`The machine is saturated (CPU ${formatPercent(metrics.cpuPercent)}); even urgent work waits for it to drop below ${thresholds.hotCpuPercent}%.`, soon)
    }
    return allow('Urgent, so it runs now even while you are working.')
  }

  if (ownerActive) {
    const remainingMs = (thresholds.ownerIdleSeconds - idle) * 1000
    return defer(`You are using this computer (last input ${formatDuration(idle)} ago).`, nowMs + Math.max(retryMs, remainingMs))
  }

  const waitsForNight = task.timing === 'night' && !night
  if (waitsForNight && !starved) {
    // Looked at again when the night opens, or earlier if the starvation guard lets it go first.
    const starvesAt = Number.isFinite(dueMs) ? dueMs + starvationMs : Number.POSITIVE_INFINITY
    return defer(`Waits for the night window (${windowLabel(thresholds)}).`, Math.min(nextNightStart(now, thresholds).getTime(), starvesAt))
  }

  if (signals.smokeRunning) return defer('A smoke test is running; scheduled work waits for it to finish.', soon)
  if (signals.deliveryRunning) return defer('A delivery is running its tests and build; scheduled work waits for it to finish.', soon)
  if (signals.localUpdateBuilding) return defer('A local update build is running; scheduled work waits for it to finish.', soon)
  if (turns) {
    return defer(turns === 1
      ? 'A Conductor conversation is mid-turn; scheduled work waits until it is done.'
      : `${turns} Conductor conversations are mid-turn; scheduled work waits until they are done.`, soon)
  }
  if (jobs && !starved) {
    return defer(jobs === 1
      ? 'An overnight local-model job is running; scheduled work waits for it to finish.'
      : `${jobs} overnight local-model jobs are running; scheduled work waits for them to finish.`, soon)
  }

  if (metrics) {
    const app = heavy[0]
    if (app) return defer(`${app.name} is running (${heavyAppLoad(app, thresholds)}).`, soon)
    const busy = busyProcesses[0]
    if (busy) return defer(`${busy.label} is busy (CPU ${formatPercent(busy.cpuPercent)}).`, soon)
    if (metrics.cpuPercent >= thresholds.machineCpuPercent) return defer(`The machine is busy (CPU ${formatPercent(metrics.cpuPercent)}).`, soon)
    if (busiestGpu >= thresholds.gpuPercent) return defer(`The GPU is busy (${formatPercent(busiestGpu)}).`, soon)
  }

  if (starved && waitsForNight) {
    return allow(`Overdue by more than ${thresholds.starvationHours} h, so it runs in this idle window instead of waiting for the night.`)
  }
  if (starved && jobs) {
    return allow(`Overdue by more than ${thresholds.starvationHours} h, so it runs alongside the overnight local-model job.`)
  }
  // Say what was actually known: an unknown owner or unmeasured machine is not claimed as away or idle.
  const away = idle === null && !signals.screenLocked ? 'your activity is unknown' : 'you are away'
  const quiet = metrics ? 'the machine is idle' : 'machine load is unknown'
  return allow(night ? `Night window, ${away} and ${quiet}.` : `${capitalize(away)} and ${quiet}.`)
}

/** The lock scripts/smoke-lock.mjs holds while a smoke runs. */
export const SMOKE_LOCK_DIR = join(tmpdir(), 'conductor-smoke.lock')
/** smoke-lock.mjs's own stale limit: past it the next smoke replaces the lock as abandoned. */
const SMOKE_LOCK_STALE_MS = 20 * 60_000

/** A lock a crashed smoke left behind is not a running smoke, and honouring it would hold even
 *  urgent tasks until some later smoke happened to clear it. */
export function smokeLockHeld(path: string = SMOKE_LOCK_DIR, nowMs: number = Date.now()): boolean {
  try { return nowMs - statSync(path).mtimeMs <= SMOKE_LOCK_STALE_MS } catch { return false }
}

export interface ScheduleGateProbeDeps {
  now?(): Date
  /** Electron powerMonitor.getSystemIdleTime(). */
  idleSeconds(): number | null
  /** powerMonitor.getSystemIdleState(1) === 'locked'. */
  screenLocked?(): boolean
  /** SystemMetricsSampler.sample(). */
  sample(): Promise<SystemMetricsSnapshot>
  sleep?(ms: number): Promise<void>
  conductorTurns(): number
  /** Default: the smoke lock directory exists and is not stale. */
  smokeRunning?(): boolean
  deliveryRunning?(): boolean
  localUpdateBuilding?(): boolean
  durableJobsRunning?(): number
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Gathers ScheduleGateSignals from the live app. Kept apart from the decision so the rules stay
 *  pure and the probe is the only place that touches Electron, the clock and the file system. */
export class ScheduleGateProbe {
  private readonly deps: ScheduleGateProbeDeps
  private readonly thresholds: ScheduleGateThresholds

  constructor(deps: ScheduleGateProbeDeps, thresholds: ScheduleGateThresholds = SCHEDULE_GATE_THRESHOLDS) {
    this.deps = deps
    this.thresholds = thresholds
  }

  /** Two metric samples settleMs apart so CPU and per-process figures describe the last few
   *  seconds, not the time since whoever sampled last. A failing sample yields metrics: null,
   *  never a throw. */
  async signals(): Promise<ScheduleGateSignals> {
    const metrics = await this.settledMetrics()
    // Everything else is read after the settle, so the verdict describes one moment.
    const now = this.deps.now?.() ?? new Date()
    return {
      now,
      ownerIdleSeconds: this.idleSeconds(),
      screenLocked: this.screenLocked(),
      metrics,
      conductorTurns: Math.max(0, this.deps.conductorTurns()),
      smokeRunning: this.deps.smokeRunning ? this.deps.smokeRunning() : smokeLockHeld(SMOKE_LOCK_DIR, now.getTime()),
      deliveryRunning: this.deps.deliveryRunning?.() ?? false,
      localUpdateBuilding: this.deps.localUpdateBuilding?.() ?? false,
      durableJobsRunning: Math.max(0, this.deps.durableJobsRunning?.() ?? 0)
    }
  }

  private async settledMetrics(): Promise<SystemMetricsSnapshot | null> {
    const sleep = this.deps.sleep ?? wait
    try {
      // The first sample only sets the baseline: its figures cover whatever interval the last
      // caller (the performance chip, or nobody for hours) happened to leave behind.
      await this.deps.sample()
      await sleep(this.thresholds.settleMs)
      return await this.deps.sample()
    } catch {
      return null
    }
  }

  /** powerMonitor can refuse before the app is ready; that is unknown, not active. */
  private idleSeconds(): number | null {
    try {
      const value = this.deps.idleSeconds()
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    } catch {
      return null
    }
  }

  private screenLocked(): boolean {
    try { return this.deps.screenLocked?.() ?? false } catch { return false }
  }
}
