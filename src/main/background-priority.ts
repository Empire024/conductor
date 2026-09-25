import { constants, getPriority, setPriority } from 'node:os'

/** Below normal: a parked test instance uses every idle cycle but yields the moment the owner's own
 *  Conductor needs one (typing-lag-under-test-load, docs/perf/typing-under-load.md). */
export const BACKGROUND_PRIORITY = constants.priority.PRIORITY_BELOW_NORMAL

export interface PriorityPorts {
  get: (pid: number) => number
  set: (pid: number, priority: number) => void
}

const osPorts: PriorityPorts = { get: getPriority, set: setPriority }

/** CONDUCTOR_BACKGROUND_PRIORITY=0 keeps a parked instance at normal priority: the owner stand-in
 *  of a typing measurement, or a run someone deliberately wants at full speed. */
export function parkedPriorityWanted(parked: boolean, env: NodeJS.ProcessEnv): boolean {
  return parked && env.CONDUCTOR_BACKGROUND_PRIORITY !== '0'
}

/** Lowers each pid that is not already at or below background priority (never raises an idle one).
 *  A process that is gone or refuses is skipped: this must never break a launch. Returns the pids
 *  it lowered. */
export function lowerToBackground(pids: Iterable<number>, ports: PriorityPorts = osPorts): number[] {
  const lowered: number[] = []
  for (const pid of pids) {
    try {
      if (ports.get(pid) >= BACKGROUND_PRIORITY) continue
      ports.set(pid, BACKGROUND_PRIORITY)
      lowered.push(pid)
    } catch { /* exited, or not ours to change */ }
  }
  return lowered
}

export interface ParkedPriorityOptions {
  parked: boolean
  env: NodeJS.ProcessEnv
  /** Every process the app has: main, GPU, renderers, utilities (app.getAppMetrics()). */
  processIds: () => number[]
  /** Subscribes to the moments new child processes appear; returns nothing, lives as long as the app. */
  onChildStarted: (sweep: () => void) => void
  ports?: PriorityPorts
  log?: (message: string) => void
}

/**
 * A parked automation instance (CONDUCTOR_TEST_USER_DATA, or CONDUCTOR_BACKGROUND_WINDOWS=1) runs
 * below normal priority, all of it. Lowering main first, before Chromium starts its GPU and
 * renderer processes, makes those inherit it (Windows passes BELOW_NORMAL to a child whose creator
 * asks for nothing else; POSIX always inherits nice); every child is swept again whenever one
 * starts, in case a launcher asked for normal. The runtime host and provider CLIs it spawns inherit
 * it from main. Returns whether it applies.
 */
export function applyParkedPriority(options: ParkedPriorityOptions): boolean {
  if (!parkedPriorityWanted(options.parked, options.env)) return false
  const ports = options.ports ?? osPorts
  lowerToBackground([process.pid], ports)
  const sweep = (): void => {
    const lowered = lowerToBackground(options.processIds(), ports)
    if (lowered.length) options.log?.(`[background-priority] lowered ${lowered.length} parked process(es) to below normal`)
  }
  options.onChildStarted(sweep)
  return true
}

/** What applyParkedPriority needs from Electron's app, so the wiring is testable without it. */
export interface ParkedPriorityApp {
  getAppMetrics: () => Array<{ pid: number }>
  whenReady: () => Promise<unknown>
  on: (event: 'web-contents-created', listener: (event: unknown, contents: { on: (event: 'dom-ready', listener: () => void) => unknown }) => void) => unknown
}

/** applyParkedPriority on Electron's app: swept once ready (the GPU process), whenever a page's DOM
 *  is ready (its renderer), and every 30 s (utility processes started later). */
export function startParkedPriority(electronApp: ParkedPriorityApp, parked: boolean, env: NodeJS.ProcessEnv, log?: (message: string) => void): boolean {
  return applyParkedPriority({
    parked, env, log,
    processIds: () => electronApp.getAppMetrics().map(metric => metric.pid),
    onChildStarted: sweep => {
      void electronApp.whenReady().then(sweep)
      electronApp.on('web-contents-created', (_event, contents) => { contents.on('dom-ready', sweep) })
      setInterval(sweep, 30_000).unref()
    }
  })
}
