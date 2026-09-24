import { describe, expect, it } from 'vitest'
import type { DurableJobEventDraft } from './watchdog.ts'
import { LocalGenerationGate, ServerSupervisor, backoffSchedule, classifyServer, createLlamaServerPorts, type EnsureResult, type ServerLifecyclePorts, type ServerObservation } from './server-lifecycle.ts'

const MODEL = 'local/qwen3.6-35b-a3b'
const KEY = 'a'.repeat(8) + '0123456789abcdef0123456789abcdef'

const healthy = (pid: number, startedAt = 't0', models = [MODEL]): ServerObservation => ({ recordPresent: true, pid, pidAlive: true, port: 8081, listening: true, health: { ok: true, status: 200, models }, startedAt })
const dead: ServerObservation = { recordPresent: true, pid: 111, pidAlive: false, port: 8081, listening: false, health: null }

function fakePorts(probes: Array<ServerObservation | (() => ServerObservation)>, ensures: EnsureResult[] = []): ServerLifecyclePorts & { clock: number; sleeps: number[]; events: DurableJobEventDraft[]; ensureCalls: Array<{ allowSwitch: boolean }> } {
  const state = {
    clock: 0, sleeps: [] as number[], events: [] as DurableJobEventDraft[], ensureCalls: [] as Array<{ allowSwitch: boolean }>,
    secrets: [KEY],
    now: () => state.clock,
    sleep: async (ms: number) => { state.sleeps.push(ms); state.clock += ms },
    probe: async () => { const next = probes.length > 1 ? probes.shift()! : probes[0]!; return typeof next === 'function' ? next() : next },
    ensure: async (opts: { allowSwitch: boolean }) => { state.ensureCalls.push(opts); return ensures.length > 1 ? ensures.shift()! : ensures[0]! },
    emit: (event: DurableJobEventDraft) => { state.events.push(event) }
  }
  return state
}

