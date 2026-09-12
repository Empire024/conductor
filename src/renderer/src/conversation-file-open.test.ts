import { describe, expect, it, vi } from 'vitest'
import { openConversationFile } from './conversation-file-open'

const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('durable conversation file routing', () => {
  it('fails closed before delayed session context resolves and never calls stale local layout routing', async () => {
    const pending = deferred<{ isFile: boolean }>()
    const stat = vi.fn(() => pending.promise), openRemote = vi.fn(), staleLocalCallback = vi.fn()
    const opening = openConversationFile({ machineId: 'unresolved-remote-owner', projectId: 'p', path: 'same.txt' }, staleLocalCallback, { stat, openRemote })
    expect(stat).toHaveBeenCalledWith('unresolved-remote-owner', 'p', 'same.txt')
    expect(staleLocalCallback).not.toHaveBeenCalled()
    // This models the delayed sessionFileContext reply. The in-flight click keeps its captured
    // unresolved authority and cannot switch to a missing tab state's implicit local machine.
    pending.reject(new Error('Remote owner is not resolved'))
    await expect(opening).rejects.toThrow('Remote owner is not resolved')
    expect(staleLocalCallback).not.toHaveBeenCalled()
    expect(openRemote).not.toHaveBeenCalled()
  })

  it('opens through the durable remote owner after context resolves even when tab state is missing', async () => {
    const stat = vi.fn().mockResolvedValue({ isFile: true }), openRemote = vi.fn(), staleLocalCallback = vi.fn()
    await openConversationFile({ machineId: 'host-a', projectId: 'p', path: 'same.txt', line: 9 }, staleLocalCallback, { stat, openRemote })
    expect(openRemote).toHaveBeenCalledWith('host-a', 'p', 'same.txt', 9)
    expect(staleLocalCallback).not.toHaveBeenCalled()
  })

  it('uses legacy local routing only for a confirmed local owner', async () => {
    const stat = vi.fn(), openRemote = vi.fn(), openLocal = vi.fn()
    await openConversationFile({ machineId: 'local', projectId: 'p', path: 'same.txt', line: 3 }, openLocal, { stat, openRemote })
    expect(openLocal).toHaveBeenCalledWith('same.txt', 3)
    expect(stat).not.toHaveBeenCalled()
    expect(openRemote).not.toHaveBeenCalled()
  })
})
