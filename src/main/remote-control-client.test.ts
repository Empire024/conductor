import { describe, expect, it } from 'vitest'
import type { RemoteProjectSummary } from '../shared/remote-control'
import type { ProjectIdentity, RemoteProjectGrant } from '../shared/project-identity'
import { RemoteControlClient } from './remote-control-client'
import { encodeTicket } from '../shared/remote-control'
import { RemoteAccessError } from './remote-peers'
import { generateDeviceKey } from './device-key'
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

/**
 * The first pairing request, which happens while the route is still deciding what it is.
 *
 * A machine handed an invite may still be working out that the relay address in it cannot be reached
 * from here, and only then hand itself to the mailbox. Failing on the first attempt would turn "give
 * it a moment" into "pairing failed", which is how an owner concludes none of this works.
 */
describe('the first knock on the other machine', () => {
  const device = generateDeviceKey('conductor pairing test')

  function pairing(answers: Array<() => Promise<{ status: number; body: string }>>) {
    const attempts: string[] = []
    const client = new RemoteControlClient({
      store: new MapStore(),
      machineId: () => 'this-machine',
      machineName: () => 'This Laptop',
      deviceKey: () => device,
      pairRetryMs: 1,
      relay: {
        enabled: () => true,
        call: async (_machineId, _peerDeviceKey, path) => {
          attempts.push(path)
          const answer = answers[Math.min(attempts.length - 1, answers.length - 1)]!
          return await answer()
        }
      },
      now: () => Date.parse('2026-03-02T09:00:00.000Z')
    })
    const ticket = encodeTicket({
      version: 1, machineId: 'render-desktop', machineName: 'Render Desktop', accountLogin: 'Empire024',
      // Nothing listens on the direct address, so only the relay can carry this.
      host: '127.0.0.1', port: 1, fingerprint: 'AA:BB', code: 'pairing-code',
      expiresAt: '2026-03-02T09:10:00.000Z', relayKey: 'relay-public-key', deviceKey: 'ssh-ed25519 THEIRS'
    })
    return { client, ticket, attempts }
  }

  it('adopts an approval that arrived after it stopped waiting', async () => {
    // Every poll while connect() waits says "pending" and the code runs out; the owner approves
    // only after that. The record left pending is asked about again by the next call, and adopted.
    let clock = Date.parse('2026-03-02T09:00:00.000Z')
    let approvedYet = false
    const paths: string[] = []
    const client = new RemoteControlClient({
      store: new MapStore(),
      machineId: () => 'this-machine',
      machineName: () => 'This Laptop',
      deviceKey: () => device,
      pairRetryMs: 1,
      relay: {
        enabled: () => true,
        call: async (_machineId, _peerDeviceKey, path) => {
          paths.push(path)
          const result = path === '/remote/pair/status'
            ? (approvedYet ? { status: 'approved', peerId: 'peer-late', projects: [] } : { status: 'pending', projects: [] })
            : path === '/remote/call' ? { echoed: true } : { accepted: true }
          return { status: 200, body: Buffer.from(JSON.stringify({ result }), 'utf8').toString('base64') }
        }
      },
      now: () => clock
    })
    const ticket = encodeTicket({
      version: 1, machineId: 'render-desktop', machineName: 'Render Desktop', accountLogin: 'Empire024',
      host: '127.0.0.1', port: 1, fingerprint: 'AA:BB', code: 'pairing-code',
      expiresAt: '2026-03-02T09:10:00.000Z', relayKey: 'relay-public-key', deviceKey: 'ssh-ed25519 THEIRS'
    })
    // Each wait for the owner takes five minutes here, so the code expires after two polls.
    await expect(client.connect(ticket, async () => { clock += 5 * 60_000 })).rejects.toMatchObject({ status: 408 })
    expect(client.get('render-desktop')).toMatchObject({ status: 'pending', peerId: '' })
    expect(paths.filter(path => path === '/remote/pair/status')).toHaveLength(2)

    approvedYet = true
    expect(await client.call('render-desktop', 'projects.list')).toEqual({ echoed: true })
    expect(client.get('render-desktop')).toMatchObject({ status: 'connected', peerId: 'peer-late' })
    expect(paths.filter(path => path === '/remote/pair/status')).toHaveLength(3)
  })

  const unreachable = async (): Promise<{ status: number; body: string }> => { throw new RemoteAccessError('nothing carried it', 503) }
  const approved = async (): Promise<{ status: number; body: string }> => ({
    status: 200,
    body: Buffer.from(JSON.stringify({ result: { status: 'approved', peerId: 'peer-9', projects: [] } }), 'utf8').toString('base64')
  })

  it('keeps knocking while the route is still settling, instead of failing on the first silence', async () => {
    let knocks = 0
    const fixture = pairing([async () => {
      knocks++
      if (knocks <= 3) throw new RemoteAccessError('nothing carried it', 503)
      return await approved()
    }])

    const connection = await fixture.client.connect(fixture.ticket, async () => { /* no waiting between polls */ })
    expect(connection.status).toBe('connected')
    expect(knocks).toBeGreaterThan(3)
  })

  it('does not keep knocking at a machine that answered', async () => {
    // An expired code says the same thing in a minute, so it is reported at once.
    const fixture = pairing([async () => { throw new RemoteAccessError('That pairing code is not valid on this machine.', 401) }])
    await expect(fixture.client.connect(fixture.ticket, async () => {})).rejects.toThrow(/not valid/)
    expect(fixture.attempts).toHaveLength(1)
  })

  it('gives up when nothing carries it at all', async () => {
    const fixture = pairing([unreachable])
    await expect(fixture.client.connect(fixture.ticket, async () => {})).rejects.toThrow(/nothing carried it/)
    expect(fixture.attempts.length).toBeGreaterThan(1)
  })
})

