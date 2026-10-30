import { beforeEach, describe, expect, it, vi } from 'vitest'
import { THREADS_CHANGED_CHANNEL } from '../shared/threads'
import { createThreadInvalidations } from '../main/thread-invalidations'

const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>()
const ipcRenderer = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({ ipcRenderer }))

import { threadsBridge } from './threads'

const emit = (channel: string, ...args: unknown[]): void => { for (const listener of [...(listeners.get(channel) ?? [])]) listener({ sender: 'main' }, ...args) }

describe('rank9 threads preload bridge', () => {
  beforeEach(() => {
    listeners.clear()
    ipcRenderer.invoke.mockReset(); ipcRenderer.on.mockReset(); ipcRenderer.removeListener.mockReset()
    ipcRenderer.on.mockImplementation((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(listener)
    })
    ipcRenderer.removeListener.mockImplementation((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => { listeners.get(channel)?.delete(listener) })
  })

  it('keeps the invoke calls unchanged', async () => {
    ipcRenderer.invoke.mockResolvedValue('ok')
    await threadsBridge.list('q')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('threads:list', 'q')
  })

  it('onChanged hears the channel main sends on, hands the listener no payload, and unsubscribes', () => {
    vi.useFakeTimers()
    try {
      const listener = vi.fn()
      const off = threadsBridge.onChanged(listener)
      expect(ipcRenderer.on).toHaveBeenCalledTimes(1)
      // The window main would send to: delivery goes through the same ipcRenderer the bridge listens on.
      const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string) => emit(channel) } }
      const invalidations = createThreadInvalidations({ windows: () => [window], intervalMs: 5 })
      invalidations.observe('agent:status', { id: 'x' }); vi.advanceTimersByTime(5)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener.mock.calls[0]).toEqual([])
      emit(THREADS_CHANGED_CHANNEL, 'ignored payload')
      expect(listener.mock.calls[1]).toEqual([])
      off()
      expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
      expect(ipcRenderer.removeListener.mock.calls[0]?.[0]).toBe(ipcRenderer.on.mock.calls[0]?.[0])
      invalidations.observe('agent:status', { id: 'x' }); vi.advanceTimersByTime(5)
      expect(listener).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('a listener that throws neither breaks the bridge nor the other listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bad = vi.fn(() => { throw new Error('render failed') }), good = vi.fn()
    threadsBridge.onChanged(bad); threadsBridge.onChanged(good)
    expect(() => emit(THREADS_CHANGED_CHANNEL)).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
