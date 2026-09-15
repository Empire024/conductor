import { describe, expect, it, vi } from 'vitest'
import { RemoteAttachment, detachExplanation, type RemoteAttachmentDeps } from './remote-attachment'

interface StoredConnection { machineId: string; machineName: string; detached?: boolean; generation?: number; status?: string }

/** A connection store that persists, so "does a restart stay standalone" is a real question here. */
function store(initial: StoredConnection[]): {
  connections: RemoteAttachmentDeps['connections']
  rows: Map<string, StoredConnection>
  writes: number
} {
  const rows = new Map(initial.map(entry => [entry.machineId, { ...entry }]))
  let writes = 0
  return {
    rows,
    get writes() { return writes },
    connections: {
      get: (machineId: string) => rows.get(machineId) ?? null,
      mark: (machineId: string, patch) => { writes++; rows.set(machineId, { ...rows.get(machineId)!, ...patch }) }
    }
  }
}

function build(initial: StoredConnection[] = [{ machineId: 'main', machineName: 'MAIN', generation: 0, status: 'connected' }]) {
  const persisted = store(initial)
  const transport = { attach: vi.fn(), detach: vi.fn() }
  const drafts = { retainRemote: vi.fn(() => 2) }
  const queues = { dropPending: vi.fn(() => 5) }
  const mirror = { markUnavailable: vi.fn() }
  const changed = vi.fn()
  const attachment = new RemoteAttachment({ connections: persisted.connections, transport, drafts, queues, mirror, changed })
  return { attachment, persisted, transport, drafts, queues, mirror, changed }
}

describe('using this computer independently', () => {
  it('detaches locally: nothing is asked of the host, and the decision is persisted at once', () => {
    const f = build()
    const result = f.attachment.detach('main')
    expect(result).toMatchObject({ machineName: 'MAIN', generation: 1, alreadyDetached: false })
    expect(f.persisted.rows.get('main')).toMatchObject({ detached: true, generation: 1 })
    // The only transport call is the local teardown; nothing is sent to MAIN and nothing awaited.
    expect(f.transport.detach).toHaveBeenCalledWith('main')
    expect(f.transport.attach).not.toHaveBeenCalled()
    expect(f.changed).toHaveBeenCalled()
  })

  it('bumps the generation so a reply asked for before the detach cannot land afterwards', () => {
    const f = build([{ machineId: 'main', machineName: 'MAIN', generation: 7 }])
    expect(f.attachment.detach('main').generation).toBe(8)
    expect(f.attachment.attach('main').generation).toBe(9)
    // Every transition spends one, so no two windows of time ever share a generation.
    expect(f.attachment.detach('main').generation).toBe(10)
  })

  it('works when the host is unreachable, because it never consults it', () => {
    const f = build([{ machineId: 'main', machineName: 'MAIN', generation: 0, status: 'unreachable' }])
    expect(() => f.attachment.detach('main')).not.toThrow()
    expect(f.attachment.isDetached('main')).toBe(true)
  })

  it('stays detached after a restart, because the flag and the generation come back from the store', () => {
    const f = build()
    f.attachment.detach('main')
    const snapshot = [...f.persisted.rows.values()].map(entry => ({ ...entry }))
    // A fresh process, reading the same persisted rows.
    const restarted = build(snapshot)
    expect(restarted.attachment.isDetached('main')).toBe(true)
    expect(restarted.attachment.describe('main')).toMatchObject({ state: 'detached', failure: null, generation: 1 })
    // Nothing is dialled on startup: reattaching is always something the owner does.
    expect(restarted.transport.attach).not.toHaveBeenCalled()
  })

  it('throws away queued work instead of replaying it, and says how much', () => {
    const f = build()
    const result = f.attachment.detach('main')
    expect(f.queues.dropPending).toHaveBeenCalledWith('main')
    expect(result.droppedOperations).toBe(5)
    // Attaching again starts from nothing; there is no queue to resume.
    f.attachment.attach('main')
    expect(f.queues.dropPending).toHaveBeenCalledTimes(1)
  })

  it('retains unsaved remote edits as recovery drafts, before the transport is torn down', () => {
    const order: string[] = []
    const f = build()
    f.drafts.retainRemote.mockImplementation(() => { order.push('drafts'); return 3 })
    f.transport.detach.mockImplementation(() => { order.push('transport') })
    const result = f.attachment.detach('main')
    expect(result.retainedDrafts).toBe(3)
    expect(order).toEqual(['drafts', 'transport'])
  })

  it('marks mirrored sessions unavailable without releasing their bindings', () => {
    const f = build()
    f.attachment.detach('main')
    expect(f.mirror.markUnavailable).toHaveBeenCalledWith('main')
  })

  it('leaves the owner detached even if the teardown throws, because that is the safe direction', () => {
    const f = build()
    f.transport.detach.mockImplementation(() => { throw new Error('stream already gone') })
    expect(() => f.attachment.detach('main')).not.toThrow()
    expect(f.persisted.rows.get('main')).toMatchObject({ detached: true, generation: 1 })
  })

  it('does nothing and spends no generation when the machine is already detached', () => {
    const f = build([{ machineId: 'main', machineName: 'MAIN', detached: true, generation: 4 }])
    const result = f.attachment.detach('main')
    expect(result).toMatchObject({ alreadyDetached: true, generation: 4, retainedDrafts: 0, droppedOperations: 0 })
    expect(f.transport.detach).not.toHaveBeenCalled()
    expect(f.drafts.retainRemote).not.toHaveBeenCalled()
  })

  it('detaches every host for the one standalone action, and one failure does not save the rest', () => {
    const f = build([
      { machineId: 'main', machineName: 'MAIN', generation: 0 },
      { machineId: 'studio', machineName: 'Studio', generation: 2 }
    ])
    const results = f.attachment.useIndependently(['main', 'studio', 'never-paired'])
    expect(results.map(entry => entry.machineId)).toEqual(['main', 'studio'])
    expect(f.attachment.isDetached('main')).toBe(true)
    expect(f.attachment.isDetached('studio')).toBe(true)
  })
})

