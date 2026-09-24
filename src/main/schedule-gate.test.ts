import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decideScheduleGate,
  heavyAppsIn,
  inNightWindow,
  nextNightStart,
  SCHEDULE_GATE_THRESHOLDS,
  ScheduleGateProbe,
  smokeLockHeld,
  type ScheduleGateSignals
} from './schedule-gate.ts'
import type { ScheduleDefinition } from '../shared/schedules.ts'
import type { ProcessMetric, SystemMetricsSnapshot } from '../shared/system-metrics.ts'

// Local-time constructors throughout, so the night window means the same hours in any timezone.
const at = (hour: number, minute = 0, day = 24, month = 8): Date => new Date(2026, month, day, hour, minute)
const GiB = 1024 ** 3

const metrics = (overrides: Partial<SystemMetricsSnapshot> = {}): SystemMetricsSnapshot => ({
  sampledAt: at(14).toISOString(),
  cpuPercent: 6,
  cpuCores: 24,
  memoryUsedBytes: 20 * GiB,
  memoryTotalBytes: 63 * GiB,
  gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 5070', utilizationPercent: 3, memoryUsedBytes: GiB, memoryTotalBytes: 12 * GiB }],
  processes: [],
  localServers: [],
  unavailable: [],
  ...overrides
})

let nextPid = 1000
const proc = (name: string, cpuPercent: number, extra: Partial<ProcessMetric> = {}): ProcessMetric => ({
  pid: nextPid++,
  name,
  kind: 'other',
  label: name,
  cpuPercent,
  memoryBytes: 500 * 1024 ** 2,
  ...extra
})

const signals = (overrides: Partial<ScheduleGateSignals> = {}): ScheduleGateSignals => ({
  now: at(14),
  ownerIdleSeconds: 30 * 60,
  screenLocked: false,
  metrics: metrics(),
  conductorTurns: 0,
  smokeRunning: false,
  deliveryRunning: false,
  localUpdateBuilding: false,
  durableJobsRunning: 0,
  ...overrides
})

type GateTask = Pick<ScheduleDefinition, 'timing' | 'urgent' | 'nextDueAt'>
const task = (overrides: Partial<GateTask> = {}): GateTask => ({ timing: 'idle', urgent: false, nextDueAt: null, ...overrides })
const hoursBefore = (date: Date, hours: number): string => new Date(date.getTime() - hours * 3_600_000).toISOString()
const minutesAfter = (date: Date, minutes: number): string => new Date(date.getTime() + minutes * 60_000).toISOString()

describe('night window', () => {
  it('is 01:00 inclusive to 06:00 exclusive in local time', () => {
    expect(inNightWindow(at(0, 59))).toBe(false)
    expect(inNightWindow(at(1, 0))).toBe(true)
    expect(inNightWindow(at(5, 59))).toBe(true)
    expect(inNightWindow(at(6, 0))).toBe(false)
    expect(inNightWindow(at(14))).toBe(false)
  })

  it('wraps past midnight when it starts later than it ends', () => {
    const late = { ...SCHEDULE_GATE_THRESHOLDS, nightStartHour: 22, nightEndHour: 6 }
    expect(inNightWindow(at(23), late)).toBe(true)
    expect(inNightWindow(at(3), late)).toBe(true)
    expect(inNightWindow(at(7), late)).toBe(false)
    expect(inNightWindow(at(21, 59), late)).toBe(false)
    expect(nextNightStart(at(7), late).getTime()).toBe(at(22).getTime())
    expect(nextNightStart(at(23, 30), late).getTime()).toBe(at(23, 30).getTime())
  })

  it('names the next local 01:00, or the moment itself inside the window', () => {
    expect(nextNightStart(at(0, 30)).getTime()).toBe(at(1).getTime())
    expect(nextNightStart(at(14)).getTime()).toBe(at(1, 0, 25).getTime())
    expect(nextNightStart(at(2, 30)).getTime()).toBe(at(2, 30).getTime())
    // Across a month end: 30 September afternoon -> 1 October 01:00.
    expect(nextNightStart(at(14, 0, 30)).getTime()).toBe(new Date(2026, 9, 1, 1).getTime())
  })
})

