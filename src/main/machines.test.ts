import { describe, expect, it } from 'vitest'
import { LOCAL_MACHINE_ID, type RemoteConnection, type RemoteProjectSummary } from '../shared/remote-control'
import type { ProjectIdentity, RemoteProjectGrant } from '../shared/project-identity'
import { describeMachines, inheritMachineId, machineBriefing, machineLabel, machineRunsProject, tabMachineId } from './machines'

const LOCAL_IDENTITY: ProjectIdentity = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: 'C:/laptop/conductor', name: 'Conductor' }
const REMOTE_IDENTITY: ProjectIdentity = { key: 'b'.repeat(32), keyCreatedAt: '2026-02-02T00:00:00.000Z', path: 'D:/renders/conductor', name: 'Conductor' }

/** The two machines hold two checkouts, so their keys differ; the owner said they are a pair. */
const grant = (overrides: Partial<RemoteProjectGrant> = {}): RemoteProjectGrant => ({
  localProjectId: 'project-a',
  local: LOCAL_IDENTITY,
  remoteProjectId: 'remote-project',
  remote: REMOTE_IDENTITY,
  confirmedAt: '2026-02-03T00:00:00.000Z',
  ...overrides
})

const advertise = (identity: ProjectIdentity | null, id = 'remote-project'): RemoteProjectSummary =>
  ({ id, name: 'Conductor', path: identity?.path ?? '', identity, identityError: null })

const connection = (overrides: Partial<RemoteConnection> = {}): RemoteConnection => ({
  machineId: 'render-desktop',
  machineName: 'Render Desktop',
  accountLogin: 'Empire024',
  host: '192.168.1.20',
  port: 51840,
  fingerprint: 'AA:BB',
  peerId: 'peer-1',
  projectGrants: [grant()],
  remoteProjects: [advertise(REMOTE_IDENTITY)],
  remoteProjectsAt: '2026-03-01T10:05:00.000Z',
  unconfirmedRemoteProjectIds: [],
  connectedAt: '2026-03-01T10:00:00.000Z',
  lastContactAt: '2026-03-01T10:05:00.000Z',
  status: 'connected',
  message: null,
  ...overrides
})

const machines = (...connections: RemoteConnection[]) => describeMachines('This Laptop', connections)

/** The peer machine from a list built by describeMachines. */
const peerFor = (...overrides: Parameters<typeof connection>) => machines(connection(...overrides))[1]!

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

  it('pairs each confirmed grant with what that machine advertises for it now', () => {
    const moved = { ...REMOTE_IDENTITY, path: 'E:/moved/conductor' }
    const machine = peerFor({ remoteProjects: [advertise(moved)] })
    expect(machine.projects).toEqual([{ grant: grant(), observed: moved }])
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
})

/**
 * Placement is decided by comparing identities, never by comparing project ids or names between
 * two machines that each mint their own. Every case here has to fail closed with a reason the
 * owner can act on, because the alternative is an agent editing the wrong checkout.
 */
describe('whether a machine may run a tab for this project', () => {
  it('lets this machine run any of its own projects', () => {
    expect(machineRunsProject(machines(connection())[0]!, 'anything')).toEqual({ ok: true, grant: null })
  })

  it('runs a project on a paired machine only through the pair the owner confirmed', () => {
    const placement = machineRunsProject(peerFor(), 'project-a')
    expect(placement).toEqual({ ok: true, grant: grant() })
    expect(placement.ok && placement.grant?.remoteProjectId).toBe('remote-project')
  })

  it('refuses a project that was never mapped to that machine', () => {
    const placement = machineRunsProject(peerFor(), 'project-b')
    expect(placement).toMatchObject({ ok: false, reason: 'not-mapped' })
    expect(placement.ok === false && placement.message).toMatch(/has not been told which of its projects this one is/)
  })

  it('refuses when that machine is sharing a different project under the mapping', () => {
    const swapped = { ...REMOTE_IDENTITY, key: 'c'.repeat(32) }
    const placement = machineRunsProject(peerFor({ remoteProjects: [advertise(swapped)] }), 'project-a')
    expect(placement).toMatchObject({ ok: false, reason: 'different-project' })
    expect(placement.ok === false && placement.message).toMatch(/now sharing a different project/)
  })

  it('refuses a key that reappears with a different creation time, which is a copy, not the project', () => {
    const reminted = { ...REMOTE_IDENTITY, keyCreatedAt: '2026-05-05T00:00:00.000Z' }
    const placement = machineRunsProject(peerFor({ remoteProjects: [advertise(reminted)] }), 'project-a')
    expect(placement).toMatchObject({ ok: false, reason: 'identity-recreated' })
    expect(placement.ok === false && placement.message).toMatch(/copied or regenerated identity/)
  })

  it('refuses a moved folder and shows the owner both paths instead of accepting the move', () => {
    const moved = { ...REMOTE_IDENTITY, path: 'E:/renders/conductor' }
    const placement = machineRunsProject(peerFor({ remoteProjects: [advertise(moved)] }), 'project-a')
    expect(placement).toEqual({
      ok: false,
      reason: 'project-moved',
      message: expect.stringContaining('moved from D:/renders/conductor to E:/renders/conductor'),
      recordedPath: 'D:/renders/conductor',
      currentPath: 'E:/renders/conductor'
    })
  })

  it('accepts the same folder written with the other separator or in another case', () => {
    const rewritten = { ...REMOTE_IDENTITY, path: 'd:\\Renders\\Conductor' }
    expect(machineRunsProject(peerFor({ remoteProjects: [advertise(rewritten)] }), 'project-a')).toMatchObject({ ok: true })
  })

  it('refuses when the machine has stopped advertising the mapped project at all', () => {
    expect(machineRunsProject(peerFor({ remoteProjects: [] }), 'project-a')).toMatchObject({ ok: false, reason: 'not-advertised' })
    expect(machineRunsProject(peerFor({ remoteProjects: [advertise(null)] }), 'project-a')).toMatchObject({ ok: false, reason: 'not-advertised' })
  })

  it('refuses a project id carried over from a pairing made before identities existed', () => {
    const legacy = peerFor({ projectGrants: [], unconfirmedRemoteProjectIds: ['remote-project'] })
    expect(machineRunsProject(legacy, 'project-a')).toMatchObject({ ok: false, reason: 'not-mapped' })
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
