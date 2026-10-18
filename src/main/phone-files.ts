import { randomBytes } from 'node:crypto'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { PhoneAccessError } from './phone-access'

/**
 * A project's files, read-only, for a phone that is paired and unlocked.
 *
 * Listing is an ordinary authenticated API call. Reading a file goes through a capability instead:
 * an unguessable token minted for one folder of one project, so an <img src>, the relative links
 * of an HTML page and a download all work without the bearer header a browser cannot attach to
 * them. A capability lives as long as the phone's unlocked session and at most CAPABILITY_IDLE_MS
 * past its last use, never outside its folder, and is never written to a log.
 */

/** The largest file the phone is ever sent; streamed, with Range for the big ones. */
export const MAX_PHONE_FILE_BYTES = 256 * 1024 * 1024
export const MAX_PHONE_LISTING = 1000
/** A capability nobody used for this long is gone; each use slides it. */
export const CAPABILITY_IDLE_MS = 15 * 60_000
/** And none outlives this, used or not. */
export const CAPABILITY_MAX_MS = 4 * 3600_000
const MAX_CAPABILITIES_PER_DEVICE = 32
export const PHONE_FILES_PREFIX = '/files/'

/** An HTML page runs its own scripts but in an opaque origin: it cannot read the API, the phone's
 *  storage or its token, and its relative assets resolve under the same capability. */
export const SANDBOX_CSP = "sandbox allow-scripts; default-src 'self' 'unsafe-inline' data: blob:"

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.py': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
}
/** Types a browser would run as a document of its own; they always get the sandbox. */
const ACTIVE = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/xml)/
const IMAGE = /^image\//

export function phoneFileType(name: string): string { return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream' }

export interface PhoneFileEntry { name: string; kind: 'dir' | 'file'; size: number | null; modifiedAt: string | null; type: string | null; image: boolean }
export interface PhoneFileListing { path: string; parent: string | null; entries: PhoneFileEntry[]; truncated: boolean }
export interface PhoneFileCapability { url: string; path: string; expiresAt: string }

interface Capability {
  token: string
  deviceId: string
  unlockId: string | null
  /** The folder's real path; every file it serves resolves inside it. */
  root: string
  createdAt: number
  usedAt: number
}

/** Hidden or sensitive: anything starting with '.', and dependency trees. */
export function hiddenSegment(name: string): boolean {
  return name.startsWith('.') || name.toLowerCase() === 'node_modules'
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(?:\..*)?$/i

/**
 * The relative path's segments, or a refusal. Absolute paths, drive letters, `..`, NUL and
 * every other control character, Windows stream and device names, and hidden segments are all
 * refused here, before the disk is touched.
 */
export function pathSegments(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== 'string' || raw.length > 2048) throw new PhoneAccessError('That path is not valid.', 400)
  if (/[\u0000-\u001f]/.test(raw)) throw new PhoneAccessError('That path is not valid.', 400)
  if (/^[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw)) throw new PhoneAccessError('Paths are relative to the project.', 400)
  const segments = raw.split(/[\\/]+/).filter(Boolean)
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_DEVICE.test(segment)) throw new PhoneAccessError('That path is not valid.', 400)
    if (hiddenSegment(segment)) throw new PhoneAccessError('That file is not shared with the phone.', 403)
  }
  return segments
}

const insensitive = process.platform === 'win32' || process.platform === 'darwin'
const same = (left: string, right: string): boolean => insensitive ? left.toLowerCase() === right.toLowerCase() : left === right

/** Whether `target` (a real path) is `root` or below it, with no hidden segment in between. */
export function confined(root: string, target: string): boolean {
  if (same(root, target)) return true
  const base = root.endsWith(sep) ? root : root + sep
  if (!(insensitive ? target.toLowerCase().startsWith(base.toLowerCase()) : target.startsWith(base))) return false
  return !relative(root, target).split(sep).some(hiddenSegment)
}