describe('heavy apps', () => {
  it('matches image names case-insensitively and ignores a trailing .exe', () => {
    const apps = heavyAppsIn(metrics({ processes: [proc('Blender.EXE', 45), proc('Adobe Premiere Pro', 12), proc('chrome', 40)] }))
    expect(apps.map(app => app.name)).toEqual(['Blender', 'Premiere Pro'])
    expect(apps[0]!.cpuPercent).toBe(45)
  })

  it('ignores an app that is merely open, and counts one that holds VRAM', () => {
    expect(heavyAppsIn(metrics({ processes: [proc('blender', 0, { gpuMemoryBytes: 200 * 1024 ** 2 })] }))).toEqual([])
    expect(heavyAppsIn(metrics({ processes: [proc('blender', 0, { gpuMemoryBytes: 2 * GiB })] }))).toEqual([
      { name: 'Blender', cpuPercent: 0, gpuMemoryBytes: 2 * GiB }
    ])
  })

  it('never counts Conductor or a local model server, whatever they are called', () => {
    const processes = [proc('blender', 50, { kind: 'conductor' }), proc('blender', 50, { kind: 'local-model' })]
    expect(heavyAppsIn(metrics({ processes }))).toEqual([])
  })
})

describe('decideScheduleGate', () => {
  it('defers a non-urgent task while the owner is working, but not an urgent one', () => {
    const working = signals({ ownerIdleSeconds: 60 })
    const verdict = decideScheduleGate(task(), working)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe('You are using this computer (last input 1 min ago).')
    // Nine more minutes of quiet are needed before the owner counts as away.
    expect(verdict.retryAt).toBe(minutesAfter(at(14), 9))
    expect(verdict.signals).toContain('owner idle 1 min')

    const urgent = decideScheduleGate(task({ urgent: true }), working)
    expect(urgent.allowed).toBe(true)
    expect(urgent.reason).toMatch(/even while you are working/)
    expect(urgent.retryAt).toBeNull()
  })

  it('retries an active-owner deferral no sooner than retryMinutes', () => {
    const verdict = decideScheduleGate(task(), signals({ ownerIdleSeconds: 590 }))
    expect(verdict.reason).toBe('You are using this computer (last input 9 min ago).')
    expect(verdict.retryAt).toBe(minutesAfter(at(14), 5))
    expect(decideScheduleGate(task(), signals({ ownerIdleSeconds: 12 })).reason).toBe('You are using this computer (last input 12 s ago).')
  })

  it('counts a locked screen as away at once', () => {
    const verdict = decideScheduleGate(task(), signals({ ownerIdleSeconds: 5, screenLocked: true }))
    expect(verdict.allowed).toBe(true)
    expect(verdict.signals).toContain('screen locked')
    expect(verdict.reason).toBe('You are away and the machine is idle.')
  })

  it('holds a night task outside the window until the next local 01:00', () => {
    const verdict = decideScheduleGate(task({ timing: 'night', nextDueAt: hoursBefore(at(14), 2) }), signals())
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe('Waits for the night window (01:00-06:00).')
    expect(verdict.retryAt).toBe(at(1, 0, 25).toISOString())

    const justBefore = decideScheduleGate(task({ timing: 'night' }), signals({ now: at(0, 30) }))
    expect(justBefore.retryAt).toBe(at(1).toISOString())
  })

  it('names the configured window hours, two-digit', () => {
    const late = { ...SCHEDULE_GATE_THRESHOLDS, nightStartHour: 22, nightEndHour: 5 }
    expect(decideScheduleGate(task({ timing: 'night' }), signals(), late).reason).toBe('Waits for the night window (22:00-05:00).')
  })

  it('retries a night deferral when the starvation guard would release it, if that comes first', () => {
    // Due 20 h ago at 14:00: starved at 18:00 today, before tonight's 01:00.
    const verdict = decideScheduleGate(task({ timing: 'night', nextDueAt: hoursBefore(at(14), 20) }), signals())
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAt).toBe(at(18).toISOString())
  })

  it('runs a night task inside the window when the owner is away and the machine is quiet', () => {
    const verdict = decideScheduleGate(task({ timing: 'night' }), signals({ now: at(2, 30) }))
    expect(verdict).toMatchObject({ allowed: true, reason: 'Night window, you are away and the machine is idle.', retryAt: null })
    expect(verdict.signals).toEqual(expect.arrayContaining(['owner idle 30 min', 'night window', 'CPU 6%', 'GPU 3%']))
    expect(verdict.checkedAt).toBe(at(2, 30).toISOString())
  })

  it('runs an idle task in the afternoon when the owner is away and the machine is quiet', () => {
    const verdict = decideScheduleGate(task(), signals({ now: at(15, 10) }))
    expect(verdict).toMatchObject({ allowed: true, reason: 'You are away and the machine is idle.', retryAt: null })
    expect(verdict.signals).toContain('outside the night window (01:00-06:00)')
  })

  describe('starvation guard', () => {
    const overdue = task({ timing: 'night', nextDueAt: hoursBefore(at(14), 30) })

    it('lets an overdue night task run in a daytime idle window', () => {
      const verdict = decideScheduleGate(overdue, signals())
      expect(verdict.allowed).toBe(true)
      expect(verdict.reason).toBe('Overdue by more than 24 h, so it runs in this idle window instead of waiting for the night.')
      expect(verdict.signals).toContain('overdue 30 h')
    })

    it('lets an overdue task run alongside a durable job, which otherwise holds it', () => {
      expect(decideScheduleGate(overdue, signals({ durableJobsRunning: 1 })).allowed).toBe(true)
      const idleOverdue = decideScheduleGate(task({ nextDueAt: hoursBefore(at(14), 30) }), signals({ durableJobsRunning: 1 }))
      expect(idleOverdue.allowed).toBe(true)
      expect(idleOverdue.reason).toMatch(/alongside the overnight local-model job/)

      const fresh = decideScheduleGate(task({ timing: 'night' }), signals({ now: at(2), durableJobsRunning: 2 }))
      expect(fresh.allowed).toBe(false)
      expect(fresh.reason).toBe('2 overnight local-model jobs are running; scheduled work waits for them to finish.')
    })

    it('never overrides an active owner or a busy machine', () => {
      expect(decideScheduleGate(overdue, signals({ ownerIdleSeconds: 30 })).allowed).toBe(false)
      const busy = decideScheduleGate(overdue, signals({ metrics: metrics({ cpuPercent: 50 }) }))
      expect(busy.allowed).toBe(false)
      expect(busy.reason).toBe('The machine is busy (CPU 50%).')
    })

    it('starts exactly at starvationHours', () => {
      expect(decideScheduleGate(task({ timing: 'night', nextDueAt: hoursBefore(at(14), 24) }), signals()).allowed).toBe(true)
      expect(decideScheduleGate(task({ timing: 'night', nextDueAt: hoursBefore(at(14), 23.9) }), signals()).allowed).toBe(false)
    })
  })

  describe('machine load', () => {
    it('defers at machineCpuPercent and not below', () => {
      const verdict = decideScheduleGate(task(), signals({ metrics: metrics({ cpuPercent: 30 }) }))
      expect(verdict).toMatchObject({ allowed: false, reason: 'The machine is busy (CPU 30%).', retryAt: minutesAfter(at(14), 5) })
      expect(decideScheduleGate(task(), signals({ metrics: metrics({ cpuPercent: 29 }) })).allowed).toBe(true)
    })

    it('defers when a GPU is busy', () => {
      const gpus = [{ index: 0, name: 'RTX 5070', utilizationPercent: 72, memoryUsedBytes: 9 * GiB, memoryTotalBytes: 12 * GiB }]
      const verdict = decideScheduleGate(task(), signals({ metrics: metrics({ gpus }) }))
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toBe('The GPU is busy (72%).')
      expect(verdict.signals).toContain('GPU 72%')
    })

    it('defers for a busy unrelated process and names it', () => {
      const verdict = decideScheduleGate(task(), signals({ metrics: metrics({ cpuPercent: 25, processes: [proc('ffmpeg', 20)] }) }))
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toBe('ffmpeg is busy (CPU 20%).')
      expect(verdict.signals).toContain('ffmpeg CPU 20%')
    })

    it('defers for Blender at 45% and names Blender rather than the CPU it causes', () => {
      const verdict = decideScheduleGate(task(), signals({ metrics: metrics({ cpuPercent: 52, processes: [proc('blender', 45)] }) }))
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toBe('Blender is running (CPU 45%).')
      expect(verdict.signals).toContain('Blender CPU 45%')
    })

    it('does not defer for an idle Blender holding little VRAM', () => {
      const processes = [proc('blender', 0, { gpuMemoryBytes: 200 * 1024 ** 2 })]
      expect(decideScheduleGate(task(), signals({ metrics: metrics({ processes }) })).allowed).toBe(true)
    })

    it('defers for an idle heavy app holding a scene on the GPU', () => {
      const processes = [proc('blender', 0, { gpuMemoryBytes: 2 * GiB })]
      expect(decideScheduleGate(task(), signals({ metrics: metrics({ processes }) })).reason).toBe('Blender is running (CPU 0%, 2.0 GB VRAM).')
    })

    it('does not count a local model server as an unrelated busy process', () => {
      const processes = [proc('llama-server', 60, { kind: 'local-model', label: 'qwen3.5-9b' })]
      const verdict = decideScheduleGate(task(), signals({ metrics: metrics({ cpuPercent: 10, processes }) }))
      expect(verdict.allowed).toBe(true)
      expect(verdict.signals).toContain('local model qwen3.5-9b CPU 60%')
    })
  })

  describe('Conductor activity', () => {
    const cases: Array<[Partial<ScheduleGateSignals>, string]> = [
      [{ smokeRunning: true }, 'A smoke test is running; scheduled work waits for it to finish.'],
      [{ deliveryRunning: true }, 'A delivery is running its tests and build; scheduled work waits for it to finish.'],
      [{ localUpdateBuilding: true }, 'A local update build is running; scheduled work waits for it to finish.'],
      [{ conductorTurns: 1 }, 'A Conductor conversation is mid-turn; scheduled work waits until it is done.'],
      [{ conductorTurns: 2 }, '2 Conductor conversations are mid-turn; scheduled work waits until they are done.'],
      [{ durableJobsRunning: 1 }, 'An overnight local-model job is running; scheduled work waits for it to finish.']
    ]
    it.each(cases)('defers for %o', (overrides, reason) => {
      const verdict = decideScheduleGate(task(), signals(overrides))
      expect(verdict).toMatchObject({ allowed: false, reason, retryAt: minutesAfter(at(14), 5) })
    })

    it('names the activity in the signals', () => {
      const verdict = decideScheduleGate(task(), signals({ conductorTurns: 2, deliveryRunning: true }))
      expect(verdict.signals).toEqual(expect.arrayContaining(['2 Conductor turns running', 'delivery running']))
    })
  })

  describe('urgent tasks', () => {
    it('wait for a running smoke', () => {
      const verdict = decideScheduleGate(task({ urgent: true }), signals({ ownerIdleSeconds: 3, smokeRunning: true }))
      expect(verdict).toMatchObject({ allowed: false, reason: 'A smoke test is running; urgent work waits for it to finish.', retryAt: minutesAfter(at(14), 5) })
    })

    it('wait for a saturated machine', () => {
      const verdict = decideScheduleGate(task({ urgent: true }), signals({ metrics: metrics({ cpuPercent: 91 }) }))
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toMatch(/^The machine is saturated \(CPU 91%\)/)
      expect(decideScheduleGate(task({ urgent: true }), signals({ metrics: metrics({ cpuPercent: 84 }) })).allowed).toBe(true)
    })

    it('ignore the night window, deliveries, agents and heavy apps', () => {
      const busy = signals({
        ownerIdleSeconds: 1,
        deliveryRunning: true,
        conductorTurns: 3,
        durableJobsRunning: 1,
        metrics: metrics({ cpuPercent: 60, processes: [proc('blender', 45)] })
      })
      expect(decideScheduleGate(task({ urgent: true, timing: 'night' }), busy).allowed).toBe(true)
    })
  })

  it('does not block on unknown owner activity or missing metrics, but names both', () => {
    const verdict = decideScheduleGate(task(), signals({ ownerIdleSeconds: null, metrics: null }))
    expect(verdict.allowed).toBe(true)
    expect(verdict.signals).toEqual(expect.arrayContaining(['owner activity unknown', 'machine metrics unavailable']))
    expect(verdict.reason).toBe('Your activity is unknown and machine load is unknown.')
  })

  it('is deterministic for the same inputs', () => {
    const input = signals({ conductorTurns: 1, metrics: metrics({ processes: [proc('blender', 5)] }) })
    expect(decideScheduleGate(task(), input)).toEqual(decideScheduleGate(task(), input))
  })
})

