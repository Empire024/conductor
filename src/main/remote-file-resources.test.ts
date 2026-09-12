import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_FILE_CHUNK_BYTES, type RemoteFileDescription, type RemoteFileIdentity } from '../shared/remote-files'
import type { RemoteFiles } from './remote-files'
import { RemoteFileResourceServer } from './remote-file-resources'

const identity: RemoteFileIdentity = { machineId: 'render-host', projectId: 'controller-project', path: 'renders/frame.png' }
const roots: string[] = []
const servers: RemoteFileResourceServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

function fixture(bytes = Buffer.from('remote-render-bytes')) {
  let now = Date.parse('2026-09-12T15:00:00.000Z')
  let version = 'a'.repeat(64)
  let mimeType = 'image/png'
  let kind: 'image' | 'video' = 'image'
  const describeFile = vi.fn(async (file: RemoteFileIdentity): Promise<RemoteFileDescription> => ({
    file: { ...file }, size: bytes.length, modifiedAt: '2026-09-12T14:59:00.000Z', version, mimeType, kind
  }))
  const readChunk = vi.fn(async (requested: RemoteFileIdentity & { offset: number; length: number; version: string }) => {
    if (requested.version !== version) throw new Error('version changed')
    const content = bytes.subarray(requested.offset, requested.offset + requested.length)
    return {
      file: { machineId: requested.machineId, projectId: requested.projectId, path: requested.path },
      offset: requested.offset, length: content.length, totalSize: bytes.length, version,
      bytesBase64: content.toString('base64'), eof: requested.offset + content.length >= bytes.length
    }
  })
  const files = { describe: describeFile, readChunk } as unknown as Pick<RemoteFiles, 'describe' | 'readChunk'>
  return {
    files, describeFile, readChunk,
    now: () => now,
    advance: (ms: number) => { now += ms },
    change: () => { version = 'b'.repeat(64) },
    active: () => { mimeType = 'image/svg+xml'; kind = 'image' as const }
  }
}

