import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BootDiagnostics, bootFailureRequest, type BootRecord } from './boot-diagnostics'
import { bootVerdict } from './recovery/boot-verdict'

describe('boot diagnostics: every stage is on disk the moment it begins', () => {
  let directory = ''
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

  const recorder = (options: { pid?: number; heap?: () => number; alive?: (pid: number) => boolean; hooks?: EventEmitter } = {}) => {
    directory ||= mkdtempSync(join(tmpdir(), 'boot-diagnostics-'))
    let now = Date.parse('2026-10-22T10:00:00.000Z')
    const diagnostics = new BootDiagnostics({
      directory, pid: options.pid ?? 1000, version: '0.1.59-local.9', packaged: true, exe: 'C:\\Conductor.exe', startedAtMs: now - 200,
      now: () => (now += 100), memory: () => ({ heapMb: options.heap?.() ?? 50, rssMb: 120, heapLimitMb: 4096 }),
      isAlive: options.alive ?? (() => false), sampler: false, processHooks: (options.hooks as unknown as NodeJS.Process) ?? null
    })
    return diagnostics
  }
  const onDisk = (): BootRecord => JSON.parse(readFileSync(join(directory, 'boot.json'), 'utf8')) as BootRecord
  const history = (): Array<Record<string, unknown>> => readFileSync(join(directory, 'boot-history.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)

  it('writes each stage synchronously, with its time and memory, and the peak heap', () => {
    let heap = 40
    const diagnostics = recorder({ heap: () => heap }).start()
    expect(onDisk()).toMatchObject({ schema: 1, pid: 1000, version: '0.1.59-local.9', stage: 'single-instance', outcome: 'booting', heapLimitMb: 4096 })
    heap = 3900
    diagnostics.stage('structured-store')
    const record = onDisk()
    expect(record.stage).toBe('structured-store')
    expect(record.stages.map(stage => stage.name)).toEqual(['process-start', 'single-instance', 'structured-store'])
    expect(record.stages.at(-1)).toMatchObject({ heapMb: 3900, rssMb: 120 })
    expect(record.stages.at(-1)!.ms).toBeGreaterThan(record.stages[1]!.ms)
    expect(record.peak.heapMb).toBe(3900)
    // A process killed now (an OOM abort runs no JavaScript) is read as dying in that stage.
    expect(bootVerdict({ record, alive: false, exitCode: 3758096392, log: '', now: Date.now() })).toMatchObject({ state: 'died', stage: 'structured-store', cause: 'oom' })
  })

  it('becomes ready only when app control answers and a window has loaded, and records it in the history', () => {
    const diagnostics = recorder().start()
    diagnostics.stage('control-api')
    diagnostics.markWindowLoaded()
    expect(onDisk().outcome).toBe('booting')
    diagnostics.markControlReady()
    const record = onDisk()
    expect(record).toMatchObject({ outcome: 'ready', stage: 'ready' })
    expect(record.readyMs).toBe(record.stages.at(-1)!.ms)
    expect(history()).toEqual([expect.objectContaining({ pid: 1000, outcome: 'ready', stage: 'ready', cause: null })])
    // Nothing after ready changes the record.
    diagnostics.stage('windows')
    diagnostics.error('uncaughtException', new Error('late'))
    expect(onDisk().stages.at(-1)!.name).toBe('ready')
    expect(onDisk().errors).toEqual([])
  })

  it('records boot errors with their stage, and an exit before ready as fatal', () => {
    const hooks = new EventEmitter()
    const diagnostics = recorder({ hooks }).start()
    diagnostics.stage('services')
    hooks.emit('unhandledRejection', new TypeError('x is undefined'))
    expect(onDisk().errors).toEqual([expect.objectContaining({ stage: 'services', kind: 'unhandledRejection', message: 'TypeError: x is undefined' })])
    hooks.emit('exit', 70)
    expect(onDisk()).toMatchObject({ outcome: 'failed', fatal: { stage: 'services', kind: 'exit', message: 'exit code 70' } })
    diagnostics.dispose()
  })

  it('stays bounded: at most 40 stages, 5 errors, messages clipped', () => {
    const diagnostics = recorder().start()
    for (let index = 0; index < 100; index++) diagnostics.stage('services')
    for (let index = 0; index < 20; index++) diagnostics.error('uncaughtException', new Error('x'.repeat(5000)))
    const record = onDisk()
    expect(record.stages).toHaveLength(40)
    expect(record.errors).toHaveLength(5)
    expect(record.errors[0]!.message.length).toBeLessThanOrEqual(501)
    expect(readFileSync(join(directory, 'boot.json'), 'utf8').length).toBeLessThan(16_384)
  })

  it('files the previous launch that never became ready, once, with its last sample, and trims the history', () => {
    const first = recorder({ pid: 1 }).start()
    first.stage('structured-store')
    writeFileSync(join(directory, 'boot-sample.json'), JSON.stringify({ schema: 1, pid: 1, at: '2026-10-22T10:00:04.000Z', ms: 4100, rssMb: 4300, heapMb: 3905, mainBeatAgoMs: 3000, stage: 'structured-store' }))
    writeFileSync(join(directory, 'boot-history.jsonl'), Array.from({ length: 100 }, (_, index) => JSON.stringify({ pid: 10_000 + index, outcome: 'ready' })).join('\n') + '\n')
    recorder({ pid: 2 }).start()
    const failure = JSON.parse(readFileSync(join(directory, 'boot-last-failure.json'), 'utf8')) as BootRecord & { lastSample: { heapMb: number } }
    expect(failure).toMatchObject({ pid: 1, stage: 'structured-store', outcome: 'booting', lastSample: { heapMb: 3905 } })
    const lines = history()
    expect(lines.length).toBe(50)
    expect(lines.at(-1)).toMatchObject({ pid: 1, outcome: 'died', stage: 'structured-store', ms: 4100, peakHeapMb: 3905, cause: 'oom' })
    expect(onDisk().pid).toBe(2)
  })

  it('leaves a ready or still-live previous launch alone', () => {
    const first = recorder({ pid: 1 }).start()
    first.stage('services')
    recorder({ pid: 2, alive: pid => pid === 1 }).start()
    expect(existsSync(join(directory, 'boot-last-failure.json'))).toBe(false)
  })
})

describe('the test boot failure knob', () => {
  it('only exists in a test profile, from the variable or the file', () => {
    expect(bootFailureRequest({ CONDUCTOR_TEST_BOOT_FAIL: 'structured-store:oom' })).toBeNull()
    expect(bootFailureRequest({ CONDUCTOR_TEST_USER_DATA: 'x', CONDUCTOR_TEST_BOOT_FAIL: 'structured-store:oom' })).toEqual({ stage: 'structured-store', kind: 'oom' })
    expect(bootFailureRequest({ CONDUCTOR_TEST_USER_DATA: 'x', CONDUCTOR_TEST_BOOT_FAIL_FILE: 'f' }, () => 'settings:exit\r\n')).toEqual({ stage: 'settings', kind: 'exit' })
    expect(bootFailureRequest({ CONDUCTOR_TEST_USER_DATA: 'x', CONDUCTOR_TEST_BOOT_FAIL_FILE: 'f' }, () => null)).toBeNull()
    expect(bootFailureRequest({ CONDUCTOR_TEST_USER_DATA: 'x', CONDUCTOR_TEST_BOOT_FAIL: 'settings:explode' })).toBeNull()
  })
})
