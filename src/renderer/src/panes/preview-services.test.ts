import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../../../shared/models'
import type { RemoteServiceRecord } from '../../../shared/remote-services'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import {
  HOST_SERVICE_NOTE, noServicesMessage, normalizeServicePort, orderServices, previewHostLost,
  previewOriginNote, previewTarget, serviceActionLabel, validateRegistration, viewingService
} from './preview-services'

const at = '2026-09-16T00:00:00.000Z'
const local: ProjectRecord = { id: 'project', name: 'Conductor', path: 'C:/here', createdAt: at, updatedAt: at }
const remote: ProjectRecord = {
  ...local, id: 'remote-project',
  remote: { machineId: 'main-box', machineName: 'MAIN', remoteProjectId: 'project_9', path: 'C:/there' }
}
const service = (patch: Partial<RemoteServiceRecord> = {}): RemoteServiceRecord =>
  ({ id: 's1', projectId: 'project_9', port: 5173, label: 'Dev server', createdAt: at, ...patch })

describe('deciding whether a browser pane previews this computer or a host', () => {
  it('previews the host for a project that lives there, named by the host\u2019s own project id', () => {
    expect(previewTarget(remote)).toEqual({ mode: 'controller', machineId: 'main-box', machineName: 'MAIN', projectId: 'project_9' })
  })

  it('previews the host for a paired project whose tab is placed there, named by our id', () => {
    // Our id, because the main process maps it through the grant - the same rule tab placement and
    // the launcher's terminal list follow, so one project is never scoped two different ways.
    expect(previewTarget(local, 'desktop', 'Render desktop'))
      .toEqual({ mode: 'controller', machineId: 'desktop', machineName: 'Render desktop', projectId: 'project' })
  })

  it('previews this computer for an ordinary local project', () => {
    expect(previewTarget(local)).toEqual({ mode: 'host' })
    expect(previewTarget(local, LOCAL_MACHINE_ID)).toEqual({ mode: 'host' })
    expect(previewTarget(null, 'desktop')).toEqual({ mode: 'host' })
  })

  it('keeps previewing the host even when a remote project\u2019s tab claims to be local', () => {
    // The project's origin outranks a tab's placement: there is no local copy to preview at all.
    expect(previewTarget(remote, LOCAL_MACHINE_ID)).toMatchObject({ mode: 'controller', machineId: 'main-box' })
  })
})

describe('registering a port on the machine that runs it', () => {
  it('accepts a label and a real loopback port', () => {
    expect(validateRegistration({ label: ' Dev server ', port: '5173' }, [])).toEqual({ ok: true, message: '', port: 5173, label: 'Dev server' })
  })

  it('refuses anything that is not a port, rather than registering something unreachable', () => {
    expect(normalizeServicePort('5173')).toBe(5173)
    expect(normalizeServicePort(1)).toBe(1)
    expect(normalizeServicePort(65535)).toBe(65535)
    expect(normalizeServicePort(0)).toBeNull()
    expect(normalizeServicePort(65536)).toBeNull()
    expect(normalizeServicePort(-1)).toBeNull()
    expect(normalizeServicePort('3000.5')).toBeNull()
    expect(normalizeServicePort('localhost:3000')).toBeNull()
    expect(normalizeServicePort('http://localhost:3000')).toBeNull()
    expect(normalizeServicePort('')).toBeNull()
    expect(normalizeServicePort(undefined)).toBeNull()
  })

  it('insists on a name, because the port is never shown on the other machine', () => {
    const result = validateRegistration({ label: '   ', port: '5173' }, [])
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/tell it apart on your other computer/)
  })

  it('says which port is wrong rather than failing silently', () => {
    expect(validateRegistration({ label: 'Dev', port: 'nope' }, []).message).toMatch(/between 1 and 65535/)
  })

  it('refuses a second label for a port already registered, naming the one that holds it', () => {
    const result = validateRegistration({ label: 'Storybook', port: 5173 }, [service()])
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/already registered as “Dev server”/)
    // A different port on the same project is fine.
    expect(validateRegistration({ label: 'Storybook', port: 6006 }, [service()]).ok).toBe(true)
  })
})

