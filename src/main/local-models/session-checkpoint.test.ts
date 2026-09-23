import { describe, expect, it } from 'vitest'
import { sessionCheckpoint } from './session-checkpoint'

describe('registered local checkpoint storage', () => {
  const fixture = () => {
    const values = new Map<string, string>()
    const store = { getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) } }
    return { values, store }
  }
  it('preserves opaque inputs, tool/result pairing and pending mutation identities across runtime replacement', async () => {
    const { store } = fixture()
    let active = true
    const first = sessionCheckpoint(store, { projectId: 'project', taskId: 'registered-id' }, () => { if (!active) throw new Error('expired') })
    const payload = { input: 'owner input', messages: [{ role: 'assistant', tool_calls: [{ id: 'call-1' }] }, { role: 'tool', tool_call_id: 'call-1', content: 'result' }], pendingMutations: [{ id: 'call-2', input: { path: 'private.ts', content: 'private source' } }] }
    await first.save(payload)
    active = false
    const next = sessionCheckpoint(store, { projectId: 'project', taskId: 'registered-id' }, () => {})
    expect(next.load()).toEqual(payload)
    expect(() => first.load()).toThrow('expired')
    await expect(first.save({ overwritten: true })).rejects.toThrow('expired')
    expect(next.load()).toEqual(payload)
  })
  it('isolates projects and registered conversations, including delimiter-bearing IDs', async () => {
    const { store } = fixture()
    const checkpoint = (projectId: string, taskId: string) => sessionCheckpoint(store, { projectId, taskId }, () => {})
    await checkpoint('a:b', 'c').save({ task: 1 })
    expect(checkpoint('a', 'b:c').load()).toBeUndefined()
    expect(checkpoint('a:b', 'other').load()).toBeUndefined()
  })
  it('fails closed for corrupt persistence and propagates save failures', async () => {
    const { store, values } = fixture()
    const checkpoint = sessionCheckpoint(store, { projectId: 'p', taskId: 't' }, () => {})
    await checkpoint.save({ valid: true })
    values.set([...values.keys()][0]!, 'broken json')
    expect(() => checkpoint.load()).toThrow('refusing to restart')
    await expect(checkpoint.save(undefined)).rejects.toThrow('must be JSON')
    const broken = sessionCheckpoint({ ...store, setSetting: () => { throw new Error('disk failure') } }, { projectId: 'p', taskId: 't' }, () => {})
    await expect(broken.save({})).rejects.toThrow('disk failure')
  })
})
