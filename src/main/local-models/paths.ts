import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

/** The local stack cannot run without a usable data root. Every failure here is fail-closed:
 *  nothing is ever recreated on the system drive as a fallback. */
export class LocalRootError extends Error {}

/** One canonical setting decides where every large or growing local-model artefact lives:
 *  GGUFs, download staging, caches, runtime state, logs, config, temp files and agent
 *  workspaces. Scripts and the provider all derive their paths from here, so no drive letter
 *  is ever hardcoded anywhere else. */
export const LOCAL_ROOT_ENV = 'CONDUCTOR_LOCAL_ROOT'
export const DEFAULT_ROOT_FOLDER = 'ConductorLocal'
/** Both GGUFs (~26 GB), download overhead, caches and workspaces, with headroom. */
export const MIN_FREE_BYTES = 60 * 1024 ** 3

export interface LocalRootPointer { root: string; selectedAt: string; note?: string }

const repoPointer = (): string | null => {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'conductor-desktop') return join(dir, '.local-models', 'root.json') } catch { /* keep walking up */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const userPointer = (): string => join(homedir(), '.conductor', 'local-root.json')

/** Where the pointer is read from, in order. The pointer itself is a few bytes of JSON; it is
 *  the only piece of this feature that deliberately stays next to the checkout. */
export const pointerPaths = (): string[] => [repoPointer(), userPointer()].filter(Boolean) as string[]

export const systemDrive = (): string => (process.env.SystemDrive || 'C:').toUpperCase().replace(/\\$/, '')

export const driveOf = (path: string): string => {
  const root = parse(resolve(path)).root
  return root.slice(0, 2).toUpperCase()
}

export const onSystemDrive = (path: string): boolean => driveOf(path) === systemDrive()

export interface DriveCandidate { letter: string; freeBytes: number; totalBytes: number; label?: string; fixed: boolean }

/** Fixed, non-system drives with their free space. CIM is asked first because it is the only
 *  source that distinguishes a fixed disk from removable or network storage; if that is
 *  unavailable the letters are probed directly and reported as unverified. */
export function detectDrives(): DriveCandidate[] {
  const candidates = new Map<string, DriveCandidate>()
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,FreeSpace,Size | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      const parsed: unknown = JSON.parse(output || '[]')
      for (const entry of (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ DeviceID?: string; VolumeName?: string; FreeSpace?: number; Size?: number }>) {
        if (!entry?.DeviceID) continue
        candidates.set(entry.DeviceID.toUpperCase(), { letter: entry.DeviceID.toUpperCase(), freeBytes: Number(entry.FreeSpace ?? 0), totalBytes: Number(entry.Size ?? 0), label: entry.VolumeName, fixed: true })
      }
    } catch { /* Fall back to probing letters below. */ }
    if (!candidates.size) {
      for (const code of Array.from({ length: 24 }, (_value, index) => index + 67)) {
        const letter = `${String.fromCharCode(code)}:`
        if (!existsSync(letter + '\\')) continue
        try {
          const stats = statfsSync(letter + '\\')
          candidates.set(letter, { letter, freeBytes: Number(stats.bsize) * Number(stats.bfree), totalBytes: Number(stats.bsize) * Number(stats.blocks), fixed: false })
        } catch { /* unreadable volume */ }
      }
    }
  }
  return [...candidates.values()].sort((a, b) => a.letter.localeCompare(b.letter))
}

export const freeBytes = (path: string): number => {
  const stats = statfsSync(parse(resolve(path)).root)
  return Number(stats.bsize) * Number(stats.bfree)
}

/** Choose a data root without ever landing on the system drive. Alphabetical order among
 *  qualifying fixed drives keeps repeated setups deterministic. */
export function chooseLocalRoot(minFree = MIN_FREE_BYTES): { root: string; drive: DriveCandidate } {
  const system = systemDrive()
  const drives = detectDrives().filter(drive => drive.letter !== system)
  if (!drives.length) throw new LocalRootError('No fixed non-system drive was found. Attach one, or set CONDUCTOR_LOCAL_ROOT to a path on a non-system drive.')
  const usable = drives.filter(drive => drive.freeBytes >= minFree)
  if (!usable.length) {
    const detail = drives.map(drive => `${drive.letter} ${(drive.freeBytes / 1024 ** 3).toFixed(1)} GB free`).join(', ')
    throw new LocalRootError(`Insufficient space: the local model stack needs about ${(minFree / 1024 ** 3).toFixed(0)} GB free on a non-system drive. Found ${detail}. Free space or set CONDUCTOR_LOCAL_ROOT.`)
  }
  const drive = usable[0]!
  return { root: join(drive.letter + '\\', DEFAULT_ROOT_FOLDER), drive }
}

