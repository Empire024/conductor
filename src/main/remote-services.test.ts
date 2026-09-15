import { beforeEach, describe, expect, it } from 'vitest'
import type { RemotePeerRecord } from '../shared/remote-control'
import { RemoteAccessError } from './remote-peers'
import { RemoteServiceRegistry, readServiceRecords } from './remote-services'

const peer = { id: 'peer-1', machineName: 'LAPTOP' } as RemotePeerRecord

describe('RemoteServiceRegistry', () => {
  let settings: Map<string, string>
  let granted: Set<string>
  let current: boolean
  let projects: Set<string>
  let registry: RemoteServiceRegistry

  const build = (): RemoteServiceRegistry => new RemoteServiceRegistry({
    settings: {
      getSetting: key => settings.get(key) ?? null,
      setSetting: (key, value) => { settings.set(key, value) }
    },
    peers: {
      requireProject: (_peer, projectId) => {
        if (typeof projectId !== 'string' || !granted.has(projectId)) throw new RemoteAccessError('That project was not shared with this machine.', 403)
        return { id: projectId }
      },
      requireCurrentProject: (_peer, projectId) => {
        if (!current || typeof projectId !== 'string' || !granted.has(projectId)) {
          throw new RemoteAccessError('Remote access changed while this request was pending.', 403)
        }
        return { id: projectId }
      }
    },
    project: projectId => projects.has(projectId) ? { id: projectId } : null,
    now: () => Date.parse('2026-01-01T00:00:00.000Z')
  })

  beforeEach(() => {
    settings = new Map()
    granted = new Set(['shared'])
    projects = new Set(['shared', 'private'])
    current = true
    registry = build()
  })

  it('records the owner\'s registration and gives it an id of its own', () => {
    const record = registry.register({ projectId: 'shared', port: 5173, label: 'Vite dev server' })
    expect(record).toMatchObject({ projectId: 'shared', port: 5173, label: 'Vite dev server', createdAt: '2026-01-01T00:00:00.000Z' })
    expect(record.id).toMatch(/[0-9a-f-]{36}/)
    expect(registry.registered('shared')).toEqual([record])
  })

  it('keeps one project\'s registrations out of another\'s', () => {
    registry.register({ projectId: 'shared', port: 5173, label: 'Dev' })
    registry.register({ projectId: 'private', port: 8080, label: 'Private' })
    expect(registry.registered('shared').map(entry => entry.port)).toEqual([5173])
  })

  it.each([
    ['a port of zero', 0],
    ['a port past the last one', 65536],
    ['a fractional port', 80.5],
    ['a port that is not a number', '5173' as unknown as number]
  ])('refuses %s', (_label, port) => {
    expect(() => registry.register({ projectId: 'shared', port, label: 'Dev' })).toThrow(/between 1 and 65535/)
  })

  it.each([
    ['an empty name', ''],
    ['a name past sixty characters', 'x'.repeat(61)],
    ['a name carrying control characters', 'Dev[31m']
  ])('refuses %s', (_label, label) => {
    expect(() => registry.register({ projectId: 'shared', port: 5173, label })).toThrow(/at most 60 characters/)
  })

  it('refuses a registration for a project this machine does not have', () => {
    expect(() => registry.register({ projectId: 'ghost', port: 5173, label: 'Dev' })).toThrow(/project on this machine/)
  })

  it('bounds how many services one project can share', () => {
    for (let index = 0; index < 32; index++) registry.register({ projectId: 'shared', port: 3000 + index, label: `Service ${index}` })
    expect(() => registry.register({ projectId: 'shared', port: 9999, label: 'One too many' })).toThrow(/at most 32 services/)
  })

  it('forgets a registration, and ignores being asked to forget one twice', () => {
    const record = registry.register({ projectId: 'shared', port: 5173, label: 'Dev' })
    registry.unregister(record.id)
    registry.unregister(record.id)
    expect(registry.registered('shared')).toEqual([])
  })

  it('survives a restart', () => {
    registry.register({ projectId: 'shared', port: 5173, label: 'Dev' })
    expect(build().registered('shared')).toEqual([expect.objectContaining({ port: 5173 })])
  })

  it('shows a paired machine only the projects it was granted', async () => {
    registry.register({ projectId: 'shared', port: 5173, label: 'Dev' })
    registry.register({ projectId: 'private', port: 8080, label: 'Private' })
    expect(await registry.call(peer, 'services.list', { projectId: 'shared' })).toEqual([expect.objectContaining({ port: 5173 })])
    await expect(registry.call(peer, 'services.list', { projectId: 'private' })).rejects.toThrow(/not shared/)
  })

  it('never takes a port from the caller', async () => {
    registry.register({ projectId: 'shared', port: 5173, label: 'Dev' })
    const listed = await registry.call(peer, 'services.list', { projectId: 'shared', port: 22, label: 'ssh' }) as Array<{ port: number; label: string }>
    expect(listed).toEqual([expect.objectContaining({ port: 5173, label: 'Dev' })])
  })

  it('refuses a method it does not know', async () => {
    await expect(registry.call(peer, 'services.register', { projectId: 'shared', port: 22 })).rejects.toThrow(/Unknown remote method/)
  })

  it('resolves a registered id to the loopback port behind it', () => {
    const record = registry.register({ projectId: 'shared', port: 5173, label: 'Dev' })
    expect(registry.tunnelTarget(record.id, peer)).toEqual({ port: 5173 })
  })

  it('has no target for an id nobody registered', () => {
    expect(registry.tunnelTarget('made-up', peer)).toBeNull()
    expect(registry.tunnelTarget(5173 as unknown as string, peer)).toBeNull()
  })

  it('re-checks the grant at the moment the tunnel would be opened', () => {
    const record = registry.register({ projectId: 'shared', port: 5173, label: 'Dev' })
    current = false
    expect(() => registry.tunnelTarget(record.id, peer)).toThrow(/access changed/)
  })

  it('will not resolve a service in a project that was never shared with that machine', () => {
    const record = registry.register({ projectId: 'private', port: 8080, label: 'Private' })
    expect(() => registry.tunnelTarget(record.id, peer)).toThrow(/access changed/)
  })
})

describe('readServiceRecords', () => {
  it('drops anything that is not a whole registration', () => {
    const raw = JSON.stringify([
      { id: 'a', projectId: 'p', port: 80, label: 'ok', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', projectId: 'p', port: 0, label: 'bad port' },
      { id: 'c', projectId: 'p', port: 70000, label: 'bad port' },
      { id: '', projectId: 'p', port: 80, label: 'no id' },
      { projectId: 'p', port: 80, label: 'no id at all' },
      null,
      'nonsense'
    ])
    expect(readServiceRecords(raw).map(entry => entry.id)).toEqual(['a'])
  })

  it('reads nothing out of nothing, or out of damage', () => {
    expect(readServiceRecords(undefined)).toEqual([])
    expect(readServiceRecords('{ not json')).toEqual([])
    expect(readServiceRecords('{"not":"an array"}')).toEqual([])
  })
})
