import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemoteFileChunkRequest, RemoteFileDescription, RemoteFileIdentity } from '../shared/remote-files'
import { RemoteOpenCache, safeCopyName } from './remote-open-cache'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

const DAY = 24 * 60 * 60 * 1000
const file: RemoteFileIdentity = { machineId: 'main', projectId: 'haf-stuff', path: 'out/report.pdf' }

function fixture(content: Buffer, options: { kind?: RemoteFileDescription['kind']; version?: string; now?: () => number; maxBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-remote-open-')); roots.push(root)
  const version = options.version ?? 'a'.repeat(64)
  const describe = vi.fn(async (identity: RemoteFileIdentity): Promise<RemoteFileDescription> => ({
    file: identity, size: content.length, modifiedAt: new Date(0).toISOString(), version, kind: options.kind ?? 'document', mimeType: 'application/pdf'
  }))
  const readChunk = vi.fn(async (request: RemoteFileChunkRequest) => {
    const bytes = content.subarray(request.offset, request.offset + request.length)
    return {
      file: { machineId: request.machineId, projectId: request.projectId, path: request.path }, offset: request.offset, length: bytes.length,
      totalSize: content.length, version, bytesBase64: bytes.toString('base64'), eof: request.offset + bytes.length >= content.length
    }
  })
  const opened: string[] = []
  const cache = new RemoteOpenCache({
    files: { describe, readChunk }, root, open: async path => { opened.push(path) },
    ...(options.now ? { now: options.now } : {}), ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {})
  })
  return { cache, root, opened, describe, readChunk }
}

describe('opening a document from another machine with this computer\'s default app', () => {
  it('copies it whole, read-only, under its own name, and opens that copy', async () => {
    const content = Buffer.alloc(600 * 1024, 7)
    const f = fixture(content)
    const { path } = await f.cache.open(file)
    expect(path.startsWith(f.root)).toBe(true)
    expect(path.endsWith('report.pdf')).toBe(true)
    expect(readFileSync(path).equals(content)).toBe(true)
    // Three 256 KB chunks for 600 KB.
    expect(f.readChunk).toHaveBeenCalledTimes(3)
    expect(f.opened).toEqual([path])
    if (process.platform === 'win32') expect(() => writeFileSync(path, 'edit')).toThrow()
    else expect(statSync(path).mode & 0o222).toBe(0)
  })

  it('reuses the copy of the same version and fetches a changed one again', async () => {
    const f = fixture(Buffer.from('%PDF tiny'))
    const first = await f.cache.open(file)
    const second = await f.cache.open(file)
    expect(second.path).toBe(first.path)
    expect(f.readChunk).toHaveBeenCalledTimes(1)
    const changed = fixture(Buffer.from('%PDF changed'), { version: 'b'.repeat(64) })
    expect((await changed.cache.open(file)).path).not.toBe(first.path.replace(f.root, changed.root))
  })

  it('refuses anything that is not an allowlisted document, before asking the host', async () => {
    const f = fixture(Buffer.from('MZ'))
    await expect(f.cache.open({ ...file, path: 'tools/run.exe' })).rejects.toThrow(/PDFs, archives/)
    await expect(f.cache.open({ ...file, path: 'page.html' })).rejects.toThrow(/PDFs, archives/)
    expect(f.describe).not.toHaveBeenCalled()
    const media = fixture(Buffer.from('x'), { kind: 'image' })
    await expect(media.cache.open(file)).rejects.toThrow(/did not describe the file as a document/)
    expect(media.opened).toEqual([])
  })

  it('prunes copies older than a week, then the least recently used past the size cap, never the one being opened', async () => {
    let now = Date.parse('2026-10-19T10:00:00Z')
    const f = fixture(Buffer.alloc(400), { now: () => now, maxBytes: 1000 })
    const plant = (name: string, size: number, ageMs: number): string => {
      const folder = join(f.root, name, 'v'); mkdirSync(folder, { recursive: true })
      const path = join(folder, name + '.zip'); writeFileSync(path, Buffer.alloc(size))
      const at = new Date(now - ageMs); utimesSync(path, at, at)
      return path
    }
    const stale = plant('stale', 10, 8 * DAY)
    const older = plant('older', 400, 2 * DAY)
    const newer = plant('newer', 400, 1 * DAY)
    const { path } = await f.cache.open(file)
    expect(existsSync(stale)).toBe(false)
    // 400 + 400 + 400 is over 1000: the least recently used goes, the fresh copy stays.
    expect(existsSync(older)).toBe(false)
    expect(existsSync(newer)).toBe(true)
    expect(existsSync(path)).toBe(true)
    now += 8 * DAY
    await f.cache.prune()
    expect(existsSync(newer)).toBe(false)
  })

  it('copies an image for the phone without opening anything, and honours a narrower kind list', async () => {
    const f = fixture(Buffer.from('PNGBYTES'), { kind: 'image' })
    const { path, description } = await f.cache.copy({ ...file, path: 'out/logo.png' })
    expect(readFileSync(path, 'utf8')).toBe('PNGBYTES')
    expect(description.kind).toBe('image')
    expect(f.opened).toEqual([])
    await expect(f.cache.copy({ ...file, path: 'out/logo.png' }, ['document'])).rejects.toThrow(/document/)
  })

  it('keeps a usable, safe file name', () => {
    expect(safeCopyName('out/q3 report.pdf')).toBe('q3 report.pdf')
    expect(safeCopyName('a:b*c?.zip')).toBe('a_b_c_.zip')
    expect(safeCopyName('..')).toBe('file')
  })
})