/**
 * Reaching a machine that is no longer on this network. The direct address is tried first and fails
 * the way a stale LAN address really does; what matters is that the call still completes over the
 * encrypted relay, and that a refusal the machine itself sent is not quietly retried there.
 */
describe('reaching a machine off this network', () => {
  const device = generateDeviceKey('conductor test')
  const paired = {
    machineId: 'render-desktop', machineName: 'Render Desktop', accountLogin: 'Empire024',
    // Nothing listens here, so the direct attempt fails immediately rather than on a timer.
    host: '127.0.0.1', port: 1, fingerprint: 'AA:BB', peerId: 'peer-1',
    relayKey: 'relay-public-key', deviceKey: 'ssh-ed25519 THEIRS',
    projectGrants: [grant], remoteProjects: [advertised], remoteProjectsAt: null, unconfirmedRemoteProjectIds: [],
    connectedAt: '2026-03-01T10:00:00.000Z', lastContactAt: null, status: 'connected', message: null
  }

  function relayed(stored: unknown[], answer: () => Promise<{ status: number; body: string }>) {
    const store = new MapStore()
    store.setSetting(CONNECTIONS, JSON.stringify(stored))
    const calls: Array<{ machineId: string; path: string; body: string; peerDeviceKey: string; peerRelayKey?: string }> = []
    const client = new RemoteControlClient({
      store, machineId: () => 'this-machine', machineName: () => 'This Laptop',
      deviceKey: () => device,
      relay: {
        enabled: () => true,
        call: async (machineId, peerDeviceKey, path, body, _headers, peerRelayKey) => {
          calls.push({ machineId, path, body: body.toString('utf8'), peerDeviceKey, peerRelayKey })
          return await answer()
        }
      },
      now: () => Date.parse('2026-03-02T09:00:00.000Z')
    })
    return { client, calls }
  }

  const ok = (result: unknown) => async () => ({ status: 200, body: Buffer.from(JSON.stringify({ result }), 'utf8').toString('base64') })

  it('falls back to the encrypted relay when the stored address leads nowhere', async () => {
    const fixture = relayed([paired], ok({ id: 'tab-1' }))
    await expect(fixture.client.call('render-desktop', 'tabs.open', { projectId: 'remote-a' })).resolves.toEqual({ id: 'tab-1' })
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0]).toMatchObject({
      machineId: 'render-desktop', path: '/remote/call',
      peerDeviceKey: 'ssh-ed25519 THEIRS', peerRelayKey: 'relay-public-key'
    })
    // The relay carries the same signed body the direct route would have, method and all.
    expect(JSON.parse(fixture.calls[0]!.body)).toEqual({ method: 'tabs.open', args: { projectId: 'remote-a' } })
    expect(fixture.client.get('render-desktop')).toMatchObject({ status: 'connected', transport: 'relay' })
  })

  it('reports a refusal the other machine sent, rather than treating it as an unreachable machine', async () => {
    const fixture = relayed([paired], async () => ({
      status: 403, body: Buffer.from(JSON.stringify({ error: 'That project is not shared with you.' }), 'utf8').toString('base64')
    }))
    await expect(fixture.client.call('render-desktop', 'files.read', { path: 'x' })).rejects.toThrow(/not shared with you/)
    expect(fixture.client.get('render-desktop')).toMatchObject({ status: 'connected' })
  })

  it('says so plainly when a machine has neither a route here nor a relay key', async () => {
    const fixture = relayed([{ ...paired, host: '', port: 0, relayKey: undefined, deviceKey: undefined }], ok(null))
    await expect(fixture.client.call('render-desktop', 'tabs.list', {})).rejects.toThrow(/pair again to reach it from anywhere/i)
    expect(fixture.calls).toHaveLength(0)
  })

  /**
   * The failure the owner actually hits after moving a laptop: the stored address is on a network
   * they are no longer on, so the socket times out. What they must not be handed is the bare
   * `connect ETIMEDOUT 192.168.x.x`, which names neither route nor remedy.
   */
  it('blames the missing relay key, not the dead address, for a pairing made before the relay', async () => {
    const fixture = relayed([{ ...paired, relayKey: undefined, deviceKey: undefined }], ok(null))
    const failure = await fixture.client.call('render-desktop', 'tabs.list', {}).catch((reason: Error) => reason)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/paired before the encrypted relay existed/i)
    expect((failure as Error).message).toMatch(/pair again/i)
    // The underlying socket failure is still carried, so a real diagnosis is not lost either.
    expect((failure as Error).message).toMatch(/127\.0\.0\.1/)
    expect(fixture.calls).toHaveLength(0)
  })

  it('blames the switched-off relay when the pairing does carry its keys', async () => {
    const store = new MapStore()
    store.setSetting(CONNECTIONS, JSON.stringify([paired]))
    const client = new RemoteControlClient({
      store, machineId: () => 'this-machine', machineName: () => 'This Laptop',
      deviceKey: () => device,
      relay: { enabled: () => false, call: async () => ({ status: 200, body: '' }) },
      now: () => Date.parse('2026-03-02T09:00:00.000Z')
    })
    await expect(client.call('render-desktop', 'tabs.list', {})).rejects.toThrow(/relay is not running on this machine/i)
  })

  it('keeps a pairing made before the relay existed working over its direct address alone', () => {
    const fixture = relayed([{ ...paired, relayKey: undefined, deviceKey: undefined }], ok(null))
    const connection = fixture.client.list()[0]!
    expect(connection.relayKey).toBeUndefined()
    expect(connection.deviceKey).toBeUndefined()
    expect(connection.status).toBe('connected')
  })
})