describe('attaching again', () => {
  it('is explicit, clears the flag and takes a new generation before dialling', () => {
    const f = build([{ machineId: 'main', machineName: 'MAIN', detached: true, generation: 3 }])
    const result = f.attachment.attach('main')
    expect(result).toMatchObject({ generation: 4, alreadyAttached: false })
    expect(f.persisted.rows.get('main')).toMatchObject({ detached: false, generation: 4 })
    expect(f.transport.attach).toHaveBeenCalledWith('main')
    // Retained drafts are never replayed to the host; they stay recovery drafts here.
    expect(f.drafts.retainRemote).not.toHaveBeenCalled()
  })

  it('is a no-op on a machine that was never detached', () => {
    const f = build()
    expect(f.attachment.attach('main')).toMatchObject({ alreadyAttached: true })
    expect(f.transport.attach).not.toHaveBeenCalled()
  })

  it('refuses a machine that is not paired at all, rather than inventing one', () => {
    const f = build()
    expect(() => f.attachment.attach('ghost')).toThrow(/not paired/)
    expect(() => f.attachment.detach('ghost')).toThrow(/not paired/)
  })

  it('describes a detached machine as the owner’s decision, not as a failure', () => {
    const f = build()
    f.attachment.detach('main')
    expect(f.attachment.describe('main')).toEqual({
      state: 'detached', path: 'unknown', transport: null, failure: null,
      detail: 'Using this computer independently.', generation: 1
    })
    f.attachment.attach('main')
    expect(f.attachment.describe('main')).toBeNull()
  })
})

describe('what the owner is told', () => {
  it('names the host and keeps every promise the docs make', () => {
    const lines = detachExplanation('MAIN').join(' ')
    expect(lines).toMatch(/MAIN's files, services, models and running sessions are not available/)
    expect(lines).toMatch(/keeps running there/)
    expect(lines).toMatch(/already sent may have completed/)
    expect(lines).toMatch(/nothing is replayed later/)
    expect(lines).toMatch(/recovery drafts/)
    expect(lines).toMatch(/not forgetting the pairing/)
  })
})
