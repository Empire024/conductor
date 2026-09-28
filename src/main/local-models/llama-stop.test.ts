import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { processControl, sameIdentity, STOP_DEADLINE_MS, stopOwnedServer, stopServer, validIdentity, type ProcessIdentity, type ProcessProbe, type RunRecord, type StopDeps, type TerminateResult } from './llama.ts'
import { defaultModelConfig, QWEN_9B } from './config.ts'

// Every process, kill, port and clock here is injected: no OS process is killed and no model
// server runs. Only the last block reads real identities (read-only) and exercises the kill
// helper's identity refusal against this test's own child.

const IDENTITY: ProcessIdentity = { creationTime: '134036123456789012', executable: 'D:\\ConductorLocal\\llama\\llama-server.exe' }
const running = (identity: ProcessIdentity = IDENTITY): ProcessProbe => ({ state: 'running', ...identity })
const owned = (over: Partial<RunRecord> = {}): RunRecord => ({ pid: 4242, port: 51999, model: QWEN_9B, file: 'q.gguf', startedAt: '2026-09-28T09:00:00Z', generation: 'gen-a', identity: IDENTITY, ...over })

interface WorldOptions {
  record?: RunRecord | null
  inspect?: (call: number) => ProcessProbe | Promise<ProcessProbe>
  terminate?: (call: number) => TerminateResult | Promise<TerminateResult>
  port?: (call: number) => boolean
  /** Swaps the record on disk after the n-th dependency call (a start writing a replacement). */
  replaceAfterTerminate?: RunRecord
  deadlineMs?: number
}

function world(options: WorldOptions = {}) {
  let stored: RunRecord | null = options.record === undefined ? owned() : options.record
  const calls = { inspect: 0, terminate: [] as Array<{ pid: number; identity: ProcessIdentity }>, port: 0, removed: 0 }
  const journal: Array<Record<string, unknown>> = []
  const deps: StopDeps = {
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
    pollMs: 5,
    deadlineMs: options.deadlineMs ?? 1500,
    readRecord: () => stored,
    removeRecord: () => { calls.removed++; stored = null },
    inspect: async () => (options.inspect ?? (() => running()))(++calls.inspect),
    terminate: async (pid, identity) => {
      calls.terminate.push({ pid, identity })
      if (options.replaceAfterTerminate) stored = options.replaceAfterTerminate
      return (options.terminate ?? (() => ({ state: 'exited' as const })))(calls.terminate.length)
    },
    portInUse: async () => (options.port ?? (() => false))(++calls.port),
    journal: entry => journal.push(entry)
  }
  return { deps, calls, journal, record: () => stored }
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})

describe('stopOwnedServer: positive controls', () => {
  it('stops the exact owned process, observes its exit and the free port, then drops the record', async () => {
    const w = world()
    const outcome = await stopOwnedServer(w.deps)
    expect(outcome).toEqual({ status: 'stopped', pid: 4242, killed: true, message: 'stopped (pid 4242)' })
    expect(w.calls.terminate).toEqual([{ pid: 4242, identity: IDENTITY }])
    expect(w.record()).toBeNull()
    expect(w.journal.map(entry => entry.event)).toEqual(['stop-requested', 'inspect', 'terminate', 'stopped'])
  })

  it('waits for a delayed exit after the kill and reports stopped only once exit is observed', async () => {
    const w = world({ terminate: () => ({ state: 'signalled' }), inspect: call => call < 4 ? running() : { state: 'absent' } })
    expect((await stopOwnedServer(w.deps)).status).toBe('stopped')
    expect(w.calls.inspect).toBe(4)
    expect(w.journal.some(entry => entry.event === 'exit-observed')).toBe(true)
  })

  it('needs no kill for a known target that has already exited', async () => {
    const w = world({ inspect: () => ({ state: 'absent' }) })
    const outcome = await stopOwnedServer(w.deps)
    expect(outcome).toMatchObject({ status: 'stopped', killed: false, message: 'not running (pid 4242 had already exited)' })
    expect(w.calls.terminate).toHaveLength(0)
    expect(w.record()).toBeNull()
  })

  it('waits for the port to free after exit', async () => {
    const w = world({ port: call => call < 3 })
    expect((await stopOwnedServer(w.deps)).status).toBe('stopped')
    expect(w.calls.port).toBe(3)
  })

  it('keeps a replacement record a start wrote during the stop (explicitly registered relaunch)', async () => {
    const replacement = owned({ pid: 5151, generation: 'gen-b', identity: { ...IDENTITY, creationTime: '134036999999999999' } })
    const w = world({ replaceAfterTerminate: replacement })
    expect((await stopOwnedServer(w.deps)).status).toBe('stopped')
    expect(w.calls.removed).toBe(0)
    expect(w.record()).toEqual(replacement)
    expect(w.journal.some(entry => entry.event === 'record-replaced')).toBe(true)
  })
})