describe('what the owner is told the feature actually does', () => {
  it('promises reachability through Conductor and nothing else, and never a URL or another host', () => {
    expect(HOST_SERVICE_NOTE).toMatch(/through Conductor, and through nothing else/)
    expect(HOST_SERVICE_NOTE).toMatch(/No address is published/)
    expect(HOST_SERVICE_NOTE).toMatch(/not a port of its choosing and not any other host/)
    // The copy must not hand the owner an address to reach a service by - there is not one.
    expect(HOST_SERVICE_NOTE).not.toMatch(/https?:\/\//)
  })

  it('tells a controller exactly where to go when the host has registered nothing', () => {
    const message = noServicesMessage('MAIN')
    expect(message).toMatch(/No preview services are registered on MAIN/)
    expect(message).toMatch(/Register a dev server on MAIN under Preview services/)
  })

  it('names the machine on every action, so a preview is never mistaken for a local one', () => {
    expect(serviceActionLabel(service(), 'MAIN')).toBe('Open on MAIN: Dev server')
  })

  it('says the address belongs to this computer while the server does not', () => {
    const note = previewOriginNote(service(), 'MAIN')
    expect(note).toMatch(/running on MAIN \(port 5173 there\)/)
    expect(note).toMatch(/not a server on this computer/)
  })
})

describe('listing what is registered', () => {
  it('keeps the owner\u2019s own order stable instead of reshuffling under them', () => {
    const list = [
      service({ id: 'b', label: 'Storybook', port: 6006, createdAt: '2026-09-16T02:00:00.000Z' }),
      service({ id: 'a', label: 'Dev server', port: 5173, createdAt: '2026-09-16T01:00:00.000Z' })
    ]
    expect(orderServices(list).map(entry => entry.id)).toEqual(['a', 'b'])
    // And it does not mutate what it was given.
    expect(list.map(entry => entry.id)).toEqual(['b', 'a'])
  })
})

describe('naming the host only while its service is actually on screen', () => {
  it('names it while the tunnel’s own address is loaded', () => {
    expect(viewingService('http://127.0.0.1:49512/', 'http://127.0.0.1:49512')).toBe(true)
    expect(viewingService('http://127.0.0.1:49512/some/deep/route?x=1', 'http://127.0.0.1:49512')).toBe(true)
  })

  it('stops naming it the moment the owner navigates to their own localhost', () => {
    // The address bar keeps working while a tunnel is open. Labelling by mode rather than by what
    // is loaded would put "Remote: MAIN" over this laptop's own dev server.
    expect(viewingService('http://localhost:3000/', 'http://127.0.0.1:49512')).toBe(false)
    // A different port on the same loopback host is a different server, not the same one.
    expect(viewingService('http://127.0.0.1:3000/', 'http://127.0.0.1:49512')).toBe(false)
  })

  it('names nothing when there is no tunnel, or nothing loaded, or the address is unreadable', () => {
    expect(viewingService('http://127.0.0.1:49512/', '')).toBe(false)
    expect(viewingService(undefined, 'http://127.0.0.1:49512')).toBe(false)
    expect(viewingService('', 'http://127.0.0.1:49512')).toBe(false)
    expect(viewingService('not a url', 'http://127.0.0.1:49512')).toBe(false)
  })
})

describe('noticing that the host behind an open preview has gone', () => {
  const machine = (patch: Record<string, unknown> = {}) =>
    ({ id: 'main-box', status: 'online', connection: { state: 'connected' }, ...patch }) as never

  it('leaves a live preview alone', () => {
    expect(previewHostLost([machine()], 'main-box')).toBe(false)
  })

  it('drops the claim when the owner has detached from that machine', () => {
    expect(previewHostLost([machine({ connection: { state: 'detached' } })], 'main-box')).toBe(true)
  })

  it('drops the claim when the machine is offline or no longer paired at all', () => {
    expect(previewHostLost([machine({ status: 'offline' })], 'main-box')).toBe(true)
    expect(previewHostLost([machine({ status: 'revoked' })], 'main-box')).toBe(true)
    expect(previewHostLost([], 'main-box')).toBe(true)
  })
})
