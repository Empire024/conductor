import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteFileResourceServer } from './remote-file-resources'
import { REMOTE_FILE_CHUNK_BYTES, type RemoteFileIdentity } from '../shared/remote-files'

const identity: RemoteFileIdentity = { machineId: 'host', projectId: 'project', path: 'render.png' }
const roots: string[] = []
const servers: RemoteFileResourceServer[] = []
afterEach(async () => {
  servers.splice(0).forEach(server => server.close())
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})
function fixture(size = 16) {
  const metadata = { file: identity, size, version: 'a'.repeat(64), modifiedAt: new Date().toISOString(), kind: 'image' as const, mimeType: 'image/png' }
  const describeFile = vi.fn(async () => metadata)
  const readChunk = vi.fn(async (request: { offset: number; length: number }) => {
    const bytes = Buffer.alloc(Math.min(request.length, size - request.offset), 7)
    return { file: identity, offset: request.offset, length: bytes.length, totalSize: size, version: metadata.version,
      bytesBase64: bytes.toString('base64'), eof: request.offset + bytes.length === size }
  })
  return { files: { describe: describeFile, readChunk }, describeFile, readChunk, metadata }
}

describe('independent remote resource boundary review', () => {
  it('does not issue a capability after close wins during the final authority check', async () => {
    const fix = fixture()
    const server = new RemoteFileResourceServer({ files: fix.files }); servers.push(server)
    fix.describeFile.mockImplementationOnce(async () => fix.metadata).mockImplementationOnce(async () => {
      server.close()
      return fix.metadata
    })
    await expect(server.issue(identity)).rejects.toThrow(/closed|revoked/)
  })

  it('does not delete another writer replacement at its temporary download path', async () => {
    const fix = fixture()
    const root = await mkdtemp(join(tmpdir(), 'conductor-resource-review-')); roots.push(root)
    let replacement = ''
    fix.readChunk.mockImplementationOnce(async () => {
      replacement = join(root, (await readdir(root)).find(name => name.endsWith('.conductor-download'))!)
      await unlink(replacement)
      await writeFile(replacement, 'another writer owns this file')
      throw new Error('host revoked while reading')
    })
    const server = new RemoteFileResourceServer({ files: fix.files, chooseDownloadPath: async () => join(root, 'render.png') })
    servers.push(server)
    await expect(server.download(identity)).rejects.toThrow(/revoked/)
    expect(await readFile(replacement, 'utf8')).toBe('another writer owns this file')
  })

  it('stops reading remote chunks while the HTTP consumer applies backpressure', async () => {
    const fix = fixture(REMOTE_FILE_CHUNK_BYTES + 8)
    const server = new RemoteFileResourceServer({ files: fix.files }); servers.push(server)
    const resource = await server.issue(identity)
    const url = new URL(resource.url)
    const response = Object.assign(new EventEmitter(), {
      destroyed: false, headersSent: false,
      writeHead: vi.fn(), write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      end: vi.fn(), destroy: vi.fn()
    })
    const serving = (server as unknown as { serve(request: unknown, response: unknown): Promise<void> }).serve({
      method: 'GET', url: url.pathname, headers: { host: url.host }
    }, response)
    await new Promise(resolve => setTimeout(resolve, 20))
    const chunksBeforeDrain = fix.readChunk.mock.calls.length
    response.emit('drain')
    await serving
    expect(chunksBeforeDrain).toBe(1)
    expect(fix.readChunk).toHaveBeenCalledTimes(2)
  })
})
