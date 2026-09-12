import { describe, expect, it } from 'vitest'
import type { RemoteProjectSummary } from '../shared/remote-control'
import type { ProjectIdentity, RemoteProjectGrant } from '../shared/project-identity'
import { RemoteControlClient } from './remote-control-client'
import { describeMachines, machineRunsProject } from './machines'
import type { SecretKeyValueStore } from './secret-store'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

const CONNECTIONS = 'remote-control.connections'
const LOCAL: ProjectIdentity = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: 'C:/laptop/conductor', name: 'Conductor' }
const REMOTE: ProjectIdentity = { key: 'b'.repeat(32), keyCreatedAt: '2026-02-02T00:00:00.000Z', path: 'D:/renders/conductor', name: 'Conductor' }
const advertised: RemoteProjectSummary = { id: 'remote-a', name: 'Conductor', path: REMOTE.path, identity: REMOTE, identityError: null }
const grant: RemoteProjectGrant = { localProjectId: 'project-a', local: LOCAL, remoteProjectId: 'remote-a', remote: REMOTE, confirmedAt: '2026-02-03T00:00:00.000Z' }

/** A pairing as it was stored before projects carried an identity. */
const legacyConnection = {
  machineId: 'render-desktop', machineName: 'Render Desktop', accountLogin: 'Empire024',
  host: '192.168.1.20', port: 51840, fingerprint: 'AA:BB', peerId: 'peer-1',
  grantedProjectIds: ['remote-a', 'remote-b'],
  connectedAt: '2026-03-01T10:00:00.000Z', lastContactAt: '2026-03-01T10:05:00.000Z', status: 'connected', message: null
}

function client(stored?: unknown[]) {
  const store = new MapStore()
  if (stored) store.setSetting(CONNECTIONS, JSON.stringify(stored))
  return {
    store,
    client: new RemoteControlClient({
      store, machineId: () => 'this-machine', machineName: () => 'This Laptop',
      deviceKey: () => null, now: () => Date.parse('2026-03-02T09:00:00.000Z')
    })
  }
}

const placement = (fixture: ReturnType<typeof client>) =>
  machineRunsProject(describeMachines('This Laptop', fixture.client.list())[1]!, 'project-a')

describe('pairings stored before projects carried an identity', () => {
  it('keeps the pairing and everything the other machine shared, without inventing a mapping', () => {
    const fixture = client([legacyConnection])
    const connection = fixture.client.list()[0]!
    expect(connection.machineName).toBe('Render Desktop')
    expect(connection.peerId).toBe('peer-1')
    expect(connection.status).toBe('connected')
    // The old list said which projects that machine shares. It never said which project here each
    // one is, and no identity was kept for either side, so each still needs one confirmation.
    expect(connection.projectGrants).toEqual([])
    expect(connection.unconfirmedRemoteProjectIds).toEqual(['remote-a', 'remote-b'])
    expect(connection.remoteProjects).toEqual([])
  })

  it('refuses to place work through a carried-over project id until the owner confirms the pair', () => {
    expect(placement(client([legacyConnection]))).toMatchObject({ ok: false, reason: 'not-mapped' })
  })

  it('drops the superseded list from storage rather than leaving it to be trusted later', () => {
    const fixture = client([legacyConnection])
    fixture.client.forget('nobody')
    expect(fixture.store.getSetting(CONNECTIONS)).not.toContain('grantedProjectIds')
  })

  it('keeps the nudge until the owner has actually seen that project with an identity', () => {
    const fixture = client([legacyConnection])
    fixture.client.recordRemoteProjects('render-desktop', [advertised])
    expect(fixture.client.get('render-desktop')?.unconfirmedRemoteProjectIds).toEqual(['remote-b'])
  })
})

describe('recording which project here is which project there', () => {
  const confirmed = () => {
    const fixture = client([legacyConnection])
    fixture.client.recordRemoteProjects('render-desktop', [advertised])
    fixture.client.confirmProject('render-desktop', grant)
    return fixture
  }

  it('places work only after the owner has confirmed the pair', () => {
    const fixture = confirmed()
    expect(placement(fixture)).toEqual({ ok: true, grant })
    expect(fixture.client.get('render-desktop')?.unconfirmedRemoteProjectIds).toEqual(['remote-b'])
  })

  it('survives a restart, mapping and observed identity alike', () => {
    const fixture = confirmed()
    const reloaded = new RemoteControlClient({
      store: fixture.store, machineId: () => 'this-machine', machineName: () => 'This Laptop', deviceKey: () => null
    })
    expect(reloaded.get('render-desktop')?.projectGrants).toEqual([grant])
    expect(machineRunsProject(describeMachines('This Laptop', reloaded.list())[1]!, 'project-a')).toEqual({ ok: true, grant })
  })

  it('refuses once that machine answers with a different project under the same mapping', () => {
    const fixture = confirmed()
    fixture.client.recordRemoteProjects('render-desktop', [{ ...advertised, identity: { ...REMOTE, key: 'c'.repeat(32) } }])
    expect(placement(fixture)).toMatchObject({ ok: false, reason: 'different-project' })
  })

  it('refuses a copy of the project: same key, minted at another moment', () => {
    const fixture = confirmed()
    fixture.client.recordRemoteProjects('render-desktop', [{ ...advertised, identity: { ...REMOTE, keyCreatedAt: '2026-08-08T00:00:00.000Z' } }])
    expect(placement(fixture)).toMatchObject({ ok: false, reason: 'identity-recreated' })
  })

  it('refuses a moved folder and keeps both paths for the owner to compare', () => {
    const fixture = confirmed()
    fixture.client.recordRemoteProjects('render-desktop', [{ ...advertised, identity: { ...REMOTE, path: 'E:/renders/conductor' } }])
    expect(placement(fixture)).toMatchObject({ ok: false, reason: 'project-moved', recordedPath: REMOTE.path, currentPath: 'E:/renders/conductor' })
  })

  it('replaces rather than duplicates a mapping when the owner confirms one again', () => {
    const fixture = confirmed()
    const moved = { ...grant, remote: { ...REMOTE, path: 'E:/renders/conductor' }, confirmedAt: '2026-03-02T09:00:00.000Z' }
    fixture.client.confirmProject('render-desktop', moved)
    expect(fixture.client.get('render-desktop')?.projectGrants).toEqual([moved])
  })

  it('lets the owner take a mapping back, and refuses that machine again straight away', () => {
    const fixture = confirmed()
    const before = fixture.client.authorityRevision('render-desktop')
    fixture.client.releaseProject('render-desktop', 'project-a')
    expect(fixture.client.authorityRevision('render-desktop')).toBe(before + 1)
    expect(placement(fixture)).toMatchObject({ ok: false, reason: 'not-mapped' })
  })

  it('changes local authority generation even when an exact same mapping is confirmed again', () => {
    const fixture = confirmed()
    const before = fixture.client.authorityRevision('render-desktop')
    fixture.client.confirmProject('render-desktop', { ...grant })
    expect(fixture.client.authorityRevision('render-desktop')).toBe(before + 1)
  })

  it('will not record a mapping for a machine this one is not paired with', () => {
    expect(() => client([legacyConnection]).client.confirmProject('nowhere', grant)).toThrow(/not paired with that one/)
  })

  it('ignores a stored mapping that is missing half of what makes it one', () => {
    const fixture = client([{ ...legacyConnection, projectGrants: [{ localProjectId: 'project-a', remoteProjectId: 'remote-a', local: LOCAL }, grant] }])
    expect(fixture.client.get('render-desktop')?.projectGrants).toEqual([grant])
  })
})
