import { describe, expect, it } from 'vitest'
import type { ConnectionPath, MachineConnection, MachineDescriptor } from '../../../shared/remote-control'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import { describeExecutionTarget, executionTargetSummary, failureExplanation, failureWords, pathWords, remoteProjectBadge, transportWords } from './execution-target'

const host = (connection: Partial<MachineConnection>): MachineDescriptor => ({
  id: 'main', name: 'MAIN', kind: 'peer', status: 'online', accountLogin: 'owner', projects: [],
  connection: { state: 'connected', path: 'unknown', transport: null, failure: null, detail: null, generation: 1, ...connection }
})
const here: MachineDescriptor = { id: LOCAL_MACHINE_ID, name: 'This laptop', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION }

describe('the execution target shown beside the composer', () => {
  it('says where work opened here will actually run', () => {
    expect(describeExecutionTarget([here, host({})], LOCAL_MACHINE_ID).label).toBe('Local: This laptop')
    expect(describeExecutionTarget([here, host({})], 'main').label).toBe('Remote: MAIN')
  })

  it('names each connection state in the owner’s words', () => {
    const state = (value: MachineConnection['state']): string => describeExecutionTarget([here, host({ state: value })], 'main').state
    expect(state('connecting')).toBe('Connecting')
    expect(state('connected')).toBe('Connected')
    expect(state('reconnecting')).toBe('Reconnecting')
    expect(state('offline')).toBe('Offline')
    expect(state('detached')).toBe('Detached')
  })

  it('reports direct or relayed only from what the transport said, never from anything else', () => {
    const route = (path: ConnectionPath): string => describeExecutionTarget([here, host({ path })], 'main').path
    expect(route('direct')).toBe('Direct')
    expect(route('relayed')).toBe('Relayed')
    // 'unknown' is a real answer and is shown as one, rather than being guessed into 'Direct'.
    expect(route('unknown')).toBe('Unknown')
    // The only inputs pathWords has are path and state; there is nowhere for latency to enter.
    expect(pathWords({ path: 'direct', state: 'connected' })).toBe('Direct')
    expect(pathWords({ path: 'direct', state: 'offline' })).toBe('')
    expect(pathWords({ path: 'relayed', state: 'detached' })).toBe('')
  })

  it('says "over Tailscale" only when the transport really is Tailscale', () => {
    expect(transportWords({ transport: 'tailscale' })).toBe('over Tailscale')
    expect(transportWords({ transport: 'direct' })).toBe('')
    expect(transportWords({ transport: 'relay' })).toBe('')
    expect(transportWords({ transport: null })).toBe('')
    // And nothing anywhere in the summary claims encryption for a non-Tailscale transport.
    const relayed = describeExecutionTarget([here, host({ transport: 'relay', path: 'relayed' })], 'main')
    expect(executionTargetSummary(relayed)).toBe('Connected · Relayed')
    expect(executionTargetSummary(relayed)).not.toMatch(/encrypt/i)
  })

  it('joins only the parts that have something true to say', () => {
    expect(executionTargetSummary(describeExecutionTarget([here, host({ path: 'direct', transport: 'tailscale' })], 'main')))
      .toBe('Connected · Direct · over Tailscale')
    expect(executionTargetSummary(describeExecutionTarget([here, host({ state: 'detached' })], 'main'))).toBe('Detached')
    expect(executionTargetSummary(describeExecutionTarget([here], LOCAL_MACHINE_ID))).toBe('Connected')
  })

  it('turns each failure into the four different fixes they need', () => {
    expect(failureWords('network')).toBe('network')
    expect(failureWords('host-not-running')).toBe('host not running')
    expect(failureWords('authorization')).toBe('authorization')
    expect(failureWords('protocol')).toBe('protocol mismatch')
    expect(failureWords(null)).toBe('')
    expect(failureExplanation('host-not-running', 'MAIN')).toMatch(/turn remote control on/)
    expect(failureExplanation('authorization', 'MAIN')).toMatch(/revoked/)
    expect(failureExplanation('protocol', 'MAIN')).toMatch(/Update Conductor on both/)
    expect(failureExplanation(null, 'MAIN')).toBe('')
  })

  it('describes detaching as the owner’s decision rather than as a fault', () => {
    const target = describeExecutionTarget([here, host({ state: 'detached', failure: null, detail: null })], 'main')
    expect(target.detached).toBe(true)
    expect(target.failure).toBe('')
    expect(target.detail).toMatch(/using this computer independently of MAIN/i)
    expect(target.detail).toMatch(/until you attach again/)
  })

  it('says a disconnected host cannot be reached, and why, instead of looking fine', () => {
    const target = describeExecutionTarget([here, host({ state: 'offline', failure: 'network', detail: null })], 'main')
    expect(target.detail).toBe('MAIN cannot be reached right now (network).')
    expect(target.state).toBe('Offline')
  })

  it('falls back to offline for a machine it has never heard of, not to this computer', () => {
    const target = describeExecutionTarget([here], 'ghost')
    expect(target.local).toBe(false)
    expect(target.label).toBe('Remote: Unknown machine')
    expect(target.state).toBe('Offline')
  })
})

describe('how a project that lives on another machine appears in the project list', () => {
  const project = { remote: { machineId: 'main', machineName: 'MAIN', remoteProjectId: 'p', path: 'C:/x' } }

  it('is badged with the host it lives on', () => {
    const badge = remoteProjectBadge(project, [here, host({})])!
    expect(badge.label).toBe('Remote: MAIN')
    expect(badge.unavailable).toBe(false)
    expect(badge.title).toMatch(/Its files, terminals and agents run there/)
  })

  it('is not badged at all when it lives on this computer', () => {
    expect(remoteProjectBadge({}, [here])).toBeNull()
    expect(remoteProjectBadge(null, [here])).toBeNull()
  })

  it('stops looking like a working local project the moment its host is detached', () => {
    const badge = remoteProjectBadge(project, [here, host({ state: 'detached' })])!
    expect(badge.label).toBe('MAIN unavailable')
    expect(badge.unavailable).toBe(true)
    expect(badge.title).toMatch(/until you attach again/)
  })

  it('says so when the host is offline, and names the kind of failure', () => {
    const offline = { ...host({ state: 'offline', failure: 'host-not-running' }), status: 'offline' as const }
    const badge = remoteProjectBadge(project, [here, offline])!
    expect(badge.label).toBe('MAIN unavailable')
    expect(badge.unavailable).toBe(true)
    expect(badge.title).toMatch(/host not running/)
  })

  it('says so when the pairing is gone entirely, rather than showing nothing', () => {
    const badge = remoteProjectBadge(project, [here])!
    expect(badge.label).toBe('MAIN unavailable')
    expect(badge.title).toMatch(/no longer paired/)
  })
})