describe('server lifecycle', () => {
  it('classifies dead, loading, unresponsive, wrong-model and healthy servers', () => {
    expect(classifyServer(dead, MODEL)).toBe('dead')
    expect(classifyServer({ ...dead, pidAlive: true }, MODEL)).toBe('loading')
    expect(classifyServer({ ...dead, pidAlive: true, listening: true, health: { ok: false, status: 503 } }, MODEL)).toBe('loading')
    expect(classifyServer({ ...dead, listening: true, health: { ok: false, status: 0, detail: 'timeout' } }, MODEL)).toBe('unresponsive')
    expect(classifyServer(healthy(1, 't', ['local/qwen3.5-9b']), MODEL)).toBe('wrong-model')
    expect(classifyServer(healthy(1), MODEL)).toBe('healthy')
  })

  it('computes a capped exponential backoff schedule', () => {
    expect(backoffSchedule({ attempts: 5, initialDelayMs: 5_000, factor: 2, maxDelayMs: 30_000 })).toEqual([5_000, 10_000, 20_000, 30_000])
    expect(backoffSchedule({ attempts: 1, initialDelayMs: 5_000, factor: 2, maxDelayMs: 30_000 })).toEqual([])
  })

  it('detects a dead server, retries the start path on the backoff schedule and blocks resumably', async () => {
    const ports = fakePorts([dead], [{ ok: false, reason: 'failed', message: `llama.cpp exited --api-key ${KEY}` }])
    const supervisor = new ServerSupervisor(MODEL, ports, { backoff: { attempts: 4, initialDelayMs: 1_000, factor: 3, maxDelayMs: 5_000 } })
    const result = await supervisor.ensureReady()
    expect(ports.ensureCalls).toHaveLength(4)
    expect(ports.sleeps).toEqual([1_000, 3_000, 5_000])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.blocked.resumable).toBe(true)
    expect(result.blocked.nextAction).toMatch(/server log/)
    expect(ports.events.every(event => event.kind === 'server')).toBe(true)
    expect(ports.events[0]!.message).toMatch(/is dead/)
    expect(JSON.stringify(ports.events) + JSON.stringify(result)).not.toContain(KEY)
  })

  it('recovers after a restart and reports the new identity once', async () => {
    const probes: ServerObservation[] = [healthy(100, 't0'), dead, healthy(200, 't1')]
    const ports = fakePorts(probes, [{ ok: true, port: 8081, pid: 200, message: 'healthy' }])
    const supervisor = new ServerSupervisor(MODEL, ports)
    expect((await supervisor.ensureReady()).ok).toBe(true)
    const recovered = await supervisor.ensureReady()
    expect(recovered).toMatchObject({ ok: true, restarted: true })
    expect(ports.ensureCalls).toHaveLength(1)
    expect(ports.events.some(event => /restarted/.test(event.message))).toBe(true)
  })

  it('notices a server restarted behind its back (new pid, same port) on check', async () => {
    const ports = fakePorts([healthy(100, 't0'), healthy(300, 't9')])
    const supervisor = new ServerSupervisor(MODEL, ports)
    expect((await supervisor.check()).restarted).toBe(false)
    expect((await supervisor.check()).restarted).toBe(true)
  })

  it('waits a loading server out instead of starting another one', async () => {
    const loading: ServerObservation = { ...dead, pidAlive: true }
    const ports = fakePorts([loading, loading, healthy(111)])
    const result = await new ServerSupervisor(MODEL, ports).ensureReady()
    expect(result.ok).toBe(true)
    expect(ports.ensureCalls).toHaveLength(0)
  })

  it('never switches a busy different model and blocks after the wait window naming it', async () => {
    const other: EnsureResult = { ok: false, reason: 'other-model', running: { model: 'local/qwen3.5-9b', ours: true, busy: '1 conversation is mid-turn on it in this Conductor' }, message: 'refused' }
    const ports = fakePorts([dead], [other])
    const result = await new ServerSupervisor(MODEL, ports, { pollMs: 60_000, waitForModelMs: 10 * 60_000, interactiveQuietMs: 60_000 }).ensureReady()
    expect(ports.ensureCalls.every(call => !call.allowSwitch)).toBe(true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocked.nextAction).toMatch(/in use/)
  })

  it('switches an idle Conductor-started model only after it stayed quiet for the window', async () => {
    const other: EnsureResult = { ok: false, reason: 'other-model', running: { model: 'local/qwen3.5-9b', ours: true, busy: null }, message: 'refused' }
    let switched = false
    const ports = fakePorts([() => switched ? healthy(500) : dead])
    ports.ensure = async opts => { ports.ensureCalls.push(opts); if (opts.allowSwitch) { switched = true; return { ok: true, port: 8081, pid: 500, message: 'stopped idle local/qwen3.5-9b to make room' } } return other }
    const result = await new ServerSupervisor(MODEL, ports, { pollMs: 60_000, interactiveQuietMs: 3 * 60_000 }).ensureReady()
    expect(result.ok).toBe(true)
    expect(ports.ensureCalls.map(call => call.allowSwitch)).toEqual([false, false, false, true])
  })

  it('with the wait policy leaves an idle other model alone and blocks', async () => {
    const other: EnsureResult = { ok: false, reason: 'other-model', running: { model: 'local/qwen3.5-9b', ours: true, busy: null }, message: 'refused' }
    const ports = fakePorts([dead], [other])
    const result = await new ServerSupervisor(MODEL, ports, { differentModel: 'wait', pollMs: 60_000, waitForModelMs: 5 * 60_000, interactiveQuietMs: 0 }).ensureReady()
    expect(ports.ensureCalls.every(call => !call.allowSwitch)).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('blocks at once on a setup problem', async () => {
    const ports = fakePorts([dead], [{ ok: false, reason: 'setup', message: 'Model file missing' }])
    const result = await new ServerSupervisor(MODEL, ports).ensureReady()
    expect(ports.ensureCalls).toHaveLength(1)
    expect(result.ok).toBe(false)
  })

  it('wires probe and ensure over the llama primitives without spawning anything', async () => {
    const events: DurableJobEventDraft[] = []
    const model = { id: MODEL, port: 8081 }
    const ports = await createLlamaServerPorts(MODEL, event => events.push(event), {
      loadConfig: (() => ({ llamaServer: 'llama-server.exe', models: { [MODEL]: model } })) as never,
      readApiKey: () => KEY,
      readRunRecord: () => ({ pid: 42, port: 8090, model: MODEL, file: 'x.gguf', startedAt: 's' }),
      processAlive: () => true,
      portInUse: async () => true,
      health: async () => ({ ok: true, status: 200, models: [MODEL] }),
      startServer: async () => { throw new Error(`Not enough memory to safely start ${MODEL}`) },
      releaseVerdict: async () => 'idle'
    })
    expect(await ports.probe()).toMatchObject({ pid: 42, port: 8090, pidAlive: true, listening: true, startedAt: 's' })
    expect(await ports.ensure({ allowSwitch: false })).toMatchObject({ ok: false, reason: 'resources' })
    expect(ports.secrets).toEqual([KEY])
  })
})

describe('local generation gate', () => {
  it('runs one job generation at a time and yields to an active interactive turn', async () => {
    let clock = 0
    let interactive: string | null = 'interactive turn on local/qwen3.5-9b'
    const gate = new LocalGenerationGate({ now: () => clock, sleep: async ms => { clock += ms; interactive = clock >= 10_000 ? null : interactive }, interactiveActive: async () => interactive }, { pollMs: 5_000 })
    const first = await gate.acquire('job-a')
    expect(first.yieldedTo).toMatch(/interactive/)
    expect(first.waitedMs).toBe(10_000)
    let secondGranted = false
    const second = gate.acquire('job-b').then(lease => { secondGranted = true; return lease })
    await Promise.resolve()
    expect(secondGranted).toBe(false)
    gate.noteInteractiveDemand()
    expect(gate.yieldRequested()).toBe(true)
    first.release()
    const lease = await second
    expect(gate.holder()).toBe('job-b')
    lease.release()
    expect(gate.holder()).toBeNull()
  })

  it('re-attaching a generation already under way queues behind the holder but does not yield to interactive work', async () => {
    let slept = 0
    const gate = new LocalGenerationGate({ now: () => 0, sleep: async () => { slept++ }, interactiveActive: async () => 'the resumed conversation\'s own turn' })
    const holder = await gate.acquire('job-a', undefined, { yieldToInteractive: false })
    let granted = false
    const resumed = gate.acquire('job-b', undefined, { yieldToInteractive: false }).then(lease => { granted = true; return lease })
    await Promise.resolve()
    expect(granted).toBe(false)
    holder.release()
    const lease = await resumed
    expect(lease.yieldedTo).toBeNull()
    expect(slept).toBe(0)
    expect(gate.holder()).toBe('job-b')
    lease.release()
  })
})
