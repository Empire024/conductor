import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** Where browser_video_frames writes, under the project root. */
export const CAPTURE_FOLDER = '.conductor/browser-captures'

/** Folders and files a download may never land in, whatever path the agent names: version control,
 *  agent and editor configuration (which an agent's next turn would load as instructions or run as
 *  hooks), secrets, and installed dependencies. A download only ever creates a new file, so this is
 *  about what a new file there would be read as, not about losing one. */
const PROTECTED_SEGMENT = /^(?:\.git|\.claude|\.codex|\.agents|\.conductor|\.github|\.vscode|\.idea|\.husky|\.devcontainer|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|node_modules)$/i
const PROTECTED_NAME = /^(?:agents\.md|claude\.md|\.mcp\.json|\.env.*|\.npmrc|\.pypirc|\.netrc|_netrc|\.yarnrc.*|\.git.*|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.(?:pem|key|pfx|p12))$/i
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i
const MAX_NAME = 120

const EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'video/ogg': '.ogv', 'video/mp2t': '.ts',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/webm': '.weba', 'audio/flac': '.flac',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json', 'text/plain': '.txt', 'text/html': '.html', 'text/csv': '.csv',
  'application/vnd.apple.mpegurl': '.m3u8', 'application/x-mpegurl': '.m3u8', 'application/dash+xml': '.mpd'
}
export const extensionFor = (contentType: string | undefined): string => EXTENSIONS[(contentType ?? '').split(';')[0]!.trim().toLowerCase()] ?? ''

/** The name a server suggests in Content-Disposition, RFC 6266 filename* first. */
export function contentDispositionName(header: string | undefined): string | undefined {
  if (!header) return undefined
  const extended = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(header)?.[1]
  if (extended) { try { return decodeURIComponent(extended.trim().replace(/^"|"$/g, '')) } catch { /* fall back to the plain parameter */ } }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header)
  return plain ? (plain[1] ?? plain[2] ?? '').replace(/\\(.)/g, '$1').trim() || undefined : undefined
}

/** A single safe file name: no separators, no characters Windows refuses, no leading dots, no
 *  reserved device names, bounded length, and an extension from the content type when it has none. */
export function safeFileName(raw: string | undefined, contentType?: string, fallback = 'download'): string {
  let name = (raw ?? '').split(/[\\/]/).pop() ?? ''
  try { name = decodeURIComponent(name) } catch { /* keep it as it came */ }
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').replace(/_{2,}/g, '_')
  if (!name) name = fallback
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  if (!extname(name)) name += extensionFor(contentType)
  if (name.length > MAX_NAME) {
    const extension = extname(name).slice(0, 16)
    name = name.slice(0, MAX_NAME - extension.length) + extension
  }
  return name
}

const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}
const same = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
/** The nearest existing ancestor's real path, so a junction or symlink inside the project that
 *  points elsewhere is judged by where the bytes would actually land. */
function realAncestor(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return realpathSync.native(current)
}

/** Resolves where a download lands. `requested` is project-relative (or absolute inside the
 *  project); a value ending in a separator, or naming an existing folder, is a folder for `fileName`.
 *  Anything that leaves the project root, by `..`, an absolute path or a link, is refused, and so is
 *  a protected folder or name. The result never names an existing file: an explicit path that
 *  exists is refused, a default name gets a numbered suffix. */