/** The real path of `segments` under `root` (already real), refusing every escape a link makes. */
export async function resolveInside(root: string, segments: string[]): Promise<string> {
  let target: string
  try { target = await realpath(join(root, ...segments)) } catch { throw new PhoneAccessError('That file does not exist.', 404) }
  if (!confined(root, target)) throw new PhoneAccessError('That file is not shared with the phone.', 403)
  return target
}

export interface PhoneFilesDependencies {
  now?(): number
  /** Whether a capability's phone may still read: paired, and unlocked when a code is set. */
  alive?(capability: { deviceId: string; unlockId: string | null }): boolean
}

export class PhoneFiles {
  private readonly capabilities = new Map<string, Capability>()

  constructor(private readonly deps: PhoneFilesDependencies = {}) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** A real project root, or the refusal a phone sees. */
  async projectRoot(path: string): Promise<string> {
    try {
      const root = await realpath(path)
      if ((await stat(root)).isDirectory()) return root
    } catch { /* falls through */ }
    throw new PhoneAccessError('This project folder is not on this computer any more.', 404)
  }

  /** One folder of the project: visible entries only, folders first, then by name. */
  async list(projectPath: string, path: unknown): Promise<PhoneFileListing> {
    const root = await this.projectRoot(projectPath)
    const segments = pathSegments(path)
    const folder = await resolveInside(root, segments)
    if (!(await stat(folder)).isDirectory()) throw new PhoneAccessError('That is a file, not a folder.', 400)
    const dirents = (await readdir(folder, { withFileTypes: true })).filter(entry => !hiddenSegment(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
    const truncated = dirents.length > MAX_PHONE_LISTING
    const entries: PhoneFileEntry[] = []
    for (const dirent of dirents.slice(0, MAX_PHONE_LISTING)) {
      const full = join(folder, dirent.name)
      try {
        // A link or junction is listed only when it lands inside the project, and is described
        // by its target. Every entry is resolved: Windows reports some junctions as folders.
        const target = await realpath(full)
        if (!confined(root, target)) continue
        const info = await stat(target)
        if (info.isDirectory()) entries.push({ name: dirent.name, kind: 'dir', size: null, modifiedAt: info.mtime.toISOString(), type: null, image: false })
        else if (info.isFile()) {
          const type = phoneFileType(dirent.name)
          entries.push({ name: dirent.name, kind: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), type, image: IMAGE.test(type) })
        }
      } catch { /* vanished or unreadable: not listed */ }
    }
    entries.sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)
    return { path: segments.join('/'), parent: segments.length ? segments.slice(0, -1).join('/') : null, entries, truncated }
  }