describe('stopOwnedServer: ownership failures never reach a kill', () => {
  const refusals: Array<[string, RunRecord | null, RegExp]> = [
    ['adopted (null pid)', owned({ pid: null }), /did not start/],
    ['missing identity (older record)', owned({ identity: undefined }), /no launch identity/],
    ['missing generation', owned({ generation: undefined }), /no launch identity/],
    ['missing creation time', owned({ identity: { creationTime: '', executable: IDENTITY.executable } }), /no launch identity/],
    ['zero creation time', owned({ identity: { creationTime: '0', executable: IDENTITY.executable } }), /no launch identity/],
    ['relative executable', owned({ identity: { creationTime: IDENTITY.creationTime, executable: 'llama-server.exe' } }), /no launch identity/]
  ]
  for (const [name, record, message] of refusals) {
    it(`refuses ${name}: zero inspections, zero kills, record kept`, async () => {
      const w = world({ record })
      const outcome = await stopOwnedServer(w.deps)
      expect(outcome.status).toBe('refused')
      expect(outcome.message).toMatch(message)
      expect(w.calls.inspect).toBe(0)
      expect(w.calls.terminate).toHaveLength(0)
      expect(w.record()).toEqual(record)
    })
  }

  it('refuses when the record names another pid than the one chosen (PID changed between selection and stop)', async () => {
    const w = world()
    const outcome = await stopOwnedServer(w.deps, { expectedPid: 4141 })
    expect(outcome.status).toBe('refused')
    expect(w.calls.terminate).toHaveLength(0)
    expect(w.record()).toEqual(owned())
  })

  it('same pid, same image, different creation time: a reused pid is left alone', async () => {
    const w = world({ inspect: () => running({ ...IDENTITY, creationTime: '134036123456789999' }) })
    const outcome = await stopOwnedServer(w.deps)
    expect(outcome).toMatchObject({ status: 'stopped', killed: false })
    expect(outcome.message).toMatch(/belongs to another process, left alone/)
    expect(w.calls.terminate).toHaveLength(0)
  })

  it('same pid and creation time with a different image is not ours either', async () => {
    const w = world({ inspect: () => running({ ...IDENTITY, executable: 'C:\\Windows\\System32\\notepad.exe' }) })
    expect((await stopOwnedServer(w.deps)).status).toBe('stopped')
    expect(w.calls.terminate).toHaveLength(0)
  })

  it('image comparison ignores only case', () => {
    expect(sameIdentity(IDENTITY, { ...IDENTITY, executable: IDENTITY.executable.toUpperCase() })).toBe(true)
    expect(sameIdentity(IDENTITY, { ...IDENTITY, executable: IDENTITY.executable + ' ' })).toBe(false)
  })

  it('the kill helper finds another process on the pid at kill time: nothing killed, ours counted as exited', async () => {
    const w = world({ terminate: () => ({ state: 'mismatch', creationTime: '1', executable: 'C:\\x.exe' }) })
    const outcome = await stopOwnedServer(w.deps)
    expect(outcome).toMatchObject({ status: 'stopped', killed: false })
    expect(outcome.message).toMatch(/left alone/)
  })

  for (const [name, inspect] of [
    ['permission denied on the liveness query', () => ({ state: 'unknown', detail: 'open: Access is denied' })],
    ['failed initial inventory', () => ({ state: 'unknown', detail: 'process helper exited 1' })]
  ] as Array<[string, () => ProcessProbe]>) {
    it(`${name} is uncertainty, never absence: zero kills, record kept`, async () => {
      const w = world({ inspect })
      const outcome = await stopOwnedServer(w.deps)
      expect(outcome.status).toBe('uncertain')
      expect(outcome.message).toMatch(/nothing was stopped[\s\S]*record is kept/)
      expect(w.calls.terminate).toHaveLength(0)
      expect(w.record()).toEqual(owned())
    })
  }

  it('a hanging identity query ends at the deadline with zero kills', async () => {
    const w = world({ inspect: () => never(), deadlineMs: 150 })
    const started = Date.now()
    expect((await stopOwnedServer(w.deps)).status).toBe('uncertain')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(w.calls.terminate).toHaveLength(0)
  })
})