describe('ScheduleGateProbe', () => {
  const baseDeps = () => ({ idleSeconds: () => 900, conductorTurns: () => 0, now: () => at(3), smokeRunning: () => false })

  it('takes two samples settleMs apart and reports the second', async () => {
    const events: string[] = []
    let calls = 0
    const probe = new ScheduleGateProbe({
      ...baseDeps(),
      sample: async () => { calls++; events.push(`sample ${calls}`); return metrics({ cpuPercent: calls === 1 ? 70 : 8 }) },
      sleep: async ms => { events.push(`sleep ${ms}`) }
    })
    const result = await probe.signals()
    expect(events).toEqual(['sample 1', `sleep ${SCHEDULE_GATE_THRESHOLDS.settleMs}`, 'sample 2'])
    expect(result.metrics?.cpuPercent).toBe(8)
    expect(result).toMatchObject({ now: at(3), ownerIdleSeconds: 900, screenLocked: false, conductorTurns: 0, deliveryRunning: false, localUpdateBuilding: false, durableJobsRunning: 0 })
  })

  it('uses the configured settle time', async () => {
    const slept: number[] = []
    const probe = new ScheduleGateProbe(
      { ...baseDeps(), sample: async () => metrics(), sleep: async ms => { slept.push(ms) } },
      { ...SCHEDULE_GATE_THRESHOLDS, settleMs: 1234 }
    )
    await probe.signals()
    expect(slept).toEqual([1234])
  })

  it('turns a failing sample into metrics: null instead of throwing', async () => {
    const first = new ScheduleGateProbe({ ...baseDeps(), sample: async () => { throw new Error('nvidia-smi hung') }, sleep: async () => {} })
    expect((await first.signals()).metrics).toBeNull()

    let calls = 0
    const second = new ScheduleGateProbe({
      ...baseDeps(),
      sample: async () => { if (++calls === 2) throw new Error('powershell refused'); return metrics() },
      sleep: async () => {}
    })
    expect((await second.signals()).metrics).toBeNull()
  })

  it('reads an unavailable idle time as unknown and passes the other signals through', async () => {
    const probe = new ScheduleGateProbe({
      ...baseDeps(),
      idleSeconds: () => { throw new Error('powerMonitor not ready') },
      screenLocked: () => true,
      sample: async () => metrics(),
      sleep: async () => {},
      conductorTurns: () => 2,
      smokeRunning: () => true,
      deliveryRunning: () => true,
      localUpdateBuilding: () => true,
      durableJobsRunning: () => 1
    })
    expect(await probe.signals()).toMatchObject({
      ownerIdleSeconds: null,
      screenLocked: true,
      conductorTurns: 2,
      smokeRunning: true,
      deliveryRunning: true,
      localUpdateBuilding: true,
      durableJobsRunning: 1
    })
  })
})

describe('smokeLockHeld', () => {
  it('sees a fresh lock directory, and ignores a missing or abandoned one', () => {
    const root = mkdtempSync(join(tmpdir(), 'schedule-gate-'))
    try {
      const lock = join(root, 'conductor-smoke.lock')
      expect(smokeLockHeld(lock)).toBe(false)
      const held = mkdtempSync(join(root, 'lock-'))
      expect(smokeLockHeld(held)).toBe(true)
      expect(smokeLockHeld(held, Date.now() + 21 * 60_000)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