export function projectTarget(root: string, requested: string | undefined, fileName: string, defaultFolder: string): { absolute: string; relative: string } {
  if (!root || !isAbsolute(root)) throw new Error('This project has no folder on this machine to download into')
  const projectRoot = resolve(root)
  if (requested !== undefined && /[\u0000-\u001f]/.test(requested)) throw new Error('path contains control characters')
  const explicit = requested !== undefined && requested.trim() !== ''
  const wanted = explicit ? requested!.trim() : `${defaultFolder}/`
  // An NTFS alternate data stream (name:stream) writes bytes no folder listing shows.
  if (/:/.test(isAbsolute(wanted) ? wanted.replace(/^[a-zA-Z]:/, '') : wanted)) throw new Error(`path ${wanted} names an alternate data stream or a drive; give a path inside the project`)
  let target = isAbsolute(wanted) ? resolve(wanted) : resolve(projectRoot, wanted)
  const folder = /[\\/]$/.test(wanted) || (existsSync(target) && statSync(target).isDirectory())
  if (folder) target = join(target, fileName)
  if (!inside(projectRoot, target)) throw new Error(`path ${wanted} is outside the project; downloads stay inside ${projectRoot}`)
  const relativePath = relative(projectRoot, target)
  const segments = relativePath.split(/[\\/]/)
  const blocked = segments.slice(0, -1).find(segment => PROTECTED_SEGMENT.test(segment)) ?? (PROTECTED_NAME.test(segments.at(-1)!) ? segments.at(-1) : undefined)
  if (blocked) throw new Error(`path ${relativePath.replaceAll('\\', '/')} is in or names a protected location (${blocked}); download reference media into ${defaultFolder}/ or another ordinary project folder`)
  const realRoot = realpathSync.native(projectRoot)
  const landing = realAncestor(dirname(target))
  if (!same(landing, realRoot) && !inside(realRoot, landing)) throw new Error(`path ${wanted} leads outside the project through a link (${landing}); downloads stay inside ${projectRoot}`)
  if (existsSync(target)) {
    if (explicit && !folder) throw new Error(`${relativePath.replaceAll('\\', '/')} already exists; a download never replaces a file. Name another path.`)
    target = uniquePath(target)
  }
  return { absolute: target, relative: relative(projectRoot, target).replaceAll('\\', '/') }
}

/** name.ext, then name-1.ext, name-2.ext, … for the first that does not exist. */
export function uniquePath(path: string): string {
  if (!existsSync(path)) return path
  const extension = extname(path), stem = path.slice(0, path.length - extension.length)
  for (let index = 1; index < 10_000; index++) {
    const candidate = `${stem}-${index}${extension}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`Too many files named ${basename(path)} already exist`)
}

/** A sortable, file-name-safe timestamp for one capture folder. */
export const captureStamp = (date = new Date()): string => date.toISOString().replace(/[:.]/g, '-')

/** The media times one seeking pass visits: from start at fps until end, at most maxFrames. */
export function planFrameTimes(options: { start: number; end: number; fps: number; maxFrames: number }): { times: number[]; truncated?: string } {
  const { start, end, fps, maxFrames } = options
  if (!(end > start)) return { times: [start] }
  const step = 1 / fps
  const wanted = Math.floor((end - start) * fps + 1e-9) + 1
  const total = Math.min(wanted, maxFrames)
  const times = Array.from({ length: total }, (_, index) => Math.round((start + index * step) * 1000) / 1000)
  return { times, ...(wanted > maxFrames ? { truncated: `maxFrames ${maxFrames} reached at ${times.at(-1)} s of a ${start}–${end} s window; continue with start=${Math.round((times.at(-1)! + step) * 1000) / 1000}` } : {}) }
}

/** The part of a captured viewport image that shows a page rectangle (CSS pixels), clipped to the
 *  viewport and scaled by the image's own pixel ratio; undefined when nothing of it is visible. */
export function cropRect(rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }, image: { width: number; height: number }): { x: number; y: number; width: number; height: number } | undefined {
  if (!(viewport.width > 0) || !(viewport.height > 0)) return undefined
  const ratio = image.width / viewport.width
  const left = Math.max(0, rect.x), top = Math.max(0, rect.y)
  const right = Math.min(viewport.width, rect.x + rect.width), bottom = Math.min(viewport.height, rect.y + rect.height)
  if (right - left < 1 || bottom - top < 1) return undefined
  const x = Math.floor(left * ratio), y = Math.floor(top * ratio)
  return { x, y, width: Math.min(image.width - x, Math.round((right - left) * ratio)), height: Math.min(image.height - y, Math.round((bottom - top) * ratio)) }
}