export function readPointer(): string | null {
  const configured = process.env[LOCAL_ROOT_ENV]?.trim()
  if (configured) return resolve(configured)
  for (const path of pointerPaths()) {
    if (!existsSync(path)) continue
    try {
      const pointer = JSON.parse(readFileSync(path, 'utf8')) as LocalRootPointer
      if (typeof pointer.root === 'string' && pointer.root.trim()) return resolve(pointer.root.trim())
    } catch { /* A corrupt pointer is treated as absent; setup rewrites it. */ }
  }
  return null
}

/** Record the choice everywhere it can be read from — beside the checkout and in the user
 *  profile — so the CLI and an installed Conductor build resolve the same root. Both files hold
 *  nothing but the path; all the data itself lives on the root. */
export function writePointer(root: string, note?: string): string[] {
  const written: string[] = []
  for (const target of new Set([...pointerPaths(), userPointer()])) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ root: resolve(root), selectedAt: new Date().toISOString(), note } satisfies LocalRootPointer, null, 2) + '\n', 'utf8')
    written.push(target)
  }
  return written
}

export interface LocalLayout {
  root: string
  config: string
  models: string
  downloads: string
  cache: string
  runtime: string
  logs: string
  temp: string
  workspaces: string
}

export const layoutFor = (root: string): LocalLayout => ({
  root,
  config: join(root, 'config'),
  models: join(root, 'models'),
  downloads: join(root, 'downloads'),
  cache: join(root, 'cache'),
  runtime: join(root, 'runtime'),
  logs: join(root, 'logs'),
  temp: join(root, 'temp'),
  workspaces: join(root, 'workspaces')
})

/** The configured root, validated. Callers that only read paths use this; it never creates the
 *  root, so a disconnected drive fails closed instead of silently reappearing on C:. */
export function localRoot(): string {
  const root = readPointer()
  if (!root) throw new LocalRootError(`Conductor local root is not configured. Run scripts/local-models/setup.ps1, or set ${LOCAL_ROOT_ENV} to a path on a non-system drive.`)
  if (!isAbsolute(root)) throw new LocalRootError(`${LOCAL_ROOT_ENV} must be an absolute path`)
  if (onSystemDrive(root)) throw new LocalRootError(`Refusing a local root on the system drive (${systemDrive()}): ${root}. Model files, caches and agent workspaces must live on another fixed drive.`)
  return root
}

export const layout = (): LocalLayout => layoutFor(localRoot())

/** Startup validation: the root exists, is off the system drive, and every expected directory
 *  is readable and writable. Any failure is reported, never repaired by falling back. */
export function assertLocalRootUsable(): LocalLayout {
  const paths = layout()
  if (!existsSync(paths.root)) throw new LocalRootError(`Local root is unavailable: ${paths.root} does not exist (drive disconnected?). Reconnect it or run setup again; nothing will be recreated on ${systemDrive()}.`)
  for (const directory of Object.values(paths)) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    try { accessSync(directory, constants.R_OK | constants.W_OK) } catch { throw new LocalRootError(`Local root directory is not accessible: ${directory}`) }
  }
  return paths
}

export function ensureLayout(root: string): LocalLayout {
  const paths = layoutFor(root)
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  return paths
}

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,110}$/

/** The per-session agent workspace. This is Conductor-created data, so it lives on the local
 *  root; only this one directory is ever bind-mounted into a sandbox container. */
export function sessionWorkspace(sessionId: string, create = true): string {
  const name = sessionId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 110)
  if (!SESSION.test(name)) throw new LocalRootError('Invalid session workspace name')
  const path = join(layout().workspaces, name)
  if (create) mkdirSync(path, { recursive: true })
  return path
}

/** Environment for any child process this stack starts, so nothing large can land in %TEMP%
 *  on the system drive: downloads, model caches and scratch files all resolve to the root. */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const paths = layout()
  return {
    ...base,
    TMP: paths.temp,
    TEMP: paths.temp,
    TMPDIR: paths.temp,
    XDG_CACHE_HOME: paths.cache,
    HF_HOME: join(paths.cache, 'huggingface'),
    HF_HUB_CACHE: join(paths.cache, 'huggingface', 'hub'),
    LLAMA_CACHE: join(paths.cache, 'llama.cpp')
  }
}