/** A pairing made over the tailnet: one route, no relay key, no room secret. */
const tailscaleConnection = {
  machineId: 'render-desktop', machineName: 'Render Desktop', accountLogin: 'Empire024',
  host: '100.80.1.2', port: 51840, fingerprint: 'AA:BB', peerId: 'peer-1', transport: 'tailscale',
  dnsName: 'render-desktop.tail1234.ts.net', generation: 2,
  projectGrants: [], remoteProjects: [], remoteProjectsAt: null, unconfirmedRemoteProjectIds: [],
  connectedAt: '2026-03-01T10:00:00.000Z', lastContactAt: null, status: 'connected', message: null
}

function keyed(stored: unknown[], relay?: { enabled(): boolean; call: RelayCall }) {
  const store = new MapStore()
  store.setSetting(CONNECTIONS, JSON.stringify(stored))
  return {
    store,
    client: new RemoteControlClient({
      store, machineId: () => 'this-machine', machineName: () => 'This Laptop',
      deviceKey: () => generateDeviceKey('laptop'),
      now: () => Date.parse('2026-03-02T09:00:00.000Z'),
      ...(relay ? { relay } : {})
    })
  }
}

type RelayCall = (machineId: string, peerDeviceKey: string, path: string, body: Buffer, headers: Record<string, string>) => Promise<{ status: number; body: string }>

const envelope = (result: unknown): { status: number; body: string } =>
  ({ status: 200, body: Buffer.from(JSON.stringify({ result }), 'utf8').toString('base64') })

