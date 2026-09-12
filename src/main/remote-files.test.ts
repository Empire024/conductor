import { describe, expect, it, vi } from 'vitest'
import type { RemoteConnection, RemoteProjectSummary } from '../shared/remote-control'
import type { RemoteProjectGrant } from '../shared/project-identity'
import { RemoteControlClient } from './remote-control-client'
import { RemoteFiles } from './remote-files'
import { REMOTE_FILE_CHUNK_BYTES } from '../shared/remote-files'

const localIdentity = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: 'C:/controller/project', name: 'Project' }
const remoteIdentity = { key: 'b'.repeat(32), keyCreatedAt: '2026-02-01T00:00:00.000Z', path: 'D:/host/project', name: 'Project' }
const grant: RemoteProjectGrant = {
  localProjectId: 'local-project', local: localIdentity,
  remoteProjectId: 'host-project', remote: remoteIdentity,
  confirmedAt: '2026-02-02T00:00:00.000Z'
}
const advertised: RemoteProjectSummary = { id: 'host-project', name: 'Project', path: remoteIdentity.path, identity: remoteIdentity, identityError: null }

const connection = (): RemoteConnection => ({
  machineId: 'host-machine', machineName: 'Host', accountLogin: 'owner', host: '127.0.0.1', port: 51840,
  fingerprint: 'AA', peerId: 'peer-1', projectGrants: [grant], remoteProjects: [advertised], remoteProjectsAt: null,
  unconfirmedRemoteProjectIds: [], connectedAt: new Date(0).toISOString(), lastContactAt: null, status: 'connected', message: null
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(call?: ReturnType<typeof vi.fn>) {
  let current = connection()
  let revision = 0
  let local: RemoteProjectSummary | null = { id: 'local-project', name: 'Project', path: localIdentity.path, identity: localIdentity, identityError: null }
  const remoteCall = call ?? vi.fn(async (_machineId: string, method: string) => {
    if (method === 'projects.list') return [advertised]
    if (method === 'files.list') return [{ name: 'host-only.txt', path: 'host-only.txt', kind: 'file' }]
    if (method === 'files.stat') return { size: 10, isFile: true, modifiedAt: '2026-03-01T00:00:00.000Z' }
    if (method === 'files.read') return { path: 'same-name.txt', content: 'bytes from host' }
    if (method === 'files.write') return { status: 'saved' }
    if (method === 'files.describe') return {
      path: 'frame.png', size: 10, modifiedAt: '2026-03-01T00:00:00.000Z', version: 'c'.repeat(64),
      kind: 'image', mimeType: 'image/png'
    }
    if (method === 'files.readChunk') return {
      path: 'frame.png', offset: 0, length: 10, totalSize: 10, version: 'c'.repeat(64),
      bytesBase64: Buffer.from('host image').toString('base64'), eof: true
    }
    throw new Error(`unexpected ${method}`)
  })
  const client = {
    get: (machineId: string) => machineId === current.machineId ? current : undefined,
    authorityRevision: () => revision,
    call: remoteCall
  } as unknown as RemoteControlClient
  const files = new RemoteFiles({ client, project: id => id === 'local-project' ? local : null })
  return {
    files,
    call: remoteCall,
    release: () => { current.projectGrants = []; revision++ },
    revoke: () => { current.status = 'revoked'; revision++ },
    replace: () => { current = connection(); revision++ },
    removeLocal: () => { local = null },
    makeLocalUnreadable: () => { local = { ...local!, identity: null, identityError: 'Controller identity unreadable' } }
  }
}

const file = { machineId: 'host-machine', projectId: 'local-project', path: 'same-name.txt' }

describe('controller remote owner filespace', () => {
  it('keeps machine identity on directory entries and never exposes the host absolute path', async () => {
    const fix = fixture()
    await expect(fix.files.list({ ...file, path: '' })).resolves.toEqual([{
      file: { machineId: 'host-machine', projectId: 'local-project', path: 'host-only.txt' },
      name: 'host-only.txt', kind: 'file'
    }])
    expect(fix.call).toHaveBeenNthCalledWith(1, 'host-machine', 'projects.list')
    expect(fix.call).toHaveBeenNthCalledWith(2, 'host-machine', 'files.list', { projectId: 'host-project', path: '' })
  })

  it('reads host bytes for a same-named file and carries controller mapping identity in the result', async () => {
    await expect(fixture().files.read(file)).resolves.toEqual({ file, content: 'bytes from host' })
  })

  it('sends the exact expected host contents on guarded writes', async () => {
    const fix = fixture()
    await expect(fix.files.write({ ...file, content: 'new host bytes', expectedContent: 'bytes from host' }))
      .resolves.toEqual({ file, result: { status: 'saved' } })
    expect(fix.call).toHaveBeenLastCalledWith('host-machine', 'files.write', {
      projectId: 'host-project', path: file.path, content: 'new host bytes', expectedContent: 'bytes from host'
    })
  })

  it('describes and reads bounded versioned host media without aggregating it into text JSON', async () => {
    const fix = fixture()
    const media = { ...file, path: 'frame.png' }
    const description = await fix.files.describe(media)
    expect(description).toEqual({
      file: media, size: 10, modifiedAt: '2026-03-01T00:00:00.000Z', version: 'c'.repeat(64),
      kind: 'image', mimeType: 'image/png'
    })
    const chunk = await fix.files.readChunk({ ...media, offset: 0, length: 10, version: description.version })
    expect(Buffer.from(chunk.bytesBase64, 'base64').toString()).toBe('host image')
    expect(chunk).toMatchObject({ file: media, offset: 0, length: 10, totalSize: 10, eof: true })
    expect(fix.call).toHaveBeenLastCalledWith('host-machine', 'files.readChunk', {
      projectId: 'host-project', path: 'frame.png', offset: 0, length: 10, version: 'c'.repeat(64)
    })
  })

  it('rejects invalid chunk requests before contacting the remote host', async () => {
    const fix = fixture()
    for (const request of [
      { offset: -1, length: 1, version: 'c'.repeat(64) },
      { offset: 0, length: REMOTE_FILE_CHUNK_BYTES + 1, version: 'c'.repeat(64) },
      { offset: 0, length: 1, version: 'not-a-version' }
    ]) await expect(fix.files.readChunk({ ...file, path: 'frame.png', ...request })).rejects.toThrow(/range or version/)
    expect(fix.call).not.toHaveBeenCalled()
  })

  it('rejects a late media chunk after revocation', async () => {
    const response = deferred<unknown>()
    const call = vi.fn(async (_machineId: string, method: string) => method === 'projects.list' ? [advertised] : response.promise)
    const fix = fixture(call)
    const pending = fix.files.readChunk({ ...file, path: 'frame.png', offset: 0, length: 10, version: 'c'.repeat(64) })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    fix.revoke()
    response.resolve({
      path: 'frame.png', offset: 0, length: 10, totalSize: 10, version: 'c'.repeat(64),
      bytesBase64: Buffer.from('host image').toString('base64'), eof: true
    })
    await expect(pending).rejects.toThrow(/access changed|revoked/)
  })

  it('fails closed when the confirmed mapping is released while identity refresh is pending', async () => {
    const projects = deferred<unknown>()
    const call = vi.fn(() => projects.promise)
    const fix = fixture(call)
    const pending = fix.files.read(file)
    fix.release()
    projects.resolve([advertised])
    await expect(pending).rejects.toThrow(/access changed/)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('rejects a late file reply after revoke instead of accepting its contents', async () => {
    const response = deferred<unknown>()
    const call = vi.fn(async (_machineId: string, method: string) => method === 'projects.list' ? [advertised] : response.promise)
    const fix = fixture(call)
    const pending = fix.files.read(file)
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    fix.revoke()
    response.resolve({ path: file.path, content: 'stale host bytes' })
    await expect(pending).rejects.toThrow(/access changed|revoked/)
  })

  it('rejects identity refresh when the controller project disappears before it returns', async () => {
    const projects = deferred<unknown>()
    const call = vi.fn(() => projects.promise)
    const fix = fixture(call)
    const pending = fix.files.read(file)
    fix.removeLocal()
    projects.resolve([advertised])
    await expect(pending).rejects.toThrow(/identity|project/i)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('rejects a pending write reply when the controller project identity becomes unreadable', async () => {
    const response = deferred<unknown>()
    const call = vi.fn(async (_machineId: string, method: string) => method === 'projects.list' ? [advertised] : response.promise)
    const fix = fixture(call)
    const pending = fix.files.write({ ...file, content: 'new host bytes', expectedContent: 'bytes from host' })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    fix.makeLocalUnreadable()
    response.resolve({ status: 'saved' })
    await expect(pending).rejects.toThrow(/identity/i)
  })

  it('rejects an old response after an exact same-value re-pair', async () => {
    const response = deferred<unknown>()
    const call = vi.fn(async (_machineId: string, method: string) => method === 'projects.list' ? [advertised] : response.promise)
    const fix = fixture(call)
    const pending = fix.files.stat(file)
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    fix.replace()
    response.resolve({ size: 10, isFile: true, modifiedAt: '2026-03-01T00:00:00.000Z' })
    await expect(pending).rejects.toThrow(/access changed/)
  })

  it('has no controller-local fallback when the remote transport is offline', async () => {
    const fix = fixture(vi.fn(async (_machineId: string, method: string) => {
      if (method === 'projects.list') return [advertised]
      throw new Error('Host is offline')
    }))
    await expect(fix.files.read(file)).rejects.toThrow(/Host is offline/)
  })

  it('rejects traversal before contacting either the remote or local filesystem', async () => {
    const fix = fixture()
    await expect(fix.files.read({ ...file, path: '../same-name.txt' })).rejects.toThrow(/stay relative/)
    expect(fix.call).not.toHaveBeenCalled()
  })

  it('rejects a host list reply whose displayed name does not match its scoped path', async () => {
    const fix = fixture(vi.fn(async (_machineId: string, method: string) => method === 'projects.list'
      ? [advertised]
      : [{ name: 'safe.txt', path: '../controller/safe.txt', kind: 'file' }]))
    await expect(fix.files.list({ ...file, path: '' })).rejects.toThrow(/stay relative/)
  })

  it('rejects local-machine identities at the remote boundary', async () => {
    await expect(fixture().files.read({ ...file, machineId: 'local' })).rejects.toThrow(/paired machine/)
  })
})