  /** A capability for one folder: the URL prefix its files are read from. */
  async grant(projectPath: string, path: unknown, owner: { deviceId: string; unlockId: string | null }): Promise<PhoneFileCapability> {
    const root = await this.projectRoot(projectPath)
    const segments = pathSegments(path)
    const folder = await resolveInside(root, segments)
    if (!(await stat(folder)).isDirectory()) throw new PhoneAccessError('That is a file, not a folder.', 400)
    this.prune()
    const mine = [...this.capabilities.values()].filter(entry => entry.deviceId === owner.deviceId).sort((a, b) => a.usedAt - b.usedAt)
    for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_CAPABILITIES_PER_DEVICE + 1))) this.capabilities.delete(stale.token)
    const token = randomBytes(32).toString('base64url')
    const at = this.now()
    this.capabilities.set(token, { token, deviceId: owner.deviceId, unlockId: owner.unlockId, root: folder, createdAt: at, usedAt: at })
    return { url: PHONE_FILES_PREFIX + token + '/', path: segments.join('/'), expiresAt: new Date(at + CAPABILITY_IDLE_MS).toISOString() }
  }

  /**
   * Ends capabilities when a phone locks: with a null device every one (a code was set or
   * changed), with a null session every one of that phone (unpaired), otherwise that session's.
   */
  revoke(deviceId: string | null, unlockId: string | null): void {
    for (const entry of [...this.capabilities.values()]) {
      if (deviceId !== null && entry.deviceId !== deviceId) continue
      if (deviceId !== null && unlockId !== null && entry.unlockId !== unlockId) continue
      this.capabilities.delete(entry.token)
    }
  }

  clear(): void { this.capabilities.clear() }

  size(): number { this.prune(); return this.capabilities.size }

  private expired(entry: Capability, at: number): boolean {
    return at - entry.usedAt > CAPABILITY_IDLE_MS || at - entry.createdAt > CAPABILITY_MAX_MS
  }

  private prune(): void {
    const at = this.now()
    for (const entry of [...this.capabilities.values()]) if (this.expired(entry, at)) this.capabilities.delete(entry.token)
  }

  /**
   * Answers GET/HEAD /files/<capability>/<path>. A folder is never listed here and a refusal
   * says as little as a 404: the capability path is the only door, and it opens onto files.
   */
  async serve(pathname: string, query: URLSearchParams, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rest = pathname.slice(PHONE_FILES_PREFIX.length)
    const slash = rest.indexOf('/')
    const token = slash < 0 ? rest : rest.slice(0, slash)
    const entry = /^[A-Za-z0-9_-]{43}$/.test(token) ? this.capabilities.get(token) : undefined
    const at = this.now()
    if (!entry || this.expired(entry, at) || (this.deps.alive && !this.deps.alive(entry))) {
      if (entry) this.capabilities.delete(entry.token)
      throw new PhoneAccessError('This file link has expired. Open the folder in Conductor again.', 404)
    }
    let decoded: string[]
    try { decoded = (slash < 0 ? '' : rest.slice(slash + 1)).split('/').filter(Boolean).map(part => decodeURIComponent(part)) } catch { throw new PhoneAccessError('That path is not valid.', 400) }
    if (decoded.some(part => /[\\/]/.test(part))) throw new PhoneAccessError('That path is not valid.', 400)
    const segments = pathSegments(decoded.join('/'))
    if (!segments.length) throw new PhoneAccessError('Not found', 404)
    const target = await resolveInside(entry.root, segments)
    entry.usedAt = at
    const handle = await open(target, 'r').catch(() => { throw new PhoneAccessError('That file does not exist.', 404) })
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new PhoneAccessError('Not found', 404)
      if (info.size > MAX_PHONE_FILE_BYTES) throw new PhoneAccessError(`Files over ${MAX_PHONE_FILE_BYTES / 1024 / 1024} MiB are not sent to the phone.`, 413)
      const name = segments[segments.length - 1]!
      const type = phoneFileType(name)
      const headers: Record<string, string> = {
        'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'Last-Modified': info.mtime.toUTCString()
      }
      if (ACTIVE.test(type) || type === 'application/octet-stream') headers['Content-Security-Policy'] = SANDBOX_CSP
      if (query.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`
      let start = 0, end = info.size - 1, status = 200
      const range = typeof request.headers.range === 'string' ? request.headers.range.trim() : ''
      const parsed = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (parsed && (parsed[1] || parsed[2])) {
        if (parsed[1]) { start = Number(parsed[1]); end = parsed[2] ? Math.min(Number(parsed[2]), info.size - 1) : info.size - 1 }
        else { start = Math.max(0, info.size - Number(parsed[2])); end = info.size - 1 }
        if (start > end || start >= info.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
          response.end()
          return
        }
        status = 206
        headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`
      }
      headers['Content-Length'] = String(info.size === 0 ? 0 : end - start + 1)
      response.writeHead(status, headers)
      if (request.method === 'HEAD' || info.size === 0) { response.end(); return }
      await pipeline(handle.createReadStream({ start, end, autoClose: false }), response).catch(() => { if (!response.writableEnded) response.destroy() })
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}
