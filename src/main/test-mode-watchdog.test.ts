import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

import { app } from 'electron'
import { isProcessAlive, killOwnProcessTree, resolveWatchedPid, startTestModeWatchdog } from './test-mode-watchdog'

describe('resolveWatchedPid', () => {
  it('watches the real parent pid with no override', () => {
    expect(resolveWatchedPid({}, 4242)).toBe(4242)
  })

  it('prefers CONDUCTOR_TEST_PARENT_PID when a smoke names its own launcher', () => {
    expect(resolveWatchedPid({ CONDUCTOR_TEST_PARENT_PID: '9000' }, 4242)).toBe(9000)
  })

  it('ignores a garbage override and falls back to ppid', () => {
    expect(resolveWatchedPid({ CONDUCTOR_TEST_PARENT_PID: 'nope' }, 4242)).toBe(4242)
    expect(resolveWatchedPid({ CONDUCTOR_TEST_PARENT_PID: '-1' }, 4242)).toBe(4242)
    expect(resolveWatchedPid({ CONDUCTOR_TEST_PARENT_PID: '0' }, 4242)).toBe(4242)
  })
})

describe('isProcessAlive', () => {
  it('is true for this process itself', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('is false for a pid that does not exist', () => {
    // A pid this large is never a real process on this machine.
    expect(isProcessAlive(2 ** 30)).toBe(false)
  })
})

describe('startTestModeWatchdog', () => {
  it('does nothing while the watched pid stays alive', () => {
    vi.useFakeTimers()
    const onOrphaned = vi.fn()
    const watchdog = startTestModeWatchdog({ ppid: 111, alive: () => true, onOrphaned, intervalMs: 1000 })
    vi.advanceTimersByTime(5000)
    expect(onOrphaned).not.toHaveBeenCalled()
    watchdog.stop()
    vi.useRealTimers()
  })

  it('fires exactly once when the watched pid disappears', () => {
    vi.useFakeTimers()
    const onOrphaned = vi.fn()
    startTestModeWatchdog({ ppid: 111, alive: () => false, onOrphaned, intervalMs: 1000 })
    vi.advanceTimersByTime(5000)
    expect(onOrphaned).toHaveBeenCalledTimes(1)
    expect(onOrphaned).toHaveBeenCalledWith(111)
    vi.useRealTimers()
  })

  it('honors an explicit CONDUCTOR_TEST_PARENT_PID over the real ppid', () => {
    vi.useFakeTimers()
    const onOrphaned = vi.fn()
    startTestModeWatchdog({ env: { CONDUCTOR_TEST_PARENT_PID: '555' }, ppid: 111, alive: () => false, onOrphaned, intervalMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(onOrphaned).toHaveBeenCalledWith(555)
    vi.useRealTimers()
  })

  it('stop() prevents any further check', () => {
    vi.useFakeTimers()
    const onOrphaned = vi.fn()
    const watchdog = startTestModeWatchdog({ ppid: 111, alive: () => false, onOrphaned, intervalMs: 1000 })
    watchdog.stop()
    vi.advanceTimersByTime(5000)
    expect(onOrphaned).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('killOwnProcessTree', () => {
  it('always calls app.exit, on every platform, as the fallback if taskkill is unavailable or not Windows', () => {
    killOwnProcessTree(4242)
    expect(app.exit).toHaveBeenCalledWith(1)
  })
})
