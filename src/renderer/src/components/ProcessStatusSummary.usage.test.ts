import { describe, expect, it, vi } from 'vitest'
import type { RuntimeProcessSummary } from '../../../shared/models'
import type { SessionProjection } from '../../../shared/structured-agent'
import { emptyProjection } from '../../../shared/structured-agent-reducer'
import { createProcessUsageLoader } from './ProcessStatusSummary'

const process = (id: string): RuntimeProcessSummary => ({ id, projectId: 'project', sessionId: 'workspace', kind: 'agent', title: id, status: 'running', needsInput: false, progress: null, updatedAt: '2026-09-25T00:00:00.000Z' })
const projection = (id: string, phase: SessionProjection['phase'] = 'completed'): SessionProjection => ({ ...emptyProjection(id), phase })

describe('status bar usage: an unchanged conversation is not fetched again', () => {
  it('reuses a report until an event for that conversation arrives, and always re-reads the cap', async () => {
    const snapshot = vi.fn(async (id: string) => projection(id))
    const caps = vi.fn(async () => ({ effective: null }))
    const loader = createProcessUsageLoader({ snapshot, caps })
    await loader.load(process('a'))
    await loader.load(process('a'))
    await loader.load(process('b'))
    expect(snapshot.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    expect(caps).toHaveBeenCalledTimes(3)
    loader.changed(['a'])
    snapshot.mockImplementationOnce(async id => projection(id, 'running'))
    expect((await loader.load(process('a')))[1]?.snapshotPhase).toBe('running')
    expect(snapshot).toHaveBeenCalledTimes(3)
  })
  it('does not keep a report fetched while the conversation changed, nor one for a missing snapshot', async () => {
    let release!: () => void
    const snapshot = vi.fn((id: string) => new Promise<SessionProjection | null>(resolve => { release = () => resolve(projection(id)) }))
    const loader = createProcessUsageLoader({ snapshot, caps: async () => ({ effective: null }) })
    const first = loader.load(process('a'))
    loader.changed(['a'])
    release()
    await first
    const second = loader.load(process('a'))
    release()
    await second
    expect(snapshot).toHaveBeenCalledTimes(2)
    snapshot.mockImplementation(async () => null)
    loader.changed(['a'])
    expect((await loader.load(process('a')))[1]).toBeUndefined()
    expect((await loader.load(process('a')))[1]).toBeUndefined()
    expect(snapshot).toHaveBeenCalledTimes(4)
  })
  it('forgets conversations that are no longer running', async () => {
    const snapshot = vi.fn(async (id: string) => projection(id))
    const loader = createProcessUsageLoader({ snapshot, caps: async () => ({ effective: null }) })
    await loader.load(process('a'))
    loader.retain(new Set(['b']))
    await loader.load(process('a'))
    expect(snapshot).toHaveBeenCalledTimes(2)
  })
})