describe('a pairing made over Tailscale', () => {
  it('keeps the transport, the MagicDNS name and the generation across a restart', () => {
    const connection = keyed([tailscaleConnection]).client.list()[0]!
    expect(connection).toMatchObject({ transport: 'tailscale', dnsName: 'render-desktop.tail1234.ts.net', generation: 2 })
    expect(connection.relayKey).toBeUndefined()
    expect(connection.deviceKey).toBeUndefined()
  })

  it('refuses to dial an address that is not on the tailnet, and never reaches for the relay', async () => {
    const calls: string[] = []
    const fixture = keyed(
      [{ ...tailscaleConnection, host: '192.168.1.20', relayKey: 'relay-key', deviceKey: 'device-key' }],
      { enabled: () => true, call: async (machineId) => { calls.push(machineId); return envelope({}) } }
    )
    // Both fallbacks refused at once: the LAN address is not dialled, and the relay key that was
    // somehow stored alongside it is not used either. There is one route or there is none.
    await expect(fixture.client.call('render-desktop', 'projects.list')).rejects.toThrow(/only reached at its tailnet address/)
    expect(calls).toEqual([])
  })

  it('explains an unreachable tailnet host in terms of Tailscale rather than the relay', async () => {
    // A record with a tailnet address and no port: nothing to dial and, by construction, nothing
    // else to try. The owner needs to be sent to Tailscale, not to a relay setting that this
    // pairing deliberately does not have.
    const fixture = keyed([{ ...tailscaleConnection, port: 0 }])
    await expect(fixture.client.call('render-desktop', 'projects.list')).rejects.toThrow(/Tailscale is running and signed in on both computers/)
  })
})

describe('using this computer independently of a host', () => {
  it('sends nothing at all and says why', async () => {
    const calls: string[] = []
    const fixture = keyed(
      [{ ...tailscaleConnection, host: '', relayKey: 'relay-key', deviceKey: 'device-key' }],
      { enabled: () => true, call: async (machineId) => { calls.push(machineId); return envelope({}) } }
    )
    fixture.client.setDetached('render-desktop', true)
    const refusal = await fixture.client.call('render-desktop', 'projects.list').catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(RemoteAccessError)
    expect((refusal as RemoteAccessError).status).toBe(409)
    expect((refusal as RemoteAccessError).code).toBe('detached')
    expect((refusal as RemoteAccessError).message).toMatch(/Using this computer independently of Render Desktop/)
    // Nothing was attempted: this has to work when the host is off, lost or gone.
    expect(calls).toEqual([])
  })

  it('bumps the generation on each detach and attach, keeps the pairing, and remembers it', () => {
    const fixture = keyed([tailscaleConnection])
    expect(fixture.client.setDetached('render-desktop', true).generation).toBe(3)
    // Detaching twice is not two detaches; only a change is a change.
    expect(fixture.client.setDetached('render-desktop', true).generation).toBe(3)
    expect(fixture.client.setDetached('render-desktop', false).generation).toBe(4)
    expect(fixture.client.setDetached('render-desktop', true).generation).toBe(5)
    const reloaded = keyed(JSON.parse(fixture.store.getSetting(CONNECTIONS) ?? '[]') as unknown[])
    // Detaching is not forgetting: the pairing, its peer id and its certificate all survive.
    expect(reloaded.client.list()[0]).toMatchObject({ detached: true, generation: 5, peerId: 'peer-1', fingerprint: 'AA:BB' })
  })

  it('drops an answer that arrives after the owner detached instead of applying it', async () => {
    let detach = (): void => {}
    const fixture = keyed(
      [{ ...tailscaleConnection, transport: 'relay', host: '', relayKey: 'relay-key', deviceKey: 'device-key' }],
      { enabled: () => true, call: async () => { detach(); return envelope({ projects: [] }) } }
    )
    detach = () => { fixture.client.setDetached('render-desktop', true) }
    const refusal = await fixture.client.call('render-desktop', 'projects.list').catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(RemoteAccessError)
    expect((refusal as RemoteAccessError).code).toBe('stale-generation')
    expect((refusal as RemoteAccessError).status).toBe(409)
    // The work on the other machine really happened; it is only this machine's copy of the world
    // that must not be written by a reply the owner has already stopped waiting for.
    expect(fixture.client.list()[0]).toMatchObject({ lastContactAt: null, detached: true })
  })
})
