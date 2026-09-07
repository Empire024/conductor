import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, join, relative, isAbsolute, resolve, sep } from 'node:path'
import { valid } from 'semver'

export interface LocalBuild {
  schemaVersion: 1
  version: string
  createdAt: string
  commit: string | null
  dirty?: boolean
  installer: string
  blockmap: string
  sha512: string
  size: number
  blockmapSha512: string
  blockmapSize: number
}
interface VerifiedBuild { descriptor: LocalBuild; installerPath: string; blockmapPath: string; signature: string }
const MAX_INSTALLER = 1024 * 1024 * 1024
const MAX_BLOCKMAP = 16 * 1024 * 1024

export function parseLocalBuild(value: unknown): LocalBuild {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local build descriptor')
  const info = value as LocalBuild
  if (info.schemaVersion !== 1 || typeof info.version !== 'string' || !valid(info.version) || !/^\d+\.\d+\.\d+-local\.\d+$/.test(info.version)) throw new Error('Invalid local build version')
  if (info.installer !== 'Conductor-Setup-' + info.version + '.exe' || info.blockmap !== info.installer + '.blockmap') throw new Error('Invalid local build artifact names')
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_INSTALLER || !Number.isSafeInteger(info.blockmapSize) || info.blockmapSize <= 0 || info.blockmapSize > MAX_BLOCKMAP) throw new Error('Invalid local build artifact size')
  if (![info.sha512, info.blockmapSha512].every(hash => typeof hash === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(hash) && Buffer.from(hash, 'base64').length === 64)) throw new Error('Invalid local build checksum')
  if (typeof info.createdAt !== 'string' || !Number.isFinite(Date.parse(info.createdAt)) || (info.commit !== null && (typeof info.commit !== 'string' || !/^[a-f0-9]{7,40}$/.test(info.commit))) || (info.dirty !== undefined && typeof info.dirty !== 'boolean')) throw new Error('Invalid local build metadata')
  return info
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}
async function boundedJson(path: string): Promise<unknown> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 16_384) throw new Error('Local build descriptor is too large')
    const bytes = Buffer.alloc(16_385)
    const result = await handle.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead > 16_384) throw new Error('Local build descriptor is too large')
    return JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'))
  } finally { await handle.close() }
}
async function verify(path: string, size: number, expected: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== size) throw new Error('Local build artifact size changed')
    const hash = createHash('sha512')
    let received = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      received += chunk.length
      if (received > size) throw new Error('Local build artifact grew during verification')
      hash.update(chunk)
    }
    const after = await handle.stat()
    if (received !== size || hash.digest('base64') !== expected || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Local build artifact checksum failed')
    return [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':')
  } finally { await handle.close() }
}
function manifest(info: LocalBuild): string {
  return [
    'version: ' + info.version, 'files:', '  - url: ' + info.installer,
    '    sha512: ' + info.sha512, '    size: ' + info.size,
    'path: ' + info.installer, 'sha512: ' + info.sha512,
    'releaseDate: ' + JSON.stringify(info.createdAt), ''
  ].join('\n')
}

/** Read-only, loopback-only transport for owner-published installer artifacts. */
export class LocalUpdateFeed {
  private server?: Server
  private origin = ''
  private readonly namespace = '/' + randomBytes(24).toString('hex') + '/'
  private latest?: VerifiedBuild
  private closed = false
  private readonly builds = new Map<string, VerifiedBuild>()
  constructor(readonly directory: string) {}

  async refresh(): Promise<{ version: string; url: string; commit?: string; dirty?: boolean } | null> {
    if (this.closed) return null
    let info: LocalBuild
    let descriptorRead = false
    try {
      const root = await realpath(this.directory)
      if (root.toLocaleLowerCase() !== resolve(this.directory).toLocaleLowerCase()) throw new Error('Local build feed folder is redirected')
      const path = await realpath(join(this.directory, 'conductor-local-build.json'))
      if (!inside(root, path)) throw new Error('Local build descriptor escapes the feed folder')
      info = parseLocalBuild(await boundedJson(path))
      descriptorRead = true
      const installerPath = await realpath(join(root, info.installer))
      const blockmapPath = await realpath(join(root, info.blockmap))
      if (!inside(root, installerPath) || !inside(root, blockmapPath)) throw new Error('Local build artifact escapes the feed folder')
      const signature = JSON.stringify(info)
      let build = this.builds.get(info.version)
      if (build && build.signature !== signature) throw new Error('A published local build version cannot be overwritten')
      // Verify every refresh. No mutable file or diagnostic text is trusted as bytes.
      await Promise.all([verify(installerPath, info.size, info.sha512), verify(blockmapPath, info.blockmapSize, info.blockmapSha512)])
      if (this.closed) return null
      build = { descriptor: info, installerPath, blockmapPath, signature }
      this.builds.set(info.version, build)
      while (this.builds.size > 8) this.builds.delete(this.builds.keys().next().value!)
      this.latest = build
    } catch (error) {
      if (!descriptorRead && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    await this.listen()
    return { version: info.version, url: this.origin + this.namespace, commit: info.commit ?? undefined, dirty: info.dirty }
  }
  dispose(): void {
    this.closed = true
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = undefined
    this.builds.clear()
    this.latest = undefined
  }
  private async listen(): Promise<void> {
    if (this.server) return
    const server = createServer((request, response) => {
      void this.serve(request, response).catch(() => { if (!response.headersSent) response.writeHead(409); response.end() })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    if (this.closed) { server.close(); return }
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local update server failed to bind')
    this.origin = 'http://127.0.0.1:' + address.port
    server.unref()
  }
  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed || request.headers.origin || request.headers.host !== new URL(this.origin).host || !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(403); response.end(); return
    }
    const url = request.url ?? ''
    const route = url.split('?')[0]!
    if (!route.startsWith(this.namespace)) { response.writeHead(404); response.end(); return }
    const name = route.slice(this.namespace.length)
    if (name !== basename(name) || /[%\\/:]/.test(name)) { response.writeHead(404); response.end(); return }
    if (name === 'latest.yml' && this.latest) {
      const body = manifest(this.latest.descriptor)
      response.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : body); return
    }
    const build = [...this.builds.values()].find(entry => entry.descriptor.installer === name || entry.descriptor.blockmap === name)
    if (!build) { response.writeHead(404); response.end(); return }
    const installer = name === build.descriptor.installer
    const path = installer ? build.installerPath : build.blockmapPath
    const size = installer ? build.descriptor.size : build.descriptor.blockmapSize
    if (await realpath(path) !== path) throw new Error('Local update artifact was redirected')
    const handle: FileHandle = await open(path, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== size) throw new Error('Local update artifact changed')
      let start = 0, end = size - 1
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range)
        if (!match || Number(match[1]) >= size || (match[2] && (Number(match[2]) < Number(match[1]) || Number(match[2]) >= size))) {
          response.writeHead(416, { 'Content-Range': 'bytes */' + size }); response.end(); return
        }
        start = Number(match[1]); end = match[2] ? Number(match[2]) : end
      }
      response.writeHead(request.headers.range ? 206 : 200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
        ...(request.headers.range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size } : {})
      })
      if (request.method === 'HEAD') { response.end(); return }
      await new Promise<void>((resolve, reject) => {
        const stream = handle.createReadStream({ start, end, autoClose: false })
        stream.on('error', reject)
        response.once('close', () => { stream.destroy(); resolve() })
        response.once('finish', resolve)
        stream.pipe(response)
      })
    } finally { await handle.close() }
  }
}
