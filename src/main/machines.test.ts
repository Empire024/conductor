import { describe, expect, it } from 'vitest'
import { LOCAL_MACHINE_ID, type RemoteConnection } from '../shared/remote-control'
import { describeMachines, inheritMachineId, machineBriefing, machineLabel, machineRunsProject, tabMachineId } from './machines'

const connection = (overrides: Partial<RemoteConnection> = {}): RemoteConnection => ({
  machineId: 'render-desktop',
  machineName: 'Render Desktop',
  accountLogin: 'Empire024',
  host: '192.168.1.20',
  port: 51840,
  fingerprint: 'AA:BB',
  peerId: 'peer-1',
  grantedProjectIds: ['project-a'],
  connectedAt: '2026-03-01T10:00:00.000Z',
  lastContactAt: '2026-03-01T10:05:00.000Z',
  status: 'connected',
  message: null,
  ...overrides
})

const machines = (...connections: RemoteConnection[]) => describeMachines('This Laptop', connections)

describe('which machine a tab runs on', () => {
  it('treats a tab with no recorded machine as running here', () => {
    expect(tabMachineId(undefined)).toBe(LOCAL_MACHINE_ID)
    expect(tabMachineId({ state: undefined })).toBe(LOCAL_MACHINE_ID)
    expect(tabMachineId({ state: { machineId: '' } })).toBe(LOCAL_MACHINE_ID)
    expect(tabMachineId({ state: { machineId: 'render-desktop' } })).toBe('render-desktop')
  })

  it('lists this machine first, then paired machines with their live status', () => {
    const list = machines(connection(), connection({ machineId: 'studio', machineName: 'Studio', status: 'unreachable' }))
    expect(list.map(machine => [machine.id, machine.kind, machine.status])).toEqual([
      [LOCAL_MACHINE_ID, 'local', 'online'],
      ['render-desktop', 'peer', 'online'],
      ['studio', 'peer', 'offline']
    ])
    expect(machineLabel(list, 'render-desktop')).toBe('Render Desktop')
    expect(machineLabel(list, 'gone')).toBe('Unknown machine')
  })

  it('marks a revoked pairing as revoked rather than merely offline', () => {
    expect(machines(connection({ status: 'revoked' }))[1]?.status).toBe('revoked')
  })
})

describe('the inheritance rule for a linked or child tab', () => {
  it('keeps a child on the same machine as its parent when nothing says otherwise', () => {
    const list = machines(connection())
    expect(inheritMachineId('render-desktop', undefined, list)).toBe('render-desktop')
    expect(inheritMachineId(LOCAL_MACHINE_ID, undefined, list)).toBe(LOCAL_MACHINE_ID)
  })

  it('moves the child only when a machine is named explicitly', () => {
    const list = machines(connection())
    expect(inheritMachineId('render-desktop', LOCAL_MACHINE_ID, list)).toBe(LOCAL_MACHINE_ID)
    expect(inheritMachineId(LOCAL_MACHINE_ID, 'render-desktop', list)).toBe('render-desktop')
  })

  it('falls back to this machine when the parent machine is no longer paired', () => {
    expect(inheritMachineId('render-desktop', undefined, machines())).toBe(LOCAL_MACHINE_ID)
    expect(inheritMachineId('render-desktop', undefined, machines(connection({ status: 'revoked' })))).toBe(LOCAL_MACHINE_ID)
  })

  it('refuses an explicitly named machine that is unusable instead of quietly running work here', () => {
    const list = machines(connection({ status: 'revoked' }))
    expect(() => inheritMachineId(LOCAL_MACHINE_ID, 'render-desktop', list)).toThrow(/not paired with this one|revoked/)
    expect(() => inheritMachineId(LOCAL_MACHINE_ID, 'never-heard-of-it', list)).toThrow(/machines.list/)
    expect(() => inheritMachineId(LOCAL_MACHINE_ID, 42, list)).toThrow(/Invalid machineId/)
    expect(() => inheritMachineId(LOCAL_MACHINE_ID, '', list)).toThrow(/Invalid machineId/)
  })

  it('only lets a peer machine run a project it was granted', () => {
    const list = machines(connection())
    expect(machineRunsProject(list[0]!, 'anything')).toBe(true)
    expect(machineRunsProject(list[1]!, 'project-a')).toBe(true)
    expect(machineRunsProject(list[1]!, 'project-b')).toBe(false)
  })
})

describe('what an agent is told about its machine', () => {
  it('tells a local agent where it is and that its child tabs stay here', () => {
    const briefing = machineBriefing(machines(connection()), LOCAL_MACHINE_ID)
    expect(briefing).toContain('This Laptop')
    expect(briefing).toContain('inherits this machine unless you pass an explicit machineId')
    expect(briefing).toContain('Render Desktop (render-desktop)')
  })

  it('tells a remotely placed agent that it is not running in the window showing it', () => {
    const briefing = machineBriefing(machines(connection()), 'render-desktop')
    expect(briefing).toContain('runs on the paired machine “Render Desktop”')
    expect(briefing).toContain('not on the window you are shown in')
  })

  it('says nothing about other machines when there are none', () => {
    expect(machineBriefing(machines(), LOCAL_MACHINE_ID)).not.toContain('Other machines available')
  })
})