const get = (url: string, options: { method?: string; range?: string; host?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const call = request({
      hostname: target.hostname, port: target.port, path: target.pathname + target.search,
      method: options.method ?? 'GET', headers: {
        ...(options.range ? { Range: options.range } : {}),
        ...(options.host ? { Host: options.host } : {})
      }
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    call.on('error', reject)
    call.end()
  })

describe('remote file loopback capabilities', () => {
  it('serves only the opaque capability on loopback with bounded range requests', async () => {
    const fix = fixture(Buffer.from('0123456789abcdef'))
    const server = new RemoteFileResourceServer({ files: fix.files, now: fix.now, token: () => 'c'.repeat(64) })
    servers.push(server)
    const resource = await server.issue(identity)
    const target = new URL(resource.url)
    expect(target.hostname).toBe('127.0.0.1')
    expect(target.pathname).toBe('/' + 'c'.repeat(64))
    expect(resource).toMatchObject({ file: identity, kind: 'image', mimeType: 'image/png', size: 16 })

    const ranged = await get(resource.url, { range: 'bytes=3-8' })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe('bytes 3-8/16')
    expect(ranged.headers['content-type']).toBe('image/png')
    expect(ranged.headers['x-content-type-options']).toBe('nosniff')
    expect(ranged.body.toString()).toBe('345678')
    expect(fix.readChunk).toHaveBeenCalledWith({ ...identity, offset: 3, length: 6, version: 'a'.repeat(64) })
  })

  it('rejects path additions, forged Host headers, invalid ranges and expired capabilities', async () => {
    const fix = fixture()
    const server = new RemoteFileResourceServer({ files: fix.files, now: fix.now, token: () => 'd'.repeat(64), ttlMs: 1000 })
    servers.push(server)
    const resource = await server.issue(identity)
    expect((await get(resource.url + '/../../secrets')).status).toBe(404)
    expect((await get(resource.url, { host: 'attacker.example' })).status).toBe(404)
    expect((await get(resource.url, { range: 'bytes=0-999999' })).status).toBe(416)
    fix.advance(1001)
    expect((await get(resource.url)).status).toBe(409)
    expect(fix.readChunk).not.toHaveBeenCalled()
  })

  it('revokes a capability when the host version changes and never serves active SVG content', async () => {
    const fix = fixture()
    const server = new RemoteFileResourceServer({ files: fix.files, token: () => 'e'.repeat(64) })
    servers.push(server)
    const resource = await server.issue(identity)
    fix.change()
    expect((await get(resource.url)).status).toBe(409)
    expect(fix.readChunk).not.toHaveBeenCalled()

    const active = fixture()
    active.active()
    const activeServer = new RemoteFileResourceServer({ files: active.files })
    servers.push(activeServer)
    await expect(activeServer.issue({ ...identity, path: 'active.svg' })).rejects.toThrow(/metadata is invalid/)
  })

  it('does not mint a capability when authority or the file version changes while loopback startup is pending', async () => {
    const fix = fixture()
    fix.describeFile.mockImplementationOnce(async file => {
      fix.change()
      return {
        file: { ...file }, size: Buffer.byteLength('remote-render-bytes'), modifiedAt: '2026-09-12T14:59:00.000Z',
        version: 'a'.repeat(64), mimeType: 'image/png', kind: 'image'
      }
    })
    const server = new RemoteFileResourceServer({ files: fix.files, token: () => 'f'.repeat(64) })
    servers.push(server)
    await expect(server.issue(identity)).rejects.toThrow(/changed while the service was starting/)
    expect(fix.describeFile).toHaveBeenCalledTimes(2)
  })

  it('streams an explicit owner-selected download through an exact temporary file and atomically publishes it', async () => {
    const bytes = Buffer.alloc(REMOTE_FILE_CHUNK_BYTES + 17, 91)
    const fix = fixture(bytes)
    const root = await mkdtemp(join(tmpdir(), 'conductor-remote-download-')); roots.push(root)
    const destination = join(root, 'frame.png')
    const server = new RemoteFileResourceServer({ files: fix.files, chooseDownloadPath: async () => destination })
    servers.push(server)
    await expect(server.download(identity)).resolves.toMatchObject({ file: identity, path: destination, size: bytes.length })
    expect(await readFile(destination)).toEqual(bytes)
    expect(fix.readChunk).toHaveBeenCalledTimes(2)
    expect(fix.readChunk.mock.calls.every(([request]) => request.length <= REMOTE_FILE_CHUNK_BYTES)).toBe(true)
    expect((await readdir(root)).filter(name => name.endsWith('.conductor-download'))).toEqual([])
  })

  it('removes only its owned temporary download when cancellation wins between chunks', async () => {
    const bytes = Buffer.alloc(REMOTE_FILE_CHUNK_BYTES + 17, 90)
    const fix = fixture(bytes)
    const root = await mkdtemp(join(tmpdir(), 'conductor-remote-download-')); roots.push(root)
    const destination = join(root, 'cancelled.png')
    const cancellation = new AbortController()
    fix.readChunk.mockImplementationOnce(async request => {
      cancellation.abort()
      const content = bytes.subarray(request.offset, request.offset + request.length)
      return { file: identity, offset: request.offset, length: content.length, totalSize: bytes.length,
        version: request.version, bytesBase64: content.toString('base64'), eof: false }
    })
    const server = new RemoteFileResourceServer({ files: fix.files, chooseDownloadPath: async () => destination })
    servers.push(server)
    await expect(server.download(identity, cancellation.signal)).rejects.toThrow(/cancelled/)
    expect(await readdir(root)).toEqual([])
  })

  it('does not publish and removes its exact temporary file when close wins during a remote chunk', async () => {
    const fix = fixture()
    const root = await mkdtemp(join(tmpdir(), 'conductor-remote-download-')); roots.push(root)
    const destination = join(root, 'closed.png')
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    fix.readChunk.mockImplementationOnce(async request => {
      await pending
      const content = Buffer.alloc(request.length, 88)
      return { file: identity, offset: request.offset, length: content.length, totalSize: content.length,
        version: request.version, bytesBase64: content.toString('base64'), eof: true }
    })
    const server = new RemoteFileResourceServer({ files: fix.files, chooseDownloadPath: async () => destination })
    servers.push(server)
    const downloading = server.download(identity)
    await vi.waitFor(() => expect(fix.readChunk).toHaveBeenCalledTimes(1))
    server.close()
    release()
    await expect(downloading).rejects.toThrow(/closed|revoked/)
    expect(await readdir(root)).toEqual([])
  })

  it('writes every byte when a temporary filesystem write completes partially', async () => {
    const fix = fixture()
    const server = new RemoteFileResourceServer({ files: fix.files })
    servers.push(server)
    const positions: number[] = []
    const fakeHandle = {
      write: vi.fn(async (_bytes: Buffer, _offset: number, length: number, position: number) => {
        positions.push(position)
        return { bytesWritten: Math.min(3, length), buffer: Buffer.alloc(0) }
      })
    }
    await (server as unknown as {
      writeAll(writer: { write: typeof fakeHandle.write }, bytes: Buffer, offset: number, current: () => void): Promise<void>
    }).writeAll(fakeHandle, Buffer.from('abcdefgh'), 11, () => {})
    expect(positions).toEqual([11, 14, 17])
  })
})
