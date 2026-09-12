import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { renameSync } from 'node:fs'
import { lstat, open, rm, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  RemoteFileDescription,
  RemoteFileDownloadResult,
  RemoteFileIdentity,
  RemoteFilePreviewResource
} from '../shared/remote-files'
import { REMOTE_FILE_CHUNK_BYTES, REMOTE_FILE_MAX_ASSET_BYTES } from '../shared/remote-files'
import type { RemoteFiles } from './remote-files'

const DEFAULT_TTL_MS = 2 * 60 * 1000
const SAFE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime'
])

interface Capability {
  token: string
  description: RemoteFileDescription
  expiresAt: number
}

interface TemporaryIdentity {
  dev: number
  ino: number
  birthtimeMs: number
}

export interface RemoteFileResourceDependencies {
  files: Pick<RemoteFiles, 'describe' | 'readChunk'>
  now?(): number
  token?(): string
  ttlMs?: number
  /** Main-owned native save dialog. The renderer never supplies a destination path. */
  chooseDownloadPath?(description: RemoteFileDescription): Promise<string | null>
}

const sameFile = (left: RemoteFileIdentity, right: RemoteFileIdentity): boolean =>
  left.machineId === right.machineId && left.projectId === right.projectId && left.path === right.path

const sameDescription = (left: RemoteFileDescription, right: RemoteFileDescription): boolean =>
  sameFile(left.file, right.file) && left.size === right.size && left.version === right.version
  && left.kind === right.kind && left.mimeType === right.mimeType

const validDescription = (value: RemoteFileDescription): boolean =>
  Boolean(value && value.file && typeof value.file.machineId === 'string' && typeof value.file.projectId === 'string'
    && typeof value.file.path === 'string' && Number.isSafeInteger(value.size)
    && value.size > 0 && value.size <= REMOTE_FILE_MAX_ASSET_BYTES
    && /^[a-f0-9]{64}$/.test(value.version) && SAFE_MIME.has(value.mimeType)
    && (value.kind === 'image' ? value.mimeType.startsWith('image/') : value.kind === 'video' && value.mimeType.startsWith('video/')))

/**
 * Streams an authenticated remote media file through one short-lived opaque loopback URL. The
 * URL contains no machine, project or filesystem path. Every request and every chunk goes back
 * through RemoteFiles, which revalidates account, mapping, grant and revocation around its awaits.
 */
export class RemoteFileResourceServer {
  private server: Server | null = null
  private starting: Promise<void> | null = null
  private origin = ''
  private closed = false
  private lifecycle = 0
  private capabilities = new Map<string, Capability>()