describe('stopOwnedServer: bounded, truthful failure', () => {
  it('a killer that fails to start and a target still running: uncertain, record kept', async () => {
    const w = world({ terminate: () => ({ state: 'unknown', detail: 'process helper failed to start: ENOENT' }), deadlineMs: 200 })
    const outcome = await stopOwnedServer(w.deps)
    expect(outcome.status).toBe('uncertain')
    expect(outcome.message).toMatch(/did not exit[\s\S]*ENOENT/)
    expect(w.record()).toEqual(owned())
  })

  it('a killer that exits nonzero but whose target did exit: stopped only after the exit is observed', async () => {
    const w = world({ terminate: () => ({ state: 'unknown', detail: 'process helper exited 1' }), inspect: call => call === 1 ? running() : { state: 'absent' } })
    expect((await stopOwnedServer(w.deps)).status).toBe('stopped')
    expect(w.calls.inspect).toBe(2)
  })

  it('a hanging killer is abandoned at the deadline: uncertain inside the bound', async () => {
    const w = world({ terminate: () => never(), deadlineMs: 200 })
    const started = Date.now()
    expect((await stopOwnedServer(w.deps)).status).toBe('uncertain')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(w.record()).toEqual(owned())
  })

  it('a target that survives the kill: uncertain, never stopped', async () => {
    const w = world({ terminate: () => ({ state: 'signalled' }), deadlineMs: 200 })
    const outcome = await stopOwnedServer(w.deps)
    expect(outcome.status).toBe('uncertain')
    expect(outcome.message).toMatch(/did not exit/)
    expect(w.record()).toEqual(owned())
  })

  it('failed inventory at the final check stays uncertain rather than reading as exit', async () => {
    const w = world({ terminate: () => ({ state: 'signalled' }), inspect: call => call === 1 ? running() : { state: 'unknown', detail: 'Access is denied' }, deadlineMs: 200 })
    expect((await stopOwnedServer(w.deps)).status).toBe('uncertain')
    expect(w.record()).toEqual(owned())
  })

  it('a port still answering after the target exited: uncertain, record kept', async () => {
    const w = world({ port: () => true, deadlineMs: 200 })
    const outcome = await stopOwnedServer(w.deps)
    expect(outcome.status).toBe('uncertain')
    expect(outcome.message).toMatch(/still answering/)
    expect(w.record()).toEqual(owned())
  })

  it('a hanging port probe counts as held', async () => {
    const w = world({ port: () => { throw new Error('unused') }, deadlineMs: 150 })
    w.deps.portInUse = () => never()
    expect((await stopOwnedServer(w.deps)).status).toBe('uncertain')
  })

  it('never exceeds the 20-second ceiling whatever deadline is asked for', async () => {
    let clock = 0
    const w = world({ terminate: () => ({ state: 'signalled' }), deadlineMs: 10 * 60_000 })
    w.deps.now = () => clock
    w.deps.sleep = async ms => { clock += ms }
    w.deps.pollMs = 1000
    const outcome = await stopOwnedServer(w.deps)
    expect(outcome.status).toBe('uncertain')
    expect(clock).toBeLessThanOrEqual(STOP_DEADLINE_MS)
    expect(clock).toBeGreaterThanOrEqual(STOP_DEADLINE_MS - 1000)
  })

  it('records each attempt as it happens', async () => {
    const w = world({ terminate: () => ({ state: 'signalled' }), deadlineMs: 100 })
    await stopOwnedServer(w.deps)
    expect(w.journal[0]).toMatchObject({ event: 'stop-requested', pid: 4242, generation: 'gen-a' })
    expect(w.journal.map(entry => entry.event)).toEqual(['stop-requested', 'inspect', 'terminate', 'uncertain'])
    expect(JSON.stringify(w.journal)).not.toMatch(/api-key/i)
  })
})

describe('stopServer: callers never see a refusal or uncertainty as success', () => {
  const model = defaultModelConfig(QWEN_9B)
  it('returns the stop message only for a confirmed stop', async () => {
    expect(await stopServer(model, { deps: world().deps })).toBe('stopped (pid 4242)')
    expect(await stopServer(model, { deps: world({ record: null }).deps })).toBe('not running')
  })
  it('stops the pid local.stop chose, and refuses when the record names another process by then', async () => {
    expect(await stopServer(model, { expectedPid: 4242, deps: world().deps })).toBe('stopped (pid 4242)')
    const replaced = world({ record: owned({ pid: 5151, generation: 'gen-b' }) })
    await expect(stopServer(model, { expectedPid: 4242, deps: replaced.deps })).rejects.toThrow(/names pid 5151, not the chosen pid 4242/)
    expect(replaced.calls.inspect).toBe(0)
    expect(replaced.calls.terminate).toHaveLength(0)
    expect(replaced.record()).toMatchObject({ pid: 5151, generation: 'gen-b' })
  })

  it('throws for refused and uncertain stops', async () => {
    await expect(stopServer(model, { deps: world({ record: owned({ pid: null }) }).deps })).rejects.toThrow(/did not start/)
    await expect(stopServer(model, { deps: world({ record: owned({ identity: undefined }) }).deps })).rejects.toThrow(/no launch identity/)
    await expect(stopServer(model, { deps: world({ port: () => true, deadlineMs: 100 }).deps })).rejects.toThrow(/record is kept/)
    await expect(stopServer(model, { expectedPid: 1, deps: world().deps })).rejects.toThrow(/not the chosen pid/)
  })
})

describe('validIdentity', () => {
  it('accepts a FILETIME or ps start stamp with an absolute image, nothing less', () => {
    expect(validIdentity(IDENTITY)).toBe(true)
    expect(validIdentity({ creationTime: 'Mon Sep 28 09:00:00 2026', executable: '/usr/local/bin/llama-server' })).toBe(true)
    for (const bad of [null, {}, { creationTime: '000', executable: IDENTITY.executable }, { creationTime: IDENTITY.creationTime, executable: '' }, { creationTime: '1;rm', executable: IDENTITY.executable }, { creationTime: 5, executable: IDENTITY.executable }])
      expect(validIdentity(bad), JSON.stringify(bad)).toBe(false)
  })
})

// Read-only against real processes: identity of a child this test owns, an absent pid, and the kill
// helper refusing a wrong identity (if that refusal were broken, only this test's own child dies).
describe.runIf(process.platform === 'win32')('processControl on this machine', () => {
  it('reads a pinned identity, reports absence, and refuses to kill on a creation-time mismatch', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject) })
    try {
      const probe = await processControl.inspect(child.pid!, 15_000)
      expect(probe.state).toBe('running')
      if (probe.state !== 'running') return
      expect(validIdentity(probe)).toBe(true)
      expect(probe.executable.toLowerCase()).toBe(process.execPath.toLowerCase())
      expect(await processControl.inspect(child.pid!, 15_000)).toEqual(probe)
      const refused = await processControl.terminate(child.pid!, { ...probe, creationTime: String(BigInt(probe.creationTime) + 1n) }, 15_000)
      expect(refused.state).toBe('mismatch')
      expect(child.exitCode).toBeNull()
      expect((await processControl.inspect(child.pid!, 15_000)).state).toBe('running')
      expect(await processControl.inspect(2147483644, 15_000)).toEqual({ state: 'absent' })
    } finally { child.kill() }
  }, 60_000)
})