  constructor(private readonly deps: RemoteFileResourceDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private assertOpen(lifecycle = this.lifecycle): void {
    if (this.closed || lifecycle !== this.lifecycle) throw new Error('Remote preview service is closed or revoked.')
  }

  private current(capability: Capability): void {
    if (this.closed || this.capabilities.get(capability.token) !== capability || capability.expiresAt <= this.now()) {
      this.capabilities.delete(capability.token)
      throw new Error('Remote preview capability expired or was revoked.')
    }
  }

  private async listen(): Promise<void> {
    if (this.closed) throw new Error('Remote preview service is closed.')
    if (this.server) return
    if (this.starting) return this.starting
    const server = createServer((request, response) => {
      void this.serve(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(409, { 'Cache-Control': 'no-store' })
        response.end()
      })
    })
    this.starting = new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { server.off('listening', listened); reject(error) }
      const listened = (): void => { server.off('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', listened)
      server.listen(0, '127.0.0.1')
    })
    try {
      await this.starting
      if (this.closed) { server.close(); throw new Error('Remote preview service was closed while starting.') }
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Remote preview service did not bind to loopback.')
      this.server = server
      this.origin = `http://127.0.0.1:${address.port}`
      server.unref()
    } catch (error) {
      server.close()
      throw error
    } finally {
      this.starting = null
    }
  }

  async issue(file: RemoteFileIdentity): Promise<RemoteFilePreviewResource> {
    const lifecycle = this.lifecycle
    this.assertOpen(lifecycle)
    const description = await this.deps.files.describe(file)
    this.assertOpen(lifecycle)
    if (!validDescription(description) || !sameFile(description.file, file)) throw new Error('Remote preview metadata is invalid.')
    await this.listen()
    this.assertOpen(lifecycle)
    const current = await this.deps.files.describe(file)
    this.assertOpen(lifecycle)
    if (!validDescription(current) || !sameDescription(current, description)) {
      throw new Error('Remote preview resource changed while the service was starting.')
    }
    const token = this.deps.token?.() ?? randomBytes(32).toString('hex')
    if (!/^[a-f0-9]{64}$/.test(token) || this.capabilities.has(token)) throw new Error('Remote preview token generation failed.')
    const ttl = Math.min(Math.max(this.deps.ttlMs ?? DEFAULT_TTL_MS, 1000), 10 * 60 * 1000)
    const capability = { token, description, expiresAt: this.now() + ttl }
    this.capabilities.set(token, capability)
    return { ...description, url: `${this.origin}/${token}`, expiresAt: new Date(capability.expiresAt).toISOString() }
  }

  revoke(urlOrToken: string): void {
    let token = urlOrToken
    try { token = new URL(urlOrToken).pathname.slice(1) } catch { /* already a token */ }
    this.capabilities.delete(token)
  }

  private parse(request: IncomingMessage): Capability | null {
    if (!this.origin || request.headers.host !== new URL(this.origin).host || !['GET', 'HEAD'].includes(request.method ?? '')) return null
    const url = new URL(request.url ?? '/', this.origin)
    if (url.search || url.hash || !/^\/[a-f0-9]{64}$/.test(url.pathname)) return null
    return this.capabilities.get(url.pathname.slice(1)) ?? null
  }

  private range(header: string | undefined, size: number): { start: number; end: number; partial: boolean } | null {
    if (!header) return { start: 0, end: size - 1, partial: false }
    const match = /^bytes=(\d+)-(\d*)$/.exec(header)
    if (!match) return null
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || end >= size) return null
    return { start, end, partial: true }
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const capability = this.parse(request)
    if (!capability) { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(); return }
    this.current(capability)
    const refreshed = await this.deps.files.describe(capability.description.file)
    this.current(capability)
    if (!validDescription(refreshed) || !sameFile(refreshed.file, capability.description.file)
      || refreshed.version !== capability.description.version || refreshed.size !== capability.description.size
      || refreshed.kind !== capability.description.kind || refreshed.mimeType !== capability.description.mimeType) {
      this.capabilities.delete(capability.token)
      throw new Error('Remote preview resource changed.')
    }
    const range = this.range(typeof request.headers.range === 'string' ? request.headers.range : undefined, refreshed.size)
    if (!range) {
      response.writeHead(416, { 'Content-Range': `bytes */${refreshed.size}`, 'Cache-Control': 'no-store' })
      response.end(); return
    }
    response.writeHead(range.partial ? 206 : 200, {
      'Content-Type': refreshed.mimeType,
      'Content-Length': range.end - range.start + 1,
      'Accept-Ranges': 'bytes',
      ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${refreshed.size}` } : {}),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    })
    if (request.method === 'HEAD') { response.end(); return }
    let offset = range.start
    while (offset <= range.end && !response.destroyed) {
      this.current(capability)
      const length = Math.min(REMOTE_FILE_CHUNK_BYTES, range.end - offset + 1)
      const chunk = await this.deps.files.readChunk({
        ...refreshed.file, offset, length, version: refreshed.version
      })
      this.current(capability)
      if (chunk.offset !== offset || chunk.totalSize !== refreshed.size || chunk.version !== refreshed.version
        || chunk.length < 1 || chunk.length > length) throw new Error('Remote preview returned an inconsistent chunk.')
      const bytes = Buffer.from(chunk.bytesBase64, 'base64')
      if (bytes.length !== chunk.length) throw new Error('Remote preview returned invalid bytes.')
      if (!response.write(bytes)) await this.drain(response)
      this.current(capability)
      offset += bytes.length
    }
    if (!response.destroyed && offset === range.end + 1) response.end()
    else if (!response.destroyed) response.destroy(new Error('Remote preview ended before the requested range.'))
  }

  private drain(response: ServerResponse): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        response.off('drain', drained)
        response.off('close', closed)
        response.off('error', failed)
      }
      const drained = (): void => { cleanup(); resolve() }
      const closed = (): void => { cleanup(); reject(new Error('Remote preview consumer disconnected during backpressure.')) }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      response.once('drain', drained)
      response.once('close', closed)
      response.once('error', failed)
      if (response.destroyed) closed()
    })
  }

  private async ownsTemporary(path: string, identity: TemporaryIdentity): Promise<boolean> {
    try {
      const current = await lstat(path)
      return current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev
        && current.ino === identity.ino && current.birthtimeMs === identity.birthtimeMs
    } catch { return false }
  }

  private async writeAll(handle: Pick<FileHandle, 'write'>, bytes: Buffer, offset: number, current: () => void): Promise<void> {
    let written = 0
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, offset + written)
      current()
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1 || result.bytesWritten > bytes.length - written) {
        throw new Error('Remote download temporary write was incomplete.')
      }
      written += result.bytesWritten
    }
  }

  async download(file: RemoteFileIdentity, signal?: AbortSignal): Promise<RemoteFileDownloadResult | null> {
    const lifecycle = this.lifecycle
    const current = (): void => {
      this.assertOpen(lifecycle)
      if (signal?.aborted) throw new Error('Remote download was cancelled.')
    }
    current()
    if (!this.deps.chooseDownloadPath) throw new Error('Remote downloads require an owner-controlled save dialog.')
    const description = await this.deps.files.describe(file)
    current()
    if (!validDescription(description) || !sameFile(description.file, file)) throw new Error('Remote download metadata is invalid.')
    const destination = await this.deps.chooseDownloadPath(description)
    current()
    if (!destination) return null
    const stillCurrent = async (): Promise<void> => {
      const current = await this.deps.files.describe(file)
      this.assertOpen(lifecycle)
      if (signal?.aborted) throw new Error('Remote download was cancelled.')
      if (!validDescription(current) || !sameFile(current.file, description.file)
        || current.version !== description.version || current.size !== description.size
        || current.kind !== description.kind || current.mimeType !== description.mimeType) {
        throw new Error('Remote download resource changed.')
      }
    }
    await stillCurrent()
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(12).toString('hex')}.conductor-download`)
    let handle: FileHandle | null = null
    let temporaryIdentity: TemporaryIdentity | null = null
    let published = false
    try {
      handle = await open(temporary, 'wx')
      current()
      const opened = await handle.stat()
      current()
      temporaryIdentity = { dev: opened.dev, ino: opened.ino, birthtimeMs: opened.birthtimeMs }
      let offset = 0
      while (offset < description.size) {
        current()
        const length = Math.min(REMOTE_FILE_CHUNK_BYTES, description.size - offset)
        const chunk = await this.deps.files.readChunk({
          ...description.file, offset, length, version: description.version
        })
        current()
        if (chunk.offset !== offset || chunk.totalSize !== description.size || chunk.version !== description.version
          || chunk.length < 1 || chunk.length > length || chunk.eof !== (offset + chunk.length >= description.size)) {
          throw new Error('Remote download returned an inconsistent chunk.')
        }
        const bytes = Buffer.from(chunk.bytesBase64, 'base64')
        if (bytes.length !== chunk.length) throw new Error('Remote download returned invalid bytes.')
        await this.writeAll(handle, bytes, offset, current)
        offset += bytes.length
      }
      await handle.sync()
      current()
      await stillCurrent()
      await handle.close()
      handle = null
      current()
      await stillCurrent()
      if (!temporaryIdentity || !(await this.ownsTemporary(temporary, temporaryIdentity))) {
        throw new Error('Remote download temporary file ownership changed before publish.')
      }
      current()
      // Synchronous rename gives close/cancellation no event-loop gap between the final authority
      // check and the atomic publish. A replaced temporary path is refused above.
      renameSync(temporary, destination)
      published = true
      return { file: description.file, path: destination, size: description.size, version: description.version }
    } finally {
      await handle?.close().catch(() => {})
      if (!published && temporaryIdentity && await this.ownsTemporary(temporary, temporaryIdentity)) {
        await rm(temporary, { force: true }).catch(() => {})
      }
    }
  }

  close(): void {
    this.lifecycle++
    this.closed = true
    this.capabilities.clear()
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = null
    this.origin = ''
  }
}
